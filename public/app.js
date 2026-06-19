const state = {
  commands: [],
  expandedId: null
};

let listOpen = false;
let dragSourceId = null;
let archiveOpen = false;
const translationCache = {};

const els = {
  form: document.querySelector("#add-form"),
  commandInput: document.querySelector("#command-input"),
  languageSelect: document.querySelector("#language-select"),
  settingsBtn: document.querySelector("#settings-btn"),
  settingsPanel: document.querySelector("#settings-panel"),
  updateBadge: document.querySelector("#update-badge"),
  updateRow: document.querySelector("#update-row"),
  updateBtn: document.querySelector("#update-btn"),
  minimizeButton: document.querySelector("#minimize-btn"),
  closeButton: document.querySelector("#close-button"),
  error: document.querySelector("#error"),
  listArea: document.querySelector("#list-area"),
  listCount: document.querySelector("#list-count"),
  listToggleArrow: document.querySelector("#list-toggle-arrow"),
  listToggleBar: document.querySelector("#list-toggle-bar"),
  list: document.querySelector("#commands-list"),
  descModal: document.querySelector("#desc-modal"),
  descModalInput: document.querySelector("#desc-modal-input"),
  descModalSave: document.querySelector("#desc-modal-save"),
  descModalSkip: document.querySelector("#desc-modal-skip"),
  syncCodeInput: document.querySelector("#sync-code-input"),
  syncCodeSave: document.querySelector("#sync-code-save"),
  syncStatus: document.querySelector("#sync-status")
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
  return [...state.commands];
}

function truncateText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function updateListCount() {
  const activeCount = state.commands.filter(c => !c.archived).length;
  els.listCount.textContent = String(activeCount);
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

function descriptionRow(command) {
  const row = document.createElement("div");
  row.className = "detail-row description-row";

  const labelWrap = document.createElement("div");
  labelWrap.className = "detail-label-wrap";

  const labelEl = document.createElement("span");
  labelEl.className = "detail-label";
  labelEl.textContent = "Description";

  const copyDescBtn = document.createElement("button");
  copyDescBtn.className = "detail-copy-btn";
  copyDescBtn.type = "button";
  copyDescBtn.title = "説明文をコピー";
  copyDescBtn.textContent = "Copy";
  copyDescBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(command.description || "");
      copyDescBtn.textContent = "Copied";
      setTimeout(() => { copyDescBtn.textContent = "Copy"; }, 1200);
    } catch {
      showError("Clipboard copy failed.");
    }
  });

  labelWrap.append(labelEl, copyDescBtn);

  const valueEl = document.createElement("span");
  valueEl.className = "detail-value editable";
  valueEl.title = "Double-click to edit";
  valueEl.textContent = command.description || "-";

  let isEditing = false;

  function startEdit() {
    if (isEditing) return;
    isEditing = true;

    const textarea = document.createElement("textarea");
    textarea.className = "description-textarea";
    textarea.value = command.description || "";
    textarea.rows = 4;

    const editActions = document.createElement("div");
    editActions.className = "description-edit-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "description-save-btn";
    saveBtn.type = "button";
    saveBtn.textContent = "保存";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "description-cancel-btn";
    cancelBtn.type = "button";
    cancelBtn.textContent = "キャンセル";

    editActions.append(saveBtn, cancelBtn);
    valueEl.replaceWith(textarea);
    row.append(editActions);
    textarea.focus();
    textarea.select();

    async function save() {
      const nextValue = textarea.value.trim();
      if (nextValue === (command.description || "").trim()) {
        cancel();
        return;
      }
      saveBtn.disabled = true;
      try {
        const updated = await requestJSON(`/api/commands/${command.id}`, {
          method: "PATCH",
          body: JSON.stringify({ description: nextValue })
        });
        state.commands = state.commands.map(item => item.id === updated.id ? updated : item);
        render();
      } catch (error) {
        showError(error.message);
        saveBtn.disabled = false;
      }
    }

    function cancel() {
      isEditing = false;
      textarea.replaceWith(valueEl);
      editActions.remove();
    }

    saveBtn.addEventListener("click", save);
    cancelBtn.addEventListener("click", cancel);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); save(); }
    });
  }

  valueEl.addEventListener("dblclick", (e) => { e.stopPropagation(); startEdit(); });

  row.append(labelWrap, valueEl);
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

async function translateFields(command, lang) {
  if (!translationCache[lang]) translationCache[lang] = {};
  if (translationCache[lang][command.id]) return translationCache[lang][command.id];

  const fields = ["description", "tip", "usage"];
  const results = await Promise.all(
    fields.map(async (field) => {
      const text = command[field];
      if (!text) return [field, text];
      try {
        const data = await requestJSON("/api/translate", {
          method: "POST",
          body: JSON.stringify({ text, targetLang: lang })
        });
        return [field, data.translated];
      } catch {
        return [field, text];
      }
    })
  );

  const translated = Object.fromEntries(results);
  translationCache[lang][command.id] = translated;
  return translated;
}

