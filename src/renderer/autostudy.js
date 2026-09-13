/**
 * autostudy.js — Авторежим изучения Knowledge Studio
 *
 * Что делает:
 *  • Обходит узлы дерева в заданном порядке (По уровням / В глубину / Случайный)
 *  • Показывает прогресс-бар и счётчик в шапке
 *  • Открывает узлы по одному через AnswerPanel.open()
 *  • Ждёт, когда пользователь пометит узел — и переходит к следующему
 *  • Учитывает длину сессии (study_session): после N узлов делает паузу
 *  • Автопереход (study_autonext): переходит к следующему сразу после смены статуса
 *  • Кнопки: ▶ Старт / ⏸ Пауза / ⏹ Стоп прямо в шапке
 *
 * Подключение:
 *  1. Скопировать файл в renderer/autostudy.js
 *  2. В index.html добавить перед </body>:
 *       <script src="renderer/autostudy.js"></script>
 *     (после answer-panel.js, settings.js, index.js)
 *  3. В index.js заменить строку:
 *       document.getElementById('btn-auto-study')?.addEventListener('click', () => alert('Авторежим — в разработке'));
 *     на:
 *       document.getElementById('btn-auto-study')?.addEventListener('click', () => AutoStudy.toggle());
 */

window.AutoStudy = (() => {
  'use strict';

  // ─── Состояние сессии ────────────────────────────────────────
  let _session = {
    running:   false,
    paused:    false,
    queue:     [],       // [nodeId, ...]
    index:     0,        // текущая позиция в очереди
    doneInSession: 0,    // сколько узлов отмечено за эту сессию
    sessionLimit: 10,    // из Settings.get('study_session')
    unsubscribe: null,   // отписка от AppState.on('selectedNodeId')
  };

  // ─── UI-элементы (создаются при первом старте) ───────────────
  let _bar = null;

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════

  /** Переключатель: если не запущен — старт, если запущен — пауза/возобновление */
  function toggle() {
    if (!_session.running) {
      start();
    } else if (_session.paused) {
      resume();
    } else {
      pause();
    }
  }

  function start() {
    const topic = AppState.getCurrentTopic();
    if (!topic) {
      _notify('Сначала выбери тему в левой панели', 'warn');
      return;
    }

    const order = _getSetting('study_order', 'По уровням');
    const limit = _getSetting('study_session', 10);

    const queue = _buildQueue(topic.nodes, order);
    if (!queue.length) {
      _notify('Все узлы уже изучены! 🎉', 'success');
      return;
    }

    _session = {
      running:        true,
      paused:         false,
      queue,
      index:          0,
      doneInSession:  0,
      sessionLimit:   limit,
      unsubscribe:    null,
    };

    AppState.update('autoStudy', () => ({
      running:  true,
      progress: 0,
      total:    queue.length,
    }));

    _renderBar();
    _subscribeToStatusChanges();
    _openCurrent();
  }

  function pause() {
    if (!_session.running || _session.paused) return;
    _session.paused = true;
    _updateBar();
    _notify('Пауза. Нажми кнопку снова чтобы продолжить.', 'info');
  }

  function resume() {
    if (!_session.running || !_session.paused) return;
    _session.paused = false;
    _updateBar();
    _openCurrent();
  }

  function stop() {
    _cleanup();
    _notify(`Сессия завершена. Изучено узлов: ${_session.doneInSession}`, 'info');
  }

  function isRunning() { return _session.running; }

  // ═══════════════════════════════════════════════════════════
  //  Построение очереди
  // ═══════════════════════════════════════════════════════════

  function _buildQueue(nodes, order) {
    const flat = TreeHelpers.flatten(nodes);
    // Берём только незавершённые
    let pending = flat.filter(n => n.status !== 'done');

    switch (order) {
      case 'В глубину':
        // flatten уже даёт DFS — ничего не меняем
        break;

      case 'Случайный':
        pending = _shuffle(pending);
        break;

      case 'По сложности':
        // Узлы без детей — листья — считаем проще; с детьми — сложнее
        pending.sort((a, b) => {
          const ac = (a.children || []).length;
          const bc = (b.children || []).length;
          return ac - bc; // от простых к сложным
        });
        break;

      case 'По дате создания':
        pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        break;

      case 'По уровням':
      default:
        // flatten c depth уже есть; сортируем по _depth (BFS)
        pending.sort((a, b) => (a._depth || 0) - (b._depth || 0));
        break;
    }

    return pending.map(n => n.id);
  }

  function _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ═══════════════════════════════════════════════════════════
  //  Навигация по очереди
  // ═══════════════════════════════════════════════════════════

  function _openCurrent() {
    if (!_session.running || _session.paused) return;

    // Проверяем лимит сессии
    if (_session.doneInSession >= _session.sessionLimit) {
      _onSessionLimitReached();
      return;
    }

    // Конец очереди
    if (_session.index >= _session.queue.length) {
      _onQueueFinished();
      return;
    }

    const nodeId = _session.queue[_session.index];

    // Узел мог быть уже помечен вручную пока мы шли
    const node = AppState.findNode(nodeId);
    if (!node || node.status === 'done') {
      _session.index++;
      _openCurrent(); // пропускаем
      return;
    }

    // Раскрываем ветку в дереве и открываем панель
    AppState.setNodeOpen(nodeId, true);
    AnswerPanel.open(nodeId);

    // Прокрутить узел в видимую область дерева
    setTimeout(() => {
      const el = document.querySelector(`[data-node-row="${nodeId}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 80);

    _updateBar();
  }

  function _advance() {
    _session.index++;
    _session.doneInSession++;

    AppState.update('autoStudy', s => ({
      ...s,
      progress: _session.index,
    }));

    _updateBar();

    // Небольшая задержка перед открытием следующего
    setTimeout(_openCurrent, 400);
  }

  // ═══════════════════════════════════════════════════════════
  //  Подписка на смену статуса
  // ═══════════════════════════════════════════════════════════

  /**
   * Слушаем клики по статус-пилюле в AnswerPanel.
   * AnswerPanel диспатчит CustomEvent 'ks:nodeStatusChanged' { detail: { nodeId, status } }
   * — мы сами добавим этот диспатч ниже через патч.
   */
  function _subscribeToStatusChanges() {
    if (_session.unsubscribe) _session.unsubscribe();

    const handler = (e) => {
      if (!_session.running || _session.paused) return;
      const { nodeId, status } = e.detail || {};
      if (!nodeId || !status) return;

      const currentNodeId = _session.queue[_session.index];
      if (nodeId !== currentNodeId) return;

      const autoNext = _getSetting('study_autonext', false);
      if (autoNext || status === 'done') {
        _advance();
      }
    };

    document.addEventListener('ks:nodeStatusChanged', handler);
    _session.unsubscribe = () => document.removeEventListener('ks:nodeStatusChanged', handler);
  }

  // ═══════════════════════════════════════════════════════════
  //  Конец сессии / очереди
  // ═══════════════════════════════════════════════════════════

  function _onSessionLimitReached() {
    _session.paused = true;
    _updateBar();

    const msg = document.createElement('div');
    msg.className = 'as-break-toast';
    msg.innerHTML = `
      <div class="as-toast-inner">
        <strong>Перерыв!</strong>
        <span>За сессию изучено ${_session.doneInSession} вопросов. Отдохни и продолжи.</span>
        <div class="as-toast-btns">
          <button id="as-continue-btn" class="as-btn-primary">Продолжить</button>
          <button id="as-stop-btn"     class="as-btn-ghost">Завершить</button>
        </div>
      </div>
    `;
    document.body.appendChild(msg);

    msg.querySelector('#as-continue-btn').addEventListener('click', () => {
      msg.remove();
      _session.doneInSession = 0; // сбрасываем счётчик сессии
      _session.paused = false;
      _updateBar();
      _openCurrent();
    });
    msg.querySelector('#as-stop-btn').addEventListener('click', () => {
      msg.remove();
      stop();
    });
  }

  function _onQueueFinished() {
    const total = _session.queue.length;
    _cleanup();
    _notify(`🎉 Все ${total} вопросов пройдены! Отличная работа.`, 'success');
  }

  // ═══════════════════════════════════════════════════════════
  //  Прогресс-бар в шапке
  // ═══════════════════════════════════════════════════════════

  function _renderBar() {
    _removeBar();

    _bar = document.createElement('div');
    _bar.id = 'as-progress-bar';
    _bar.innerHTML = `
      <div class="as-inner">
        <span class="as-label" id="as-label">Авторежим</span>
        <div class="as-track">
          <div class="as-fill" id="as-fill"></div>
        </div>
        <span class="as-counter" id="as-counter">0 / 0</span>
        <button class="as-ctrl" id="as-pause-btn" title="Пауза">⏸</button>
        <button class="as-ctrl" id="as-stop-btn-bar" title="Стоп">⏹</button>
      </div>
    `;

    // Вставляем под topbar
    const topbar = document.getElementById('topbar') || document.querySelector('.topbar');
    if (topbar) {
      topbar.insertAdjacentElement('afterend', _bar);
    } else {
      document.body.prepend(_bar);
    }

    _bar.querySelector('#as-pause-btn').addEventListener('click', () => {
      if (_session.paused) resume(); else pause();
    });
    _bar.querySelector('#as-stop-btn-bar').addEventListener('click', stop);

    _injectStyles();
    _updateBar();
  }

  function _updateBar() {
    if (!_bar) return;
    const total   = _session.queue.length;
    const current = _session.index;
    const pct     = total > 0 ? Math.round(current / total * 100) : 0;

    const fill    = _bar.querySelector('#as-fill');
    const counter = _bar.querySelector('#as-counter');
    const label   = _bar.querySelector('#as-label');
    const pauseBtn = _bar.querySelector('#as-pause-btn');

    if (fill)    fill.style.width = pct + '%';
    if (counter) counter.textContent = `${current} / ${total}`;
    if (label)   label.textContent = _session.paused ? 'Пауза' : 'Авторежим';
    if (pauseBtn) pauseBtn.textContent = _session.paused ? '▶' : '⏸';

    // Кнопка в шапке — подсвечиваем пока режим активен
    const headerBtn = document.getElementById('btn-auto-study');
    if (headerBtn) headerBtn.classList.toggle('active', _session.running && !_session.paused);
  }

  function _removeBar() {
    _bar?.remove();
    _bar = null;
  }

  // ═══════════════════════════════════════════════════════════
  //  Утилиты
  // ═══════════════════════════════════════════════════════════

  function _getSetting(key, fallback) {
    try {
      return typeof Settings !== 'undefined' ? Settings.get(key) ?? fallback : fallback;
    } catch (_) { return fallback; }
  }

  function _cleanup() {
    _session.running = false;
    _session.paused  = false;
    _session.unsubscribe?.();
    _session.unsubscribe = null;

    AppState.update('autoStudy', () => ({ running: false, progress: 0, total: 0 }));

    const headerBtn = document.getElementById('btn-auto-study');
    if (headerBtn) headerBtn.classList.remove('active');

    _removeBar();
  }

  function _notify(msg, type = 'info') {
    const colors = { info: '#7c6af7', warn: '#f5a623', success: '#34c759', error: '#ff3b30' };
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:${colors[type] || colors.info}; color:#fff;
      padding:10px 20px; border-radius:10px; font-size:14px;
      z-index:9999; box-shadow:0 4px 16px rgba(0,0,0,.25);
      animation: as-toast-in .2s ease;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  function _injectStyles() {
    if (document.getElementById('as-styles')) return;
    const s = document.createElement('style');
    s.id = 'as-styles';
    s.textContent = `
      @keyframes as-toast-in { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }

      #as-progress-bar {
        position: relative;
        z-index: 100;
        background: var(--bg-sidebar, #1e1e2e);
        border-bottom: 1px solid var(--border-subtle, #30303a);
        padding: 6px 16px;
      }
      .as-inner {
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: 100%;
      }
      .as-label {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--accent, #7c6af7);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        white-space: nowrap;
        min-width: 80px;
      }
      .as-track {
        flex: 1;
        height: 4px;
        background: var(--bg-hover, #2a2a3a);
        border-radius: 2px;
        overflow: hidden;
      }
      .as-fill {
        height: 100%;
        background: var(--accent, #7c6af7);
        border-radius: 2px;
        transition: width 0.35s ease;
      }
      .as-counter {
        font-size: 12px;
        color: var(--text-muted, #888);
        white-space: nowrap;
        min-width: 48px;
        text-align: right;
      }
      .as-ctrl {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 14px;
        color: var(--text-muted, #888);
        padding: 2px 5px;
        border-radius: 5px;
        transition: background 0.12s, color 0.12s;
        line-height: 1;
      }
      .as-ctrl:hover {
        background: var(--bg-hover, #2a2a3a);
        color: var(--text-primary, #fff);
      }

      /* Тост перерыва */
      .as-break-toast {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9998;
      }
      .as-toast-inner {
        background: var(--bg-sidebar, #1e1e2e);
        border: 1px solid var(--border-subtle, #30303a);
        border-radius: 14px;
        padding: 28px 32px;
        max-width: 360px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        text-align: center;
      }
      .as-toast-inner strong {
        font-size: 18px;
        color: var(--text-primary, #fff);
      }
      .as-toast-inner span {
        font-size: 14px;
        color: var(--text-muted, #999);
        line-height: 1.5;
      }
      .as-toast-btns {
        display: flex;
        gap: 10px;
        margin-top: 8px;
        justify-content: center;
      }
      .as-btn-primary {
        background: var(--accent, #7c6af7);
        color: #fff;
        border: none;
        border-radius: 8px;
        padding: 9px 22px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity .15s;
      }
      .as-btn-primary:hover { opacity: .85; }
      .as-btn-ghost {
        background: none;
        color: var(--text-muted, #999);
        border: 1px solid var(--border-subtle, #30303a);
        border-radius: 8px;
        padding: 9px 22px;
        font-size: 14px;
        cursor: pointer;
        transition: border-color .15s;
      }
      .as-btn-ghost:hover { border-color: var(--text-muted); }

      /* Подсветка активной кнопки в шапке */
      #btn-auto-study.active {
        color: var(--accent, #7c6af7);
        background: color-mix(in srgb, var(--accent, #7c6af7) 15%, transparent);
      }
    `;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════
  //  Патч AnswerPanel — диспатч события при смене статуса
  // ═══════════════════════════════════════════════════════════

  /**
   * AnswerPanel не диспатчит событие при смене статуса — патчим его.
   * Ждём DOMContentLoaded чтобы AnswerPanel точно был инициализирован.
   */
  function _patchAnswerPanel() {
    if (typeof AnswerPanel === 'undefined') return;

    // Перехватываем клики по статус-пилюле (делегирование на document)
    document.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-cycle-status]');
      if (!pill) return;
      const nodeId = pill.dataset.cycleStatus;
      if (!nodeId) return;

      // Ждём один тик — AnswerPanel уже сменит статус
      requestAnimationFrame(() => {
        const node = AppState.findNode(nodeId);
        if (!node) return;
        document.dispatchEvent(new CustomEvent('ks:nodeStatusChanged', {
          detail: { nodeId, status: node.status }
        }));
      });
    });

    // Также слушаем контекстное меню (render.js setStatus)
    // Патчим через AppState.on('*') — любое изменение topics
    AppState.on('topics', () => {
      if (!_session.running) return;
      const nodeId = _session.queue[_session.index];
      if (!nodeId) return;
      const node = AppState.findNode(nodeId);
      if (!node) return;
      if (node.status === 'done') {
        document.dispatchEvent(new CustomEvent('ks:nodeStatusChanged', {
          detail: { nodeId, status: 'done' }
        }));
      }
    });
  }

  // Инициализация после загрузки DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _patchAnswerPanel);
  } else {
    setTimeout(_patchAnswerPanel, 0);
  }

  // ═══════════════════════════════════════════════════════════
  //  Экспорт
  // ═══════════════════════════════════════════════════════════
  return { toggle, start, pause, resume, stop, isRunning };

})();