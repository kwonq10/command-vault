import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import cors from "cors";
import express from "express";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.COMMANDS_DB_PATH || path.join(__dirname, "commands.json");
const PORT = process.env.PORT || 3456;
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_DESCRIPTION_LANGUAGE = "ja";
const CLAUDE_CODE_DOC_URLS = {
  ja: "https://docs.anthropic.com/ja/docs/claude-code/cli-usage",
  en: "https://docs.anthropic.com/en/docs/claude-code/cli-usage"
};
const CLAUDE_CODE_DOC_URL = CLAUDE_CODE_DOC_URLS.ja;

const CATEGORY_RULES = [
  { pattern: /clear|reset|exit|quit|new\s*session|start/i, cat: "session" },
  { pattern: /compact|context|compress|memory|token|window/i, cat: "context" },
  { pattern: /config|setting|theme|model|permission|api.?key/i, cat: "config" },
  { pattern: /git|commit|pr|pull.?request|diff|branch|github|merge/i, cat: "git" },
  { pattern: /export|copy|output|clipboard|save|download/i, cat: "output" },
  { pattern: /doctor|diagnos|install|health|check|debug/i, cat: "diagnostic" },
  { pattern: /cost|token.?usage|stat|usage|billing/i, cat: "other" },
  { pattern: /review|suggest|explain|help|man/i, cat: "other" }
];

const COMMAND_DESCRIPTIONS = {
  ja: {
    "/goal": {
      description:
        "/goal は、これから達成したい目標を Claude Code に明示し、作業の方向性や完了条件を揃えやすくするコマンドです。長い作業でも脱線しにくくなり、今何を終わらせるべきかを共有しやすくなります。",
      tip: "実装前に「何ができたら完了か」を書いておくと、進捗確認や仕上げの判断がしやすくなります。"
    },
    "/compact": {
      description:
        "/compact は、長くなった会話の重要点を圧縮し、残りのコンテキストを有効に使いやすくするコマンドです。長時間の実装や調査でも、必要な前提を保ったまま作業を続けやすくなります。",
      tip: "会話が長くなって応答が重くなったり、前提を整理したくなったタイミングで使うと効果的です。"
    }
  },
  en: {
    "/goal": {
      description:
        "/goal tells Claude Code what you want to achieve so the session can stay aligned on direction and completion criteria. It helps longer work stay focused and makes it clearer what should be finished next.",
      tip: "Use it before implementation to define what counts as done, then refer back to it when checking progress."
    },
    "/compact": {
      description:
        "/compact condenses a long conversation into the important points so Claude Code can keep useful context while freeing up the context window. It helps extended implementation or research sessions continue with less drift.",
      tip: "Use it when the conversation gets long, responses feel weighed down, or you want to preserve the essentials before continuing."
    }
  }
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function readDB() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeDB([]);
      return [];
    }
    throw error;
  }
}

async function writeDB(commands) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, `${JSON.stringify(commands, null, 2)}\n`, "utf8");
}

