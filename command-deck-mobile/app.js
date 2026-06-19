// Firebase は静的インポートせず動的インポートで遅延読み込み。
// これにより CDN 読み込み前にイベントリスナーが登録され、
// 設定パネルが開かない・コマンドが登録できないバグを修正。

// ---- Firebase 動的ロード ----
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBcWrn5zcF1kUaPqcvVnDeQ5MQGsasQJKI",
  authDomain: "command-vault-9f1ce.firebaseapp.com",
  projectId: "command-vault-9f1ce",
  storageBucket: "command-vault-9f1ce.firebasestorage.app",
  messagingSenderId: "886072410929",
  appId: "1:886072410929:web:f0aa9ac7f6482d462ca610"
};

let _fbCache = null;

async function getFb() {
  if (_fbCache) return _fbCache;
  const [{ initializeApp }, fs] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js'),
  ]);
  const app = initializeApp(FIREBASE_CONFIG);
  const db = fs.getFirestore(app);
  _fbCache = { db, fs };
  return _fbCache;
}

// ---- 状態 ----
let syncCode = '';
let pendingAddName = '';
let pendingDeleteId = null;
let currentLang = localStorage.getItem('lang') || 'ja';
const translateCache = {};

// ---- ローカルストレージ ----
const LOCAL_COMMANDS_KEY = 'localCommands';

