/**
 * index.js — точка входа рендерера.
 *
 * Система ресайза:
 *  - Три блока: [дерево] | [ответ] | [браузер]
 *  - Каждый схлопывается до 0 при перетаскивании ниже SNAP_CLOSE (60px)
 *  - Ручки ВСЕГДА видны (даже когда блок закрыт) — можно потянуть для открытия
 *  - При потягивании закрытого блока он открывается когда превышен SNAP_OPEN (80px)
 *  - Нет принудительных min-width у панелей
 */

(async function init() {

  // ─── 1. Load persisted data ───────────────────────────────
  await Persist.load();

  // ─── 2. Render ────────────────────────────────────────────
  Render.renderTopicsList();
  Render.renderTree();
  Render.renderBreadcrumb();

  // ─── 3. Sidebar flyout ────────────────────────────────────
  const $sidebar  = document.getElementById('sidebar');
  const $overlay  = document.getElementById('sidebar-overlay');

  function sidebarOpen() {
    $sidebar.classList.add('sidebar-open');
    $sidebar.classList.remove('sidebar-collapsed');
    $overlay.classList.add('visible');
    document.getElementById('rail-toggle-sidebar').classList.add('active');
  }
  function sidebarClose() {
    $sidebar.classList.remove('sidebar-open');
    $sidebar.classList.add('sidebar-collapsed');
    $overlay.classList.remove('visible');
    document.getElementById('rail-toggle-sidebar').classList.remove('active');
  }
  function sidebarToggle() {
    $sidebar.classList.contains('sidebar-open') ? sidebarClose() : sidebarOpen();
  }

  document.getElementById('rail-toggle-sidebar')?.addEventListener('click', sidebarToggle);
  document.getElementById('sidebar-close')?.addEventListener('click', sidebarClose);
  $overlay?.addEventListener('click', sidebarClose);

  document.getElementById('rail-new-topic')?.addEventListener('click', () => {
    sidebarOpen();
    setTimeout(() => { Render.openNewTopicModal(); PromptModule.renderTemplateChips(); }, 60);
  });
  AppState.on('currentTopicId', () => sidebarClose());

  // ─── 4. Mode tabs ─────────────────────────────────────────
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => Render.switchMode(btn.dataset.mode));
  });

  // ─── 5. New topic modal ───────────────────────────────────
  document.getElementById('btn-new-topic')?.addEventListener('click', () => {
    Render.openNewTopicModal(); PromptModule.renderTemplateChips();
  });
  document.getElementById('empty-new-topic')?.addEventListener('click', () => {
    sidebarOpen();
    setTimeout(() => { Render.openNewTopicModal(); PromptModule.renderTemplateChips(); }, 60);
  });
  document.getElementById('btn-create-topic')?.addEventListener('click', () => {
    const name   = document.getElementById('input-topic-name').value.trim();
    const prompt = document.getElementById('input-topic-prompt').value.trim();
    if (!name) { document.getElementById('input-topic-name').focus(); return; }
    const topic = AppState.createTopic(name, prompt);
    Render.closeModal('modal-new-topic');
    Render.renderTopicsList();
    Render.selectTopic(topic.id);
    document.getElementById('input-topic-name').value  = '';
    document.getElementById('input-topic-prompt').value = '';
  });
  document.getElementById('input-topic-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create-topic')?.click();
  });

  // ─── 6. Modal close ───────────────────────────────────────
  document.querySelectorAll('.modal-close, [data-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.modal || btn.closest('.modal-overlay')?.id;
      if (id) Render.closeModal(id);
    });
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    if (overlay.id === 'modal-settings') return;
    overlay.addEventListener('click', e => { if (e.target === overlay) Render.closeModal(overlay.id); });
  });

  // ══════════════════════════════════════════════════════════
  //  DOM refs
  // ══════════════════════════════════════════════════════════
  const $tc      = document.getElementById('tree-container');
  const $ap      = document.getElementById('answer-panel');
  const $bp      = document.getElementById('browser-panel');
  const $ra      = document.getElementById('resize-answer');   // ручка дерево↔ответ
  const $rb      = document.getElementById('resize-browser');  // ручка ответ↔браузер
  const $btnTree = document.getElementById('btn-collapse-tree');

  // Пороги snap (px)
  const SNAP_CLOSE = 60;  // закрыть блок если меньше
  const SNAP_OPEN  = 80;  // открыть блок если больше (при потягивании из 0)

  // ── Saved widths ──────────────────────────────────────────
  const savedTreeW    = () => Math.max(200, AppState.get('layout').treeWidth    || 320);
  const savedBrowserW = () => Math.max(200, AppState.get('layout').browserWidth || 420);

  // ── Tree collapsed state ──────────────────────────────────
  let _treeCollapsed = false;

  function _setTreeCollapsed(yes) {
    _treeCollapsed = yes;
    if (yes) {
      $tc.style.width    = '0';
      $tc.style.flex     = '0 0 0';
      $tc.style.overflow = 'hidden';
      $tc.style.padding  = '0';
      $ap.classList.add('tree-collapsed-border');
      if ($btnTree) {
        $btnTree.classList.add('active');
        $btnTree.title = 'Показать дерево вопросов';
        $btnTree.querySelector('svg').style.transform = 'scaleX(-1)';
      }
    } else {
      $tc.style.overflow = '';
      $tc.style.padding  = '';
      $ap.classList.remove('tree-collapsed-border');
      if ($btnTree) {
        $btnTree.classList.remove('active');
        $btnTree.title = 'Скрыть дерево вопросов';
        $btnTree.querySelector('svg').style.transform = '';
      }
    }
    AppState.update('layout', l => ({ ...l, treeCollapsed: yes }));
    Persist.save();
  }

  // Выставить ширину дерева с учётом того, открыт ли ответ
  function _applyTreeWidth(w) {
    if (_treeCollapsed) return;
    const apOpen = !$ap.classList.contains('collapsed');
    if (apOpen) {
      $tc.style.flex  = '0 0 auto';
      $tc.style.width = w + 'px';
    } else {
      // Ответ закрыт — дерево занимает всё
      $tc.style.flex  = '1';
      $tc.style.width = 'auto';
    }
  }

  function collapseTree() {
    _setTreeCollapsed(true);
  }

  function expandTree() {
    _setTreeCollapsed(false);
    _applyTreeWidth(savedTreeW());
  }

  $btnTree?.addEventListener('click', () => {
    _treeCollapsed ? expandTree() : collapseTree();
  });

  // ── Слушаем открытие/закрытие answer-panel ────────────────
  // answer-panel.js диспатчит эти события
  document.addEventListener('ap:open', () => {
    if (!_treeCollapsed) {
      $tc.style.flex  = '0 0 auto';
      $tc.style.width = savedTreeW() + 'px';
    }
  });
  document.addEventListener('ap:close', () => {
    if (!_treeCollapsed) {
      $tc.style.flex  = '1';
      $tc.style.width = 'auto';
    }
  });

  // ══════════════════════════════════════════════════════════
  //  RESIZE: дерево ↔ ответ  (#resize-answer)
  //
  //  Ручка ВСЕГДА видна:
  //  - Когда дерево открыто: двигает границу
  //  - Когда дерево закрыто: тянуть вправо = открыть дерево
  //  - Если ответ закрыт: ресайз не работает (дерево занимает всё)
  // ══════════════════════════════════════════════════════════
  {
    let dragging = false, startX = 0, startW = 0, wasTreeCollapsed = false;

    $ra.addEventListener('mousedown', e => {
      dragging         = true;
      wasTreeCollapsed = _treeCollapsed;
      startX           = e.clientX;
      startW           = _treeCollapsed ? 0 : $tc.offsetWidth;

      // Фиксируем flex дерева перед drag
      if (!_treeCollapsed) {
        $tc.style.flex  = '0 0 auto';
        $tc.style.width = startW + 'px';
      }

      $ra.classList.add('dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      let w = Math.max(0, startW + delta);

      // Если ответ закрыт — ресайз только дерева без ограничений
      const apOpen = !$ap.classList.contains('collapsed');
      if (apOpen) {
        // Ответ открыт: не даём полностью вытеснить ответ (оставляем хоть 1px чтобы видеть схлопывание)
        const panelW = document.getElementById('panel-tree')?.offsetWidth || 1000;
        w = Math.min(w, panelW - 5); // 5px для ручки
      }

      $tc.style.width = w + 'px';
      $tc.style.flex  = '0 0 auto';
      $tc.style.overflow = w > 0 ? '' : 'hidden';
      $tc.style.padding  = w > 0 ? '' : '0';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      $ra.classList.remove('dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';

      const w = $tc.offsetWidth;
      const apOpen = !$ap.classList.contains('collapsed');

      if (w < SNAP_CLOSE) {
        // Схлопнуть дерево
        _setTreeCollapsed(true);
      } else {
        // Дерево открыто
        if (_treeCollapsed) _setTreeCollapsed(false);
        $tc.style.overflow = '';
        $tc.style.padding  = '';

        if (apOpen) {
          // Проверить: если дерево вытеснило ответ почти полностью — закрыть ответ
          const panelW = document.getElementById('panel-tree')?.offsetWidth || 1000;
          if (w >= panelW - SNAP_CLOSE - 5) {
            // Схлопнуть ответ
            if (typeof AnswerPanel !== 'undefined') AnswerPanel.close();
          } else {
            AppState.update('layout', l => ({ ...l, treeWidth: w }));
            Persist.save();
          }
        } else {
          AppState.update('layout', l => ({ ...l, treeWidth: w }));
          Persist.save();
        }
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  //  RESIZE: main ↔ браузер  (#resize-browser)
  //
  //  Ручка ВСЕГДА видна:
  //  - Когда браузер открыт: двигает границу
  //  - Когда браузер закрыт: тянуть влево = открыть браузер
  // ══════════════════════════════════════════════════════════
  {
    let dragging = false, startX = 0, startW = 0;

    $rb.addEventListener('mousedown', e => {
      dragging = true;
      startX   = e.clientX;
      startW   = $bp.classList.contains('collapsed') ? 0 : $bp.offsetWidth;

      // Если браузер закрыт — снимаем collapsed чтобы начать drag
      if ($bp.classList.contains('collapsed')) {
        $bp.classList.remove('collapsed');
        $bp.style.width = '0';
        // Инициализируем webview при первом открытии через drag
        if (typeof BrowserModule !== 'undefined') BrowserModule._ensureWebview?.();
      }

      $rb.classList.add('dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      // invert: тянем влево — увеличиваем браузер
      const delta = startX - e.clientX;
      const w     = Math.max(0, startW + delta);
      $bp.style.width = w + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      $rb.classList.remove('dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';

      const w = $bp.offsetWidth;
      if (w < SNAP_CLOSE) {
        // Схлопнуть браузер
        BrowserModule.close();
        $bp.style.width = '';
      } else {
        // Зафиксировать браузер как открытый
        if (typeof BrowserModule !== 'undefined') {
          // Убеждаемся что браузер отмечен как открытый
          if ($bp.classList.contains('collapsed')) $bp.classList.remove('collapsed');
          AppState.set('browser', { ...AppState.get('browser'), open: true });
          document.getElementById('btn-toggle-browser')?.classList.add('active');
          if (!$bp.querySelector('webview')) BrowserModule._ensureWebview?.();
        }
        AppState.update('layout', l => ({ ...l, browserWidth: w }));
        Persist.save();
      }
    });
  }

  // ─── 9. Resize: sidebar width ─────────────────────────────
  setupResize({
    handle:   document.getElementById('resize-sidebar'),
    target:   $sidebar,
    prop:     'width',
    min: 180, max: 480,
    invert:   false,
    onDone:   w => AppState.update('layout', l => ({ ...l, sidebarWidth: w })),
  });

  // ══════════════════════════════════════════════════════════
  //  Восстановление состояния при старте
  // ══════════════════════════════════════════════════════════
  const layout = AppState.get('layout');

  // Санируем
  if ((layout.treeWidth    || 0) < 100) AppState.update('layout', l => ({ ...l, treeWidth:    320 }));
  if ((layout.browserWidth || 0) < 100) AppState.update('layout', l => ({ ...l, browserWidth: 420 }));

  // Дерево
  if (layout.treeCollapsed) {
    _treeCollapsed = true;
    _setTreeCollapsed(true);
  } else {
    // answer-panel стартует collapsed → дерево flex:1
    $tc.style.flex  = '1';
    $tc.style.width = 'auto';
    _treeCollapsed = false;
    $tc.style.overflow = '';
    $tc.style.padding  = '';
  }

  // Браузер: НЕ восстанавливаем width как inline при старте
  // (ширина будет применена в BrowserModule.open())

  // ─── Авторазбор ───────────────────────────────────────────
  const $btnAB = document.getElementById('btn-auto-breakdown');
  if ($btnAB) {
    document.addEventListener('ab:statechange', e => {
      $btnAB.classList.toggle('running', !!e.detail?.active);
    });
  }

  // ─── 10. Keyboard shortcuts ───────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === '/')  { e.preventDefault(); sidebarToggle(); }
      if (e.key === 'n')  { e.preventDefault(); sidebarOpen(); setTimeout(() => { Render.openNewTopicModal(); PromptModule.renderTemplateChips(); }, 60); }
      if (e.key === 'b')  { e.preventDefault(); BrowserModule.toggle(); }
      if (e.key === 'e')  { e.preventDefault(); ExportModule.generate(); }
      if (e.key === '1')  { e.preventDefault(); Render.switchMode('tree'); }
      if (e.key === '2')  { e.preventDefault(); Render.switchMode('graph'); }
      if (e.key === '3')  { e.preventDefault(); Render.switchMode('tutorial'); }
    }
    if (e.key === 'Escape') {
      if (typeof Settings !== 'undefined' && Settings.isOpen()) return;
      if (document.getElementById('img-inline-viewer')) return;
      if ($sidebar.classList.contains('sidebar-open')) { sidebarClose(); return; }
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => {
        if (m.id !== 'modal-settings') Render.closeModal(m.id);
      });
    }
  });

  // ─── 11. Other ────────────────────────────────────────────
  document.getElementById('btn-auto-breakdown')?.addEventListener('click', () => window.autoBreakdown?.showDialog(null, true));
  document.getElementById('btn-browser-reload')?.addEventListener('click', () => {
    document.querySelector('#browser-webview-container webview')?.reload?.();
  });

  console.log('[Knowledge Studio] ✓ Init complete');
})();


// ══════════════════════════════════════════════════════════════
//  Universal resize helper (для sidebar)
// ══════════════════════════════════════════════════════════════
function setupResize({ handle, target, prop, min, max, invert = false, onDone, onStart, onMove }) {
  if (!handle || !target) return;
  let startPos = 0, startSize = 0, dragging = false;
  const isWidth = prop === 'width';

  handle.addEventListener('mousedown', e => {
    dragging  = true;
    startPos  = isWidth ? e.clientX : e.clientY;
    startSize = isWidth ? target.offsetWidth : target.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.cursor     = isWidth ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    onStart?.();
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const cur   = isWidth ? e.clientX : e.clientY;
    const delta = invert ? startPos - cur : cur - startPos;
    const size  = Math.min(max, Math.max(min, startSize + delta));
    target.style[prop] = size + 'px';
    onMove?.(size);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    const final = isWidth ? target.offsetWidth : target.offsetHeight;
    onDone?.(final);
    Persist.save();
  });
}