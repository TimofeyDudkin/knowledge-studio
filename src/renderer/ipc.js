/**
 * ipc.js — слой хранилища и IPC.
 *
 * Persist-стратегия:
 *   • Electron: fs через preload (store:saveAll / store:loadAll)
 *   • Dev/Browser: localStorage
 *
 * Публичный API:
 *   Persist.save()       — дебаунс 600 мс, запись всего снимка
 *   Persist.load()       — загрузка снимка при старте
 *   Persist.forceSave()  — немедленная запись (beforeunload)
 */

window.IPC = (() => {
  const api = window.electronAPI || null;

  function isElectron() { return !!api; }

  async function openFile()      { return api ? api.openFile() : { canceled: true }; }
  async function readClipboard() {
    if (api) return api.readClipboard();
    return navigator.clipboard?.readText?.().catch(() => '') ?? '';
  }

  function onClipboardChange(cb) {
    if (api) api.on('clipboard:changed', cb);
  }

  function onUpdaterStatus(cb) {
    if (api) api.on('updater:status', cb);
  }

  async function checkForUpdates() { return api ? api.checkForUpdates() : { ok: false, reason: 'not-electron' }; }
  async function quitAndInstall()  { if (api) return api.quitAndInstall(); }

  // Сохранить байты на диск через диалог "Сохранить как" и открыть результат.
  // bytes: Uint8Array | ArrayBuffer. Возвращает { ok, filePath, canceled }.
  async function saveAndOpen({ defaultName, bytes, filters, open = true }) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (api?.saveFile) {
      const res = await api.saveFile({ defaultName, data, filters });
      if (res.canceled) return { ok: false, canceled: true };
      if (!res.filePath) return { ok: false, error: res.error };
      if (open) { try { await api.openPath(res.filePath); } catch (e) { console.warn('openPath', e); } }
      return { ok: true, filePath: res.filePath };
    }
    // Браузер/dev: скачиваем через blob
    const mime = (filters?.[0]?.extensions?.[0] === 'docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/octet-stream';
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = defaultName || 'export';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true, filePath: null };
  }

  return { isElectron, openFile, readClipboard, onClipboardChange, saveAndOpen, onUpdaterStatus, checkForUpdates, quitAndInstall };
})();

// ─────────────────────────────────────────────────────────────
window.Persist = (() => {
  const api = window.electronAPI || null;
  const LS_KEY = 'ks_snapshot';
  let _debounceTimer = null;

  // Сериализовать state в plain-объект (Map → array)
  function serialize() {
    const s = AppState.get();
    return {
      topics: [...s.topics.entries()].map(([id, t]) => ({ ...t, _id: id })),
      currentTopicId: s.currentTopicId,
      layout: s.layout,
      promptTemplates: s.promptTemplates,
      openNodes: s.openNodes ? [...s.openNodes] : [],
    };
  }

  // Восстановить state из plain-объекта
  function deserialize(snapshot) {
    if (!snapshot) return;
    // Темы
    const map = new Map();
    (snapshot.topics || []).forEach(t => {
      const { _id, ...rest } = t;
      map.set(_id || rest.id, rest);
    });
    AppState._restore({
      topics: map,
      currentTopicId: snapshot.currentTopicId || null,
      layout: snapshot.layout || AppState.get('layout'),
      promptTemplates: snapshot.promptTemplates || AppState.get('promptTemplates'),
      openNodes: new Set(snapshot.openNodes || []),
    });
  }

  async function load() {
    try {
      const raw = api
        ? await api.loadAll()
        : JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (raw) deserialize(raw);
    } catch (e) {
      console.warn('[Persist] load error', e);
    }
  }

  function save() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(forceSave, 600);
  }

  async function forceSave() {
    clearTimeout(_debounceTimer);
    try {
      const snapshot = serialize();
      if (api) {
        await api.saveAll(snapshot);
      } else {
        localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
      }
    } catch (e) {
      console.warn('[Persist] save error', e);
    }
  }

  // Сохранить перед закрытием
  window.addEventListener('beforeunload', forceSave);

  return { load, save, forceSave, serialize, deserialize };
})();