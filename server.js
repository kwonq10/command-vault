import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import cors from "cors";
import express from "express";
import fetch from "node-fetch";
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDocs, deleteDoc } from "firebase/firestore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.COMMANDS_DB_PATH || path.join(__dirname, "commands.json");
const SYNC_CONFIG_PATH = path.join(path.dirname(DB_PATH), "sync-config.json");
const PORT = process.env.PORT || 3456;
const FETCH_TIMEOUT_MS = 8000;
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBcWrn5zcF1kUaPqcvVnDeQ5MQGsasQJKI",
  authDomain: "command-vault-9f1ce.firebaseapp.com",
  projectId: "command-vault-9f1ce",
  storageBucket: "command-vault-9f1ce.firebasestorage.app",
  messagingSenderId: "886072410929",
  appId: "1:886072410929:web:f0aa9ac7f6482d462ca610"
};
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

async function readSyncConfig() {
  try {
    const raw = await fs.readFile(SYNC_CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSyncConfig(config) {
  await fs.mkdir(path.dirname(SYNC_CONFIG_PATH), { recursive: true });
  await fs.writeFile(SYNC_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

async function getSyncCode() {
  const config = await readSyncConfig();
  return config.syncCode || null;
}

let _firestoreDb = null;
function firestoreDb() {
  if (!_firestoreDb) {
    console.log("[Firebase] initializing app...");
    const firebaseApp = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    _firestoreDb = getFirestore(firebaseApp);
    console.log("[Firebase] Firestore instance created");
  }
  return _firestoreDb;
}

async function pushCommandToFirestore(syncCode, command, order) {
  console.log(`[Firestore] push start: syncCode=${syncCode} id=${command.id} order=${order}`);
  try {
    const db = firestoreDb();
    const ref = doc(db, "sync_codes", syncCode, "commands", command.id);
    await setDoc(ref, { ...command, _order: order });
    console.log(`[Firestore] push OK: ${command.id}`);
  } catch (err) {
    console.error(`[Firestore] push FAILED: ${command.id}`, err);
    throw err;
  }
}

async function deleteCommandFromFirestore(syncCode, commandId) {
  console.log(`[Firestore] delete start: syncCode=${syncCode} id=${commandId}`);
  try {
    const db = firestoreDb();
    const ref = doc(db, "sync_codes", syncCode, "commands", commandId);
    await deleteDoc(ref);
    console.log(`[Firestore] delete OK: ${commandId}`);
  } catch (err) {
    console.error(`[Firestore] delete FAILED: ${commandId}`, err);
    throw err;
  }
}

async function pullFromFirestore(syncCode) {
  const db = firestoreDb();
  const ref = collection(db, "sync_codes", syncCode, "commands");
  const snapshot = await getDocs(ref);
  const items = snapshot.docs.map((d) => d.data());
  items.sort((a, b) => (a._order ?? 0) - (b._order ?? 0));
  return items.map(({ _order, ...rest }) => rest);
}

function mergeCommands(local, remote) {
  const localMap = new Map(local.map((c) => [c.id, c]));
  const merged = remote.map((r) => ({ ...r, ...(localMap.get(r.id) || {}) }));
  const remoteIds = new Set(remote.map((r) => r.id));
  for (const c of local) {
    if (!remoteIds.has(c.id)) merged.push(c);
  }
  return merged;
}

async function initSync() {
  const syncCode = await getSyncCode();
  console.log(`[Firestore] initSync: syncCode=${syncCode || "(none)"}`);
  if (!syncCode) return;
  try {
    const [local, remote] = await Promise.all([readDB(), pullFromFirestore(syncCode)]);
    if (remote.length === 0) {
      for (let i = 0; i < local.length; i++) {
        await pushCommandToFirestore(syncCode, local[i], i);
      }
    } else {
      const merged = mergeCommands(local, remote);
      await writeDB(merged);
      for (let i = 0; i < merged.length; i++) {
        await pushCommandToFirestore(syncCode, merged[i], i);
      }
    }
    console.log(`Firestore sync complete: ${syncCode}`);
  } catch (err) {
    console.error("initSync error:", err);
  }
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
    // コマンド名直後のテキストだけを抽出（コマンド名自体は除外）
    const after = bodyText.slice(commandIndex + commandName.length).trimStart();
    const nextCommandIndex = after.search(/\s\/[a-z]/i);
    const chunk = (nextCommandIndex > 0 ? after.slice(0, nextCommandIndex) : after.slice(0, 200)).trim();

    // 句点・ピリオド・感嘆符で終わる最初の1文のみ取得
    const firstSentence = chunk.match(/^.{5,}?[。.!?]/u);
    // slice しない — 長さ検証は enrichCommand() の品質検証で行う
    return firstSentence ? firstSentence[0].trim() : chunk.slice(0, 200).trim();
  }

  const heading = $(`h1, h2, h3, h4`).filter((_, el) => {
    return new RegExp(commandPattern, "i").test($(el).text());
  }).first();

  if (heading.length) {
    // 見出し自体（コマンド名を含む）は除外し、セクション本文のみを使う
    const sectionText = normalizeSnippet(heading.nextUntil("h1, h2, h3, h4").text());
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

  // 1. 公式ドキュメントを優先して参照（ja → en の順）
  if (!curated && !description) {
    for (const docUrl of Object.values(CLAUDE_CODE_DOC_URLS)) {
      try {
        const html = await fetchText(docUrl);
        const snippet = extractDescriptionFromHtml(html, normalizedName);
        if (snippet) {
          description = snippet;
          sourceUrl = docUrl;
          break;
        }
      } catch (error) {
        console.warn(`Official doc fetch failed: ${docUrl}`, error.message);
      }
    }
  }

  // 2. 公式で見つからない場合のみ DuckDuckGo にフォールバック
  if (!curated && !description) {
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

  // スクレイピング結果の品質検証（キュレーション済みは除外）
  if (!curated && description) {
    const commandWord = normalizedName.replace(/^\//, "").toLowerCase();
    const trimmed = description.trimEnd();
    const isInvalid =
      // 適切な長さ範囲外（20〜79文字が適切）
      description.length < 20 || description.length >= 80 ||
      // 口語・ブログ的表現を含む
      /ちょっと|微妙|回答が返ってきた|試してみた|使ってみた|やってみた|なんか|わりと|けっこう/.test(description) ||
      // 文末が句点・ピリオド・感嘆符で終わらない
      !/[。.!?]$/.test(trimmed) ||
      // コマンド名（スラッシュなし）が説明文に含まれる
      description.toLowerCase().includes(commandWord);
    if (isInvalid) description = "";
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
    const syncCode = await getSyncCode();
    if (syncCode) pushCommandToFirestore(syncCode, command, 0).catch((err) => console.error("[Firestore] POST /api/commands sync error:", err.message));
    res.status(201).json(command);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/commands/reorder", async (req, res, next) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: "ids must be an array" });

    const commands = await readDB();
    const commandMap = new Map(commands.map((c) => [c.id, c]));
    const reordered = ids.filter((id) => commandMap.has(id)).map((id) => commandMap.get(id));
    const reorderedIds = new Set(reordered.map((c) => c.id));
    const remaining = commands.filter((c) => !reorderedIds.has(c.id));

    const nextCommands = [...reordered, ...remaining];
    await writeDB(nextCommands);
    const syncCode = await getSyncCode();
    if (syncCode) nextCommands.forEach((c, i) => pushCommandToFirestore(syncCode, c, i).catch((err) => console.error("[Firestore] reorder sync error:", err.message)));
    res.json(nextCommands);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/commands/:id", async (req, res, next) => {
  try {
    const allowed = ["description", "tip", "usage", "params", "descriptionLanguage", "archived"];
    const updates = Object.fromEntries(
      allowed
        .filter((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key))
        .map((key) => {
          if (key === "archived") return [key, Boolean(req.body[key])];
          if (key === "descriptionLanguage") return [key, normalizeDescriptionLanguage(req.body[key])];
          return [key, String(req.body[key] ?? "").trim()];
        })
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
    const syncCode = await getSyncCode();
    if (syncCode) pushCommandToFirestore(syncCode, commands[index], index).catch((err) => console.error("[Firestore] PATCH sync error:", err.message));
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
    const syncCode = await getSyncCode();
    if (syncCode) deleteCommandFromFirestore(syncCode, req.params.id).catch((err) => console.error("[Firestore] DELETE sync error:", err.message));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/sync-config", async (req, res, next) => {
  try {
    const config = await readSyncConfig();
    res.json(config);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync-config", async (req, res, next) => {
  try {
    const { syncCode } = req.body || {};
    const config = await readSyncConfig();
    config.syncCode = typeof syncCode === "string" ? syncCode.trim() : "";
    await writeSyncConfig(config);
    if (config.syncCode) {
      initSync().catch((err) => console.error("sync after config change:", err));
    }
    res.json(config);
  } catch (error) {
    next(error);
  }
});

app.post("/api/translate", async (req, res, next) => {
  try {
    const { text, targetLang } = req.body || {};
    if (!text || typeof text !== "string") return res.status(400).json({ error: "text is required" });
    if (!targetLang || typeof targetLang !== "string") return res.status(400).json({ error: "targetLang is required" });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch("https://libretranslate.com/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, source: "auto", target: targetLang, format: "text" }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`LibreTranslate: HTTP ${response.status}`);
      const data = await response.json();
      res.json({ translated: data.translatedText });
    } finally {
      clearTimeout(timeout);
    }
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
  initSync().catch((err) => console.error("initSync:", err));
});