function getLocalCommands() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_COMMANDS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveLocalCommands(commands) {
  localStorage.setItem(LOCAL_COMMANDS_KEY, JSON.stringify(commands));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---- DOM ----
const settingsBtn      = document.getElementById('settings-btn');
const settingsPanel    = document.getElementById('settings-panel');
const syncInput        = document.getElementById('sync-input');
const syncRandomBtn    = document.getElementById('sync-random-btn');
const syncSaveBtn      = document.getElementById('sync-save-btn');
const syncStatus       = document.getElementById('sync-status');
const translateStatus  = document.getElementById('translate-status');
const langSelect       = document.getElementById('language-select');
const addForm          = document.getElementById('add-form');
const cmdInput         = document.getElementById('cmd-input');
const errorEl          = document.getElementById('error');
const listToggleBar    = document.getElementById('list-toggle-bar');
const listArea         = document.getElementById('list-area');
const listCount        = document.getElementById('list-count');
const loading          = document.getElementById('loading');
const emptyMsg         = document.getElementById('empty-msg');
const commandList      = document.getElementById('command-list');
const modalDesc        = document.getElementById('modal-desc');
const modalOverlay     = document.getElementById('modal-overlay');
const modalCmdName     = document.getElementById('modal-cmd-name');
const newCmdDesc       = document.getElementById('new-cmd-desc');
const addError         = document.getElementById('add-error');
const modalSkipBtn     = document.getElementById('modal-skip-btn');
const modalSaveBtn     = document.getElementById('modal-save-btn');
const modalDelete      = document.getElementById('modal-delete');
const deleteOverlay    = document.getElementById('delete-overlay');
const deleteCmdLabel   = document.getElementById('delete-cmd-label');
const deleteCancelBtn  = document.getElementById('delete-cancel-btn');
const deleteConfirmBtn = document.getElementById('delete-confirm-btn');

// ---- エラー表示 ----
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
function clearError() {
  errorEl.hidden = true;
}

// ---- 件数更新 ----
function updateCount() {
  listCount.textContent = commandList.children.length;
}

// ---- 翻訳 ----
async function translateText(text, targetLang) {
  if (!text || targetLang === 'ja') return text;
  const key = targetLang + ':' + text;
  if (translateCache[key]) return translateCache[key];
  const res = await fetch('https://libretranslate.com/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: 'ja', target: targetLang, format: 'text' })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const translated = data.translatedText || text;
  translateCache[key] = translated;
  return translated;
}

async function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('lang', lang);

  const descs = commandList.querySelectorAll('.cmd-item__desc');
  if (descs.length === 0) return;

  if (lang === 'ja') {
    descs.forEach(el => {
      if (el.dataset.orig !== undefined) el.textContent = el.dataset.orig;
    });
    translateStatus.hidden = true;
    return;
  }

  translateStatus.textContent = '翻訳中...';
  translateStatus.className = 'sync-status';
  translateStatus.hidden = false;

  try {
    for (const el of descs) {
      const orig = el.dataset.orig ?? el.textContent;
      el.dataset.orig = orig;
      if (orig) {
        el.classList.add('is-translating');
        el.textContent = await translateText(orig, lang);
        el.classList.remove('is-translating');
      }
    }
    translateStatus.textContent = '翻訳完了 ✓';
    setTimeout(() => { translateStatus.hidden = true; }, 1500);
  } catch (e) {
    translateStatus.textContent = '翻訳に失敗しました: ' + e.message;
    translateStatus.className = 'sync-status is-error';
  }
}

// ---- コマンド一覧取得 ----
async function loadCommands() {
  loading.hidden = false;
  emptyMsg.hidden = true;
  commandList.innerHTML = '';
  updateCount();
  clearError();

  if (syncCode) {
    // Firestore から読み込み（動的インポート）
    try {
      const { db, fs } = await getFb();
      const { collection, getDocs, query, orderBy } = fs;
      const col = collection(db, 'sync_codes', syncCode, 'commands');
      const q = query(col, orderBy('createdAt', 'asc'));
      const snap = await getDocs(q);
      const docs = snap.docs.filter(d => !d.data().archived);
      loading.hidden = true;
      if (docs.length === 0) {
        emptyMsg.hidden = false;
      } else {
        docs.forEach(d => renderItem(d.id, d.data()));
        if (currentLang !== 'ja') applyLanguage(currentLang);
      }
    } catch (e) {
      loading.hidden = true;
      showError('読み込みに失敗しました: ' + e.message);
    }
  } else {
    // localStorage から読み込み
    const commands = getLocalCommands().filter(c => !c.archived);
    loading.hidden = true;
    if (commands.length === 0) {
      emptyMsg.hidden = false;
    } else {
      commands.forEach(c => renderItem(c.id, c));
      if (currentLang !== 'ja') applyLanguage(currentLang);
    }
  }
  updateCount();
}

// ---- コマンド行描画 ----
function renderItem(id, data) {
  const li = document.createElement('li');
  li.className = 'cmd-item';
  li.dataset.id = id;

  const row = document.createElement('div');
  row.className = 'cmd-item__row';

  const nameEl = document.createElement('span');
  nameEl.className = 'cmd-item__name';
  nameEl.textContent = data.name ?? '';

  const chevron = document.createElement('span');
  chevron.className = 'cmd-item__chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▼';

  row.appendChild(nameEl);
  row.appendChild(chevron);
  row.addEventListener('click', () => li.classList.toggle('is-open'));

  const detail = document.createElement('div');
  detail.className = 'cmd-item__detail';

  // 説明文（表示モード）
  const descEl = document.createElement('p');
  descEl.className = 'cmd-item__desc';
  const origDesc = data.description ?? '';
  descEl.textContent = origDesc;
  descEl.dataset.orig = origDesc;

  // テキストエリア（編集モード、初期非表示）
  const editTextarea = document.createElement('textarea');
  editTextarea.className = 'cmd-item__edit-textarea';
  editTextarea.hidden = true;
  editTextarea.rows = 3;
  editTextarea.placeholder = '説明を入力...';

  // ボタン行（表示モード）
  const btnRow = document.createElement('div');
  btnRow.className = 'cmd-item__btn-row';

  const editBtn = document.createElement('button');
  editBtn.className = 'cmd-item__edit-btn';
  editBtn.textContent = '編集';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'cmd-item__delete';
  deleteBtn.textContent = '削除';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDeleteModal(id, data.name);
  });

  btnRow.appendChild(editBtn);
  btnRow.appendChild(deleteBtn);

  // 編集アクション行（編集モード、初期非表示）
  const editActions = document.createElement('div');
  editActions.className = 'cmd-item__edit-actions';
  editActions.hidden = true;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'cmd-item__save-btn';
  saveBtn.textContent = '保存';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cmd-item__cancel-btn';
  cancelBtn.textContent = 'キャンセル';

  editActions.appendChild(saveBtn);
  editActions.appendChild(cancelBtn);

  // 編集モードに切り替え
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    editTextarea.value = descEl.dataset.orig ?? descEl.textContent;
    descEl.hidden = true;
    editTextarea.hidden = false;
    btnRow.hidden = true;
    editActions.hidden = false;
    editTextarea.focus();
  });

  // キャンセル → 表示モードに戻す
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    descEl.hidden = false;
    editTextarea.hidden = true;
    btnRow.hidden = false;
    editActions.hidden = true;
  });

  // 保存 → Firestore または localStorage を更新
  saveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const newDesc = editTextarea.value.trim();
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';

    try {
      if (syncCode) {
        const { db, fs } = await getFb();
        const { doc, updateDoc } = fs;
        await updateDoc(doc(db, 'sync_codes', syncCode, 'commands', id), {
          description: newDesc
        });
      } else {
        const commands = getLocalCommands();
        const idx = commands.findIndex(c => c.id === id);
        if (idx !== -1) {
          commands[idx].description = newDesc;
          saveLocalCommands(commands);
        }
      }
      descEl.textContent = newDesc;
      descEl.dataset.orig = newDesc;
      descEl.hidden = false;
      editTextarea.hidden = true;
      btnRow.hidden = false;
      editActions.hidden = true;
    } catch (err) {
      alert('保存に失敗しました: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  });

  detail.appendChild(descEl);
  detail.appendChild(editTextarea);
  detail.appendChild(btnRow);
  detail.appendChild(editActions);
  li.appendChild(row);
  li.appendChild(detail);
  commandList.appendChild(li);
}

// ---- 設定パネル ----
settingsBtn.addEventListener('click', () => {
  const willOpen = settingsPanel.hidden;
  settingsPanel.hidden = !willOpen;
  settingsBtn.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    syncInput.value = syncCode;
    syncStatus.hidden = true;
    syncInput.focus();
  }
});