async function applyTranslations(lang) {
  const needsTranslation = state.commands.filter((c) => c.descriptionLanguage !== lang);
  if (!needsTranslation.length) return;

  const archiveSection = document.querySelector("#archive-section");
  els.list.classList.add("is-translating");
  if (archiveSection) archiveSection.classList.add("is-translating");
  try {
    const translatedFields = await Promise.all(needsTranslation.map((c) => translateFields(c, lang)));
    state.commands = state.commands.map((c) => {
      const idx = needsTranslation.findIndex((n) => n.id === c.id);
      if (idx === -1) return c;
      return { ...c, ...translatedFields[idx], descriptionLanguage: lang };
    });
    render();
  } finally {
    els.list.classList.remove("is-translating");
    if (archiveSection) archiveSection.classList.remove("is-translating");
  }
}

async function reorderCommands(nextCommands) {
  state.commands = nextCommands;
  render();
  try {
    await requestJSON("/api/commands/reorder", {
      method: "PATCH",
      body: JSON.stringify({ ids: nextCommands.map((c) => c.id) })
    });
  } catch (error) {
    showError(error.message);
    await loadCommands();
  }
}

function commandItem(command) {
  const isExpanded = command.id === state.expandedId;
  const item = document.createElement("article");
  item.className = isExpanded ? "command-item is-expanded" : "command-item";
  item.draggable = true;

  item.addEventListener("dragstart", (event) => {
    dragSourceId = command.id;
    item.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });

  item.addEventListener("dragend", () => {
    dragSourceId = null;
    item.classList.remove("dragging");
    document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  });

  item.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragSourceId && dragSourceId !== command.id) {
      item.classList.add("drag-over");
    }
  });

  item.addEventListener("dragleave", () => {
    item.classList.remove("drag-over");
  });

  item.addEventListener("drop", (event) => {
    event.preventDefault();
    item.classList.remove("drag-over");
    if (!dragSourceId || dragSourceId === command.id) return;

    const sourceIndex = state.commands.findIndex((c) => c.id === dragSourceId);
    const targetIndex = state.commands.findIndex((c) => c.id === command.id);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const next = [...state.commands];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    reorderCommands(next);
  });

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

  const dragHandle = document.createElement("span");
  dragHandle.className = "drag-handle";
  dragHandle.textContent = "⠿";
  dragHandle.setAttribute("aria-hidden", "true");

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

  summary.append(dragHandle, name, copyButton, category, description, chevron);
  item.append(summary);

  if (isExpanded) {
    const details = document.createElement("div");
    details.className = "command-details";
    details.append(
      descriptionRow(command),
      detailRow("Language", command.descriptionLanguage === "en" ? "English" : "日本語"),
      detailRow("Usage", command.usage, { editable: true, command, field: "usage" }),
      detailRow("Params", command.params, { editable: true, command, field: "params" }),
      detailRow("Tip", command.tip, { editable: true, command, field: "tip" }),
      detailRow("Source", command.sourceUrl ? "Open source" : "-", { href: command.sourceUrl })
    );

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const archiveButton = document.createElement("button");
    archiveButton.className = "archive-button";
    archiveButton.type = "button";
    archiveButton.textContent = "アーカイブ";
    archiveButton.addEventListener("click", (event) => {
      event.stopPropagation();
      archiveCommand(command);
    });
    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-button";
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteCommand(command);
    });
    actions.append(archiveButton, deleteButton);
    details.append(actions);
    item.append(details);
  }

  return item;
}

function archivedCommandItem(command) {
  const lang = els.languageSelect.value;
  const cached = translationCache[lang]?.[command.id];

  const item = document.createElement("article");
  item.className = "command-item is-archived";

  const summary = document.createElement("div");
  summary.className = "command-summary archive-summary";

  const name = document.createElement("span");
  name.className = "command-name";
  name.textContent = command.name;

  const description = document.createElement("span");
  description.className = "command-description";
  description.textContent = truncateText(cached?.description || command.description);

  const restoreButton = document.createElement("button");
  restoreButton.className = "restore-button";
  restoreButton.type = "button";
  restoreButton.textContent = "復元";
  restoreButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    await restoreCommand(command);
  });

  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-button";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteCommand(command);
  });

  summary.append(name, description, restoreButton, deleteButton);
  item.append(summary);
  return item;
}

function render() {
  const active = state.commands.filter(c => !c.archived);
  const archived = state.commands.filter(c => c.archived);

  updateListCount();
  els.list.replaceChildren();

  if (!active.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No commands yet.";
    els.list.append(empty);
  } else {
    for (const command of active) {
      els.list.append(commandItem(command));
    }
  }

  let archiveSection = document.querySelector("#archive-section");
  if (!archiveSection) {
    archiveSection = document.createElement("div");
    archiveSection.id = "archive-section";
    els.listArea.append(archiveSection);
  }
  archiveSection.replaceChildren();

  if (archived.length) {
    const toggleBar = document.createElement("div");
    toggleBar.className = "archive-toggle-bar";
    toggleBar.role = "button";
    toggleBar.tabIndex = 0;
    toggleBar.textContent = `${archiveOpen ? "▲" : "▼"} アーカイブ (${archived.length})`;
    toggleBar.addEventListener("click", () => {
      archiveOpen = !archiveOpen;
      render();
    });
    toggleBar.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        archiveOpen = !archiveOpen;
        render();
      }
    });
    archiveSection.append(toggleBar);

    if (archiveOpen) {
      const archiveList = document.createElement("div");
      archiveList.className = "archive-list";
      for (const command of archived) {
        archiveList.append(archivedCommandItem(command));
      }
      archiveSection.append(archiveList);
    }
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
    if (!created.description) {
      showDescModal(created);
    }
  } catch (error) {
    showError(error.message);
  } finally {
    els.commandInput.disabled = false;
    els.commandInput.focus();
  }
}

