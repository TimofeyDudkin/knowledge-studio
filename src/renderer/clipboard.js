/**
 * clipboard.js — умный перехват буфера обмена.
 *
 * Этап 3: вместо простого тоста — полноценный UI выбора:
 *
 *  1. Polling каждые 1 с (через IPC.readClipboard или main-процесс event)
 *  2. Если текст длиннее 40 символов и изменился — показываем тост
 *  3. В тосте:
 *     • Превью текста (первые ~120 символов)
 *     • Кнопка "Вставить" → вставляет в выбранный узел
 *     • Кнопка "Выбрать узел…" → открывает picker со списком всех вопросов
 *     • Dismiss
 *  4. Picker: поиск по узлам, клик → выбрать и вставить
 *  5. После вставки: автоматически отмечает узел как 'done',
 *     открывает AnswerPanel и показывает мини-уведомление
 *  6. Игнорирует текст, если он уже является ответом какого-то узла
 *     (защита от зацикливания при копировании из самого приложения)
 */

window.ClipboardModule = (() => {
  let _lastText      = '';
  let _pendingText   = '';
  let _pollingTimer  = null;
  let _hideTimer     = null;
  let _pickerOpen    = false;

  // ─── DOM ────────────────────────────────────────────────

  // Заменяем статичный тост на динамически управляемый
  let $toast = document.getElementById('toast-clipboard');

  function buildToastDOM() {
    // Перестраиваем тост с расширенным UI
    $toast.innerHTML = `
      <div class="toast-row">
        <div class="toast-icon-wrap">📋</div>
        <div class="toast-body">
          <p class="toast-title">Скопирован текст</p>
          <p class="toast-preview" id="toast-preview"></p>
        </div>
        <button class="toast-btn-no" id="toast-dismiss" title="Закрыть">✕</button>
      </div>
      <div class="toast-target-row">
        <span class="toast-target-label">→</span>
        <span class="toast-node-name" id="toast-node-name">нет выбранного вопроса</span>
        <button class="toast-btn-pick" id="toast-pick">Выбрать…</button>
      </div>
      <div class="toast-footer-row">
        <button class="toast-btn-yes" id="toast-confirm">Вставить как ответ</button>
        <span class="toast-hint">или выбери другой узел</span>
      </div>`;

    document.getElementById('toast-dismiss')?.addEventListener('click', dismiss);
    document.getElementById('toast-confirm')?.addEventListener('click', confirmInsert);
    document.getElementById('toast-pick')?.addEventListener('click', openPicker);
  }

  buildToastDOM();

  // ─── Picker DOM ──────────────────────────────────────────

  let $picker = null;

  function buildPickerDOM() {
    if ($picker) return;
    $picker = document.createElement('div');
    $picker.id = 'clipboard-picker';
    $picker.className = 'cb-picker hidden';
    $picker.innerHTML = `
      <div class="cb-picker-header">
        <span class="cb-picker-title">Выбери вопрос для ответа</span>
        <button class="icon-btn-sm" id="cb-picker-close">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 3l8 8M11 3l-8 8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="cb-picker-search-wrap">
        <input id="cb-picker-search" class="field-input" placeholder="Поиск вопросов…" autocomplete="off"/>
      </div>
      <div class="cb-picker-preview">
        <p class="cb-picker-preview-text" id="cb-preview-text"></p>
      </div>
      <div class="cb-picker-list" id="cb-picker-list"></div>`;

    document.body.appendChild($picker);

    document.getElementById('cb-picker-close')?.addEventListener('click', closePicker);
    document.getElementById('cb-picker-search')?.addEventListener('input', e => {
      renderPickerList(e.target.value.toLowerCase().trim());
    });

    $picker.addEventListener('click', e => {
      if (e.target === $picker) closePicker();
    });
  }

  // ─── Polling ─────────────────────────────────────────────

  function start() {
    if (_pollingTimer) return;
    // Подписаться на события из main (мгновеннее чем polling)
    IPC.onClipboardChange(onNewText);
    // Fallback polling на случай если main-события не доходят
    _pollingTimer = setInterval(pollFallback, 2000);
  }

  function stop() {
    clearInterval(_pollingTimer);
    _pollingTimer = null;
  }

  async function pollFallback() {
    try {
      const text = await IPC.readClipboard();
      if (text && text !== _lastText) onNewText(text);
    } catch { /* ignore */ }
  }

  function onNewText(text) {
    if (!text || text === _lastText) return;
    if (text.length < 40) return;           // слишком короткий — не ответ ИИ
    if (isOwnAnswer(text))  return;         // уже в базе — игнорируем
    if (isInlineEditing())  return;         // пользователь редактирует узел — не мешаем

    _lastText    = text;
    _pendingText = text;
    showToast(text);
  }

  // ─── Guards ──────────────────────────────────────────────

  function isOwnAnswer(text) {
    const topic = AppState.getCurrentTopic();
    if (!topic) return false;
    const flat = TreeHelpers.flatten(topic.nodes);
    return flat.some(n => n.answer && n.answer.trim() === text.trim());
  }

  function isInlineEditing() {
    return document.activeElement?.closest?.('.inline-edit-input, [contenteditable="true"]') !== null;
  }

  // ─── Toast ───────────────────────────────────────────────

  function showToast(text) {
    clearTimeout(_hideTimer);

    // Превью
    const preview = text.slice(0, 130).replace(/\n+/g, ' ') + (text.length > 130 ? '…' : '');
    const $preview = document.getElementById('toast-preview');
    if ($preview) $preview.textContent = preview;

    // Имя целевого узла
    updateToastTarget();

    $toast.classList.remove('hidden');
    $toast.classList.add('visible');

    _hideTimer = setTimeout(dismiss, 12000);
  }

  function updateToastTarget() {
    const nodeId = AppState.get('selectedNodeId');
    const $name  = document.getElementById('toast-node-name');
    if (!$name) return;

    if (nodeId) {
      const node = AppState.findNode(nodeId);
      if (node) {
        const label = node.label.length > 48 ? node.label.slice(0, 46) + '…' : node.label;
        $name.textContent = label;
        $name.className = 'toast-node-name has-node';
        document.getElementById('toast-confirm')?.removeAttribute('disabled');
        return;
      }
    }
    $name.textContent = 'нет выбранного вопроса';
    $name.className = 'toast-node-name no-node';
    document.getElementById('toast-confirm')?.setAttribute('disabled', 'true');
  }

  function dismiss() {
    clearTimeout(_hideTimer);
    $toast.classList.remove('visible');
    setTimeout(() => $toast.classList.add('hidden'), 200);
    _pendingText = '';
    closePicker();
  }

  function confirmInsert() {
    const nodeId = AppState.get('selectedNodeId');
    if (!nodeId || !_pendingText) { dismiss(); return; }
    insertAnswer(nodeId, _pendingText);
    dismiss();
  }

  function insertAnswer(nodeId, text) {
    AnswerPanel.setAnswer(nodeId, text);
    // Мини-уведомление об успехе
    showSuccessFlash(nodeId);
  }

  function showSuccessFlash(nodeId) {
    const node = AppState.findNode(nodeId);
    if (!node) return;
    const flash = document.createElement('div');
    flash.className = 'cb-flash';
    flash.textContent = `✓ Ответ сохранён: "${node.label.slice(0, 40)}"`;
    document.body.appendChild(flash);
    requestAnimationFrame(() => flash.classList.add('visible'));
    setTimeout(() => { flash.classList.remove('visible'); setTimeout(() => flash.remove(), 300); }, 2500);
  }

  // ─── Picker ──────────────────────────────────────────────

  function openPicker() {
    buildPickerDOM();
    _pickerOpen = true;

    // Превью текста
    const prev = document.getElementById('cb-preview-text');
    if (prev) prev.textContent = _pendingText.slice(0, 200) + (_pendingText.length > 200 ? '…' : '');

    renderPickerList('');
    $picker.classList.remove('hidden');
    setTimeout(() => document.getElementById('cb-picker-search')?.focus(), 50);
  }

  function closePicker() {
    _pickerOpen = false;
    $picker?.classList.add('hidden');
  }

  function renderPickerList(query) {
    const $list = document.getElementById('cb-picker-list');
    if (!$list) return;

    const topic = AppState.getCurrentTopic();
    if (!topic) { $list.innerHTML = '<p class="cb-picker-empty">Нет активной темы</p>'; return; }

    const flat = TreeHelpers.flatten(topic.nodes);
    const selectedId = AppState.get('selectedNodeId');

    const filtered = query
      ? flat.filter(n => n.label.toLowerCase().includes(query))
      : flat;

    if (filtered.length === 0) {
      $list.innerHTML = '<p class="cb-picker-empty">Нет совпадений</p>';
      return;
    }

    $list.innerHTML = filtered.map(n => {
      const indent   = n._depth * 16;
      const isCurrent = n.id === selectedId;
      const isDone   = n.status === 'done';
      const hasAnswer = !!n.answer;
      return `
        <div class="cb-picker-item ${isCurrent ? 'current' : ''} ${isDone ? 'done' : ''}"
             data-node-id="${n.id}"
             style="padding-left:${12 + indent}px">
          <span class="cb-picker-status ${n.status}"></span>
          <span class="cb-picker-label">${escHtml(n.label)}</span>
          ${hasAnswer ? '<span class="cb-picker-badge">есть ответ</span>' : ''}
          ${isCurrent ? '<span class="cb-picker-badge current">выбран</span>' : ''}
        </div>`;
    }).join('');

    $list.querySelectorAll('.cb-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        const nodeId = el.dataset.nodeId;
        AppState.set('selectedNodeId', nodeId);
        Render.selectNode(nodeId);
        updateToastTarget();
        closePicker();
        // Автовставка
        if (_pendingText) insertAnswer(nodeId, _pendingText);
        dismiss();
      });
    });
  }

  // ─── Utils ───────────────────────────────────────────────

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Обновить имя узла в тосте при смене выбранного узла
  AppState.on('selectedNodeId', () => {
    if (!$toast.classList.contains('hidden')) updateToastTarget();
  });

  // Старт
  start();

  return { start, stop, dismiss, openPicker };
})();