// ランダム同期コード生成
function randomSyncCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return 'deck-' + suffix;
}

syncRandomBtn.addEventListener('click', () => {
  syncInput.value = randomSyncCode();
  syncInput.focus();
});

// 同期コード接続
function setSyncStatus(msg, isError = false) {
  syncStatus.textContent = msg;
  syncStatus.className = 'sync-status' + (isError ? ' is-error' : '');
  syncStatus.hidden = false;
}

async function saveSync() {
  const code = syncInput.value.trim();
  if (!code) { setSyncStatus('同期コードを入力してください', true); return; }

  syncSaveBtn.disabled = true;
  syncSaveBtn.textContent = '接続中...';
  setSyncStatus('接続中...');

  try {
    const { db, fs } = await getFb();
    const { collection, getDocs, query, orderBy } = fs;
    const col = collection(db, 'sync_codes', code, 'commands');
    const q = query(col, orderBy('createdAt', 'asc'));
    await getDocs(q);
    syncCode = code;
    localStorage.setItem('syncCode', code);
    setSyncStatus('接続しました ✓');
    setTimeout(() => {
      settingsPanel.hidden = true;
      settingsBtn.setAttribute('aria-expanded', 'false');
    }, 800);
    loadCommands();
  } catch (e) {
    setSyncStatus('接続に失敗しました: ' + e.message, true);
  } finally {
    syncSaveBtn.disabled = false;
    syncSaveBtn.textContent = '接続する';
  }
}

syncSaveBtn.addEventListener('click', saveSync);
syncInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveSync(); });

// 言語切り替え
langSelect.value = currentLang;
langSelect.addEventListener('change', () => applyLanguage(langSelect.value));

// ---- トグルバー ----
listToggleBar.addEventListener('click', () => {
  const isOpen = listToggleBar.getAttribute('aria-expanded') === 'true';
  listToggleBar.setAttribute('aria-expanded', String(!isOpen));
  listArea.style.display = isOpen ? 'none' : '';
});

