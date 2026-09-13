/**
 * state.js — единое состояние приложения.
 *
 * Изменения (критические исправления):
 *   • _nodeIndex: Map<nodeId, node> — O(1) поиск вместо O(n) рекурсии
 *   • _rebuildIndex() — пересборка индекса при restore/смене темы
 *   • _indexNode/_deindexNode — инкрементальные обновления индекса
 *   • findNode теперь O(1)
 */

window.AppState = (() => {
  let _state = {
    currentTopicId: null,
    topics: new Map(),
    selectedNodeId: null,
    mode: 'tree',
    browser: { open: false, activeTab: 'claude' },
    lastClipboard: '',
    openNodes: new Set(),

    promptTemplates: [
      { id: 'study', label: '🎓 Учёба', text: 'Ты опытный педагог. Объясняй чётко, с примерами. Структурируй ответ: краткое определение → суть → пример → связь с другими темами.' },
      { id: 'dev', label: '💡 Разработка', text: 'Ты senior-разработчик. Объясняй концепцию, покажи практический пример кода, укажи типичные ошибки и best practices.' },
      { id: 'math', label: '📐 Математика', text: 'Ты преподаватель математики. Дай строгое определение, объясни интуицию, покажи доказательство или пример вычисления.' },
      { id: 'history', label: '🌍 История', text: 'Ты историк. Дай контекст эпохи, ключевые события, причины и следствия, связь с современностью.' },
    ],

    layout: {
      sidebarWidth: 240,
      browserWidth: 420,
      answerPanelWidth: 420,
    },

    autoStudy: { running: false, progress: 0, total: 0 },
  };

  const _listeners = new Map();
  let _restoring = false;

  // ─── O(1) Node Index ───────────────────────────────────────
  // Map<nodeId, node> для мгновенного поиска без рекурсии
  const _nodeIndex = new Map();

  function _indexNode(node) {
    _nodeIndex.set(node.id, node);
    if (node.children) node.children.forEach(_indexNode);
  }

  function _deindexNode(node) {
    _nodeIndex.delete(node.id);
    if (node.children) node.children.forEach(_deindexNode);
  }

  function _rebuildIndex() {
    _nodeIndex.clear();
    const topic = _state.topics.get(_state.currentTopicId);
    if (topic?.nodes) topic.nodes.forEach(_indexNode);
  }

  // ─── Core pub/sub ──────────────────────────────────────────

  function get(key) {
    return key ? _state[key] : _state;
  }

  function set(key, value) {
    _state[key] = value;
    _notify(key, value);
    // При смене темы — пересобираем индекс
    if (key === 'currentTopicId') _rebuildIndex();
    if (!_restoring && !_TRANSIENT_KEYS.has(key)) _scheduleSave();
  }

  function update(key, updater) {
    const newVal = updater(_state[key]);
    _state[key] = newVal;
    _notify(key, newVal);
    if (!_restoring && !_TRANSIENT_KEYS.has(key)) _scheduleSave();
  }

  function on(key, cb) {
    if (!_listeners.has(key)) _listeners.set(key, []);
    _listeners.get(key).push(cb);
    return () => off(key, cb);
  }

  function off(key, cb) {
    const arr = _listeners.get(key) || [];
    _listeners.set(key, arr.filter(fn => fn !== cb));
  }

  function _notify(key, value) {
    (_listeners.get(key) || []).forEach(fn => fn(value));
    (_listeners.get('*') || []).forEach(fn => fn(key, value));
  }

  const _TRANSIENT_KEYS = new Set(['selectedNodeId', 'mode', 'autoStudy', 'browser']);

  function _scheduleSave() {
    if (typeof Persist !== 'undefined') Persist.save();
  }

  // ─── Restore ──────────────────────────────────────────────

  function _restore(fields) {
    _restoring = true;
    Object.assign(_state, fields);
    _notify('topics', _state.topics);
    _notify('currentTopicId', _state.currentTopicId);
    _notify('layout', _state.layout);
    _restoring = false;
    // Пересобираем индекс после восстановления
    _rebuildIndex();
  }

  // ─── Topic helpers ─────────────────────────────────────────

  function createTopic(name, prompt) {
    const id = 'topic_' + Date.now();
    const topic = { id, name, prompt: prompt || '', createdAt: Date.now(), nodes: [] };
    _state.topics.set(id, topic);
    _notify('topics', _state.topics);
    _scheduleSave();
    return topic;
  }

  function deleteTopic(id) {
    // Если удаляем текущую тему — очищаем индекс
    if (_state.currentTopicId === id) _nodeIndex.clear();
    _state.topics.delete(id);
    if (_state.currentTopicId === id) {
      const remaining = [..._state.topics.keys()];
      _state.currentTopicId = remaining[0] || null;
      _notify('currentTopicId', _state.currentTopicId);
      _rebuildIndex();
    }
    _notify('topics', _state.topics);
    _scheduleSave();
  }

  function renameTopic(id, newName) {
    const t = _state.topics.get(id);
    if (t) { t.name = newName; _notify('topics', _state.topics); _scheduleSave(); }
  }

  function getTopic(id) { return _state.topics.get(id || _state.currentTopicId); }
  function getCurrentTopic() { return getTopic(_state.currentTopicId); }

  // ─── Node helpers ──────────────────────────────────────────

  function createNode(label, parentId = null) {
    return {
      id: 'node_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      label,
      status: 'open',
      answer: null,
      children: [],
      parentId,
      attachments: [],
    };
  }

  /**
   * findNode — O(1) через индекс.
   * nodes-аргумент сохранён для обратной совместимости, но игнорируется
   * когда ищем в текущей теме (что всегда так).
   */
  function findNode(nodeId, nodes = null) {
    if (!nodeId) return null;
    // Быстрый путь: O(1) через индекс текущей темы
    if (nodes === null) {
      const fromIndex = _nodeIndex.get(nodeId);
      if (fromIndex) return fromIndex;
    }
    // Fallback: рекурсивный поиск в произвольном поддереве (для совместимости)
    const list = nodes || (getCurrentTopic()?.nodes ?? []);
    for (const node of list) {
      if (node.id === nodeId) return node;
      const found = findNode(nodeId, node.children);
      if (found) return found;
    }
    return null;
  }

  /**
   * Зарегистрировать узел в индексе (вызывать после addNode).
   * Публичный — нужен render.js и autobreakdown.js при инлайн-добавлении.
   */
  function indexNode(node) { _indexNode(node); }

  /**
   * Удалить узел и его детей из индекса (вызывать после removeNode).
   */
  function deindexNode(node) { _deindexNode(node); }

  /**
   * Пересобрать индекс полностью (для случаев bulk-изменений).
   */
  function rebuildIndex() { _rebuildIndex(); }

  // ─── openNodes helpers ────────────────────────────────────

  function isNodeOpen(nodeId) { return _state.openNodes.has(nodeId); }

  function toggleNodeOpen(nodeId) {
    if (_state.openNodes.has(nodeId)) _state.openNodes.delete(nodeId);
    else _state.openNodes.add(nodeId);
    _scheduleSave();
  }

  function setNodeOpen(nodeId, open) {
    if (open) _state.openNodes.add(nodeId);
    else _state.openNodes.delete(nodeId);
    _scheduleSave();
  }

  return {
    get, set, update, on, off,
    _restore,
    createTopic, deleteTopic, renameTopic, getTopic, getCurrentTopic,
    createNode, findNode, indexNode, deindexNode, rebuildIndex,
    isNodeOpen, toggleNodeOpen, setNodeOpen,
  };
})();