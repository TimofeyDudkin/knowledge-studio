/**
 * render.js — отрисовка UI.
 *
 * Что добавлено:
 *   • Inline-редактирование узла (двойной клик / F2)
 *   • Drag-and-drop перемещение узлов
 *   • Контекстное меню узла (переименовать / добавить подвопрос / удалить)
 *   • Сохранение открытых/закрытых ветвей через AppState.openNodes
 *   • Inline-редактирование названия темы в сайдбаре
 *   • Удаление темы
 */

window.Render = (() => {
  const $topicsList    = document.getElementById('topics-list');
  const $treeContainer = document.getElementById('tree-container');
  const $breadcrumb    = document.getElementById('topic-breadcrumb');

  // ─── DOM-кэш узлов: Map<nodeId, Element> для O(1) патча без полного ре-рендера
  const _nodeElMap = new Map();

  // ─── SVG-иконки как константы (убираем дублирование строк по всему файлу) ──
  const ICON_ARROW       = '<svg class="toggle-arrow" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2l4 3-4 3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_PLACEHOLDER = '<span class="toggle-placeholder"></span>';

  // ─── drag state ─────────────────────────────────────────────
  let _drag = {
    nodeId: null,
    sourceParentId: null,
    overNodeId: null,
    overEl: null,       // кешируем DOM-элемент цели чтобы не делать querySelectorAll
    position: null,   // 'before' | 'after' | 'inside'
  };

  // ─── context menu ────────────────────────────────────────────
  let _ctxMenu = null;
  let _dragDelegationInit = false;

  // ════════════════════════════════════════════════════════════
  //  ТЕМЫ (сайдбар)
  // ════════════════════════════════════════════════════════════

  function renderTopicsList() {
    const topics    = [...AppState.get('topics').values()];
    const currentId = AppState.get('currentTopicId');

    if (topics.length === 0) {
      $topicsList.innerHTML = `
        <div class="topics-empty"><p>Нет тем.</p><p>Создай первую →</p></div>`;
      return;
    }

    $topicsList.innerHTML = topics.map(t => `
      <div class="topic-item ${t.id === currentId ? 'active' : ''}"
           data-topic-id="${t.id}" role="button" tabindex="0">
        <span class="topic-dot"></span>
        <span class="topic-name" data-editable-topic="${t.id}">${escHtml(t.name)}</span>
        <span class="topic-menu-btn" data-topic-menu="${t.id}" title="Меню">…</span>
      </div>`).join('');

    // Клик на тему
    $topicsList.querySelectorAll('.topic-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.topic-menu-btn') || e.target.closest('[data-editable-topic]')?.isEditing) return;
        selectTopic(el.dataset.topicId);
      });
    });

    // Двойной клик → переименовать тему
    $topicsList.querySelectorAll('[data-editable-topic]').forEach(el => {
      el.addEventListener('dblclick', e => {
        e.stopPropagation();
        startTopicRename(el);
      });
    });

    // Меню темы
    $topicsList.querySelectorAll('[data-topic-menu]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        showTopicMenu(btn.dataset.topicMenu, btn);
      });
    });
  }

  function selectTopic(id) {
    AppState.set('currentTopicId', id);
    AppState.set('selectedNodeId', null);
    renderTopicsList();
    renderTree();
    renderBreadcrumb();
    AnswerPanel.close?.();
  }

  function startTopicRename(el) {
    const id = el.dataset.editableTopic;
    const old = AppState.getTopic(id)?.name || '';
    el.isEditing = true;

    const input = document.createElement('input');
    input.className = 'inline-edit-input';
    input.value = old;
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const v = input.value.trim();
      if (v && v !== old) AppState.renameTopic(id, v);
      el.isEditing = false;
      renderTopicsList();
    };
    input.addEventListener('blur',   commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { el.isEditing = false; renderTopicsList(); }
    });
  }

  function showTopicMenu(topicId, anchor) {
    closeCtxMenu();
    const menu = createMenu([
      { label: 'Переименовать', action: () => {
        const el = $topicsList.querySelector(`[data-editable-topic="${topicId}"]`);
        if (el) startTopicRename(el);
      }},
      { label: 'Удалить', danger: true, action: () => {
        if (confirm('Удалить тему и все вопросы?')) {
          AppState.deleteTopic(topicId);
          renderTopicsList();
          renderTree();
          renderBreadcrumb();
        }
      }},
    ], anchor);
    document.body.appendChild(menu);
    _ctxMenu = menu;
  }

  // ════════════════════════════════════════════════════════════
  //  ДЕРЕВО ВОПРОСОВ
  // ════════════════════════════════════════════════════════════

  function renderTree() {
    _prevSelectedNodeId = null;
    const topic = AppState.getCurrentTopic();

    if (!topic) {
      _nodeElMap.clear();
      $treeContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg viewBox="0 0 48 48" fill="none">
            <path d="M24 8C15.2 8 8 15.2 8 24s7.2 16 16 16 16-7.2 16-16S32.8 8 24 8z"
                  stroke="currentColor" stroke-width="1.5" opacity=".3"/>
          </svg></div>
          <h3>Выбери тему или создай новую</h3>
          <p>Дерево вопросов появится здесь</p>
          <button class="btn-primary" id="empty-new-topic">Создать тему</button>
        </div>`;
      document.getElementById('empty-new-topic')?.addEventListener('click', openNewTopicModal);
      return;
    }

    if (topic.nodes.length === 0) {
      _nodeElMap.clear();
      $treeContainer.innerHTML = `
        <div class="empty-state">
          <h3>${escHtml(topic.name)}</h3>
          <p>Добавь первый вопрос для изучения</p>
          <button class="btn-primary" id="btn-add-root-node">+ Добавить вопрос</button>
        </div>`;
      document.getElementById('btn-add-root-node')
        ?.addEventListener('click', () => addNodeInline(null));
      return;
    }

    const selectedId = AppState.get('selectedNodeId');

    // Проверяем есть ли уже отрисованное дерево для этой темы
    const existingRoot = document.getElementById('tree-root-container');
    const existingTopicTitle = document.querySelector('.tree-topic-title');
    const isRerender = existingRoot && existingTopicTitle;

    if (isRerender) {
      // ── Умный режим: патчим только изменившиеся узлы ──
      existingTopicTitle.textContent = topic.name;
      _patchNodeList(topic.nodes, $treeContainer.querySelector('[data-parent-id="root"]'), null, selectedId);
      return;
    }

    // ── Первичный рендер или смена темы: полный innerHTML ──
    _nodeElMap.clear();
    $treeContainer.innerHTML = `
      <div class="tree-root" id="tree-root-container">
        <div class="tree-header" id="tree-sticky-header">
          <h3 class="tree-topic-title">${escHtml(topic.name)}</h3>
          <button class="tree-add-root icon-btn-sm" title="Добавить вопрос в корень (Ctrl+Enter)">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M6 2v8M2 6h8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <div class="tree-node-list" data-parent-id="root">
          ${renderNodeList(topic.nodes, selectedId)}
        </div>
      </div>`;

    // Индексируем все новые DOM-элементы
    $treeContainer.querySelectorAll('[data-node-id]').forEach(el => {
      _nodeElMap.set(el.dataset.nodeId, el);
    });

    $treeContainer.querySelector('.tree-add-root')
      ?.addEventListener('click', () => addNodeInline(null));

    // Sticky-заголовок: добавляем класс is-stuck когда header прилипает
    _initStickyHeader();

    // Drag delegation (dragover/dragleave/drop) инициализируем один раз
    if (!_dragDelegationInit) { _initDragDelegation(); _dragDelegationInit = true; }

    // Полный event delegation для click/dblclick/drag — один раз за жизнь
    _initTreeEventDelegation();
  }

  /**
   * Умный патч дерева: обновляет label/status/attachments существующих узлов,
   * добавляет новые, удаляет отсутствующие. Не трогает скролл, фокус и открытые ветки.
   */
  function _patchNodeList(nodes, containerEl, parentId, selectedId) {
    if (!containerEl) return;

    const existingIds = new Set();
    containerEl.querySelectorAll(':scope > [data-node-id]').forEach(el => {
      existingIds.add(el.dataset.nodeId);
    });

    const newIds = new Set(nodes.map(n => n.id));

    // Удалить узлы которых больше нет
    for (const id of existingIds) {
      if (!newIds.has(id)) {
        const el = containerEl.querySelector(`:scope > [data-node-id="${id}"]`);
        el?.remove();
        _nodeElMap.delete(id);
      }
    }

    // Добавить / обновить узлы
    nodes.forEach((node, idx) => {
      let nodeEl = containerEl.querySelector(`:scope > [data-node-id="${node.id}"]`);

      if (!nodeEl) {
        // Новый узел — вставить
        const html = renderNodeItem(node, selectedId);
        const tmp  = document.createElement('div');
        tmp.innerHTML = html;
        nodeEl = tmp.firstElementChild;
        if (!nodeEl) return;
        const refEl = containerEl.children[idx] || null;
        containerEl.insertBefore(nodeEl, refEl);
        _nodeElMap.set(node.id, nodeEl);
        bindTreeEvents(nodeEl);
      } else {
        // Существующий узел — патчим только изменившиеся части
        _patchExistingNode(nodeEl, node, selectedId);
      }

      // Рекурсивно патчим детей если ветка открыта
      const childrenEl = nodeEl.querySelector(':scope > .tree-node-children');
      const isOpen = AppState.isNodeOpen(node.id);
      if (childrenEl && isOpen && node.children?.length) {
        _patchNodeList(node.children, childrenEl, node.id, selectedId);
      }
    });
  }

  function _patchExistingNode(nodeEl, node, selectedId) {
    // Label
    const labelEl = nodeEl.querySelector(`[data-label="${node.id}"]`);
    if (labelEl && labelEl.textContent !== node.label && !labelEl.isContentEditable) {
      labelEl.textContent = node.label;
    }
    // Status
    const statusEl = nodeEl.querySelector(`[data-status="${node.id}"]`);
    if (statusEl) {
      const expected = `tree-node-status ${node.status}`;
      if (statusEl.className !== expected) statusEl.className = expected;
    }
    // Selection
    const rowEl = nodeEl.querySelector(`[data-node-row="${node.id}"]`);
    const isSelected = node.id === selectedId;
    rowEl?.classList.toggle('selected', isSelected);
    nodeEl.classList.toggle('selected-node', isSelected);
    // Attach badge
    const hasAttach = Array.isArray(node.attachments) && node.attachments.length > 0;
    const badgeEl   = nodeEl.querySelector('.node-attach-badge');
    const actionsEl = nodeEl.querySelector('.tree-node-actions');
    if (hasAttach && !badgeEl && actionsEl) {
      const badge = document.createElement('span');
      badge.className = 'node-attach-badge';
      badge.title = `${node.attachments.length} файл(ов) прикреплено`;
      badge.textContent = '📎' + (node.attachments.length > 1 ? node.attachments.length : '');
      actionsEl.before(badge);
    } else if (!hasAttach && badgeEl) {
      badgeEl.remove();
    }
    // Arrow: показать/скрыть в зависимости от наличия детей
    const toggleEl = nodeEl.querySelector(`[data-toggle="${node.id}"]`);
    if (toggleEl) {
      const hasChildren = node.children?.length > 0;
      const hasArrow = !!toggleEl.querySelector('.toggle-arrow');
      if (hasChildren && !hasArrow) {
        toggleEl.innerHTML = ICON_ARROW;
      } else if (!hasChildren && hasArrow) {
        toggleEl.innerHTML = ICON_PLACEHOLDER;
      }
    }
  }

  function renderNodeList(nodes, selectedId) {
    return nodes.map(n => renderNodeItem(n, selectedId)).join('');
  }

  function renderNodeItem(node, selectedId) {
    const hasChildren  = node.children?.length > 0;
    const isOpen       = AppState.isNodeOpen(node.id);
    const isSelected   = node.id === selectedId;
    const hasAttach    = Array.isArray(node.attachments) && node.attachments.length > 0;

    const arrowHtml = hasChildren ? ICON_ARROW : ICON_PLACEHOLDER;

    const attachBadge = hasAttach
      ? `<span class="node-attach-badge" title="${node.attachments.length} файл(ов) прикреплено">📎${node.attachments.length > 1 ? node.attachments.length : ''}</span>`
      : '';

    // children-контейнер рендерим всегда — нужен для addNodeInline и toggle без ре-рендера
    const childrenHtml = `
      <div class="tree-node-children" data-parent-id="${node.id}"${!hasChildren || !isOpen ? ' style="display:none"' : ''}>
        ${hasChildren && isOpen ? renderNodeList(node.children, selectedId) : ''}
      </div>`;

    return `
      <div class="tree-node ${isOpen ? 'open' : ''} ${isSelected ? 'selected-node' : ''}"
           data-node-id="${node.id}" draggable="true">
        <div class="tree-node-row ${isSelected ? 'selected' : ''}" data-node-row="${node.id}">
          <span class="tree-node-toggle" data-toggle="${node.id}">${arrowHtml}</span>
          <span class="tree-node-status ${node.status}" data-status="${node.id}" title="Сменить статус"></span>
          <span class="tree-node-label" data-label="${node.id}">${escHtml(node.label)}</span>
          ${attachBadge}
          <span class="tree-node-actions">
            <button class="icon-btn-sm btn-add-child" data-parent-id="${node.id}" title="Добавить подвопрос">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2v8M2 6h8" stroke-linecap="round"/></svg>
            </button>
            <button class="icon-btn-sm btn-node-menu" data-node-menu="${node.id}" title="Меню">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="2" cy="6" r="1" fill="currentColor" stroke="none"/>
                <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none"/>
                <circle cx="10" cy="6" r="1" fill="currentColor" stroke="none"/>
              </svg>
            </button>
          </span>
        </div>
        ${childrenHtml}
      </div>`;
  }

  // ─── Bind all tree events ────────────────────────────────────
  // Используем единый делегированный обработчик на $treeContainer для всех типов событий.
  // Это устраняет привязку N обработчиков при каждом ре-рендере и утечки событий.

  let _treeEventsDelegated = false;

  function _initTreeEventDelegation() {
    if (_treeEventsDelegated) return;
    _treeEventsDelegated = true;

    // ── click: строка / toggle / статус / кнопки ──
    $treeContainer.addEventListener('click', e => {
      // Toggle раскрытия
      const toggleEl = e.target.closest('[data-toggle]');
      if (toggleEl && $treeContainer.contains(toggleEl)) {
        e.stopPropagation();
        const nodeId  = toggleEl.dataset.toggle;
        const nodeEl  = toggleEl.closest('[data-node-id]');
        if (!nodeEl) return;
        AppState.toggleNodeOpen(nodeId);
        const isNowOpen = AppState.isNodeOpen(nodeId);
        nodeEl.classList.toggle('open', isNowOpen);
        const childrenEl = nodeEl.querySelector(':scope > .tree-node-children');
        if (!childrenEl) return;
        if (isNowOpen) {
          const node = AppState.findNode(nodeId);
          if (node?.children?.length) {
            childrenEl.innerHTML = renderNodeList(node.children, AppState.get('selectedNodeId'));
            // Регистрируем новые элементы в nodeElMap
            childrenEl.querySelectorAll('[data-node-id]').forEach(el => _nodeElMap.set(el.dataset.nodeId, el));
            if (!toggleEl.querySelector('.toggle-arrow')) toggleEl.innerHTML = ICON_ARROW;
          }
          childrenEl.style.display = '';
        } else {
          childrenEl.style.display = 'none';
        }
        return;
      }

      // Статус
      const statusEl = e.target.closest('[data-status]');
      if (statusEl && !e.target.closest('button') && !e.target.closest('[data-toggle]')) {
        e.stopPropagation();
        cycleStatus(statusEl.dataset.status);
        return;
      }

      // Кнопка добавить подвопрос
      const addBtn = e.target.closest('.btn-add-child');
      if (addBtn) {
        e.stopPropagation();
        addNodeInline(addBtn.dataset.parentId);
        return;
      }

      // Кнопка меню узла
      const menuBtn = e.target.closest('.btn-node-menu');
      if (menuBtn) {
        e.stopPropagation();
        showNodeMenu(menuBtn.dataset.nodeMenu, menuBtn);
        return;
      }

      // Клик по строке → выбор узла
      const rowEl = e.target.closest('[data-node-row]');
      if (rowEl && !e.target.closest('button') && !e.target.closest('[data-toggle]')) {
        selectNode(rowEl.dataset.nodeRow);
      }
    });

    // ── dblclick: переименование ──
    $treeContainer.addEventListener('dblclick', e => {
      const labelEl = e.target.closest('[data-label]');
      if (labelEl) {
        e.stopPropagation();
        startNodeRename(labelEl.dataset.label);
      }
    });

    // ── drag: dragstart/dragend только на самих узлах (нельзя делегировать) ──
    $treeContainer.addEventListener('dragstart', e => {
      const nodeEl = e.target.closest('.tree-node[draggable]');
      if (nodeEl) onDragStart({ ...e, currentTarget: nodeEl });
    });
    $treeContainer.addEventListener('dragend', e => {
      const nodeEl = e.target.closest('.tree-node[draggable]');
      if (nodeEl) onDragEnd({ ...e, currentTarget: nodeEl });
    });
  }

  /**
   * bindTreeEvents — оставлен для обратной совместимости при insertNodeEl/addNodeInline.
   * Реальная привязка теперь через delegation (один раз), эта функция — no-op.
   */
  function bindTreeEvents(_root) {
    // Все события делегированы через _initTreeEventDelegation()
    // Dragstart/dragend используют тот же delegation выше
  }

  // ─── Drag delegation: навешивается один раз на $treeContainer ────
  // dragover/dragleave/drop приходят пузырьком от любого узла,
  // поэтому не нужно вешать их на каждый .tree-node отдельно.
  function _initDragDelegation() {
    $treeContainer.addEventListener('dragover', e => {
      onDragOver(e);
    });

    $treeContainer.addEventListener('dragleave', e => {
      // Игнорируем если уходим к дочернему элементу того же узла
      const nodeEl = e.target.closest('.tree-node[draggable]');
      if (nodeEl && nodeEl.contains(e.relatedTarget)) return;
      if (nodeEl) {
        nodeEl.classList.remove('drop-before', 'drop-after', 'drop-inside');
        if (_drag.overEl === nodeEl) {
          _drag.overEl = null;
          _drag.overNodeId = null;
          _drag.position   = null;
        }
      }
    });

    $treeContainer.addEventListener('drop', e => {
      const nodeEl = e.target.closest('.tree-node[draggable]');
      if (!nodeEl) return;
      onDrop(e);
    });
  }

  // ─── Inline node creation ────────────────────────────────────

  function addNodeInline(parentId) {
    const topic = AppState.getCurrentTopic();
    if (!topic) return;

    // Если есть пустой-state — нужен полный ре-рендер после добавления
    const wasEmpty = topic.nodes.length === 0;

    if (parentId) AppState.setNodeOpen(parentId, true);

    const placeholder = document.createElement('div');
    placeholder.className = 'tree-node-new-placeholder';
    placeholder.innerHTML = `
      <span class="tree-node-toggle"><span class="toggle-placeholder"></span></span>
      <span class="tree-node-status open"></span>
      <input class="inline-edit-input new-node-input" placeholder="Введи вопрос… (Tab — ещё один)" />`;

    // Найти контейнер для вставки
    let listEl = null;
    if (parentId) {
      const parentEl = $treeContainer.querySelector(`[data-node-id="${parentId}"]`);
      listEl = parentEl?.querySelector(`:scope > .tree-node-children`);
      if (listEl) {
        // Показать контейнер и обновить стрелку
        listEl.style.display = '';
        const toggleEl = parentEl.querySelector(`[data-toggle="${parentId}"]`);
        if (toggleEl && !toggleEl.querySelector('.toggle-arrow')) {
          toggleEl.innerHTML = ICON_ARROW;
        }
      }
    } else {
      listEl = $treeContainer.querySelector('[data-parent-id="root"]');
    }

    if (listEl) {
      listEl.appendChild(placeholder);
    } else {
      // Fallback: рендер не готов — добавляем в конец tree-container
      $treeContainer.appendChild(placeholder);
    }

    const input = placeholder.querySelector('.new-node-input');
    input?.focus();

    const commit = () => {
      const label = input?.value.trim();
      placeholder.remove();
      if (!label) return;

      const node = AppState.createNode(label, parentId);
      TreeHelpers.addNode(topic.nodes, parentId, node);
      Persist.save();

      if (wasEmpty) {
        // Перестроить дерево с нуля — уйдёт empty-state
        renderTree();
        selectNode(node.id);
      } else {
        // Добавить DOM-узел без полного ре-рендера
        insertNodeEl(node, parentId);
        selectNode(node.id);
      }
    };

    input?.addEventListener('blur', commit);
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.removeEventListener('blur', commit); commit(); }
      if (e.key === 'Escape') { placeholder.remove(); }
      if (e.key === 'Tab')    {
        e.preventDefault();
        input.removeEventListener('blur', commit);
        commit();
        // Небольшая задержка чтобы DOM обновился
        setTimeout(() => addNodeInline(parentId), 60);
      }
    });
  }

  // Вставить один DOM-узел без полного ре-рендера дерева
  function insertNodeEl(node, parentId) {
    const html     = renderNodeItem(node, AppState.get('selectedNodeId'));
    const temp     = document.createElement('div');
    temp.innerHTML = html;
    const newEl    = temp.firstElementChild;
    if (!newEl) return;

    let listEl;
    if (parentId) {
      const parentEl = $treeContainer.querySelector(`[data-node-id="${parentId}"]`);
      listEl = parentEl?.querySelector(`:scope > .tree-node-children`);
    } else {
      listEl = $treeContainer.querySelector('[data-parent-id="root"]');
    }
    listEl?.appendChild(newEl);
    // Регистрируем в карте для дальнейшего O(1) доступа
    _nodeElMap.set(node.id, newEl);
    newEl.querySelectorAll('[data-node-id]').forEach(el => _nodeElMap.set(el.dataset.nodeId, el));
    // События делегированы — bindTreeEvents не нужен
  }

  // ─── Inline rename ───────────────────────────────────────────

  function startNodeRename(nodeId) {
    const labelEl = $treeContainer.querySelector(`[data-label="${nodeId}"]`);
    if (!labelEl) return;

    const node = AppState.findNode(nodeId);
    if (!node) return;
    const oldLabel = node.label;

    labelEl.contentEditable = 'true';
    labelEl.classList.add('editing');
    labelEl.focus();

    // Выделить весь текст
    const range = document.createRange();
    range.selectNodeContents(labelEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const commit = () => {
      labelEl.contentEditable = 'false';
      labelEl.classList.remove('editing');
      const newLabel = labelEl.textContent.trim();
      if (newLabel && newLabel !== oldLabel) {
        const topic = AppState.getCurrentTopic();
        TreeHelpers.updateNode(topic.nodes, nodeId, { label: newLabel });
        Persist.save();
        renderBreadcrumb();
      } else {
        labelEl.textContent = oldLabel; // откат
      }
    };

    labelEl.addEventListener('blur', commit, { once: true });
    labelEl.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); labelEl.blur(); }
      if (e.key === 'Escape') {
        labelEl.textContent = oldLabel;
        labelEl.contentEditable = 'false';
        labelEl.classList.remove('editing');
      }
    }, { once: true });
  }

  // ─── Status cycling ──────────────────────────────────────────

  function cycleStatus(nodeId) {
    const node = AppState.findNode(nodeId);
    if (!node) return;
    const order = ['open', 'active', 'done'];
    const next  = order[(order.indexOf(node.status) + 1) % order.length];
    const topic = AppState.getCurrentTopic();
    TreeHelpers.updateNode(topic.nodes, nodeId, { status: next });
    Persist.save();
    // Обновить точку без полного ре-рендера
    const el = $treeContainer.querySelector(`[data-status="${nodeId}"]`);
    if (el) { el.className = `tree-node-status ${next}`; el.title = `Статус: ${next}`; }
  }

  // ─── Node context menu ───────────────────────────────────────

  function showNodeMenu(nodeId, anchor) {
    closeCtxMenu();
    const node = AppState.findNode(nodeId);
    if (!node) return;
    // Синхронизируем selectedNodeId — autoBreakdown.showDialog() читает его
    AppState.set('selectedNodeId', nodeId);

    const statusLabel = { open: 'Открыт', active: 'Изучается', done: 'Готово' };

    const menu = createMenu([
      { label: '✏️ Переименовать (F2)', action: () => startNodeRename(nodeId) },
      { label: '➕ Добавить подвопрос', action: () => {
        AppState.setNodeOpen(nodeId, true);
        addNodeInline(nodeId);
      }},
      { separator: true },
      { label: `○  Открыт`,    check: node.status === 'open',   action: () => setStatus(nodeId, 'open') },
      { label: `◐  Изучается`, check: node.status === 'active', action: () => setStatus(nodeId, 'active') },
      { label: `●  Готово`,    check: node.status === 'done',   action: () => setStatus(nodeId, 'done') },
      { separator: true },
      { label: '🗑 Удалить', danger: true, action: () => deleteNode(nodeId) },
    ], anchor);

    document.body.appendChild(menu);
    _ctxMenu = menu;
  }

  function setStatus(nodeId, status) {
    const topic = AppState.getCurrentTopic();
    TreeHelpers.updateNode(topic.nodes, nodeId, { status });
    Persist.save();
    const el = $treeContainer.querySelector(`[data-status="${nodeId}"]`);
    if (el) { el.className = `tree-node-status ${status}`; el.title = `Статус: ${status}`; }
  }

  function deleteNode(nodeId) {
    const node = AppState.findNode(nodeId);
    const hasChildren = node?.children?.length > 0;
    const msg = hasChildren
      ? 'Удалить вопрос и все подвопросы?'
      : 'Удалить вопрос?';
    if (!confirm(msg)) return;

    const topic = AppState.getCurrentTopic();
    TreeHelpers.removeNode(topic.nodes, nodeId);

    if (AppState.get('selectedNodeId') === nodeId) {
      AppState.set('selectedNodeId', null);
      AnswerPanel.close?.();
    }
    Persist.save();
    renderTree();
    renderBreadcrumb();
  }

  // ─── Context menu factory ────────────────────────────────────

  function createMenu(items, anchor) {
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';

    items.forEach(item => {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'ctx-menu-sep';
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'ctx-menu-item' + (item.danger ? ' danger' : '');
      if (item.check) btn.classList.add('checked');
      btn.textContent = item.label;
      btn.addEventListener('click', () => { closeCtxMenu(); item.action(); });
      menu.appendChild(btn);
    });

    // Позиционирование
    document.body.appendChild(menu); // нужно для getBoundingClientRect
    const aRect = anchor.getBoundingClientRect();
    const mRect = menu.getBoundingClientRect();
    let top  = aRect.bottom + 4;
    let left = aRect.left;
    if (left + mRect.width > window.innerWidth - 8)  left = aRect.right - mRect.width;
    if (top  + mRect.height > window.innerHeight - 8) top  = aRect.top - mRect.height - 4;
    menu.style.top  = top  + 'px';
    menu.style.left = left + 'px';
    document.body.removeChild(menu); // вернём обратно в caller

    return menu;
  }

  function closeCtxMenu() {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  }

  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

  // ─── Drag & Drop ─────────────────────────────────────────────

  function onDragStart(e) {
    const nodeEl = e.currentTarget;
    _drag.nodeId = nodeEl.dataset.nodeId;
    nodeEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _drag.nodeId);
  }

  function onDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    clearDropIndicators();
    _drag = { nodeId: null, sourceParentId: null, overNodeId: null, overEl: null, position: null };
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // При делегировании currentTarget = $treeContainer, ищем ближайший узел
    const nodeEl   = e.target.closest('.tree-node[draggable]');
    if (!nodeEl) return;
    const targetId = nodeEl.dataset.nodeId;
    if (targetId === _drag.nodeId) return;

    const rect = nodeEl.getBoundingClientRect();
    const relY  = e.clientY - rect.top;
    const zone  = rect.height * 0.25;

    let newPosition;
    if (relY < zone) {
      newPosition = 'before';
    } else if (relY > rect.height - zone) {
      newPosition = 'after';
    } else {
      newPosition = 'inside';
    }

    // Обновляем индикаторы только если цель или позиция изменились — избегаем лишних DOM-операций
    if (_drag.overEl !== nodeEl || _drag.position !== newPosition) {
      // Убрать классы только с предыдущей цели (без querySelectorAll по всему дереву)
      if (_drag.overEl && _drag.overEl !== nodeEl) {
        _drag.overEl.classList.remove('drop-before', 'drop-after', 'drop-inside');
      } else if (_drag.overEl === nodeEl) {
        nodeEl.classList.remove('drop-before', 'drop-after', 'drop-inside');
      }
      _drag.overNodeId = targetId;
      _drag.overEl     = nodeEl;
      _drag.position   = newPosition;
      nodeEl.classList.add('drop-' + newPosition);
    }
  }

  function onDragLeave(e) {
    e.currentTarget.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }

  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDropIndicators();

    const { nodeId, overNodeId, position } = _drag;
    if (!nodeId || !overNodeId || nodeId === overNodeId) return;

    const topic = AppState.getCurrentTopic();
    if (!topic) return;

    if (TreeHelpers.isAncestor(topic.nodes, nodeId, overNodeId)) return;

    const node = TreeHelpers.extractNode(topic.nodes, nodeId);
    if (!node) return;

    if (position === 'inside') {
      node.parentId = overNodeId;
      TreeHelpers.addNode(topic.nodes, overNodeId, node);
      AppState.setNodeOpen(overNodeId, true);
    } else {
      const parentId = TreeHelpers.findParentId(topic.nodes, overNodeId);
      node.parentId  = parentId ?? null;
      TreeHelpers.insertAdjacent(topic.nodes, overNodeId, node, position);
    }

    Persist.save();
    // После DnD — полный ре-рендер (структура изменилась) с пересборкой карты
    _nodeElMap.clear();
    renderTree();
  }

  function clearDropIndicators() {
    // Используем кешированный элемент вместо querySelectorAll по всему дереву
    if (_drag.overEl) {
      _drag.overEl.classList.remove('drop-before', 'drop-after', 'drop-inside');
    } else {
      // Fallback на случай рассинхрона
      $treeContainer.querySelectorAll('.drop-before, .drop-after, .drop-inside')
        .forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    }
  }

  // ════════════════════════════════════════════════════════════
  //  BREADCRUMB
  // ════════════════════════════════════════════════════════════

  function renderBreadcrumb() {
    const topic  = AppState.getCurrentTopic();
    const nodeId = AppState.get('selectedNodeId');

    if (!topic) {
      $breadcrumb.innerHTML = `<span class="breadcrumb-placeholder">Выбери тему</span>`;
      return;
    }
    if (!nodeId) {
      $breadcrumb.innerHTML = `<span>${escHtml(topic.name)}</span>`;
      return;
    }
    const path  = TreeHelpers.getPath(topic.nodes, nodeId) || [];
    const parts = [topic.name, ...path.map(n => n.label)];
    $breadcrumb.innerHTML = parts
      .map((p, i) => `<span class="${i < parts.length - 1 ? 'bc-parent' : 'bc-current'}">${escHtml(p)}</span>`)
      .join(`<span class="bc-sep"> / </span>`);
  }

  // ════════════════════════════════════════════════════════════
  //  NODE SELECTION
  // ════════════════════════════════════════════════════════════

  // Отслеживаем предыдущий выбранный nodeId для точечного снятия класса
  let _prevSelectedNodeId = null;

  function selectNode(nodeId) {
    const prevId = _prevSelectedNodeId;

    AppState.set('selectedNodeId', nodeId);
    _prevSelectedNodeId = nodeId;

    // ── Снять выделение только с предыдущего элемента (без querySelectorAll по всему дереву)
    if (prevId && prevId !== nodeId) {
      const prevRow  = $treeContainer.querySelector(`[data-node-row="${prevId}"]`);
      const prevNode = $treeContainer.querySelector(`[data-node-id="${prevId}"]`);
      prevRow?.classList.remove('selected');
      prevNode?.classList.remove('selected-node');
    }

    // ── Раскрыть всех предков чтобы узел был виден
    const topic = AppState.getCurrentTopic();
    if (topic) {
      const path = TreeHelpers.getPath(topic.nodes, nodeId) || [];
      // path включает сам узел; раскрываем всех кроме последнего
      path.slice(0, -1).forEach(ancestor => {
        if (!AppState.isNodeOpen(ancestor.id)) {
          AppState.setNodeOpen(ancestor.id, true);
          const ancestorEl = $treeContainer.querySelector(`[data-node-id="${ancestor.id}"]`);
          if (ancestorEl) {
            ancestorEl.classList.add('open');
            const childrenEl = ancestorEl.querySelector(':scope > .tree-node-children');
            if (childrenEl && childrenEl.style.display === 'none') {
              const node = AppState.findNode(ancestor.id);
              if (node?.children?.length) {
                childrenEl.innerHTML = renderNodeList(node.children, nodeId);
                bindTreeEvents(childrenEl);
              }
              childrenEl.style.display = '';
            }
          }
        }
      });
    }

    // ── Выделить только новый элемент (без querySelectorAll по всем узлам)
    const newRow  = $treeContainer.querySelector(`[data-node-row="${nodeId}"]`);
    const newNode = $treeContainer.querySelector(`[data-node-id="${nodeId}"]`);
    newRow?.classList.add('selected');
    newNode?.classList.add('selected-node');

    renderBreadcrumb();
    if (typeof AnswerPanel !== 'undefined') AnswerPanel.open(nodeId);

    // Скролл до выбранного узла
    newNode?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ════════════════════════════════════════════════════════════
  //  MODE SWITCHING
  // ════════════════════════════════════════════════════════════

  function switchMode(mode) {
    AppState.set('mode', mode);
    document.querySelectorAll('.mode-tab').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.mode === mode));
    document.querySelectorAll('.content-panel').forEach(p =>
      p.classList.remove('active'));
    document.getElementById('panel-' + mode)?.classList.add('active');

    // Граф v4 управляет своим DOM сам — уведомляем модуль
    if (typeof window.graphModule !== 'undefined') {
      window.graphModule.applyViewMode?.(mode);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  MODALS
  // ════════════════════════════════════════════════════════════

  function openNewTopicModal() {
    document.getElementById('modal-new-topic').classList.remove('hidden');
    setTimeout(() => document.getElementById('input-topic-name')?.focus(), 50);
  }

  function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
  }

  // ─── Sticky header: IntersectionObserver ────────────────────
  let _stickyObserver = null;

  function _initStickyHeader() {
    // Отключаем предыдущий observer если был
    if (_stickyObserver) { _stickyObserver.disconnect(); _stickyObserver = null; }

    const header = document.getElementById('tree-sticky-header');
    if (!header) return;

    // Sentinel-элемент ставим перед header — когда он уходит из виду, header «прилип»
    let sentinel = document.getElementById('tree-sticky-sentinel');
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.id = 'tree-sticky-sentinel';
      sentinel.style.cssText = 'position:absolute;top:0;height:1px;pointer-events:none;';
      $treeContainer.prepend(sentinel);
    }

    _stickyObserver = new IntersectionObserver(
      ([entry]) => { header.classList.toggle('is-stuck', !entry.isIntersecting); },
      { root: $treeContainer, threshold: 0 }
    );
    _stickyObserver.observe(sentinel);
  }

  // ─── Keyboard shortcuts ──────────────────────────────────────
  //   F2            → переименовать выбранный узел
  //   Cmd+Enter     → добавить корневой вопрос
  //   Cmd+Shift+Enter → добавить подвопрос к выбранному узлу
  document.addEventListener('keydown', e => {
    const active = document.activeElement;
    // Не перехватываем когда пользователь что-то вводит
    const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
                     || active.isContentEditable);

    if (e.key === 'F2') {
      const nodeId = AppState.get('selectedNodeId');
      if (nodeId) { e.preventDefault(); startNodeRename(nodeId); }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && e.metaKey) {
      const nodeId = AppState.get('selectedNodeId');
      if (nodeId) { e.preventDefault(); deleteNode(nodeId); }
    }

    // Cmd+Enter → новый корневой вопрос
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.shiftKey && !isTyping) {
      e.preventDefault();
      const topic = AppState.getCurrentTopic();
      if (topic) addNodeInline(null);
    }

    // Cmd+Shift+Enter → подвопрос к выбранному узлу
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter' && !isTyping) {
      e.preventDefault();
      const topic  = AppState.getCurrentTopic();
      const nodeId = AppState.get('selectedNodeId');
      if (topic && nodeId) {
        AppState.setNodeOpen(nodeId, true);
        addNodeInline(nodeId);
      } else if (topic) {
        addNodeInline(null);
      }
    }
  });

  // ─── Utils ───────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }


  return {
    renderTopicsList, renderTree, renderBreadcrumb,
    selectTopic, selectNode,
    switchMode,
    openNewTopicModal, closeModal,
    addNodeInline,
    escHtml,
  };
})();