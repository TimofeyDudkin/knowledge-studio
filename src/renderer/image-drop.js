/**
 * image-drop.js — вставка изображений в ответ узла.
 *
 * Три способа добавить картинку:
 *   1. Drag & Drop на зону просмотра / редактора answer-panel
 *   2. Ctrl+V / Cmd+V (paste из буфера обмена) когда панель открыта
 *   3. Кнопка «Вставить изображение» (открывает диалог выбора файла)
 *
 * Картинки хранятся как base64 data-URL прямо в markdown ответа:
 *   ![image](data:image/png;base64,…)
 *
 * Подключать ПОСЛЕ answer-panel.js.
 */

window.ImageDropModule = (() => {
  'use strict';

  // ── Вспомогательные ──────────────────────────────────────────

  function _readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.readAsDataURL(file);
    });
  }

  function _isImageFile(file) {
    return file && file.type && file.type.startsWith('image/');
  }

  // ── Масштабирование: максимум 1400px по ширине (сохраняет читаемость + размер) ──
  function _resizeImage(dataUrl, maxW = 1400) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (w <= maxW) { resolve(dataUrl); return; }
        const scale = maxW / w;
        const canvas = document.createElement('canvas');
        canvas.width = maxW;
        canvas.height = Math.round(h * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = () => resolve(dataUrl); // не смогли — возвращаем как есть
      img.src = dataUrl;
    });
  }

  // ── Вставка dataUrl в текущий ответ узла ─────────────────────
  async function _insertImageIntoAnswer(dataUrl, label = 'image') {
    const nodeId = _getCurrentNodeId();
    if (!nodeId) {
      _showHint('Откройте узел чтобы вставить изображение');
      return;
    }

    const resized = await _resizeImage(dataUrl);
    const mdImg = `\n\n![${label}](${resized})\n`;

    const topic = AppState.getCurrentTopic();
    if (!topic) return;

    const node = AppState.findNode(nodeId);
    if (!node) return;

    const currentAnswer = node.answer || '';
    const newAnswer = currentAnswer + mdImg;

    // Если сейчас в режиме редактирования — вставляем в textarea.
    // Есть два независимых редактора с одинаковой разметкой: answer-panel
    // (#ap-textarea) и панель узла в графе (#gnp-ta) — используем тот, что
    // сейчас реально открыт, иначе вставка в VIEW-режиме затирает несохранённый
    // текст второго редактора значением node.answer из хранилища.
    const ta = document.getElementById('ap-textarea') || document.getElementById('gnp-ta');
    if (ta) {
      // В textarea вставляем плейсхолдер, а не полный base64 —
      // иначе редактор зависает на огромной строке.
      // Используем тот же механизм collapse что в answer-panel.js:
      // просим его добавить картинку в кеш и вернуть плейсхолдер.
      let insertText;
      if (typeof AnswerPanel !== 'undefined' && AnswerPanel.cacheImage) {
        const key = AnswerPanel.cacheImage(resized);
        const kb  = Math.round(resized.length * 0.75 / 1024);
        insertText = `\n\n![${label}](${key} «${kb} KB»)\n`;
      } else {
        insertText = mdImg; // fallback
      }
      const pos = ta.selectionEnd;
      const val = ta.value;
      ta.value = val.slice(0, pos) + insertText + val.slice(pos);
      ta.selectionStart = ta.selectionEnd = pos + insertText.length;
      ta.focus();
      // Обновляем live preview если открыт
      const pc = document.getElementById('ap-live-preview-content');
      if (pc && !document.getElementById('ap-live-preview')?.classList.contains('hidden')) {
        if (window.AnswerPanel?._renderIntoContainer) {
          window.AnswerPanel._renderIntoContainer(pc, window.AnswerPanel._expandImages?.(ta.value) ?? ta.value);
        }
      }
      _showHint('Изображение вставлено в редактор', 'success');
    } else {
      // VIEW режим — сохраняем напрямую
      if (typeof AnswerPanel !== 'undefined') {
        AnswerPanel.setAnswer(nodeId, newAnswer);
        _showHint('Изображение добавлено к ответу', 'success');
      }
    }
  }

  function _getCurrentNodeId() {
    return AppState?.get?.('selectedNodeId') || null;
  }

  // ── Toast-уведомление ────────────────────────────────────────
  let _hintTimer = null;
  function _showHint(msg, type = 'info') {
    let hint = document.getElementById('img-drop-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'img-drop-hint';
      document.body.appendChild(hint);
    }
    hint.textContent = msg;
    hint.className = 'img-drop-hint img-drop-hint--' + type + ' img-drop-hint--show';
    clearTimeout(_hintTimer);
    _hintTimer = setTimeout(() => { hint.classList.remove('img-drop-hint--show'); }, 2800);
  }

  // ── Overlay для drag-and-drop ─────────────────────────────────
  let _dragOverlay = null;
  let _dragCounter = 0;

  function _getAnswerPanel() {
    return document.getElementById('answer-panel');
  }

  function _showDragOverlay() {
    if (_dragOverlay) return;

    const panel = _getAnswerPanel();
    const hasEditor = panel && !panel.classList.contains('collapsed');

    _dragOverlay = document.createElement('div');
    _dragOverlay.className = 'img-drop-overlay-global';
    _dragOverlay.innerHTML = `
      <div class="img-drop-global-inner">
        <div class="img-drop-zone img-drop-zone--viewer" id="idz-viewer">
          <div class="img-drop-zone-icon">🔍</div>
          <div class="img-drop-zone-title">Открыть в просмотрщике</div>
          <div class="img-drop-zone-sub">Масштаб · Панорама · Shift+Колесо</div>
        </div>
        ${hasEditor ? `<div class="img-drop-zone img-drop-zone--editor" id="idz-editor">
          <div class="img-drop-zone-icon">✏️</div>
          <div class="img-drop-zone-title">Вставить в редактор</div>
          <div class="img-drop-zone-sub">Добавить изображение в ответ</div>
        </div>` : ''}
      </div>`;
    document.body.appendChild(_dragOverlay);

    _dragOverlay.addEventListener('dragover', ev => {
      const zones = _dragOverlay.querySelectorAll('.img-drop-zone');
      zones.forEach(z => z.classList.remove('img-drop-zone--hover'));
      const over = [...zones].find(z => {
        const r = z.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      });
      if (over) over.classList.add('img-drop-zone--hover');
    });
  }

  function _hideDragOverlay() {
    if (_dragOverlay) {
      _dragOverlay.remove();
      _dragOverlay = null;
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  ВСТРОЕННЫЙ ПРОСМОТРЩИК ИЗОБРАЖЕНИЙ
  // ══════════════════════════════════════════════════════════════

  let _viewerState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 };
  // Ссылка на _closeViewer текущего открытого просмотрщика — вызываем её
  // (а не просто .remove() DOM-узла) при открытии нового, иначе слушатели
  // window mousemove/mouseup и document keydown старого инстанса остаются
  // висеть навсегда (а его self-cleanup в _onKey не срабатывает, т.к. проверяет
  // по id элемента, который новый viewer тоже удовлетворяет).
  let _closeActiveViewer = null;

  function _openImageViewer(dataUrl, label) {
    // Закрываем старый если есть — снимает его обработчики, а не просто прячет DOM
    _closeActiveViewer?.();

    const viewer = document.createElement('div');
    viewer.id = 'img-inline-viewer';
    viewer.className = 'img-inline-viewer';

    // Создаём структуру через DOM — НЕ через innerHTML с dataUrl,
    // иначе браузер зависает при парсинге огромного base64 в атрибуте src
    viewer.innerHTML = `
      <div class="iiv-toolbar">
        <span class="iiv-title">${_escHtml(label || 'Изображение')}</span>
        <div class="iiv-toolbar-actions">
          <button class="iiv-btn" id="iiv-zoom-out" title="Уменьшить (−)">−</button>
          <span class="iiv-zoom-label" id="iiv-zoom-label">100%</span>
          <button class="iiv-btn" id="iiv-zoom-in" title="Увеличить (+)">+</button>
          <button class="iiv-btn" id="iiv-zoom-fit" title="По размеру окна">⟷</button>
          <button class="iiv-btn" id="iiv-zoom-orig" title="Оригинальный размер">1:1</button>
          <div class="iiv-sep"></div>
          <button class="iiv-btn iiv-btn-insert" id="iiv-insert" title="Вставить в редактор">↙ В редактор</button>
          <button class="iiv-btn iiv-btn-close" id="iiv-close" title="Закрыть (Esc)">✕</button>
        </div>
      </div>
      <div class="iiv-canvas-wrap" id="iiv-canvas-wrap"></div>
      <div class="iiv-hint">Колесо — масштаб · Shift+Колесо — прокрутка по горизонтали · ЛКМ+тяга — перемещение · Esc — закрыть</div>
    `;

    // Создаём img через DOM и назначаем src программно — браузер не парсит base64 в HTML
    const $img = document.createElement('img');
    $img.id        = 'iiv-img';
    $img.className = 'iiv-img';
    $img.alt       = label || 'image';
    $img.draggable = false;

    document.body.appendChild(viewer);
    document.getElementById('iiv-canvas-wrap').appendChild($img);

    // src назначаем ПОСЛЕ вставки в DOM — избегаем двойного layout
    $img.src = dataUrl;

    // Состояние
    _viewerState = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 };

    const $wrap = document.getElementById('iiv-canvas-wrap');
    const $lbl  = document.getElementById('iiv-zoom-label');

    function _applyTransform() {
      $img.style.transform = `translate(${_viewerState.x}px, ${_viewerState.y}px) scale(${_viewerState.zoom})`;
      $lbl.textContent = Math.round(_viewerState.zoom * 100) + '%';
    }

    function _setZoom(z, pivotX, pivotY) {
      const prev = _viewerState.zoom;
      _viewerState.zoom = Math.max(0.1, Math.min(10, z));
      // Масштабировать относительно точки курсора
      if (pivotX !== undefined) {
        const scale = _viewerState.zoom / prev;
        _viewerState.x = pivotX + (_viewerState.x - pivotX) * scale;
        _viewerState.y = pivotY + (_viewerState.y - pivotY) * scale;
      }
      _applyTransform();
    }

    function _fitToWindow() {
      $img.onload = null;
      const ww = $wrap.clientWidth  - 48;
      const wh = $wrap.clientHeight - 48;
      const iw = $img.naturalWidth  || $img.width  || 800;
      const ih = $img.naturalHeight || $img.height || 600;
      const z  = Math.min(ww / iw, wh / ih, 1);
      _viewerState.x = 0;
      _viewerState.y = 0;
      _viewerState.zoom = z;
      _applyTransform();
    }

    // Подождём загрузки изображения чтобы получить натуральный размер
    if ($img.complete && $img.naturalWidth) {
      _fitToWindow();
    } else {
      $img.onload = _fitToWindow;
    }

    // ── Колесо мыши ──────────────────────────────────────────────
    $wrap.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey) {
        // Shift+Wheel → горизонтальная прокрутка (панорамирование)
        _viewerState.x -= e.deltaY * 0.8;
        _applyTransform();
        return;
      }

      // Обычное Wheel → зум относительно курсора
      const rect = $wrap.getBoundingClientRect();
      const px = e.clientX - rect.left - $wrap.clientWidth  / 2;
      const py = e.clientY - rect.top  - $wrap.clientHeight / 2;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      _setZoom(_viewerState.zoom * factor, px, py);
    }, { passive: false });

    // ── Перетаскивание (pan) ──────────────────────────────────────
    $wrap.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      _viewerState.dragging = true;
      _viewerState.startX   = e.clientX;
      _viewerState.startY   = e.clientY;
      _viewerState.startPanX = _viewerState.x;
      _viewerState.startPanY = _viewerState.y;
      $wrap.style.cursor = 'grabbing';
      e.preventDefault();
    });
    function _onMouseMove(e) {
      if (!_viewerState.dragging) return;
      _viewerState.x = _viewerState.startPanX + (e.clientX - _viewerState.startX);
      _viewerState.y = _viewerState.startPanY + (e.clientY - _viewerState.startY);
      _applyTransform();
    }
    function _onMouseUp() {
      if (!_viewerState.dragging) return;
      _viewerState.dragging = false;
      $wrap.style.cursor = 'grab';
    }
    window.addEventListener('mousemove', _onMouseMove);
    window.addEventListener('mouseup', _onMouseUp);

    // ── Кнопки ────────────────────────────────────────────────────
    document.getElementById('iiv-zoom-in') ?.addEventListener('click', () => _setZoom(_viewerState.zoom * 1.25));
    document.getElementById('iiv-zoom-out')?.addEventListener('click', () => _setZoom(_viewerState.zoom / 1.25));
    document.getElementById('iiv-zoom-fit') ?.addEventListener('click', _fitToWindow);
    document.getElementById('iiv-zoom-orig')?.addEventListener('click', () => { _viewerState.x = 0; _viewerState.y = 0; _setZoom(1); });

    function _closeViewer() {
      if (_closeActiveViewer === _closeViewer) _closeActiveViewer = null;
      window.removeEventListener('mousemove', _onMouseMove);
      window.removeEventListener('mouseup', _onMouseUp);
      document.removeEventListener('keydown', _onKey, true);
      // Сразу убираем pointer-events — иначе 180мс анимации блокируют ресайзер и клики
      viewer.style.pointerEvents = 'none';
      viewer.classList.add('iiv-closing');
      setTimeout(() => {
        viewer.remove();
        // Восстанавливаем flex дерева — viewer мог заморозить layout
        const tc = document.getElementById('tree-container');
        const ap = document.getElementById('answer-panel');
        const ra = document.getElementById('resize-answer');
        if (tc && ap && !ap.classList.contains('collapsed')) {
          const savedW = Math.max(280, AppState?.get?.('layout')?.treeWidth || tc.offsetWidth || 380);
          tc.style.flex  = '0 0 auto';
          tc.style.width = savedW + 'px';
        }
        // Принудительный reflow — возвращает resize-handle в рабочее состояние
        if (ra) { void ra.offsetHeight; }
        if (tc) { void tc.offsetHeight; }
        // Возвращаем фокус — иначе после закрытия viewer браузер теряет фокус
        // и весь UI перестаёт реагировать на клавиши и ресайзер до следующего клика
        const ta = document.getElementById('ap-textarea');
        if (ta) {
          ta.focus();
        } else {
          // view-режим: фокусируем answer-content чтобы scroll и клавиши работали
          const ac = document.getElementById('answer-content');
          if (ac) {
            if (!ac.hasAttribute('tabindex')) ac.setAttribute('tabindex', '-1');
            ac.focus({ preventScroll: true });
          } else {
            // последний резерв
            if (!document.body.hasAttribute('tabindex')) document.body.setAttribute('tabindex', '-1');
            document.body.focus({ preventScroll: true });
          }
        }
      }, 180);
    }

    _closeActiveViewer = _closeViewer;

    document.getElementById('iiv-close')?.addEventListener('click', _closeViewer);

    document.getElementById('iiv-insert')?.addEventListener('click', async () => {
      await _insertImageIntoAnswer(dataUrl, label || 'image');
      _closeViewer();
    });

    // ── Клавиши ───────────────────────────────────────────────────
    function _onKey(e) {
      if (!document.getElementById('img-inline-viewer')) {
        document.removeEventListener('keydown', _onKey);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        _closeViewer();
        return;
      }
      if (e.key === '=' || e.key === '+') _setZoom(_viewerState.zoom * 1.2);
      if (e.key === '-') _setZoom(_viewerState.zoom / 1.2);
      if (e.key === '0') { _viewerState.x = 0; _viewerState.y = 0; _setZoom(1); }
    }
    // capture: true — перехватываем раньше других обработчиков
    document.addEventListener('keydown', _onKey, true);

    // Анимация появления
    requestAnimationFrame(() => viewer.classList.add('iiv-visible'));
  }

  function _escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Биндинги drag & drop ──────────────────────────────────────
  function _bindDragDrop() {
    // Используем делегирование через document
    document.addEventListener('dragenter', e => {
      if (!_hasImageFile(e.dataTransfer)) return;
      _dragCounter++;
      _showDragOverlay(e);
      e.preventDefault();
    }, false);

    document.addEventListener('dragover', e => {
      if (!_hasImageFile(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }, false);

    document.addEventListener('dragleave', e => {
      if (!_hasImageFile(e.dataTransfer)) return;
      _dragCounter--;
      if (_dragCounter <= 0) {
        _dragCounter = 0;
        _hideDragOverlay();
      }
    }, false);

    document.addEventListener('drop', async e => {
      _dragCounter = 0;
      _hideDragOverlay();

      const dt    = e.dataTransfer;
      const files = [...(dt?.files || [])].filter(_isImageFile);
      const items = [...(dt?.items || [])];

      // Проверяем есть ли изображение (файл или URL)
      const hasImg = files.length > 0
        || items.some(it => it.kind === 'file' && it.type.startsWith('image/'))
        || !!(dt && _extractImageUrl(dt));
      if (!hasImg) return;
      e.preventDefault();

      // Определяем — упало ли на редактор или нет
      const panel = _getAnswerPanel();
      const isOnEditor = panel && panel.contains(e.target);

      // Собираем все DataURL
      const urls = [];

      // 1. Файлы (drag из файловой системы или webview-blob)
      for (const file of files) {
        urls.push({ url: await _readFileAsDataURL(file), label: file.name.replace(/\.[^.]+$/, '') });
      }
      if (files.length === 0) {
        for (const item of items) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) urls.push({ url: await _readFileAsDataURL(file), label: 'image' });
          }
        }
      }

      // 2. URL-ссылка (drag img-тега из браузера / ИИ-панели)
      if (urls.length === 0 && dt) {
        const imgUrl = _extractImageUrl(dt);
        if (imgUrl) {
          _showHint('Загрузка изображения…', 'info');
          try {
            const dataUrl = await _fetchImageAsDataUrl(imgUrl);
            const label = imgUrl.split('/').pop().split('?')[0].replace(/\.[^.]+$/, '') || 'image';
            urls.push({ url: dataUrl, label });
          } catch (err) {
            // CORS заблокировал — открываем напрямую по URL (не base64)
            console.warn('[image-drop] fetch failed, opening URL directly:', err);
            urls.push({ url: imgUrl, label: 'image', isRemoteUrl: true });
          }
        }
      }

      if (!urls.length) return;

      if (isOnEditor) {
        // Drop на редактор → вставляем в ответ (старое поведение)
        for (const { url, label } of urls) {
          await _insertImageIntoAnswer(url, label);
        }
      } else {
        // Проверяем попал ли в зону редактора в оверлее
        const editorZone = document.getElementById('idz-editor');
        const inEditorZone = editorZone && (() => {
          const r = editorZone.getBoundingClientRect();
          return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        })();

        if (inEditorZone) {
          for (const { url, label } of urls) {
            await _insertImageIntoAnswer(url, label);
          }
        } else {
          // Drop на зону просмотра или где угодно → открываем просмотрщик
          const { url, label } = urls[0];
          _openImageViewer(url, label);
          if (urls.length > 1) _showHint(`Открыто первое из ${urls.length} изображений`, 'info');
        }
      }
    }, false);
  }

  function _hasImageFile(dt) {
    if (!dt) return false;
    const types = dt.types || [];
    // Файлы (drag из проводника / из webview как blob)
    if (types.includes('Files')) {
      if (dt.items) {
        return [...dt.items].some(it => it.kind === 'file' && it.type.startsWith('image/'));
      }
      return true;
    }
    // URL-ссылка на картинку (drag img из браузера / ИИ-панели)
    if (types.includes('text/uri-list') || types.includes('text/html')) return true;
    return false;
  }

  // ── Извлечь URL картинки из dataTransfer ─────────────────────
  // text/html даёт src самого <img> — надёжный сигнал, доверяем ему даже
  // без расширения в URL (CDN часто отдают картинки без .jpg/.png).
  // text/uri-list и text/plain — просто перетащенная ссылка (может вести
  // на любую страницу, не только на картинку) — проверяем расширение,
  // чтобы не пытаться открыть/вставить как изображение произвольный URL.
  function _extractImageUrl(dt) {
    // 1. text/html — ищем src у <img> (самый надёжный источник)
    if (dt.types?.includes('text/html')) {
      const html = dt.getData('text/html') || '';
      const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m) return m[1];
    }
    // 2. text/uri-list — прямой URL
    if (dt.types?.includes('text/uri-list')) {
      const raw = dt.getData('text/uri-list');
      const url = (raw || '').split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#'));
      if (url && _looksLikeImageUrl(url)) return url;
    }
    // 3. text/plain — если это просто URL
    if (dt.types?.includes('text/plain')) {
      const txt = (dt.getData('text/plain') || '').trim();
      if (/^https?:\/\//i.test(txt) && _looksLikeImageUrl(txt)) return txt;
    }
    return null;
  }

  function _looksLikeImageUrl(url) {
    return /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico)(\?.*)?$/i.test(url);
  }

  // ── Загрузить изображение по URL через Electron IPC или XHR ──
  async function _fetchImageAsDataUrl(url) {
    // 1. Electron IPC — main process делает запрос, нет CORS
    if (window.electronAPI?.fetchImageAsDataUrl) {
      try {
        const result = await window.electronAPI.fetchImageAsDataUrl(url);
        if (result) return result;
      } catch (err) {
        console.warn('[image-drop] IPC fetch failed:', err);
      }
    }
    // 2. XMLHttpRequest — в Electron renderer нет CORS-проблем (в отличие от браузера)
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.timeout = 15000;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          _readFileAsDataURL(xhr.response).then(resolve).catch(reject);
        } else {
          reject(new Error('HTTP ' + xhr.status));
        }
      };
      xhr.onerror   = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.send();
    });
  }

  // ── Paste из буфера обмена (глобальный) ──────────────────────
  // Есть два независимых редактора ответа: answer-panel (#answer-panel,
  // #ap-textarea) в дереве вопросов и панель узла в графе (#graph-node-panel,
  // #gnp-ta) — раньше paste работал только для первого, и Ctrl+V молча
  // игнорировался при редактировании ответа в режиме "Граф".
  function _bindPaste() {
    document.addEventListener('paste', async e => {
      const apPanel  = _getAnswerPanel();
      const apOpen   = apPanel && !apPanel.classList.contains('collapsed');
      const gnpPanel = document.getElementById('graph-node-panel');
      const gnpTa    = document.getElementById('gnp-ta');
      if (!apOpen && !gnpTa) return;

      const items = [...(e.clipboardData?.items || [])];
      const imgItems = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
      if (!imgItems.length) return;

      // Не перехватываем если фокус в постороннем <input>/<textarea>
      const active = document.activeElement;
      const isOurTextarea = active?.id === 'ap-textarea' || active?.id === 'gnp-ta';
      const isBody = !active || active === document.body || active === document.documentElement;
      const inOurPanel = (apOpen && apPanel.contains(active)) || (gnpPanel && gnpPanel.contains(active));
      if (!isOurTextarea && !isBody && !inOurPanel) return;

      e.preventDefault();

      for (const item of imgItems) {
        const file = item.getAsFile();
        if (!file) continue;
        const url = await _readFileAsDataURL(file);
        await _insertImageIntoAnswer(url, 'clipboard-image');
      }
    });
  }

  // ── Кнопка открытия файла ─────────────────────────────────────
  function _createFileInput() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.style.display = 'none';
    inp.id = 'img-drop-file-input';
    document.body.appendChild(inp);

    inp.addEventListener('change', async () => {
      const files = [...inp.files].filter(_isImageFile);
      for (const file of files) {
        const url = await _readFileAsDataURL(file);
        await _insertImageIntoAnswer(url, file.name.replace(/\.[^.]+$/, ''));
      }
      inp.value = '';
    });

    return inp;
  }

  // ── Добавляем кнопку в тулбар редактора ──────────────────────
  function _injectToolbarButton() {
    const toolbar = document.getElementById('ap-fmt-toolbar');
    if (!toolbar || toolbar.querySelector('.ap-img-btn')) return;

    const sep = document.createElement('div');
    sep.className = 'ap-fmt-sep';

    const btn = document.createElement('button');
    btn.className = 'ap-fmt-btn ap-img-btn';
    btn.title = 'Вставить изображение (drag/drop, Ctrl+V, или выбрать файл)';
    btn.innerHTML = `<svg viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.3" style="width:14px;height:12px"><rect x="1" y="1" width="12" height="10" rx="1.5"/><circle cx="4.5" cy="4.5" r="1"/><path d="M1 9l3-3 2.5 2.5L9 5.5l4 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    btn.addEventListener('click', () => {
      const inp = document.getElementById('img-drop-file-input') || _createFileInput();
      inp.click();
    });

    // Вставляем перед spacer (последний элемент)
    const children = [...toolbar.children];
    const spacer = children.find(el => el.style.flex === '1');
    if (spacer) {
      toolbar.insertBefore(sep, spacer);
      toolbar.insertBefore(btn, spacer);
    } else {
      toolbar.appendChild(sep);
      toolbar.appendChild(btn);
    }
  }

  // ── Наблюдаем за появлением тулбара (EDIT mode) ───────────────
  function _watchToolbar() {
    const obs = new MutationObserver(() => {
      if (document.getElementById('ap-fmt-toolbar')) {
        _injectToolbarButton();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Если уже есть
    if (document.getElementById('ap-fmt-toolbar')) _injectToolbarButton();
  }

  // ── Стили ────────────────────────────────────────────────────
  function _injectStyles() {}

  // ── Клик по картинке в ответе → открываем inline-viewer ─────
  function _bindLightbox() {
    document.addEventListener('click', e => {
      if (e.target.matches('.ap-answer-body .md-img')) {
        _openImageViewer(e.target.src, e.target.alt || 'Изображение');
      }
    });
  }

  // ── Инициализация ─────────────────────────────────────────────
  function init() {
    _injectStyles();
    _createFileInput();
    _bindDragDrop();
    _bindPaste();
    _bindLightbox();
    _watchToolbar();

    console.log('[image-drop] ✓ ImageDropModule initialized — drag/paste/open');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { insertImage: _insertImageIntoAnswer, openViewer: _openImageViewer };
})();
