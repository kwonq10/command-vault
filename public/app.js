const state = {
  commands: [],
  expandedId: null
};

let listOpen = false;

const els = {
  form: document.querySelector("#add-form"),
  commandInput: document.querySelector("#command-input"),
  languageSelect: document.querySelector("#language-select"),
  minimizeButton: document.querySelector("#minimize-btn"),
  closeButton: document.querySelector("#close-button"),
  error: document.querySelector("#error"),
  listArea: document.querySelector("#list-area"),
  listCount: document.querySelector("#list-count"),
  listToggleArrow: document.querySelector("#list-toggle-arrow"),
  listToggleBar: document.querySelector("#list-toggle-bar"),
  list: document.querySelector("#commands-list")
};

const savedLanguage = localStorage.getItem("commandVault.descriptionLanguage");
if (savedLanguage === "ja" || savedLanguage === "en") {
  els.languageSelect.value = savedLanguage;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return null;
  return response.json();
}

function sortedCommands() {
  return [...state.commands].sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
}

function truncateText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function updateListCount() {
  els.listCount.textContent = String(state.commands.length);
}

function toggleList() {
  listOpen = !listOpen;
  els.listArea.style.display = listOpen ? "block" : "none";
  els.listToggleArrow.textContent = listOpen ? "▲" : "▼";
  els.listToggleBar.setAttribute("aria-expanded", String(listOpen));

  const height = listOpen ? 420 : 160;
  if (window.commandVault?.resize) {
    window.commandVault.resize(height);
  } else {
    window.resizeTo(550, height);
  }
}

function detailRow(label, value, options = {}) {
  const row = document.createElement("div");
  row.className = "detail-row";

  const labelEl = document.createElement("span");
  labelEl.className = "detail-label";
  labelEl.textContent = label;

  const valueEl = document.createElement(options.href ? "a" : "span");
  valueEl.className = options.editable ? "detail-value editable" : "detail-value";
  valueEl.textContent = value || "-";

  if (options.href) {
    valueEl.href = options.href;
    valueEl.target = "_blank";
    valueEl.rel = "noreferrer";
  }

  if (options.editable) {
    makeEditable(valueEl, options.command, options.field);
  }

  row.append(labelEl, valueEl);
  return row;
}

function makeEditable(element, command, field) {
  element.title = "Double-click to edit";

  element.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    element.contentEditable = "true";
    element.dataset.original = element.textContent === "-" ? "" : element.textContent;
    element.textContent = element.dataset.original;
    element.focus();
  });

  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      element.blur();
    }
    if (event.key === "Escape") {
      element.textContent = element.dataset.original || "-";
      element.contentEditable = "false";
      element.blur();
    }
  });

  element.addEventListener("click", (event) => {
    if (element.contentEditable === "true") event.stopPropagation();
  });

  element.addEventListener("blur", async () => {
    if (element.contentEditable !== "true") return;
    element.contentEditable = "false";

    const nextValue = element.textContent.trim();
    const previousValue = element.dataset.original || "";
    if (nextValue === previousValue) {
      element.textContent = nextValue || "-";
      return;
    }

    try {
      const updated = await requestJSON(`/api/commands/${command.id}`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: nextValue })
      });
      state.commands = state.commands.map((item) => (item.id === updated.id ? updated : item));
      render();
    } catch (error) {
      element.textContent = previousValue || "-";
      showError(error.message);
    }
  });
}

