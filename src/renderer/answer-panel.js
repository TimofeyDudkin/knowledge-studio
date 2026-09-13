/**
 * answer-panel.js — полноценное окно ответа.
 *
 * Архитектура: одна панель, два режима — VIEW и EDIT.
 * Переключение без перерисовки дерева.
 *
 * VIEW-режим:
 *   • Заголовок вопроса (кликабельный для перехода в EDIT)
 *   • Breadcrumb: тема / ... / вопрос
 *   • Статус-пилюля с кликом для смены
 *   • Красивый рендер markdown: заголовки, таблицы, код с подсветкой, callout-блоки
 *   • Навигация ← → по соседним вопросам (prevNode / nextNode)
 *   • Кнопки: Редактировать, Копировать, Закрыть
 *   • Дочерние вопросы — список ссылок внизу
 *
 * EDIT-режим (встроен в панель, не модал):
 *   • Полноценный textarea с тулбаром форматирования
 *   • Live-preview при Shift+Tab
 *   • Автосохранение через 2 с после последнего изменения
 *   • Ctrl+S — сохранить немедленно
 *   • Esc — выйти из редактора (с подтверждением если есть изменения)
 *   • История последних 20 версий ответа
 */

window.AnswerPanel = (() => {

  // ─── DOM ─────────────────────────────────────────────────
  const $panel   = document.getElementById('answer-panel');
  const $header  = document.getElementById('answer-panel-header');
  const $title   = document.getElementById('answer-panel-title');
  const $content = document.getElementById('answer-content');

  // ─── State ───────────────────────────────────────────────
  let _currentNodeId = null;
  let _mode          = 'view';   // 'view' | 'edit'
  let _editDirty     = false;    // есть несохранённые изменения
  let _autoSaveTimer = null;

  // История версий ответов: Map<nodeId, [{text, ts}]> с LRU-вытеснением.
  // Ограничение: не более MAX_HISTORY_NODES уникальных узлов × MAX_VERSIONS_PER_NODE версий.
  // При превышении лимита удаляем наиболее давно использованный узел (LRU).
  const MAX_HISTORY_NODES    = 50;   // максимум узлов в истории одновременно
  const MAX_VERSIONS_PER_NODE = 20;  // максимум версий одного узла
  const _history    = new Map();     // nodeId → [{text, ts}]
  const _historyLRU = [];            // порядок использования nodeId (хвост = самый свежий)

  // ══════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════

  function open(nodeId) {
    const node = AppState.findNode(nodeId);
    if (!node) return;

    // Если в режиме редактирования другого узла — спросить
    if (_mode === 'edit' && _editDirty && _currentNodeId !== nodeId) {
      if (!confirm('Есть несохранённые изменения. Перейти без сохранения?')) return;
      _editDirty = false;
    }

    _currentNodeId = nodeId;
    const wasCollapsed = $panel.classList.contains('collapsed');
    $panel.classList.remove('collapsed');
    if (wasCollapsed) document.dispatchEvent(new CustomEvent('ap:open'));

    // Если переключаемся на тот же узел и уже в edit — не сбрасываем режим
    if (_mode === 'edit' && _currentNodeId === nodeId) {
      _renderEditMode(node);
    } else {
      _mode = 'view';
      _renderViewMode(node);
    }

    _updateHeaderActions();
  }

  function close() {
    if (_mode === 'edit' && _editDirty) {
      if (!confirm('Есть несохранённые изменения. Закрыть без сохранения?')) return;
    }
    _exitEdit(false);
    $panel.classList.add('collapsed');
    document.dispatchEvent(new CustomEvent('ap:close'));

    const prevId = _currentNodeId;
    _currentNodeId = null;
    AppState.set('selectedNodeId', null);

    if (prevId) {
      document.querySelectorAll(`[data-node-row="${prevId}"]`).forEach(el => el.classList.remove('selected'));
      document.querySelectorAll(`[data-node-id="${prevId}"]`).forEach(el => el.classList.remove('selected-node'));
    }
    Render.renderBreadcrumb();
  }

  function setAnswer(nodeId, markdownText) {
    const topic = AppState.getCurrentTopic();
    if (!topic) return;

    _pushHistory(nodeId, markdownText);
    TreeHelpers.updateNode(topic.nodes, nodeId, { answer: markdownText, status: 'done' });
    Persist.save();

    // Инвалидируем кэш crossref — ответ изменился
    CrossRef?.invalidate?.();

    _patchStatusDot(nodeId, 'done');

    if (_currentNodeId === nodeId) open(nodeId);
  }

  // ══════════════════════════════════════════════════════════
  //  VIEW MODE
  // ══════════════════════════════════════════════════════════

  function _renderViewMode(node) {
    const topic    = AppState.getCurrentTopic();
    const path     = TreeHelpers.getPath(topic?.nodes || [], node.id) || [];
    const siblings = _getSiblings(node.id);
    const prevNode = siblings[siblings.indexOf(node.id) - 1];
    const nextNode = siblings[siblings.indexOf(node.id) + 1];
    const stats    = TreeHelpers.getStats(topic?.nodes || []);

    $content.innerHTML = `
      <div class="ap-view">

        <!-- breadcrumb -->
        <div class="ap-breadcrumb">
          ${_buildBreadcrumbHtml(path, topic)}
        </div>

        <!-- question title -->
        <h1 class="ap-question-title">${escHtml(node.label)}</h1>

        <!-- meta row: status + children count + progress -->
        <div class="ap-meta-row">
          <button class="ap-status-pill status-${node.status}" data-cycle-status="${node.id}">
            ${_statusLabel(node.status)}
          </button>
          ${node.children?.length ? `<span class="ap-meta-chip">↳ ${node.children.length} подвопрос${_plural(node.children.length)}</span>` : ''}
          <span class="ap-meta-chip">Тема: ${stats.done}/${stats.total} готово</span>
          <div class="ap-progress-bar" title="${Math.round(stats.done/Math.max(stats.total,1)*100)}% выполнено">
            <div class="ap-progress-fill" style="width:${Math.round(stats.done/Math.max(stats.total,1)*100)}%"></div>
          </div>
        </div>

        <!-- answer body -->
        <div class="ap-answer-body" id="ap-answer-body">
          ${node.answer
            ? '<!-- answer will be injected by JS -->'
            : `<div class="ap-no-answer">
                <div class="ap-no-answer-icon">✦</div>
                <p>Ответа пока нет</p>
                <p class="ap-no-answer-hint">Скопируй ответ из ИИ — приложение предложит вставить его сюда, или нажми «Редактировать».</p>
                <button class="btn-primary ap-write-btn" id="ap-btn-write-first">Написать ответ</button>
              </div>`
          }
        </div>

        <!-- children list -->
        ${node.children?.length ? `
          <div class="ap-children-section">
            <div class="ap-children-title">Подвопросы</div>
            <div class="ap-children-list">
              ${node.children.map(ch => `
                <div class="ap-child-item" data-open-node="${ch.id}">
                  <span class="ap-child-status status-dot-${ch.status}"></span>
                  <span class="ap-child-label">${escHtml(ch.label)}</span>
                  ${ch.answer ? '<span class="ap-child-badge">✓</span>' : ''}
                </div>`).join('')}
            </div>
          </div>` : ''}

        <!-- navigation -->
        <div class="ap-nav-row">
          <button class="ap-nav-btn" id="ap-prev" ${!prevNode ? 'disabled' : ''} data-nav-node="${prevNode || ''}">
            <svg viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 1L1 5l5 4M1 5h12" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Предыдущий
          </button>
          <button class="ap-nav-btn" id="ap-next" ${!nextNode ? 'disabled' : ''} data-nav-node="${nextNode || ''}">
            Следующий
            <svg viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1l5 4-5 4M13 5H1" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>

      </div>`;

    // Биндинги VIEW
    document.getElementById('ap-btn-write-first')
      ?.addEventListener('click', () => _enterEdit());

    document.querySelector(`[data-cycle-status="${node.id}"]`)
      ?.addEventListener('click', () => _cycleStatus(node.id));

    document.querySelectorAll('[data-open-node]').forEach(el => {
      el.addEventListener('click', () => Render.selectNode(el.dataset.openNode));
    });

    document.getElementById('ap-prev')
      ?.addEventListener('click', e => { if (!e.currentTarget.disabled) Render.selectNode(e.currentTarget.dataset.navNode); });
    document.getElementById('ap-next')
      ?.addEventListener('click', e => { if (!e.currentTarget.disabled) Render.selectNode(e.currentTarget.dataset.navNode); });

    // Безопасный рендер ответа — src картинок назначается через DOM, а не через innerHTML
    const bodyEl = document.getElementById('ap-answer-body');
    if (bodyEl && node.answer) _renderIntoContainer(bodyEl, node.answer);

    // CrossRef
    if (bodyEl && node.answer) CrossRef?.highlight?.(bodyEl);

    // Text selection popup
    if (bodyEl && node.answer) _bindSelectionPopup(bodyEl, node.id);
  }

  // ══════════════════════════════════════════════════════════
  //  EDIT MODE
  // ══════════════════════════════════════════════════════════

  function _renderEditMode(node) {
    const history = (_history.get(node.id) || []).slice().reverse(); // свежие вверху

    $content.innerHTML = `
      <div class="ap-edit">

        <!-- edit header -->
        <div class="ap-edit-header">
          <div class="ap-edit-question">${escHtml(node.label)}</div>
          <div class="ap-edit-hint">Ctrl+S — сохранить · Esc — отмена · Shift+Tab — превью</div>
        </div>

        <!-- toolbar -->
        <div class="ap-fmt-toolbar" id="ap-fmt-toolbar">
          <button class="ap-fmt-btn" data-fmt="bold"      title="Жирный"><b>B</b></button>
          <button class="ap-fmt-btn" data-fmt="italic"    title="Курсив"><i>I</i></button>
          <button class="ap-fmt-btn" data-fmt="strike"    title="Зачёркнутый"><s>S</s></button>
          <div class="ap-fmt-sep"></div>
          <button class="ap-fmt-btn" data-fmt="h1"        title="H1">H1</button>
          <button class="ap-fmt-btn" data-fmt="h2"        title="H2">H2</button>
          <button class="ap-fmt-btn" data-fmt="h3"        title="H3">H3</button>
          <div class="ap-fmt-sep"></div>
          <button class="ap-fmt-btn" data-fmt="ul"        title="Маркированный список">• ul</button>
          <button class="ap-fmt-btn" data-fmt="ol"        title="Нумерованный список">1. ol</button>
          <button class="ap-fmt-btn" data-fmt="quote"     title="Цитата">❝</button>
          <div class="ap-fmt-sep"></div>
          <button class="ap-fmt-btn mono" data-fmt="code"      title="Inline-код">&lt;/&gt;</button>
          <button class="ap-fmt-btn mono" data-fmt="codeblock" title="Блок кода">&#96;&#96;&#96;</button>
          <button class="ap-fmt-btn" data-fmt="table"     title="Таблица 3×2">⊞</button>
          <button class="ap-fmt-btn" data-fmt="hr"        title="Разделитель">—</button>
          <div class="ap-fmt-sep"></div>
          <button class="ap-fmt-btn" data-fmt="link"      title="Ссылка">🔗</button>
          <div style="flex:1"></div>
          <button class="ap-fmt-btn ap-preview-toggle" id="ap-preview-toggle" title="Превью (Shift+Tab)">
            <svg viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 5c2-4 10-4 12 0s-10 4-12 0z"/><circle cx="7" cy="5" r="2"/></svg>
          </button>
        </div>

        <!-- split: editor + optional preview -->
        <div class="ap-editor-area" id="ap-editor-area">
          <textarea class="ap-textarea" id="ap-textarea"
            spellcheck="true"
            placeholder="Напиши ответ в Markdown…&#10;&#10;## Определение&#10;&#10;## Суть&#10;&#10;## Примеры"
          ></textarea>
          <div class="ap-live-preview hidden" id="ap-live-preview">
            <div class="ap-live-preview-content" id="ap-live-preview-content"></div>
          </div>
        </div>

        <!-- bottom bar -->
        <div class="ap-edit-footer">
          <div class="ap-edit-footer-left">
            <span class="ap-char-count" id="ap-char-count">${(node.answer||'').length} симв.</span>
            <span class="ap-autosave-status" id="ap-autosave-status"></span>
            ${history.length ? `
              <button class="ap-history-btn" id="ap-history-toggle">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 3v4l3 2" stroke-linecap="round"/><path d="M7 13A6 6 0 107 1a6 5.6 0 00-4.2 1.8" stroke-linecap="round"/><path d="M1 1v3h3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                История (${history.length})
              </button>` : ''}
          </div>
          <div class="ap-edit-footer-right">
            <button class="btn-secondary ap-cancel-btn" id="ap-edit-cancel">Отмена</button>
            <button class="btn-primary ap-save-btn"   id="ap-edit-save">Сохранить</button>
          </div>
        </div>

        <!-- history drawer (скрыт) -->
        ${history.length ? `
          <div class="ap-history-drawer hidden" id="ap-history-drawer">
            <div class="ap-history-header">История версий</div>
            ${history.map((h, i) => `
              <div class="ap-history-item" data-hist-idx="${i}">
                <span class="ap-history-time">${_formatTs(h.ts)}</span>
                <span class="ap-history-chars">${h.text.length} симв.</span>
                <button class="ap-history-restore" data-hist-idx="${i}">Восстановить</button>
              </div>`).join('')}
          </div>` : ''}

      </div>`;

    // Биндинги EDIT
    const ta = document.getElementById('ap-textarea');

    // Значение textarea назначаем через .value (не через innerHTML) —
    // иначе браузер парсит base64 как HTML и зависает
    if (ta) ta.value = _collapseImages(node.answer || '');

    // Форматирование
    document.getElementById('ap-fmt-toolbar')?.querySelectorAll('[data-fmt]').forEach(btn => {
      btn.addEventListener('click', e => { e.preventDefault(); _applyFmt(btn.dataset.fmt); });
    });

    // Счётчик + автосохранение
    ta?.addEventListener('input', () => {
      _editDirty = true;
      const len = ta.value.length;
      const $cc = document.getElementById('ap-char-count');
      if ($cc) $cc.textContent = len + ' симв.';
      _scheduleAutoSave(ta.value);
      // live preview update
      const prev = document.getElementById('ap-live-preview-content');
      if (prev && !document.getElementById('ap-live-preview')?.classList.contains('hidden')) {
        _renderIntoContainer(prev, _expandImages(ta.value));
      }
    });

    // Ctrl+S
    ta?.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); _saveAndStay(); }
      if (e.key === 'Escape') { e.preventDefault(); _enterView(); }
      if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); _toggleLivePreview(); }
      // Tab → indent
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
      }
    });

    // Toggle preview
    document.getElementById('ap-preview-toggle')
      ?.addEventListener('click', _toggleLivePreview);

    // Save / Cancel
    document.getElementById('ap-edit-save')
      ?.addEventListener('click', () => { _saveAndExit(); });
    document.getElementById('ap-edit-cancel')
      ?.addEventListener('click', () => _enterView());

    // History
    document.getElementById('ap-history-toggle')?.addEventListener('click', () => {
      document.getElementById('ap-history-drawer')?.classList.toggle('hidden');
    });
    document.querySelectorAll('[data-hist-idx]').forEach(btn => {
      if (btn.classList.contains('ap-history-restore')) {
        btn.addEventListener('click', () => {
          const idx  = +btn.dataset.histIdx;
          const hist = (_history.get(node.id) || []).slice().reverse()[idx];
          if (hist && ta) {
            ta.value  = hist.text;
            _editDirty = true;
            document.getElementById('ap-history-drawer')?.classList.add('hidden');
          }
        });
      }
    });

    ta?.focus();
    // Курсор в конец
    ta && (ta.selectionStart = ta.selectionEnd = ta.value.length);
  }

  // ── Base64 image collapse/expand для удобного редактирования ──
  // Заменяет длинные data:image/...;base64,... на короткие плейсхолдеры
  // вида ![alt](__img0__) чтобы textarea не замусоривалась тысячами символов.
  // Кеш персистентен — не сбрасывается при повторном открытии редактора.

  let _imgCache = {}; // плейсхолдер → оригинальный dataUrl
  let _imgCacheCounter = 0; // глобальный счётчик — ключи уникальны между сессиями

  function _collapseImages(md) {
    // НЕ сбрасываем _imgCache — он живёт всё время работы приложения.
    // Это гарантирует что плейсхолдеры из предыдущих сессий редактирования
    // всё ещё разворачиваются корректно.
    return md.replace(/!\[([^\]]*)\]\((data:image\/[^)]{20,})\)/g, (_, alt, url) => {
      // Проверяем — вдруг этот url уже есть в кеше (повторное открытие того же ответа)
      const existing = Object.keys(_imgCache).find(k => _imgCache[k] === url);
      if (existing) {
        const kb = Math.round(url.length * 0.75 / 1024);
        return `![${alt || 'img'}](${existing} «${kb} KB»)`;
      }
      const key = `__img${_imgCacheCounter++}__`;
      _imgCache[key] = url;
      const ext = url.match(/data:image\/(\w+)/)?.[1] || 'img';
      const kb  = Math.round(url.length * 0.75 / 1024);
      return `![${alt || ext}](${key} «${kb} KB»)`;
    });
  }

  function _expandImages(md) {
    return md.replace(/!\[([^\]]*)\]\((__img\d+__)[^)]*\)/g, (_, alt, key) => {
      const url = _imgCache[key];
      if (!url) return `![${alt}](${key})`;
      return `![${alt}](${url})`;
    });
  }

  // ── enter / exit helpers ──────────────────────────────────

  function _enterEdit() {
    _mode = 'edit';
    _editDirty = false;
    _updateHeaderActions();
    const node = AppState.findNode(_currentNodeId);
    if (node) _renderEditMode(node);
  }

  function _enterView() {
    if (_editDirty) {
      if (!confirm('Есть несохранённые изменения. Выйти без сохранения?')) return;
    }
    _exitEdit(false);
    _mode = 'view';
    _updateHeaderActions();
    const node = AppState.findNode(_currentNodeId);
    if (node) _renderViewMode(node);
  }

  function _exitEdit(save) {
    clearTimeout(_autoSaveTimer);
    _editDirty = false;
    if (save) {
      const ta = document.getElementById('ap-textarea');
      if (ta && _currentNodeId) setAnswer(_currentNodeId, _expandImages(ta.value.trim()));
    }
  }

  function _saveAndExit() {
    const ta = document.getElementById('ap-textarea');
    if (!ta || !_currentNodeId) return;
    _exitEdit(true);
    _mode = 'view';
    _updateHeaderActions();
    // open() вызовет _renderViewMode через setAnswer→open
  }

  function _saveAndStay() {
    const ta = document.getElementById('ap-textarea');
    if (!ta || !_currentNodeId) return;
    const text = _expandImages(ta.value.trim());
    _pushHistory(_currentNodeId, text);
    const topic = AppState.getCurrentTopic();
    TreeHelpers.updateNode(topic.nodes, _currentNodeId, { answer: text, status: 'done' });
    Persist.save();
    _patchStatusDot(_currentNodeId, 'done');
    _editDirty = false;
    const $st = document.getElementById('ap-autosave-status');
    if ($st) { $st.textContent = '✓ Сохранено'; setTimeout(() => { $st.textContent = ''; }, 2000); }
  }

  // ── autosave ──────────────────────────────────────────────

  function _scheduleAutoSave(text) {
    clearTimeout(_autoSaveTimer);
    const $st = document.getElementById('ap-autosave-status');
    if ($st) $st.textContent = '...';
    _autoSaveTimer = setTimeout(() => {
      if (!_editDirty || !_currentNodeId) return;
      const expanded = _expandImages(text);
      _pushHistory(_currentNodeId, expanded);
      const topic = AppState.getCurrentTopic();
      TreeHelpers.updateNode(topic.nodes, _currentNodeId, { answer: expanded, status: 'done' });
      Persist.save();
      _patchStatusDot(_currentNodeId, 'done');
      _editDirty = false; // автосохр снимает dirty
      if ($st) { $st.textContent = '✓ Автосохр.'; setTimeout(() => { if ($st) $st.textContent = ''; }, 2000); }
    }, 2000);
  }

  // ── live preview ──────────────────────────────────────────

  function _toggleLivePreview() {
    const preview = document.getElementById('ap-live-preview');
    const area    = document.getElementById('ap-editor-area');
    const btn     = document.getElementById('ap-preview-toggle');
    if (!preview) return;
    const showing = !preview.classList.contains('hidden');
    preview.classList.toggle('hidden', showing);
    area?.classList.toggle('split', !showing);
    btn?.classList.toggle('active', !showing);
    if (!showing) {
      const ta = document.getElementById('ap-textarea');
      const pc = document.getElementById('ap-live-preview-content');
      if (ta && pc) _renderIntoContainer(pc, _expandImages(ta.value));
    }
  }

  // ── header actions ────────────────────────────────────────

  function _updateHeaderActions() {
    const isEdit = _mode === 'edit';

    $header.innerHTML = `
      <div class="ap-header-left">
        <span id="answer-panel-title" class="ap-panel-title">
          ${isEdit ? '✏ Редактор' : 'Ответ'}
        </span>
      </div>
      <div class="ap-header-actions">
        ${!isEdit ? `
          <button class="icon-btn-sm ap-hdr-btn" id="ap-hdr-edit" title="Редактировать (E)">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2l2 2-7 7H3v-2l7-7z" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn-sm ap-hdr-btn" id="ap-hdr-copy" title="Копировать ответ">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1.5"/><path d="M2 10V2.5A1.5 1.5 0 013.5 1H10" stroke-linecap="round"/></svg>
          </button>` : ''}
        <button class="icon-btn-sm ap-hdr-btn" id="ap-hdr-close" title="Закрыть">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l8 8M11 3l-8 8" stroke-linecap="round"/></svg>
        </button>
      </div>`;

    document.getElementById('ap-hdr-edit')  ?.addEventListener('click', _enterEdit);
    document.getElementById('ap-hdr-copy')  ?.addEventListener('click', _copyAnswer);
    document.getElementById('ap-hdr-close') ?.addEventListener('click', close);
  }

  function _copyAnswer() {
    const node = AppState.findNode(_currentNodeId);
    if (!node?.answer) return;
    navigator.clipboard?.writeText(node.answer).then(() => {
      const btn = document.getElementById('ap-hdr-copy');
      if (btn) { btn.title = '✓ Скопировано'; setTimeout(() => { btn.title = 'Копировать ответ'; }, 1500); }
    });
  }

  // ── format toolbar ────────────────────────────────────────

  function _applyFmt(fmt) {
    const ta = document.getElementById('ap-textarea');
    if (!ta) return;
    const s   = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    const pre = ta.value.slice(0, s);
    const suf = ta.value.slice(e);

    const tableSnippet =
`| Столбец 1 | Столбец 2 | Столбец 3 |
|-----------|-----------|-----------|
| Ячейка    | Ячейка    | Ячейка    |
| Ячейка    | Ячейка    | Ячейка    |`;

    const map = {
      bold:      { wrap: ['**','**'],  ph: 'текст' },
      italic:    { wrap: ['*','*'],    ph: 'текст' },
      strike:    { wrap: ['~~','~~'],  ph: 'текст' },
      code:      { wrap: ['`','`'],    ph: 'код'   },
      h1:        { line: '# ',        ph: 'Заголовок 1' },
      h2:        { line: '## ',       ph: 'Заголовок 2' },
      h3:        { line: '### ',      ph: 'Заголовок 3' },
      ul:        { line: '- ',        ph: 'пункт' },
      ol:        { line: '1. ',       ph: 'пункт' },
      quote:     { line: '> ',        ph: 'цитата' },
      hr:        { insert: '\n---\n' },
      link:      { insert: `[${sel || 'текст'}](url)`, cursor: sel ? e + 6 : s + 7 },
      codeblock: { insert: `\n\`\`\`\n${sel || 'код'}\n\`\`\`\n` },
      table:     { insert: '\n' + tableSnippet + '\n' },
    };

    const rule = map[fmt];
    if (!rule) return;

    let insert, newCursor;

    if (rule.insert !== undefined) {
      insert    = rule.insert;
      newCursor = rule.cursor ?? (s + insert.length);
    } else if (rule.wrap) {
      const [open, close2] = rule.wrap;
      const text  = sel || rule.ph;
      insert    = open + text + close2;
      newCursor = sel ? s + insert.length : s + open.length + text.length;
    } else if (rule.line) {
      // Применить к каждой выделенной строке
      const lines = sel ? sel.split('\n').map(l => rule.line + (l || rule.ph)).join('\n')
                        : rule.line + rule.ph;
      insert    = lines;
      newCursor = s + insert.length;
    }

    ta.value = pre + insert + suf;
    ta.selectionStart = ta.selectionEnd = newCursor;
    ta.focus();
    _editDirty = true;
    const $cc = document.getElementById('ap-char-count');
    if ($cc) $cc.textContent = ta.value.length + ' симв.';
    const pc = document.getElementById('ap-live-preview-content');
    if (pc && !document.getElementById('ap-live-preview')?.classList.contains('hidden')) {
      _renderIntoContainer(pc, _expandImages(ta.value));
    }
  }

  // ══════════════════════════════════════════════════════════
  //  TEXT SELECTION POPUP
  // ══════════════════════════════════════════════════════════

  let _selPopup = null;
  let _mousedownAbort = null;

  function _removeSelectionPopup() {
    if (_selPopup) {
      _selPopup.remove();
      _selPopup = null;
    }
  }

  function _bindSelectionPopup(bodyEl, nodeId) {
    // Remove any previous listener by replacing node
    const newBody = bodyEl.cloneNode(true);
    bodyEl.parentNode.replaceChild(newBody, bodyEl);

    // Re-run CrossRef on new element
    if (typeof CrossRef !== 'undefined') CrossRef?.highlight?.(newBody);

    newBody.addEventListener('mouseup', e => {
      _removeSelectionPopup();

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (!text || text.length < 3) return;

      // Only trigger if selection is inside the answer body
      if (!newBody.contains(sel.anchorNode)) return;

      const range = sel.getRangeAt(0);
      const rect  = range.getBoundingClientRect();
      const panelRect = $panel.getBoundingClientRect();

      const popup = document.createElement('div');
      popup.className = 'sel-popup';
      popup.innerHTML = `
        <div class="sel-popup-label">«${text.length > 40 ? text.slice(0, 40) + '…' : text}»</div>
        <div class="sel-popup-actions">
          <button class="sel-popup-btn" id="sel-add-subq" title="Добавить как подвопрос к текущему узлу">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M8 3v10M3 8h10" stroke-linecap="round"/>
            </svg>
            Подвопрос
          </button>
          <button class="sel-popup-btn" id="sel-new-topic" title="Создать новую тему из выделения">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="2" width="12" height="12" rx="2"/>
              <path d="M5 8h6M8 5v6" stroke-linecap="round"/>
            </svg>
            Новая тема
          </button>
        </div>`;

      // Position popup above the selection, relative to the panel
      const top  = rect.top  - panelRect.top  + $panel.scrollTop  - 8;
      const left = rect.left - panelRect.left + (rect.width / 2);
      popup.style.cssText = `top:${top}px; left:${left}px;`;

      $panel.appendChild(popup);
      _selPopup = popup;

      // Adjust if popup goes off right edge
      requestAnimationFrame(() => {
        const pw = popup.offsetWidth;
        const ph = popup.offsetHeight;
        const panelW = panelRect.width;
        let l = parseFloat(popup.style.left) - pw / 2;
        if (l < 8) l = 8;
        if (l + pw > panelW - 8) l = panelW - pw - 8;
        popup.style.left = l + 'px';
        popup.style.top  = (parseFloat(popup.style.top) - ph - 4) + 'px';
      });

      // Add subquestion
      popup.querySelector('#sel-add-subq')?.addEventListener('click', () => {
        const label = text.length > 120 ? text.slice(0, 120) + '…' : text;
        const topic = AppState.getCurrentTopic();
        if (!topic) return;
        const node = AppState.createNode(label, nodeId);
        TreeHelpers.addNode(topic.nodes, nodeId, node);
        AppState.setNodeOpen(nodeId, true);
        Persist.save();
        Render.renderTree();
        Render.selectNode(node.id);
        sel.removeAllRanges();
        _removeSelectionPopup();
      });

      // New topic
      popup.querySelector('#sel-new-topic')?.addEventListener('click', () => {
        const name = text.length > 60 ? text.slice(0, 60) + '…' : text;
        const topic = AppState.createTopic(name);
        Render.renderTopicsList();
        Render.selectTopic(topic.id);
        sel.removeAllRanges();
        _removeSelectionPopup();
      });
    });

    if (_mousedownAbort) _mousedownAbort.abort();
    _mousedownAbort = new AbortController();
    document.addEventListener('mousedown', e => {
      if (_selPopup && !_selPopup.contains(e.target)) {
        _removeSelectionPopup();
      }
    }, { signal: _mousedownAbort.signal });
  }

  // ══════════════════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════════════════

  function _getSiblings(nodeId) {
    const topic = AppState.getCurrentTopic();
    if (!topic) return [];
    const parentId = TreeHelpers.findParentId(topic.nodes, nodeId);
    let siblings;
    if (parentId == null) {
      siblings = topic.nodes;
    } else {
      const parent = AppState.findNode(parentId);
      siblings = parent?.children || [];
    }
    return siblings.map(n => n.id);
  }

  function _buildBreadcrumbHtml(path, topic) {
    const parts = [
      `<span class="ap-bc-topic">${escHtml(topic?.name || '')}</span>`,
      ...path.slice(0, -1).map(n =>
        `<span class="ap-bc-node" data-open-node="${n.id}">${escHtml(n.label)}</span>`),
    ];
    return parts.join('<span class="ap-bc-sep"> › </span>');
  }

  function _statusLabel(s) {
    return { open: '○ Открыт', active: '◐ Изучается', done: '● Готово' }[s] || s;
  }

  function _plural(n) {
    if (n === 1) return '';
    if (n >= 2 && n <= 4) return 'а';
    return 'ов';
  }

  function _cycleStatus(nodeId) {
    const node = AppState.findNode(nodeId);
    if (!node) return;
    const order = ['open', 'active', 'done'];
    const next  = order[(order.indexOf(node.status) + 1) % order.length];
    const topic = AppState.getCurrentTopic();
    TreeHelpers.updateNode(topic.nodes, nodeId, { status: next });
    Persist.save();
    _patchStatusDot(nodeId, next);
    // Обновить пилюлю без ре-рендера
    const pill = document.querySelector(`.ap-status-pill[data-cycle-status="${nodeId}"]`);
    if (pill) { pill.className = `ap-status-pill status-${next}`; pill.textContent = _statusLabel(next); }
  }

  function _patchStatusDot(nodeId, status) {
    const el = document.querySelector(`[data-status="${nodeId}"]`);
    if (el) { el.className = `tree-node-status ${status}`; }
  }

  function _pushHistory(nodeId, text) {
    if (!text) return;

    // Обновить LRU-порядок
    const lruIdx = _historyLRU.indexOf(nodeId);
    if (lruIdx >= 0) _historyLRU.splice(lruIdx, 1);
    _historyLRU.push(nodeId);  // в хвост = самый свежий

    // Если новый узел и лимит узлов превышен — удаляем самый старый
    if (!_history.has(nodeId) && _historyLRU.length > MAX_HISTORY_NODES) {
      const oldest = _historyLRU.shift();
      _history.delete(oldest);
    }

    // Добавляем версию
    if (!_history.has(nodeId)) _history.set(nodeId, []);
    const versions = _history.get(nodeId);
    const last = versions.at(-1);
    if (last?.text === text) return; // нет изменений
    versions.push({ text, ts: Date.now() });
    if (versions.length > MAX_VERSIONS_PER_NODE) versions.shift();
  }

  function _formatTs(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ══════════════════════════════════════════════════════════
  //  MARKDOWN RENDERER
  // ══════════════════════════════════════════════════════════

  // ── Вспомогательные функции рендера ─────────────────────────

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _mathRender(tex, display) {
    const t = tex.replace(/\\\\/g, '\\');
    if (typeof window.katex !== 'undefined') {
      try {
        return window.katex.renderToString(t, {
          displayMode: display, throwOnError: false, output: 'html', trust: true, strict: false,
        });
      } catch(e) { return escHtml(t); }
    }
    const cls = display ? 'md-math-block md-math-pending' : 'md-math-inline md-math-pending';
    return `<span class="${cls}" data-tex="${escHtml(t)}" data-display="${display?'1':'0'}">${escHtml(t)}</span>`;
  }

  function _inlineRender(s) {
    if (!s) return '';
    let r = s;
    r = r.replace(/\\\((.+?)\\\)/g, (_, tex) =>
      `<span class="md-math-inline">${_mathRender(tex.trim(), false)}</span>`
    );
    r = r.replace(/(?<![\\$])\$([^$\n]{1,200}?)\$/g, (_, tex) => {
      if (/^\d+$/.test(tex.trim())) return `$${tex}$`;
      return `<span class="md-math-inline">${_mathRender(tex.trim(), false)}</span>`;
    });
    r = r.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    r = r.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/\*(.+?)\*/g,     '<em>$1</em>');
    r = r.replace(/~~(.+?)~~/g,     '<del>$1</del>');
    r = r.replace(/__(.+?)__/g,     '<strong>$1</strong>');
    r = r.replace(/_([^_\n]+?)_/g,  '<em>$1</em>');
    r = r.replace(/`([^`\n]+)`/g, (_, c) => `<code class="md-inline-code">${escHtml(c)}</code>`);
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>');
    return r;
  }

  function renderMarkdown(md) {
    if (!md) return '';
    if (typeof window._renderMarkdownPatched === 'function') {
      return window._renderMarkdownPatched(md);
    }

    let html = md;
    const blocks = [];
    const protect = (c) => { const i = blocks.length; blocks.push(c); return `\x00BLK${i}\x00`; };

    // 1. Блочные формулы $$...$$ и \[...\]
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      const t = tex.trim().replace(/\\\\/g, '\\');
      return protect(`<div class="md-math-block" data-tex="${escHtml(t)}">${_mathRender(t, true)}</div>`);
    });
    html = html.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {
      const t = tex.trim().replace(/\\\\/g, '\\');
      return protect(`<div class="md-math-block" data-tex="${escHtml(t)}">${_mathRender(t, true)}</div>`);
    });

    // 2. Блоки кода
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const label = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '<span class="code-lang">text</span>';
      const copy  = `<button class="md-copy-code" onclick="(function(b){navigator.clipboard?.writeText(b.closest('.md-code-block').querySelector('code').textContent).then(()=>{b.textContent='✓';setTimeout(()=>b.textContent='копировать',1500)})})(this)">копировать</button>`;
      return protect(`<div class="md-code-block"><div class="md-code-header">${label}${copy}</div><pre><code class="lang-${lang||'text'}">${escHtml(code.trim())}</code></pre></div>`);
    });

    // 3. Callout-блоки
    html = html.replace(/^>\s*\[!(NOTE|WARNING|TIP|INFO|DANGER)\]\s*\n((?:>.*\n?)*)/gmi, (_, type, body) => {
      const icons = { NOTE:'💡', WARNING:'⚠️', TIP:'✨', INFO:'ℹ️', DANGER:'🚨' };
      const cleaned = body.replace(/^>\s?/gm, '').trim();
      const calloutInner = renderMarkdown(cleaned);
      const calloutHtml = typeof calloutInner === 'string' ? calloutInner : (calloutInner.html || '');
      return protect(`<div class="md-callout callout-${type.toLowerCase()}"><span class="callout-icon">${icons[type]||'📌'}</span><div class="callout-body">${calloutHtml}</div></div>`);
    });

    // 4. Таблицы (с формулами и разметкой в ячейках)
    html = html.replace(/((?:[ \t]*\|[^\n]+\n?){2,})/g, (match) => {
      const rows = match.trim().split('\n').filter(r => r.trim());
      if (rows.length < 2) return match;
      const sepIdx = rows.findIndex(r => /^\|?[\s\-:|]+\|/.test(r));
      if (sepIdx < 1) return match;
      const parseRow = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const aligns = parseRow(rows[sepIdx]).map(c => {
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
      });
      const thead = rows.slice(0, sepIdx).map(r =>
        `<tr>${parseRow(r).map((c,i) => `<th class="md-table-th" style="text-align:${aligns[i]||'left'}">${_inlineRender(c)}</th>`).join('')}</tr>`
      ).join('');
      const tbody = rows.slice(sepIdx + 1).filter(r => r.trim() && r.includes('|')).map(r =>
        `<tr>${parseRow(r).map((c,i) => `<td class="md-table-td" style="text-align:${aligns[i]||'left'}">${_inlineRender(c)}</td>`).join('')}</tr>`
      ).join('');
      return protect(`<div class="md-table-wrap"><table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`);
    });

    // 5. Заголовки
    for (let n = 6; n >= 1; n--) {
      html = html.replace(new RegExp(`^#{${n}}\\s+(.+)$`, 'gm'), (_, t) => `<h${n} class="md-h${n}">${_inlineRender(t)}</h${n}>`);
    }

    // 6. HR
    html = html.replace(/^(---|\*\*\*|___)\s*$/gm, '<hr class="md-hr">');

    // 7. Цитата
    html = html.replace(/^>\s+(.+)$/gm, (_, t) => `<blockquote class="md-quote">${_inlineRender(t)}</blockquote>`);

    // 8. Списки
    html = _processLists(html);

    // 9. Изображения — base64 data-URL НЕ вставляем в HTML-атрибут (браузер зависает при парсинге).
    // Вместо этого кладём data-url в безопасный JS-массив, а в src пишем placeholder-id.
    const _imgSrcs = [];
    html = html.replace(/!\[([^\]]*)\]\((data:[^)]{20,})\)/g, (_, alt, src) => {
      const idx = _imgSrcs.length;
      _imgSrcs.push(src);
      return `<img class="md-img" data-src-idx="${idx}" alt="${alt}" loading="lazy">`;
    });
    // обычные URL (не base64) — вставляем как раньше
    html = html.replace(/!\[([^\]]*)\]\((?!data:)([^)]+)\)/g, '<img class="md-img" src="$2" alt="$1" loading="lazy">');

    // 10. Параграфы
    const tagRx = /^<(h[1-6]|ul|ol|pre|div|blockquote|table|hr|img)/;
    html = html.split(/\n{2,}/).map(block => {
      block = block.trim();
      if (!block) return '';
      if (tagRx.test(block) || /^\x00BLK/.test(block)) return block;
      return `<p class="md-p">${_inlineRender(block.replace(/\n/g, '<br>'))}</p>`;
    }).join('\n');

    // 11. Восстанавливаем блоки
    html = html.replace(/\x00BLK(\d+)\x00/g, (_, i) => blocks[+i] || '');
    // Возвращаем вместе с массивом src для base64-картинок
    return { html, imgSrcs: _imgSrcs };
  }

  // Безопасный рендер в контейнер: HTML без base64 в атрибутах, src назначается через DOM
  function _renderIntoContainer(container, md) {
    const result = renderMarkdown(md);
    // renderMarkdown может вернуть строку (из патча render-markdown.js) или объект
    if (typeof result === 'string') {
      container.innerHTML = result;
    } else {
      container.innerHTML = result.html;
      if (result.imgSrcs && result.imgSrcs.length) {
        container.querySelectorAll('img[data-src-idx]').forEach(img => {
          const idx = parseInt(img.dataset.srcIdx, 10);
          if (result.imgSrcs[idx]) {
            img.src = result.imgSrcs[idx];
            img.removeAttribute('data-src-idx');
          }
        });
      }
    }
  }

  function _processLists(html) {
    const lines = html.split('\n'), result = [];
    let inUl = false, inOl = false;
    for (const line of lines) {
      const ulM = line.match(/^(\s*)[-*•]\s+(.+)$/);
      const olM = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
      if (ulM) {
        if (!inUl) { result.push('<ul class="md-ul">'); inUl = true; }
        result.push(`<li class="md-li">${_inlineRender(ulM[2])}</li>`);
      } else if (olM) {
        if (!inOl) { result.push('<ol class="md-ol">'); inOl = true; }
        result.push(`<li class="md-li">${_inlineRender(olM[2])}</li>`);
      } else {
        if (inUl) { result.push('</ul>'); inUl = false; }
        if (inOl) { result.push('</ol>'); inOl = false; }
        result.push(line);
      }
    }
    if (inUl) result.push('</ul>');
    if (inOl) result.push('</ol>');
    return result.join('\n');
  }

  function _matchTable() { /* legacy */ }

  // ══════════════════════════════════════════════════════════
  //  KEYBOARD (глобальный)
  // ══════════════════════════════════════════════════════════

  document.addEventListener('keydown', e => {
    if ($panel.classList.contains('collapsed')) return;
    // E — войти в редактор из view
    if (e.key === 'e' && !e.ctrlKey && !e.metaKey && _mode === 'view' &&
        document.activeElement === document.body) {
      e.preventDefault(); _enterEdit();
    }
  });

  // Инициализировать заголовок панели
  _updateHeaderActions();

  // ══════════════════════════════════════════════════════════
  //  EXPORTS
  // ══════════════════════════════════════════════════════════

  return {
    open, close, setAnswer, renderMarkdown,
    // Публичные хелперы для image-drop.js
    cacheImage: (dataUrl) => {
      // Проверяем — вдруг уже закешировано
      const existing = Object.keys(_imgCache).find(k => _imgCache[k] === dataUrl);
      if (existing) return existing;
      const key = `__img${_imgCacheCounter++}__`;
      _imgCache[key] = dataUrl;
      return key;
    },
    _expandImages,
    _renderIntoContainer,
  };
})();