function normalizeSnippet(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeDescriptionLanguage(language) {
  return language === "en" ? "en" : DEFAULT_DESCRIPTION_LANGUAGE;
}

function getDocUrl(language) {
  return CLAUDE_CODE_DOC_URLS[normalizeDescriptionLanguage(language)];
}

function normalizeCommandName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getCuratedDescription(commandName, language) {
  const descriptionLanguage = normalizeDescriptionLanguage(language);
  return COMMAND_DESCRIPTIONS[descriptionLanguage]?.[commandName.toLowerCase()] || null;
}

function localizeCommand(command, language) {
  const descriptionLanguage = normalizeDescriptionLanguage(language);
  const curated = getCuratedDescription(command.name, descriptionLanguage);

  if (!curated) {
    return {
      ...command,
      descriptionLanguage: command.descriptionLanguage || descriptionLanguage
    };
  }

  return {
    ...command,
    description: curated.description,
    tip: curated.tip,
    descriptionLanguage,
    sourceUrl: getDocUrl(descriptionLanguage),
    category: inferCategory({
      ...command,
      description: curated.description
    })
  };
}

function trimDescription(text) {
  const normalized = normalizeSnippet(text);
  if (normalized.length <= 200) return normalized;

  const firstSentence = normalized.match(/^.{1,200}?[。.!?]/u);
  if (firstSentence) return firstSentence[0].trim();
  return `${normalized.slice(0, 197).trim()}...`;
}

function inferCategory(command) {
  const haystack = [command.name, command.description, command.usage].filter(Boolean).join(" ");
  const rule = CATEGORY_RULES.find(({ pattern }) => pattern.test(haystack));
  return rule?.cat || "other";
}

function extractDuckDuckGoUrl(href) {
  if (!href) return null;

  let url = href.startsWith("//") ? `https:${href}` : href;
  if (url.startsWith("/l/")) url = `https://duckduckgo.com${url}`;

  try {
    const parsed = new URL(url);
    const redirectUrl = parsed.searchParams.get("uddg");
    if (redirectUrl) return decodeURIComponent(redirectUrl);
    return parsed.href;
  } catch {
    return null;
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "CommandVault/1.0 (+https://localhost)"
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractDescriptionFromHtml(html, commandName) {
  const $ = cheerio.load(html);
  $("nav, header, footer, script, style").remove();

  const commandPattern = commandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bodyText = normalizeSnippet($("body").text());
  const commandIndex = bodyText.toLowerCase().indexOf(commandName.toLowerCase());

  if (commandIndex >= 0) {
    const after = bodyText.slice(commandIndex, commandIndex + 500);
    const nextCommandIndex = after.slice(commandName.length).search(/\s\/[a-z]/i);
    const snippet =
      nextCommandIndex > 0
        ? after.slice(0, commandName.length + nextCommandIndex).trim()
        : after.slice(0, 300).trim();
    const sentences = snippet.match(/[^。.!\n]{10,}[。.!]/g) || [];
    let description = sentences.slice(0, 2).join("").trim();
    if (!description) description = snippet.slice(0, 120);
    return description.slice(0, 120).trim();
  }

  const heading = $(`h1, h2, h3, h4`).filter((_, el) => {
    return new RegExp(commandPattern, "i").test($(el).text());
  }).first();

  if (heading.length) {
    const sectionText = normalizeSnippet(`${heading.text()} ${heading.nextUntil("h1, h2, h3").text()}`);
    if (sectionText) return trimDescription(sectionText);
  }

  const metaDescription = $("meta[name='description']").attr("content");
  if (metaDescription) return trimDescription(metaDescription);

  return "";
}

async function searchDuckDuckGo(commandName, language) {
  const languageHint = normalizeDescriptionLanguage(language) === "ja" ? "Japanese" : "English";
  const query = encodeURIComponent(`${commandName} Claude Code slash command ${languageHint}`);
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${query}`);
  const $s = cheerio.load(html);
  const urls = [];

  $s("a.result__a").each((_, el) => {
    const href = $s(el).attr("href");
    const url = extractDuckDuckGoUrl(href);
    if (url && !urls.includes(url)) urls.push(url);
  });

  return urls.slice(0, 5);
}

async function fetchOfficialFallback(commandName, language) {
  const docUrl = getDocUrl(language);
  try {
    const html = await fetchText(docUrl);
    return extractDescriptionFromHtml(html, commandName);
  } catch (error) {
    console.warn(`Official fallback fetch failed: ${docUrl}`, error.message);
    return "";
  }
}

async function enrichCommand(name, language = DEFAULT_DESCRIPTION_LANGUAGE) {
  const normalizedName = normalizeCommandName(name);
  const descriptionLanguage = normalizeDescriptionLanguage(language);
  const curated = getCuratedDescription(normalizedName, descriptionLanguage);
  let description = "";
  let tip = "";
  let sourceUrl = getDocUrl(descriptionLanguage);

  if (curated) {
    description = curated.description;
    tip = curated.tip;
  }

  if (!description) {
    try {
      const urls = await searchDuckDuckGo(normalizedName, descriptionLanguage);
      for (const url of urls) {
        try {
          const html = await fetchText(url);
          const snippet = extractDescriptionFromHtml(html, normalizedName);
          if (snippet) {
            description = snippet;
            sourceUrl = url;
            break;
          }
        } catch (error) {
          console.warn(`Skipping failed URL: ${url}`, error.message);
        }
      }
    } catch (error) {
      console.warn("DuckDuckGo search failed:", error.message);
    }
  }

  if (!description) {
    description = await fetchOfficialFallback(normalizedName, descriptionLanguage);
  }

  if (!description) {
    description =
      descriptionLanguage === "ja"
        ? `${normalizedName} — 説明が取得できませんでした。公式ドキュメントを参照してください。`
        : `${normalizedName} — No description could be retrieved. Please refer to the official documentation.`;
    sourceUrl = getDocUrl(descriptionLanguage);
  }

  const command = {
    id: crypto.randomUUID(),
    addedAt: new Date().toISOString(),
    name: normalizedName,
    description,
    descriptionLanguage,
    usage: normalizedName,
    params: "",
    category: "other",
    tip,
    sourceUrl
  };
  command.category = inferCategory(command);
  return command;
}

app.get("/api/commands", async (req, res, next) => {
  try {
    const descriptionLanguage = normalizeDescriptionLanguage(req.query?.language);
    const commands = await readDB();
    res.json(commands.map((command) => localizeCommand(command, descriptionLanguage)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/commands", async (req, res, next) => {
  try {
    const commandText = normalizeCommandName(req.body?.command);
    if (!commandText) return res.status(400).json({ error: "command is required" });
    const descriptionLanguage = normalizeDescriptionLanguage(req.body?.language);

    const commands = await readDB();
    const duplicate = commands.find((command) => command.name.toLowerCase() === commandText.toLowerCase());
    if (duplicate) {
      return res.status(409).json({ error: `${commandText} is already registered.` });
    }

    const command = await enrichCommand(commandText, descriptionLanguage);
    commands.unshift(command);
    await writeDB(commands);
    res.status(201).json(command);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/commands/:id", async (req, res, next) => {
  try {
    const allowed = ["description", "tip", "usage", "params", "descriptionLanguage"];
    const updates = Object.fromEntries(
      allowed
        .filter((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key))
        .map((key) => [
          key,
          key === "descriptionLanguage"
            ? normalizeDescriptionLanguage(req.body[key])
            : String(req.body[key] ?? "").trim()
        ])
    );

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "No editable fields provided" });
    }

    const commands = await readDB();
    const index = commands.findIndex((command) => command.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Command not found" });

    commands[index] = {
      ...commands[index],
      ...updates
    };
    commands[index].category = inferCategory(commands[index]);

    await writeDB(commands);
    res.json(commands[index]);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/commands/:id", async (req, res, next) => {
  try {
    const commands = await readDB();
    const nextCommands = commands.filter((command) => command.id !== req.params.id);
    if (nextCommands.length === commands.length) {
      return res.status(404).json({ error: "Command not found" });
    }
    await writeDB(nextCommands);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Command Vault listening on http://localhost:${PORT}`);
});