function commandItem(command) {
  const isExpanded = command.id === state.expandedId;
  const item = document.createElement("article");
  item.className = isExpanded ? "command-item is-expanded" : "command-item";

  const summary = document.createElement("div");
  summary.className = "command-summary";
  summary.role = "button";
  summary.tabIndex = 0;
  summary.addEventListener("click", () => {
    state.expandedId = isExpanded ? null : command.id;
    render();
  });
  summary.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      state.expandedId = isExpanded ? null : command.id;
      render();
    }
  });

  const name = document.createElement("span");
  name.className = "command-name";
  name.textContent = command.name;

  const copyButton = document.createElement("button");
  copyButton.className = "copy-button";
  copyButton.type = "button";
  copyButton.textContent = "Copy";
  copyButton.title = `Copy ${command.name}`;
  copyButton.addEventListener("click", async (event) => {
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(command.name);
      copyButton.textContent = "Copied";
      copyButton.classList.add("is-copied");
      setTimeout(() => {
        copyButton.textContent = "Copy";
        copyButton.classList.remove("is-copied");
      }, 1200);
    } catch (error) {
      showError("Clipboard copy failed.");
    }
  });

  const category = document.createElement("span");
  category.className = "category";
  category.textContent = command.category || "other";

  const description = document.createElement("span");
  description.className = "command-description";
  description.textContent = truncateText(command.description);

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = isExpanded ? "▲" : "▼";

  summary.append(name, copyButton, category, description, chevron);
  item.append(summary);

  if (isExpanded) {
    const details = document.createElement("div");
    details.className = "command-details";
    details.append(
      detailRow("Description", command.description, { editable: true, command, field: "description" }),
      detailRow("Language", command.descriptionLanguage === "en" ? "English" : "日本語"),
      detailRow("Usage", command.usage, { editable: true, command, field: "usage" }),
      detailRow("Params", command.params, { editable: true, command, field: "params" }),
      detailRow("Tip", command.tip, { editable: true, command, field: "tip" }),
      detailRow("Source", command.sourceUrl ? "Open source" : "-", { href: command.sourceUrl })
    );

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-button";
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteCommand(command);
    });
    actions.append(deleteButton);
    details.append(actions);
    item.append(details);
  }

  return item;
}

function render() {
  const commands = sortedCommands();
  updateListCount();
  els.list.replaceChildren();

  if (!commands.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No commands yet.";
    els.list.append(empty);
    return;
  }

  for (const command of commands) {
    els.list.append(commandItem(command));
  }
}

async function loadCommands() {
  const language = els.languageSelect.value;
  state.commands = await requestJSON(`/api/commands?language=${encodeURIComponent(language)}`);
  render();
}

async function addCommand(event) {
  event.preventDefault();
  showError("");
  const command = els.commandInput.value.trim();
  if (!command) return;
  const language = els.languageSelect.value;
  localStorage.setItem("commandVault.descriptionLanguage", language);

  els.commandInput.disabled = true;
  try {
    const created = await requestJSON("/api/commands", {
      method: "POST",
      body: JSON.stringify({ command, language })
    });
    state.commands = [created, ...state.commands];
    state.expandedId = created.id;
    els.commandInput.value = "";
    render();
  } catch (error) {
    showError(error.message);
  } finally {
    els.commandInput.disabled = false;
    els.commandInput.focus();
  }
}

async function deleteCommand(command, allowRetry = true) {
  showError("");
  try {
    await requestJSON(`/api/commands/${command.id}`, { method: "DELETE" });
    state.commands = state.commands.filter((item) => item.id !== command.id);
    if (state.expandedId === command.id) state.expandedId = null;
    render();
  } catch (error) {
    if (error.status === 404 && allowRetry) {
      await loadCommands();
      const current = state.commands.find(
        (item) => item.name.toLowerCase() === command.name.toLowerCase()
      );
      if (current) {
        await deleteCommand(current, false);
      }
      return;
    }
    showError(error.message);
  }
}

function closeWindow() {
  if (window.commandVault?.close) {
    window.commandVault.close();
    return;
  }
  window.close();
}

function minimizeWindow() {
  window.electronAPI?.minimize();
}

els.form.addEventListener("submit", addCommand);
els.listToggleBar.addEventListener("click", toggleList);
els.listToggleBar.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleList();
  }
});
els.languageSelect.addEventListener("change", async () => {
  localStorage.setItem("commandVault.descriptionLanguage", els.languageSelect.value);
  showError("");
  try {
    await loadCommands();
  } catch (error) {
    showError(error.message);
  }
});
els.minimizeButton.addEventListener("click", minimizeWindow);
els.closeButton.addEventListener("click", closeWindow);

loadCommands().catch((error) => showError(error.message));