function showDescModal(command) {
  els.descModalInput.value = "";
  els.descModal.hidden = false;
  els.descModalInput.focus();

  const ac = new AbortController();
  const { signal } = ac;

  async function save() {
    const value = els.descModalInput.value.trim();
    if (!value) return;
    els.descModalSave.disabled = true;
    try {
      const updated = await requestJSON(`/api/commands/${command.id}`, {
        method: "PATCH",
        body: JSON.stringify({ description: value })
      });
      state.commands = state.commands.map(item => item.id === updated.id ? updated : item);
      render();
      close();
    } catch (error) {
      showError(error.message);
      els.descModalSave.disabled = false;
    }
  }

  function close() {
    els.descModal.hidden = true;
    els.descModalSave.disabled = false;
    ac.abort();
  }

  els.descModalSave.addEventListener("click", save, { signal });
  els.descModalSkip.addEventListener("click", close, { signal });
  els.descModalInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && e.ctrlKey) save();
  }, { signal });
}

async function archiveCommand(command) {
  showError("");
  try {
    const updated = await requestJSON(`/api/commands/${command.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true })
    });
    state.commands = state.commands.map(item => item.id === updated.id ? updated : item);
    if (state.expandedId === command.id) state.expandedId = null;
    render();
  } catch (error) {
    showError(error.message);
  }
}

async function restoreCommand(command) {
  showError("");
  try {
    const updated = await requestJSON(`/api/commands/${command.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: false })
    });
    state.commands = state.commands.map(item => item.id === updated.id ? updated : item);
    render();
  } catch (error) {
    showError(error.message);
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

function showSyncStatus(message, isError = false) {
  if (!els.syncStatus) return;
  els.syncStatus.textContent = message;
  els.syncStatus.className = isError ? "sync-status sync-status--error" : "sync-status sync-status--ok";
  els.syncStatus.hidden = !message;
}

async function loadSyncConfig() {
  try {
    const config = await requestJSON("/api/sync-config");
    if (els.syncCodeInput) els.syncCodeInput.value = config.syncCode || "";
    if (config.syncCode) {
      showSyncStatus(`同期中: ${config.syncCode}`);
    }
  } catch {
    // sync config is optional — ignore errors
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
els.commandInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.form.requestSubmit();
  }
});
els.listToggleBar.addEventListener("click", toggleList);
els.listToggleBar.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleList();
  }
});
els.languageSelect.addEventListener("change", async () => {
  const lang = els.languageSelect.value;
  localStorage.setItem("commandVault.descriptionLanguage", lang);
  showError("");
  try {
    await loadCommands();
    await applyTranslations(lang);
  } catch (error) {
    showError(error.message);
  }
});
els.settingsBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  const isOpen = els.settingsPanel.classList.toggle("is-open");
  els.settingsBtn.setAttribute("aria-expanded", String(isOpen));
});

document.addEventListener("click", (event) => {
  if (
    els.settingsPanel.classList.contains("is-open") &&
    !els.settingsPanel.contains(event.target) &&
    event.target !== els.settingsBtn
  ) {
    els.settingsPanel.classList.remove("is-open");
    els.settingsBtn.setAttribute("aria-expanded", "false");
  }
});

els.minimizeButton.addEventListener("click", minimizeWindow);
els.closeButton.addEventListener("click", closeWindow);

window.commandVault?.onUpdateAvailable((version) => {
  els.updateBadge.textContent = `🔔 v${version} が利用可能`;
  els.updateBadge.hidden = false;
  els.updateBtn.textContent = `v${version} をダウンロード`;
  els.updateRow.hidden = false;
});

els.updateBtn?.addEventListener("click", () => {
  window.commandVault?.openExternal("https://github.com/kwonq10/command-vault/releases/latest");
});

els.syncCodeSave?.addEventListener("click", async () => {
  const syncCode = els.syncCodeInput?.value.trim() || "";
  els.syncCodeSave.disabled = true;
  try {
    await requestJSON("/api/sync-config", {
      method: "POST",
      body: JSON.stringify({ syncCode })
    });
    if (syncCode) {
      showSyncStatus(`同期中: ${syncCode}`);
      await loadCommands();
    } else {
      showSyncStatus("");
    }
  } catch (error) {
    showSyncStatus(error.message, true);
  } finally {
    els.syncCodeSave.disabled = false;
  }
});

loadCommands().catch((error) => showError(error.message));
loadSyncConfig().catch(() => {});