listToggleBar.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); listToggleBar.click(); }
});

// ---- コマンド追加 ----
addForm.addEventListener('submit', e => {
  e.preventDefault();
  const name = cmdInput.value.trim();
  if (!name) return;
  clearError();
  pendingAddName = name;
  modalCmdName.textContent = name;
  newCmdDesc.value = '';
  addError.hidden = true;
  modalDesc.hidden = false;
  newCmdDesc.focus();
});

async function commitAdd(desc) {
  addError.hidden = true;
  modalSaveBtn.disabled = true;
  modalSkipBtn.disabled = true;
  modalSaveBtn.textContent = '保存中...';

  try {
    let newId;
    if (syncCode) {
      // Firestore に保存（動的インポート）
      const { db, fs } = await getFb();
      const { collection, addDoc, serverTimestamp } = fs;
      const col = collection(db, 'sync_codes', syncCode, 'commands');
      const docRef = await addDoc(col, {
        name: pendingAddName,
        description: desc,
        archived: false,
        createdAt: serverTimestamp()
      });
      newId = docRef.id;
    } else {
      // localStorage に保存
      const commands = getLocalCommands();
      newId = generateId();
      commands.push({
        id: newId,
        name: pendingAddName,
        description: desc,
        archived: false,
        createdAt: Date.now()
      });
      saveLocalCommands(commands);
    }

    cmdInput.value = '';
    modalDesc.hidden = true;
    emptyMsg.hidden = true;
    renderItem(newId, { name: pendingAddName, description: desc });
    if (currentLang !== 'ja' && desc) {
      const newDesc = commandList.lastElementChild?.querySelector('.cmd-item__desc');
      if (newDesc) {
        translateText(desc, currentLang).then(t => { newDesc.textContent = t; }).catch(() => {});
      }
    }
    updateCount();
    const newItem = commandList.lastElementChild;
    newItem?.classList.add('is-open');
    newItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    addError.textContent = '追加に失敗しました: ' + e.message;
    addError.hidden = false;
  } finally {
    modalSaveBtn.disabled = false;
    modalSkipBtn.disabled = false;
    modalSaveBtn.textContent = '保存';
  }
}

modalSaveBtn.addEventListener('click', () => commitAdd(newCmdDesc.value.trim()));
modalSkipBtn.addEventListener('click', () => commitAdd(''));
modalOverlay.addEventListener('click', () => { modalDesc.hidden = true; });

// ---- 削除 ----
function openDeleteModal(id, name) {
  pendingDeleteId = id;
  deleteCmdLabel.textContent = name ?? id;
  modalDelete.hidden = false;
}

function closeDeleteModal() {
  modalDelete.hidden = true;
  pendingDeleteId = null;
}

deleteOverlay.addEventListener('click', closeDeleteModal);
deleteCancelBtn.addEventListener('click', closeDeleteModal);

deleteConfirmBtn.addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  deleteConfirmBtn.disabled = true;
  deleteConfirmBtn.textContent = '削除中...';

  try {
    if (syncCode) {
      // Firestore から削除（動的インポート）
      const { db, fs } = await getFb();
      const { deleteDoc, doc } = fs;
      await deleteDoc(doc(db, 'sync_codes', syncCode, 'commands', pendingDeleteId));
    } else {
      // localStorage から削除
      const commands = getLocalCommands().filter(c => c.id !== pendingDeleteId);
      saveLocalCommands(commands);
    }
    commandList.querySelector(`[data-id="${pendingDeleteId}"]`)?.remove();
    closeDeleteModal();
    updateCount();
    if (commandList.children.length === 0) emptyMsg.hidden = false;
  } catch (e) {
    alert('削除に失敗しました: ' + e.message);
  } finally {
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = '削除する';
  }
});

// ---- 起動 ----
const saved = localStorage.getItem('syncCode');
if (saved) {
  syncCode = saved;
}
loadCommands();
