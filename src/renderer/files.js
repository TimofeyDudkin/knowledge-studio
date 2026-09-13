/**
 * files.js — File Manager + PDF/Image/Text Viewer
 * Knowledge Studio · Renderer Module
 *
 * Поддерживаемые типы:
 *   PDF   → pdf.js (canvas, постраничный рендер)
 *   Image → <img> + zoom
 *   Text/Markdown → fetch + renderMarkdown / <pre>
 *   Other → заглушка с кнопкой «Открыть в системе»
 */

window.FilesModule = (() => {

  // ══════════════════════════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════════════════════════

  let _files        = [];       // FileRecord[]
  let _activeFileId = null;
  let _pdfInstances = {};       // fileId → PDFDocumentProxy
  let _currentPage  = {};       // fileId → number
  let _pdfZoom      = {};       // fileId → scale (0.5–3.0)
  let _imgZoom      = {};       // fileId → scale
  let _docxZoom     = {};       // fileId → scale (0.6–2.0)
  let _docxPage     = {};       // fileId → текущая страница (1-based)
  let _docxTotal    = {};       // fileId → всего страниц

  // PPTX → PDF конвертация
  // fileId → { status: 'idle'|'checking'|'converting'|'ready'|'error', pdfPath, error, libreOfficePath }
  let _pptxState    = {};
  // Кэш результата проверки LibreOffice на машине (один раз за сессию)
  let _loCheck      = null;   // null | { found, path, version }

  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'];
  const TEXT_EXTS  = ['txt', 'md', 'markdown', 'log', 'csv', 'json', 'js', 'ts', 'html', 'css', 'xml'];
  const DOCX_EXTS  = ['docx', 'doc'];
  const PPTX_EXTS  = ['pptx', 'ppt'];

  // ══════════════════════════════════════════════════════════
  //  INIT / RESTORE
  // ══════════════════════════════════════════════════════════

  // ── Вспомогательная: собрать прикреплённые файлы из node.attachments темы ──
  function _collectAttachedPaths(topic) {
    const map = new Map(); // filePath → Set<nodeId>
    function walk(nodes) {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes) {
        if (Array.isArray(n.attachments)) {
          n.attachments.forEach(p => {
            if (!map.has(p)) map.set(p, new Set());
            map.get(p).add(n.id);
          });
        }
        if (n.children) walk(n.children);
      }
    }
    walk(topic.nodes || []);
    return map;
  }

  // ── Загрузить и проверить существование файлов (список FileRecord[]) ──
  async function _loadAndVerify(records) {
    const checked = await Promise.all(records.map(async f => {
      try {
        const r = await fetch('file://' + f.path, { method: 'HEAD' });
        return r.ok ? f : null;
      } catch {
        try { await fetch('file://' + f.path); return f; } catch { return null; }
      }
    }));
    return checked.filter(Boolean).map(f => {
      // Миграция: старый nodeId → nodeIds
      if (!Array.isArray(f.nodeIds)) {
        f.nodeIds = f.nodeId ? [f.nodeId] : [];
        delete f.nodeId;
      }
      return f;
    });
  }

  // ── Переключить отображаемые файлы на конкретную тему ──
  async function _switchToTopic(topicId) {
    // Освободить PDF-инстансы текущих файлов
    _files.forEach(f => {
      if (_pdfInstances[f.id]) {
        try { _pdfInstances[f.id].destroy(); } catch {}
        delete _pdfInstances[f.id];
      }
      if (_pptxState[f.id]) {
        const ps = _pptxState[f.id];
        if (ps.pdfPath && window.electronAPI?.cleanupPptxTmp) {
          window.electronAPI.cleanupPptxTmp(ps.pdfPath).catch(() => {});
        }
        delete _pptxState[f.id];
      }
    });

    _files        = [];
    _activeFileId = null;
    _currentPage  = {};
    _pdfZoom      = {};
    _imgZoom      = {};
    _docxZoom     = {};
    _docxPage     = {};
    _docxTotal    = {};

    if (!topicId) { _renderAll(); return; }

    const topic = AppState.getTopic(topicId);
    if (!topic) { _renderAll(); return; }

    // 1. Взять сохранённые openFiles темы
    const savedFiles = Array.isArray(topic.openFiles) ? topic.openFiles : [];

    // 2. Собрать прикреплённые пути из node.attachments
    const attachedPaths = _collectAttachedPaths(topic);

    // 3. Проверить существование сохранённых файлов
    let restored = await _loadAndVerify(savedFiles);

    // 4. Добавить прикреплённые файлы которых ещё нет в списке
    const openPathSet = new Set(restored.map(f => f.path));
    const extraRecords = [];
    for (const [p, nodeIdSet] of attachedPaths.entries()) {
      if (openPathSet.has(p)) continue;
      const name = p.split(/[\\/]/).pop();
      const ext  = name.split('.').pop().toLowerCase();
      extraRecords.push({
        id: 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        path: p, name, ext,
        type: _fileType(ext),
        nodeIds: [...nodeIdSet],
        addedAt: Date.now(),
      });
    }
    const extraVerified = await _loadAndVerify(extraRecords);

    // 5. Объединить и синхронизировать nodeIds
    _files = [...restored, ...extraVerified];
    _files.forEach(f => {
      const fromNodes = attachedPaths.get(f.path);
      if (fromNodes && fromNodes.size > 0) {
        const merged = new Set([...(f.nodeIds || []), ...fromNodes]);
        f.nodeIds = [...merged];
      } else {
        f.nodeIds = f.nodeIds || [];
      }
    });

    _activeFileId = _files.length ? _files[0].id : null;
    _renderAll();
  }

  async function init() {
    _annotLoadFromStorage();

    // Миграция: если есть глобальные openFiles (старый формат) — переносим в текущую тему
    const globalFiles = AppState.get('openFiles');
    if (Array.isArray(globalFiles) && globalFiles.length) {
      const topicId = AppState.get('currentTopicId');
      if (topicId) {
        const topic = AppState.getTopic(topicId);
        if (topic && !Array.isArray(topic.openFiles)) {
          topic.openFiles = globalFiles;
          Persist.save();
        }
      }
      AppState.set('openFiles', null);
    }

    await _switchToTopic(AppState.get('currentTopicId'));
  }

  // ══════════════════════════════════════════════════════════
  //  FILE TYPE HELPERS
  // ══════════════════════════════════════════════════════════

  function _fileType(ext) {
    if (ext === 'pdf')               return 'pdf';
    if (IMAGE_EXTS.includes(ext))    return 'image';
    if (TEXT_EXTS.includes(ext))     return 'text';
    if (DOCX_EXTS.includes(ext))     return 'docx';
    if (PPTX_EXTS.includes(ext))     return 'pptx';
    return 'other';
  }

  function _fileIconSvg(type) {
    const icons = {
      pdf:   `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="1" width="10" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 5h5M5 8h5M5 11h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M10 1v3.5H13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      image: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="5.5" cy="6" r="1.2" fill="currentColor"/><path d="M1.5 11l3.5-3 3 2.5 2-2L14.5 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      text:  `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="1" width="10" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
      other: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="1" width="10" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M10 1v3.5H13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    };
    return icons[type] || icons.other;
  }

  // ══════════════════════════════════════════════════════════
  //  OPEN FILE
  // ══════════════════════════════════════════════════════════

  async function openFile() {
    let result;
    try {
      result = await IPC.openFile();
    } catch (e) {
      _showFlash('Не удалось открыть диалог выбора файла', 'error');
      return;
    }
    if (!result || result.canceled || !result.filePaths?.length) return;
    const path = result.filePaths[0];
    openFileByPath(path);
  }

  async function openFileByPath(path) {
    // Дедупликация
    const existing = _files.find(f => f.path === path);
    if (existing) {
      _activeFileId = existing.id;
      _renderAll();
      return;
    }

    const name = path.split(/[\\/]/).pop();
    const ext  = name.split('.').pop().toLowerCase();
    const id   = 'file_' + Date.now();
    const type = _fileType(ext);

    const record = { id, path, name, ext, type, nodeIds: [], addedAt: Date.now() };
    _files.push(record);
    _activeFileId    = id;
    _currentPage[id] = 1;
    _pdfZoom[id]     = 0;   // 0 = fit-width
    _imgZoom[id]     = 1.0;

    _renderAll();
    _persistOpenFiles();

    // Сразу начать загрузку pdf.js если PDF
    if (type === 'pdf') {
      _loadPdf(record);
    }
  }

  // ══════════════════════════════════════════════════════════
  //  CLOSE FILE
  // ══════════════════════════════════════════════════════════

  function _closeFile(id) {
    const idx = _files.findIndex(f => f.id === id);
    if (idx === -1) return;
    _files.splice(idx, 1);

    // Освободить pdf-инстанс
    if (_pdfInstances[id]) {
      try { _pdfInstances[id].destroy(); } catch {}
      delete _pdfInstances[id];
    }
    // Почистить все связанные записи состояния
    delete _currentPage[id];
    delete _pdfZoom[id];
    delete _imgZoom[id];
    delete _docxZoom[id];
    delete _docxPage[id];
    delete _docxTotal[id];

    // Очистить временный PDF от конвертации PPTX
    if (_pptxState[id]) {
      const ps = _pptxState[id];
      if (ps.pdfPath && window.electronAPI?.cleanupPptxTmp) {
        window.electronAPI.cleanupPptxTmp(ps.pdfPath).catch(() => {});
      }
      delete _pptxState[id];
    }

    if (_activeFileId === id) {
      _activeFileId = _files.length ? _files[Math.max(0, idx - 1)].id : null;
    }

    _renderAll();
    _persistOpenFiles();
  }

  // ══════════════════════════════════════════════════════════
  //  ATTACH / DETACH
  // ══════════════════════════════════════════════════════════

  function attachToNode(filePath, nodeId) {
    const topic = AppState.getCurrentTopic();
    if (!topic) return;
    const node = AppState.findNode(nodeId);
    if (!node) return;

    // Добавить в node.attachments если ещё нет
    const attachments = node.attachments || [];
    if (!attachments.includes(filePath)) {
      TreeHelpers.updateNode(topic.nodes, nodeId, {
        attachments: [...attachments, filePath],
      });
      Render.renderTree();
    }

    // Обновить запись в _files — добавить nodeId в массив
    let record = _files.find(f => f.path === filePath);
    if (!record) {
      // Файл ещё не открыт — открыть его автоматически
      openFileByPath(filePath);
      record = _files.find(f => f.path === filePath);
    }
    if (record) {
      if (!Array.isArray(record.nodeIds)) record.nodeIds = record.nodeId ? [record.nodeId] : [];
      if (!record.nodeIds.includes(nodeId)) record.nodeIds.push(nodeId);
      delete record.nodeId; // убрать старый формат
      _renderSidebar();

    }
    Persist.save();
    _showFlash(`Прикреплено к «${node.label.slice(0, 40)}»`, 'success');
  }

  function detachFromNode(fileId, nodeId) {
    const record = _files.find(f => f.id === fileId);
    if (!record) return;

    if (!Array.isArray(record.nodeIds)) record.nodeIds = record.nodeId ? [record.nodeId] : [];

    const topic = AppState.getCurrentTopic();

    if (nodeId) {
      // Открепить от конкретного узла
      const node = topic && AppState.findNode(nodeId);
      if (node) {
        const atts = (node.attachments || []).filter(p => p !== record.path);
        TreeHelpers.updateNode(topic.nodes, nodeId, { attachments: atts });
        Render.renderTree();
      }
      record.nodeIds = record.nodeIds.filter(id => id !== nodeId);
    } else {
      // Открепить от всех узлов (старый путь / fallback)
      record.nodeIds.forEach(nid => {
        const node = topic && AppState.findNode(nid);
        if (node) {
          const atts = (node.attachments || []).filter(p => p !== record.path);
          TreeHelpers.updateNode(topic.nodes, nid, { attachments: atts });
        }
      });
      record.nodeIds = [];
      if (topic) Render.renderTree();
    }

    delete record.nodeId;
    _renderSidebar();

    Persist.save();
  }

  // ══════════════════════════════════════════════════════════
  //  RENDER — FULL
  // ══════════════════════════════════════════════════════════

  const $panel = document.getElementById('panel-files');

  function _renderAll() {
    if (!$panel) return;

    const topic = AppState.getCurrentTopic();
    const topicName = topic ? topic.name : '';

    if (_files.length === 0) {
      $panel.innerHTML = `
        <div class="files-empty-state">
          <div class="files-empty-icon">
            <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" width="48" height="48">
              <rect x="6" y="4" width="28" height="38" rx="3" stroke="currentColor" stroke-width="2"/>
              <path d="M34 4v10h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M14 18h16M14 25h16M14 32h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>
          <h3 class="files-empty-title">Нет файлов${topicName ? ` для «${topicName}»` : ''}</h3>
          <p class="files-empty-sub">Открой PDF, изображение или текстовый файл — он сохранится для этой темы</p>
          ${topic ? `<button class="btn-primary files-empty-btn" id="files-empty-open">+ Открыть файл</button>` : '<p class="files-empty-sub" style="color:var(--text-muted)">Сначала выбери тему</p>'}
        </div>`;
      document.getElementById('files-empty-open')?.addEventListener('click', openFile);
      return;
    }

    $panel.innerHTML = `
      <div class="files-layout">
        <div class="files-sidebar" id="files-sidebar">
          ${topicName ? `<div class="files-topic-label" title="${_escHtml(topicName)}">📂 ${_escHtml(topicName)}</div>` : ''}
          <div class="files-list" id="files-list"></div>
          <button class="files-open-btn" id="files-open-btn">+ Открыть файл</button>
        </div>
        <div class="files-viewer" id="files-viewer"></div>
      </div>`;

    document.getElementById('files-open-btn')?.addEventListener('click', openFile);
    _renderSidebar();
    _renderViewer();
  }

  // ══════════════════════════════════════════════════════════
  //  RENDER — SIDEBAR
  // ══════════════════════════════════════════════════════════

  function _renderSidebar() {
    const $list = document.getElementById('files-list');
    if (!$list) return;

    $list.innerHTML = _files.map(f => {
      const isActive = f.id === _activeFileId;
      // Поддержка и нового (nodeIds[]) и старого (nodeId) формата
      const nodeIds  = Array.isArray(f.nodeIds) ? f.nodeIds : (f.nodeId ? [f.nodeId] : []);
      const badges   = nodeIds.map(nid => {
        const node = AppState.findNode(nid);
        const label = node ? node.label.slice(0, 18) : nid.slice(0, 8);
        return `<span class="file-node-badge" title="Прикреплено к: ${_escHtml(node ? node.label : nid)}">📎 ${_escHtml(label)}<button class="file-detach-btn" data-file-id="${f.id}" data-node-id="${nid}" title="Открепить от этого вопроса">×</button></span>`;
      }).join('');
      return `
        <div class="file-item${isActive ? ' active' : ''}" data-file-id="${f.id}">
          <span class="file-icon">${_fileIconSvg(f.type)}</span>
          <span class="file-name" title="${_escHtml(f.path)}">${_escHtml(f.name)}</span>
          ${badges}
          <button class="file-close-btn" data-close-id="${f.id}" title="Закрыть">×</button>
        </div>`;
    }).join('');

    // Биндинги
    $list.querySelectorAll('.file-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.file-close-btn') || e.target.closest('.file-detach-btn')) return;
        const id = el.dataset.fileId;
        _activeFileId = id;
        _renderSidebar();
        _renderViewer();
      });
    });
    $list.querySelectorAll('.file-close-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _closeFile(btn.dataset.closeId);
      });
    });
    $list.querySelectorAll('.file-detach-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        detachFromNode(btn.dataset.fileId, btn.dataset.nodeId);
      });
    });
  }

  // ══════════════════════════════════════════════════════════
  //  RENDER — VIEWER (dispatcher)
  // ══════════════════════════════════════════════════════════

  function _renderViewer() {
    const $viewer = document.getElementById('files-viewer');
    if (!$viewer) return;

    const file = _files.find(f => f.id === _activeFileId);
    if (!file) { $viewer.innerHTML = ''; return; }

    switch (file.type) {
      case 'pdf':   _renderPdfViewer($viewer, file); break;
      case 'image': _renderImageViewer($viewer, file); break;
      case 'text':  _renderTextViewer($viewer, file); break;
      case 'docx':  _renderDocxViewer($viewer, file); break;
      case 'pptx':  _renderPptxViewer($viewer, file); break;
      default:      _renderOtherViewer($viewer, file); break;
    }
  }

  // ══════════════════════════════════════════════════════════
  //  PDF VIEWER
  // ══════════════════════════════════════════════════════════

  // ── Annotation state ──────────────────────────────────────
  let _annotTool   = {};  // fileId → 'none' | 'brush' | 'text' | 'eraser'
  let _annotColor  = {};  // fileId → hex string
  let _annotSize   = {};  // fileId → number
  // Layers stored as base64 PNG strings per page for persistence
  // _annotLayers[fileId][pageNum] → ImageData (runtime)
  let _annotLayers = {};
  // _annotSaved[fileId][pageNum] → base64 PNG (persisted)
  let _annotSaved  = {};
  let _annotDrawing = false;
  let _annotLastX  = 0;
  let _annotLastY  = 0;
  let _annotDropOpen = false;

  const ANNOT_LS_KEY = 'ks_annot_layers';

  function _annotLoadFromStorage() {
    try {
      const raw = localStorage.getItem(ANNOT_LS_KEY);
      if (raw) _annotSaved = JSON.parse(raw);
    } catch {}
  }

  function _annotSaveToStorage(fileId) {
    try {
      if (!_annotSaved[fileId]) _annotSaved[fileId] = {};
      const layers = _annotLayers[fileId] || {};
      const $annot = document.getElementById('pdf-annot-canvas');
      // Serialise all pages currently in memory
      for (const [pageStr, imgData] of Object.entries(layers)) {
        const tmp = document.createElement('canvas');
        tmp.width = imgData.width; tmp.height = imgData.height;
        tmp.getContext('2d').putImageData(imgData, 0, 0);
        _annotSaved[fileId][pageStr] = tmp.toDataURL('image/png');
      }
      localStorage.setItem(ANNOT_LS_KEY, JSON.stringify(_annotSaved));
    } catch (e) { console.warn('[annot] save failed', e); }
  }

  async function _annotRestoreLayer(fileId, pageNum) {
    const b64 = _annotSaved[fileId]?.[pageNum];
    if (!b64) return null;
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const tmp = document.createElement('canvas');
        tmp.width = img.width; tmp.height = img.height;
        tmp.getContext('2d').drawImage(img, 0, 0);
        resolve(tmp.getContext('2d').getImageData(0, 0, tmp.width, tmp.height));
      };
      img.onerror = () => resolve(null);
      img.src = b64;
    });
  }

  function _renderPdfViewer($viewer, file) {
    const id    = file.id;

    $viewer.innerHTML = `
      <div class="viewer-content" data-viewer="pdf">
        <div class="viewer-toolbar">
          <button class="vt-btn" id="pdf-prev" title="Предыдущая">←</button>
          <span class="pdf-page-info">
            <input class="pdf-page-input" id="pdf-page-input" value="${_currentPage[id] || 1}" />
            <span class="pdf-page-sep">/</span>
            <span class="pdf-total" id="pdf-total">…</span>
          </span>
          <button class="vt-btn" id="pdf-next" title="Следующая">→</button>
          <div class="vt-sep"></div>
          <button class="vt-btn" id="pdf-zoom-out" title="Уменьшить">−</button>
          <span class="pdf-zoom-label" id="pdf-zoom-label">${_pdfZoom[id] ? Math.round(_pdfZoom[id] * 100) + '%' : 'По ширине'}</span>
          <button class="vt-btn" id="pdf-zoom-in" title="Увеличить">+</button>
          <button class="vt-btn" id="pdf-fit" title="По ширине страницы">⟷</button>
          <div class="vt-sep" style="flex:1"></div>
          <button class="vt-btn vt-btn-send" id="pdf-screenshot" title="Вставить скриншот страницы в диалог с ИИ">↗ В ИИ</button>
        </div>
        <div class="viewer-canvas-wrap" id="viewer-canvas-wrap">
          <div class="pdf-loading" id="pdf-loading"><div class="pdf-loading-spinner"></div>Загрузка PDF…</div>
          <div id="pdf-canvas-container" style="position:relative;display:none;">
            <canvas id="pdf-canvas"></canvas>
            <canvas id="pdf-annot-canvas" style="position:absolute;top:0;left:0;pointer-events:none;"></canvas>
          </div>
          <div class="pdf-error hidden" id="pdf-error">
            <div class="pdf-error-icon">⚠</div>
            <p>Не удалось открыть PDF</p>
            <button class="btn-secondary" id="pdf-open-system">Открыть в системе</button>
          </div>
        </div>
      </div>`;



    // Навигация и зум
    document.getElementById('pdf-prev')?.addEventListener('click', () => _pdfChangePage(file, -1));
    document.getElementById('pdf-next')?.addEventListener('click', () => _pdfChangePage(file, +1));
    document.getElementById('pdf-zoom-in')?.addEventListener('click',  () => _pdfChangeZoom(file, +0.25));
    document.getElementById('pdf-zoom-out')?.addEventListener('click', () => _pdfChangeZoom(file, -0.25));
    document.getElementById('pdf-fit')?.addEventListener('click', () => { _pdfZoom[file.id] = 0; _pdfRenderPage(file); });
    document.getElementById('pdf-screenshot')?.addEventListener('click', () => _pdfScreenshot(file));
    document.getElementById('pdf-open-system')?.addEventListener('click', () => _openInSystem(file.path));

    // Ввод страницы
    document.getElementById('pdf-page-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const n = parseInt(e.target.value);
        const doc = _pdfInstances[file.id];
        if (doc && n >= 1 && n <= doc.numPages) {
          _currentPage[file.id] = n;
          _pdfRenderPage(file);
        }
      }
    });

    // Колесо мыши → листать страницы
    document.getElementById('viewer-canvas-wrap')?.addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) < 10) return;
      e.preventDefault();
      _pdfChangePage(file, e.deltaY > 0 ? +1 : -1);
    }, { passive: false });

    // Загружаем/рендерим
    if (_pdfInstances[file.id]) {
      _pdfRenderPage(file);
    } else {
      _loadPdf(file);
    }
  }

  async function _annotSetupCanvas(id) {
    const $pdf   = document.getElementById('pdf-canvas');
    const $annot = document.getElementById('pdf-annot-canvas');
    if (!$pdf || !$annot) return;

    $annot.width  = $pdf.width;
    $annot.height = $pdf.height;
    $annot.style.width  = $pdf.style.width;
    $annot.style.height = $pdf.style.height;

    const pageNum = _currentPage[id] || 1;
    const ctx = $annot.getContext('2d');
    ctx.clearRect(0, 0, $annot.width, $annot.height);

    // Try runtime cache first, then localStorage
    let imgData = _annotLayers[id]?.[pageNum];
    if (!imgData) {
      imgData = await _annotRestoreLayer(id, pageNum);
      if (imgData) {
        if (!_annotLayers[id]) _annotLayers[id] = {};
        _annotLayers[id][pageNum] = imgData;
      }
    }
    if (imgData) ctx.putImageData(imgData, 0, 0);

    // Pointer events
    _updateAnnotToolbar(id);

    // Remove old listeners by cloning
    const $new = $annot.cloneNode(true);
    $annot.parentNode.replaceChild($new, $annot);

    _annotBindDraw(id, $new);
  }

  function _annotBindDraw(id, $annot) {
    const dpr = window.devicePixelRatio || 1;

    function getPos(e) {
      const rect = $annot.getBoundingClientRect();
      const scaleX = $annot.width  / rect.width;
      const scaleY = $annot.height / rect.height;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
    }

    function saveLayer() {
      const pageNum = _currentPage[id] || 1;
      if (!_annotLayers[id]) _annotLayers[id] = {};
      const ctx = $annot.getContext('2d');
      _annotLayers[id][pageNum] = ctx.getImageData(0, 0, $annot.width, $annot.height);
      _annotSaveToStorage(id);
    }

    $annot.addEventListener('mousedown', e => {
      const tool = _annotTool[id] || 'none';
      if (tool === 'none') return;

      if (tool === 'text') {
        const [x, y] = getPos(e);
        _annotAddText(id, $annot, x, y, saveLayer);
        return;
      }

      _annotDrawing = true;
      const [x, y] = getPos(e);
      _annotLastX = x; _annotLastY = y;

      const ctx = $annot.getContext('2d');
      const color = _annotColor[id] || '#e53935';
      const size  = _annotSize[id]  || 4;

      if (tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = size * dpr * 3;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = color;
        ctx.lineWidth   = size * dpr;
        ctx.globalAlpha = 0.85;
        ctx.fillStyle   = color;
        ctx.beginPath();
        ctx.arc(x, y, size * dpr / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.lineCap  = 'round';
      ctx.lineJoin = 'round';
    });

    $annot.addEventListener('mousemove', e => {
      if (!_annotDrawing) return;
      const tool = _annotTool[id] || 'none';
      if (tool !== 'brush' && tool !== 'eraser') return;
      const [x, y] = getPos(e);
      const ctx = $annot.getContext('2d');

      if (tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        const size = _annotSize[id] || 4;
        ctx.lineWidth = size * dpr * 3;
        ctx.globalAlpha = 1;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = _annotColor[id] || '#e53935';
        ctx.lineWidth   = (_annotSize[id] || 4) * dpr;
        ctx.globalAlpha = 0.85;
      }
      ctx.lineCap  = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(_annotLastX, _annotLastY);
      ctx.lineTo(x, y);
      ctx.stroke();
      _annotLastX = x; _annotLastY = y;
    });

    const stopDraw = () => {
      if (_annotDrawing) {
        _annotDrawing = false;
        const ctx = $annot.getContext('2d');
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        saveLayer();
      }
    };
    $annot.addEventListener('mouseup', stopDraw);
    $annot.addEventListener('mouseleave', stopDraw);
  }

  function _annotAddText(id, $annot, x, y, saveLayer) {
    const $pdf = document.getElementById('pdf-canvas');
    const $container = document.getElementById('pdf-canvas-container');
    if (!$pdf || !$container) return;

    const dpr  = window.devicePixelRatio || 1;
    const rect  = $pdf.getBoundingClientRect();
    const scaleX = $pdf.width  / rect.width;
    const scaleY = $pdf.height / rect.height;

    const cssX = x / scaleX;
    const cssY = y / scaleY;

    const color = _annotColor[id] || '#e53935';
    const size  = (_annotSize[id] || 4) * 4 + 8;

    const $input = document.createElement('textarea');
    $input.style.cssText = `
      position:absolute;left:${cssX}px;top:${cssY}px;
      min-width:80px;min-height:28px;
      background:rgba(255,255,255,0.88);
      border:1.5px dashed ${color};
      border-radius:4px;padding:2px 5px;
      font-size:${size}px;color:${color};
      font-family:inherit;resize:both;outline:none;
      z-index:10;line-height:1.3;
    `;
    $container.appendChild($input);
    $input.focus();

    function commit() {
      const text = $input.value.trim();
      $input.remove();
      if (!text) return;

      const ctx = $annot.getContext('2d');
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `${size * dpr}px sans-serif`;
      ctx.fillStyle = color;
      ctx.globalAlpha = 1;
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        ctx.fillText(line, x, y + (i + 1) * size * dpr * 1.3);
      });
      saveLayer();
    }

    $input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $input.remove(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    });
    $input.addEventListener('blur', commit);
  }

  function _annotRedraw(id) {
    const $annot = document.getElementById('pdf-annot-canvas');
    if (!$annot) return;
    const pageNum = _currentPage[id] || 1;
    const ctx = $annot.getContext('2d');
    ctx.clearRect(0, 0, $annot.width, $annot.height);
    const savedData = _annotLayers[id]?.[pageNum];
    if (savedData) ctx.putImageData(savedData, 0, 0);
  }

  // ── pdf.js loader ──────────────────────────────────────────
  // Ожидает файлы: src/vendor/pdf.min.js + src/vendor/pdf.worker.min.js
  // Скачать: https://github.com/mozilla/pdf.js/releases → пакет "pdfjs-dist"
  // Нужны файлы: build/pdf.mjs (→ pdf.min.js) и build/pdf.worker.mjs (→ pdf.worker.min.js)
  //
  // Если уже подключён через <script> в index.html — тоже работает.
  let _pdfjsLoading = null;

  function _ensurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    if (_pdfjsLoading)   return _pdfjsLoading;

    _pdfjsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // Путь относительно index.html; CSP 'self' разрешает локальные файлы
      s.src = 'vendor/pdf.min.js';
      s.onload = () => {
        if (window.pdfjsLib) {
          // workerSrc — тоже локальный файл
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
        }
        resolve();
      };
      s.onerror = () => {
        // Файл не найден → показать понятную инструкцию
        reject(new Error(
          'vendor/pdf.min.js не найден.\n' +
          'Скачай pdf.js: npm install pdfjs-dist\n' +
          'и скопируй node_modules/pdfjs-dist/build/pdf.min.js и pdf.worker.min.js в src/vendor/'
        ));
      };
      document.head.appendChild(s);
    });

    return _pdfjsLoading;
  }

  async function _loadPdf(file) {
    // Показать «загрузка pdf.js» пока библиотека тянется
    const $loading = document.getElementById('pdf-loading');
    if ($loading) $loading.textContent = 'Загрузка pdf.js…';

    try {
      await _ensurePdfJs();
    } catch (err) {
      console.error('[FilesModule] pdf.js load error', err);
      _showPdfError(file, err.message || 'Не удалось загрузить pdf.js');
      return;
    }

    if ($loading) $loading.textContent = 'Загрузка PDF…';

    try {
      // Читаем файл через IPC (Node.js fs) — надёжнее file:// в Electron
      let pdfSource;
      try {
        if (window.electronAPI?.readFile) {
          const buf = await window.electronAPI.readFile(file.path);
          pdfSource = { data: buf };
        } else {
          // Fallback для dev-режима вне Electron
          const resp = await fetch('file://' + file.path);
          pdfSource  = { data: await resp.arrayBuffer() };
        }
      } catch {
        pdfSource = { url: 'file://' + file.path };
      }

      const loadingTask = pdfjsLib.getDocument(pdfSource);
      const pdfDoc = await loadingTask.promise;
      _pdfInstances[file.id] = pdfDoc;
      if (!_currentPage[file.id]) _currentPage[file.id] = 1;

      // Пользователь мог переключиться на другой файл, пока PDF грузился —
      // не трогаем DOM текущего (уже другого) вьюера чужими данными.
      if (file.id !== _activeFileId) return;

      // Обновить total pages если viewer ещё показан
      const $total = document.getElementById('pdf-total');
      if ($total) $total.textContent = pdfDoc.numPages;

      _pdfRenderPage(file);
    } catch (err) {
      console.error('[FilesModule] PDF load error', err);
      _showPdfError(file, 'Повреждён или недоступен');
    }
  }

  async function _pdfRenderPage(file) {
    const doc = _pdfInstances[file.id];
    if (!doc) return;

    const pageNum = _currentPage[file.id] || 1;
    const $canvas    = document.getElementById('pdf-canvas');
    const $container = document.getElementById('pdf-canvas-container');
    const $loading   = document.getElementById('pdf-loading');
    const $wrap      = document.getElementById('viewer-canvas-wrap');
    if (!$canvas || !$wrap) return;

    if ($loading) $loading.style.display = 'flex';
    if ($container) $container.style.display = 'none';

    try {
      const page = await doc.getPage(pageNum);
      const dpr  = window.devicePixelRatio || 1;

      // Вычислить масштаб
      let scale = _pdfZoom[file.id] || 0;
      if (!scale) {
        // fit-width
        const vp0   = page.getViewport({ scale: 1 });
        const avail = $wrap.clientWidth - 40;
        scale = avail / vp0.width;
        if (scale <= 0) scale = 1;
      }

      const viewport = page.getViewport({ scale });
      $canvas.width  = viewport.width  * dpr;
      $canvas.height = viewport.height * dpr;
      $canvas.style.width  = viewport.width  + 'px';
      $canvas.style.height = viewport.height + 'px';

      const ctx = $canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      await page.render({ canvasContext: ctx, viewport }).promise;

      // Пока страница рендерилась, могли открыть другой файл — тогда
      // #pdf-canvas уже принадлежит другому вьюеру, не дорисовываем поверх.
      if (file.id !== _activeFileId) return;

      if ($loading) $loading.style.display = 'none';
      // Скрыть блок ошибки если он был показан ранее
      const $errBlock = document.getElementById('pdf-error');
      if ($errBlock) $errBlock.classList.add('hidden');
      if ($container) $container.style.display = 'block';

      // Setup annotation overlay
      _annotSetupCanvas(file.id);

      // Обновить UI
      const $pageInput = document.getElementById('pdf-page-input');
      if ($pageInput) $pageInput.value = pageNum;
      const $total = document.getElementById('pdf-total');
      if ($total) $total.textContent = doc.numPages;
      const $zoomLabel = document.getElementById('pdf-zoom-label');
      if ($zoomLabel) $zoomLabel.textContent = _pdfZoom[file.id] ? Math.round(_pdfZoom[file.id] * 100) + '%' : 'По ширине';
    } catch (err) {
      console.error('[FilesModule] PDF render error', err);
      if ($loading) $loading.style.display = 'none';
      _showPdfError(file, 'Ошибка рендера страницы');
    }
  }

  function _pdfChangePage(file, delta) {
    const doc = _pdfInstances[file.id];
    if (!doc) return;
    const cur  = _currentPage[file.id] || 1;
    const next = Math.max(1, Math.min(doc.numPages, cur + delta));
    if (next === cur) return;
    _currentPage[file.id] = next;
    _pdfRenderPage(file);
  }

  function _pdfChangeZoom(file, delta) {
    const cur   = _pdfZoom[file.id] || 1;
    const next  = Math.max(0.5, Math.min(3.0, cur + delta));
    _pdfZoom[file.id] = next;
    _pdfRenderPage(file);
  }

  function _showPdfError(file, msg) {
    const $loading = document.getElementById('pdf-loading');
    const $err     = document.getElementById('pdf-error');
    if ($loading) $loading.style.display = 'none';
    if ($err) {
      $err.classList.remove('hidden');
      const $p = $err.querySelector('p');
      if ($p) $p.textContent = 'Не удалось открыть PDF: ' + msg;
    }
  }

  async function _pdfScreenshot(file) {
    const $canvas = document.getElementById('pdf-canvas');
    if (!$canvas) return;
    try {
      const dataUrl = $canvas.toDataURL('image/png');
      await _sendImageToAI(dataUrl, file.name + '_page' + (_currentPage[file.id] || 1));
    } catch(e) {
      _showFlash('Не удалось отправить скриншот в ИИ', 'error');
    }
  }

  // ── Конвертировать dataUrl (data:image/png;base64,...) → ArrayBuffer ──────────
  function _dataUrlToBuffer(dataUrl) {
    // fetch() не работает с data: URL в Electron (CSP блокирует).
    // Парсим base64 вручную — надёжно в любой среде.
    const comma = dataUrl.indexOf(',');
    if (comma === -1) throw new Error('Invalid dataUrl: no comma found');
    const base64 = dataUrl.slice(comma + 1);
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // ── Записать PNG dataUrl в системный clipboard (Electron IPC → Web API) ──────
  async function _writeImageToClipboard(dataUrl) {
    // Конвертируем dataUrl → ArrayBuffer без fetch()
    let buf;
    try {
      buf = _dataUrlToBuffer(dataUrl);
    } catch(e) {
      _showFlash('Ошибка конвертации изображения: ' + e.message, 'error');
      return false;
    }

    // Путь 1: нативный Electron clipboard через IPC
    if (window.electronAPI?.writeImageToClipboard) {
      try {
        const result = await window.electronAPI.writeImageToClipboard(buf);
        if (result?.ok) return true;
      } catch(e) { /* fallback */ }
    }

    // Путь 2: Web Clipboard API (браузер / dev-режим)
    try {
      const blob = new Blob([buf], { type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch(e) { /* не поддерживается */ }

    return false;
  }

  // ── Отправить изображение (dataUrl) в открытый диалог ИИ ──────────────────
  async function _sendImageToAI(dataUrl, label) {
    // 1. Конвертируем dataUrl → base64 строку (без префикса)
    const comma = dataUrl.indexOf(',');
    if (comma === -1) { _showFlash('Ошибка формата изображения', 'error'); return; }
    const base64png = dataUrl.slice(comma + 1);

    // 2. Записываем в системный clipboard через нативный Electron IPC
    const clipOk = await _writeImageToClipboard(dataUrl);
    if (!clipOk) {
      _showFlash('Не удалось скопировать изображение в буфер', 'error');
      return;
    }

    // 3. Находим активный webview — сначала браузерный (BrowserModule),
    //    потом граф-окно Claude, потом любой webview на странице
    const wv = (typeof BrowserModule !== 'undefined' && BrowserModule.getWebview?.())
            || document.querySelector('#gwcl-webview')
            || document.querySelector('webview');

    if (!wv || !wv.executeJavaScript) {
      _showFlash('Изображение скопировано — вставь в ИИ через Ctrl+V', 'success');
      return;
    }

    // 4. Внутри webview: фокусируем поле ввода, затем вставляем изображение
    //    через navigator.clipboard.read() + искусственный paste-event с ImageData.
    //    wv.paste() работает только если webview сам имеет фокус ОС —
    //    надёжнее вставить base64 через executeJavaScript и нарисовать через Blob.
    try {
      const injected = await wv.executeJavaScript(`
        (async function() {
          // Находим поле ввода
          const selectors = [
            'rich-textarea div[contenteditable="true"]',
            'div[contenteditable="true"][data-testid="composer-content"]',
            'div[contenteditable="true"].ProseMirror',
            'div.ql-editor[contenteditable="true"]',
            '[contenteditable="true"]',
            'textarea'
          ];
          let input = null;
          for (const sel of selectors) {
            try { input = document.querySelector(sel); } catch(e) {}
            if (input) break;
          }
          if (!input) return 'no_input';

          input.focus();
          await new Promise(r => setTimeout(r, 60));

          // Пробуем navigator.clipboard.read() — работает если webview имеет разрешение
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              if (item.types.includes('image/png')) {
                const blob = await item.getType('image/png');
                const dt = new DataTransfer();
                dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
                input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
                return 'clipboard_read_ok';
              }
            }
          } catch(e) {}

          // Fallback: вставляем через DataTransfer с base64 blob
          try {
            const b64 = ${JSON.stringify(base64png)};
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const blob = new Blob([arr], { type: 'image/png' });
            const file = new File([blob], 'screenshot.png', { type: 'image/png' });
            const dt = new DataTransfer();
            dt.items.add(file);
            input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
            return 'datatransfer_ok';
          } catch(e) {
            return 'error: ' + e.message;
          }
        })()
      `);

      if (injected && injected !== 'no_input' && !injected.startsWith('error')) {
        _showFlash('Изображение вставлено в диалог с ИИ', 'success');
      } else if (injected === 'no_input') {
        // Поле ввода не найдено — пробуем нативный paste как запасной вариант
        if (typeof wv.paste === 'function') wv.paste();
        _showFlash('Изображение скопировано — вставь в ИИ через Ctrl+V если не появилось', 'success');
      } else {
        _showFlash('Изображение скопировано — вставь в ИИ через Ctrl+V', 'success');
      }
    } catch(e) {
      // executeJavaScript упал — изображение всё равно в системном буфере
      _showFlash('Изображение скопировано — вставь в ИИ через Ctrl+V', 'success');
    }
  }

  async function _imgSendToAI(file) {
    try {
      // Читаем файл через Electron API или fetch
      let dataUrl;
      if (window.electronAPI?.readFile) {
        const buf = await window.electronAPI.readFile(file.path);
        const blob = new Blob([buf], { type: 'image/png' });
        dataUrl = await new Promise(res => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.readAsDataURL(blob);
        });
      } else {
        const resp = await fetch('file://' + file.path);
        const buf = await resp.arrayBuffer();
        const ext = file.ext || 'png';
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
        const blob = new Blob([buf], { type: mime });
        dataUrl = await new Promise(res => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.readAsDataURL(blob);
        });
      }
      // Конвертируем в png для clipboard
      const img = new Image();
      img.src = dataUrl;
      await new Promise(res => { img.onload = res; img.onerror = res; });
      const tmp = document.createElement('canvas');
      tmp.width = img.naturalWidth; tmp.height = img.naturalHeight;
      tmp.getContext('2d').drawImage(img, 0, 0);
      const pngUrl = tmp.toDataURL('image/png');
      await _sendImageToAI(pngUrl, file.name);
    } catch(e) {
      _showFlash('Не удалось отправить изображение в ИИ: ' + e.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════
  //  IMAGE VIEWER
  // ══════════════════════════════════════════════════════════

  function _renderImageViewer($viewer, file) {
    const zoom = _imgZoom[file.id] || 1.0;
    $viewer.innerHTML = `
      <div class="viewer-content" data-viewer="image">
        <div class="viewer-toolbar">
          <button class="vt-btn" id="img-zoom-out" title="Уменьшить">−</button>
          <span class="pdf-zoom-label" id="img-zoom-label">${Math.round(zoom * 100)}%</span>
          <button class="vt-btn" id="img-zoom-in" title="Увеличить">+</button>
          <button class="vt-btn" id="img-zoom-reset" title="Сбросить масштаб">1:1</button>
          <div class="vt-sep" style="flex:1"></div>
          <button class="vt-btn vt-btn-send" id="img-send-ai" title="Вставить изображение в диалог с ИИ">↗ В ИИ</button>
        </div>
        <div class="viewer-canvas-wrap">
          <img id="viewer-img" src="file://${file.path}"
            style="transform:scale(${zoom});transform-origin:top center;max-width:100%;display:block;cursor:zoom-in;box-shadow:0 2px 16px rgba(0,0,0,.3);border-radius:4px;"
            alt="${_escHtml(file.name)}"
          />
        </div>
      </div>`;

    const $img = document.getElementById('viewer-img');
    $img?.addEventListener('error', () => {
      $img.replaceWith(Object.assign(document.createElement('div'), {
        className: 'pdf-error',
        innerHTML: '<p>Не удалось загрузить изображение</p>',
      }));
    });

    document.getElementById('img-zoom-in')?.addEventListener('click',    () => _imgChangeZoom(file, +0.25));
    document.getElementById('img-zoom-out')?.addEventListener('click',   () => _imgChangeZoom(file, -0.25));
    document.getElementById('img-zoom-reset')?.addEventListener('click', () => { _imgZoom[file.id] = 1.0; _renderViewer(); });
    $img?.addEventListener('dblclick', () => { _imgZoom[file.id] = 1.0; _renderViewer(); });
    document.getElementById('img-send-ai')?.addEventListener('click', () => _imgSendToAI(file));
  }

  function _imgChangeZoom(file, delta) {
    const cur  = _imgZoom[file.id] || 1.0;
    _imgZoom[file.id] = Math.max(0.2, Math.min(5.0, cur + delta));
    const $img   = document.getElementById('viewer-img');
    const $label = document.getElementById('img-zoom-label');
    if ($img)   $img.style.transform = `scale(${_imgZoom[file.id]})`;
    if ($label) $label.textContent   = Math.round(_imgZoom[file.id] * 100) + '%';
  }

  // ══════════════════════════════════════════════════════════
  //  TEXT / MARKDOWN VIEWER
  // ══════════════════════════════════════════════════════════

  async function _renderTextViewer($viewer, file) {
    $viewer.innerHTML = `
      <div class="viewer-content" data-viewer="text">
        <div class="viewer-toolbar">
          <span class="vt-label">${_escHtml(file.name)}</span>
          <div class="vt-sep" style="flex:1"></div>
          <button class="vt-btn" id="text-copy" title="Скопировать текст">⧉ Копировать</button>
        </div>
        <div class="viewer-canvas-wrap viewer-text-wrap" id="viewer-text-wrap">
          <div class="text-loading">Загрузка…</div>
        </div>
      </div>`;



    const MAX_BYTES = 50 * 1024; // 50KB
    let rawText = '';

    try {
      const resp = await fetch('file://' + file.path);
      const buf  = await resp.arrayBuffer();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const full    = decoder.decode(buf);

      let truncated = false;
      if (buf.byteLength > MAX_BYTES) {
        rawText   = decoder.decode(buf.slice(0, MAX_BYTES));
        truncated = true;
      } else {
        rawText = full;
      }

      const $wrap = document.getElementById('viewer-text-wrap');
      if (!$wrap) return;

      const isMarkdown = ['md', 'markdown'].includes(file.ext);
      if (isMarkdown && typeof AnswerPanel !== 'undefined' && AnswerPanel.renderMarkdown) {
        $wrap.innerHTML = `<div class="viewer-md-body">${AnswerPanel.renderMarkdown(rawText)}</div>`;
      } else {
        $wrap.innerHTML = `<pre class="viewer-pre">${_escHtml(rawText)}</pre>`;
      }

      if (truncated) {
        $wrap.insertAdjacentHTML('beforeend',
          `<div class="text-truncate-warn">⚠ Показаны первые 50 КБ из ${Math.round(buf.byteLength / 1024)} КБ</div>`);
      }
    } catch (err) {
      const $wrap = document.getElementById('viewer-text-wrap');
      if ($wrap) $wrap.innerHTML = `<div class="pdf-error"><p>Не удалось прочитать файл: ${_escHtml(String(err))}</p></div>`;
    }

    document.getElementById('text-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(rawText).then(() => _showFlash('Текст скопирован', 'success'));
    });
  }

  // ══════════════════════════════════════════════════════════
  //  DOCX VIEWER (via mammoth.js)
  // ══════════════════════════════════════════════════════════

  let _mammothLoading = null;

  function _ensureMammoth() {
    if (window.mammoth) return Promise.resolve();
    if (_mammothLoading) return _mammothLoading;
    _mammothLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error('Не удалось загрузить mammoth.js'));
      document.head.appendChild(s);
    });
    return _mammothLoading;
  }

  // ── Геометрия страницы A4 при 96 dpi ───────────────────────
  const DOCX_PAGE_W   = 794;   // 210 мм
  const DOCX_PAGE_H   = 1123;  // 297 мм
  const DOCX_MARGIN_T = 75;    // ~2 см
  const DOCX_MARGIN_B = 75;
  const DOCX_MARGIN_L = 113;   // ~3 см (левое поле как в ГОСТ)
  const DOCX_MARGIN_R = 57;    // ~1.5 см
  const DOCX_CONTENT_H = DOCX_PAGE_H - DOCX_MARGIN_T - DOCX_MARGIN_B;

  async function _renderDocxViewer($viewer, file) {
    const id = file.id;
    if (!_docxZoom[id]) _docxZoom[id] = 1;
    if (!_docxPage[id]) _docxPage[id] = 1;

    $viewer.innerHTML = `
      <div class="viewer-content" data-viewer="docx">
        <div class="viewer-toolbar">
          <button class="vt-btn" id="docx-prev" title="Предыдущая страница">←</button>
          <span class="pdf-page-info">
            <input class="pdf-page-input" id="docx-page-input" value="${_docxPage[id]}" />
            <span class="pdf-page-sep">/</span>
            <span class="pdf-total" id="docx-total">…</span>
          </span>
          <button class="vt-btn" id="docx-next" title="Следующая страница">→</button>
          <div class="vt-sep"></div>
          <button class="vt-btn" id="docx-zoom-out" title="Уменьшить">−</button>
          <span class="pdf-zoom-label" id="docx-zoom-label">${Math.round(_docxZoom[id] * 100)}%</span>
          <button class="vt-btn" id="docx-zoom-in" title="Увеличить">+</button>
          <button class="vt-btn" id="docx-zoom-reset" title="Сбросить масштаб">⟲</button>
          <div class="vt-sep"></div>
          <span class="vt-label" title="${_escHtml(file.name)}">${_escHtml(file.name)}</span>
          <div class="vt-sep" style="flex:1"></div>
          <button class="vt-btn" id="docx-open-system" title="Открыть в Word / LibreOffice">↗ Открыть в системе</button>
        </div>
        <div class="viewer-docx-scroll" id="viewer-docx-scroll">
          <div class="pdf-loading" id="docx-loading"><div class="pdf-loading-spinner"></div>Загрузка документа…</div>
        </div>
      </div>`;


    document.getElementById('docx-open-system')?.addEventListener('click', () => _openInSystem(file.path));

    const $scroll = document.getElementById('viewer-docx-scroll');

    try {
      await _ensureMammoth();
    } catch (err) {
      $scroll.innerHTML = `<div class="pdf-error"><div class="pdf-error-icon">⚠</div><p>Не удалось загрузить рендерер: ${_escHtml(String(err))}</p><button class="btn-secondary" id="docx-sys2">Открыть в системе</button></div>`;
      document.getElementById('docx-sys2')?.addEventListener('click', () => _openInSystem(file.path));
      return;
    }

    try {
      let arrayBuffer;
      if (window.electronAPI?.readFile) {
        const buf = await window.electronAPI.readFile(file.path);
        arrayBuffer = buf.buffer ? buf.buffer : buf;
      } else {
        const resp = await fetch('file://' + file.path);
        arrayBuffer = await resp.arrayBuffer();
      }

      const result = await mammoth.convertToHtml(
        { arrayBuffer },
        {
          convertImage: mammoth.images.imgElement(async (image) => {
            try {
              const b64 = await image.read('base64');
              return { src: `data:${image.contentType};base64,${b64}` };
            } catch {
              return {};
            }
          }),
          styleMap: [
            "p[style-name='Title'] => h1.docx-title:fresh",
            "p[style-name='Заголовок'] => h1.docx-title:fresh",
            "p[style-name='Subtitle'] => p.docx-subtitle:fresh",
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Заголовок 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Заголовок 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
            "p[style-name='Заголовок 3'] => h3:fresh",
            "p[style-name='Heading 4'] => h4:fresh",
            "p[style-name='Заголовок 4'] => h4:fresh",
          ],
          includeDefaultStyleMap: true,
        }
      );

      const cleanHtml = _normalizeDocxHtml(result.value);

      // Разбиваем содержимое на страницы A4
      const pages = await _paginateDocx(cleanHtml);
      _docxTotal[id] = pages.length;
      if (_docxPage[id] > pages.length) _docxPage[id] = pages.length || 1;

      $scroll.innerHTML = `<div class="docx-pages" id="docx-pages"></div>`;
      const $pages = document.getElementById('docx-pages');

      pages.forEach((pageHtml, i) => {
        const $page = document.createElement('div');
        $page.className = 'docx-page';
        $page.dataset.page = String(i + 1);
        $page.innerHTML = `
          <div class="docx-page-body">${pageHtml}</div>
          <div class="docx-page-foot">${i + 1}</div>`;
        $pages.appendChild($page);
      });

      _docxApplyZoom(file);
      _docxUpdateToolbar(file);
      _docxWireControls(file, $scroll);

      // Прокрутка к запомненной странице
      _docxScrollToPage(file, _docxPage[id], false);
    } catch (err) {
      console.error('[FilesModule] DOCX render error', err);
      $scroll.innerHTML = `<div class="pdf-error"><div class="pdf-error-icon">⚠</div><p>Не удалось открыть документ: ${_escHtml(String(err))}</p><button class="btn-secondary" id="docx-sys3">Открыть в системе</button></div>`;
      document.getElementById('docx-sys3')?.addEventListener('click', () => _openInSystem(file.path));
    }
  }

  // ── Управление зумом / навигацией ───────────────────────────

  function _docxApplyZoom(file) {
    const z = _docxZoom[file.id] || 1;
    document.querySelectorAll('#docx-pages .docx-page').forEach($p => {
      $p.style.width  = (DOCX_PAGE_W * z) + 'px';
      $p.style.minHeight = (DOCX_PAGE_H * z) + 'px';
      const $body = $p.querySelector('.docx-page-body');
      if ($body) {
        $body.style.transform = `scale(${z})`;
        $body.style.width  = DOCX_PAGE_W + 'px';
        $body.style.height = DOCX_PAGE_H + 'px';
      }
    });
    const $lbl = document.getElementById('docx-zoom-label');
    if ($lbl) $lbl.textContent = Math.round(z * 100) + '%';
  }

  function _docxChangeZoom(file, delta) {
    const cur = _docxZoom[file.id] || 1;
    let next = Math.round((cur + delta) * 100) / 100;
    next = Math.max(0.5, Math.min(2.5, next));
    _docxZoom[file.id] = next;
    _docxApplyZoom(file);
  }

  function _docxScrollToPage(file, n, smooth = true) {
    const $scroll = document.getElementById('viewer-docx-scroll');
    const $page = $scroll?.querySelector(`.docx-page[data-page="${n}"]`);
    if (!$page) return;
    const top = $page.offsetTop - 24;
    $scroll.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    _docxPage[file.id] = n;
    _docxUpdateToolbar(file);
  }

  function _docxChangePage(file, delta) {
    const total = _docxTotal[file.id] || 1;
    let n = (_docxPage[file.id] || 1) + delta;
    n = Math.max(1, Math.min(total, n));
    _docxScrollToPage(file, n);
  }

  function _docxUpdateToolbar(file) {
    const $input = document.getElementById('docx-page-input');
    const $total = document.getElementById('docx-total');
    if ($input) $input.value = _docxPage[file.id] || 1;
    if ($total) $total.textContent = _docxTotal[file.id] || 1;
  }

  function _docxWireControls(file, $scroll) {
    document.getElementById('docx-prev')?.addEventListener('click', () => _docxChangePage(file, -1));
    document.getElementById('docx-next')?.addEventListener('click', () => _docxChangePage(file, +1));
    document.getElementById('docx-zoom-in')?.addEventListener('click',  () => _docxChangeZoom(file, +0.1));
    document.getElementById('docx-zoom-out')?.addEventListener('click', () => _docxChangeZoom(file, -0.1));
    document.getElementById('docx-zoom-reset')?.addEventListener('click', () => { _docxZoom[file.id] = 1; _docxApplyZoom(file); });

    const $input = document.getElementById('docx-page-input');
    $input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        let n = parseInt($input.value, 10);
        if (!isNaN(n)) _docxScrollToPage(file, Math.max(1, Math.min(_docxTotal[file.id] || 1, n)));
        $input.blur();
      }
    });

    // Ctrl + колесо → зум
    $scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        _docxChangeZoom(file, e.deltaY < 0 ? +0.1 : -0.1);
      }
    }, { passive: false });

    // Обновлять номер текущей страницы при прокрутке
    let _t;
    $scroll.addEventListener('scroll', () => {
      clearTimeout(_t);
      _t = setTimeout(() => {
        const pages = $scroll.querySelectorAll('.docx-page');
        const mid = $scroll.scrollTop + $scroll.clientHeight / 3;
        let curr = 1;
        pages.forEach($p => { if ($p.offsetTop <= mid) curr = parseInt($p.dataset.page, 10); });
        if (curr !== _docxPage[file.id]) {
          _docxPage[file.id] = curr;
          _docxUpdateToolbar(file);
        }
      }, 80);
    });
  }

  /**
   * Нормализация HTML от mammoth.
   * Word часто разбивает абзац на несколько <p> по одной строке —
   * НЕ склеиваем агрессивно (это ломало форматирование), а лишь
   * удаляем пустые <p> и помечаем выравнивание из атрибутов style.
   */
  function _normalizeDocxHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstChild;

    // Чистим пустые абзацы (оставляем как вертикальный отступ)
    root.querySelectorAll('p').forEach(p => {
      const txt = p.textContent.replace(/\u00a0/g, ' ').trim();
      if (!txt && !p.querySelector('img')) {
        p.classList.add('docx-empty');
      }
    });

    // Параграф, содержащий только картинку → центрируем
    root.querySelectorAll('p').forEach(p => {
      if (p.querySelector('img') && p.textContent.trim() === '') {
        p.classList.add('docx-imgline');
      }
    });

    return root.innerHTML;
  }

  /**
   * Разбивает HTML на страницы A4. Рендерит во временный
   * измеритель шириной = область печати, затем переносит блоки
   * верхнего уровня (а при необходимости — строки длинных абзацев)
   * на новые страницы по достижении высоты страницы.
   */
  function _paginateDocx(html) {
    return new Promise((resolve) => {
      const printW = DOCX_PAGE_W - DOCX_MARGIN_L - DOCX_MARGIN_R;

      // Скрытый измеритель с типографикой страницы
      const meas = document.createElement('div');
      meas.style.cssText =
        `position:absolute;left:-99999px;top:0;width:${printW}px;visibility:hidden;`;

      const src = document.createElement('div');
      src.className = 'docx-page-body docx-measure-body';
      src.style.cssText = `width:${printW}px;height:auto;padding:0;`;
      src.innerHTML = html;
      meas.appendChild(src);
      document.body.appendChild(meas);

      const blocks = Array.from(src.childNodes).filter(
        n => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim())
      );

      const pages = [];
      let current = document.createElement('div');
      current.className = 'docx-page-body docx-measure-body';
      current.style.cssText = `width:${printW}px;height:auto;padding:0;`;
      meas.innerHTML = '';
      meas.appendChild(current);

      let usedH = 0;

      const flushPage = () => {
        pages.push(current.innerHTML);
        current = document.createElement('div');
        current.className = 'docx-page-body docx-measure-body';
        current.style.cssText = `width:${printW}px;height:auto;padding:0;`;
        meas.innerHTML = '';
        meas.appendChild(current);
        usedH = 0;
      };

      const measure = () => current.offsetHeight;

      for (const node of blocks) {
        const el = node.nodeType === Node.TEXT_NODE
          ? (() => { const s = document.createElement('span'); s.textContent = node.textContent; return s; })()
          : node;

        current.appendChild(el);
        const h = measure();

        if (h > DOCX_CONTENT_H && current.childNodes.length > 1) {
          // Не влезает — выносим на новую страницу
          current.removeChild(el);
          flushPage();
          current.appendChild(el);
          let h2 = measure();

          // Блок сам по себе выше страницы (длинная таблица/абзац) —
          // оставляем как есть, он растянет страницу (лучше так, чем терять текст)
          if (h2 > DOCX_CONTENT_H) {
            // допускаем переполнение, начинаем новую страницу после него
            flushPage();
          } else {
            usedH = h2;
          }
        } else {
          usedH = h;
        }
      }

      if (current.innerHTML.trim()) pages.push(current.innerHTML);
      document.body.removeChild(meas);

      if (!pages.length) pages.push('');
      resolve(pages);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  PPTX VIEWER — LibreOffice → PDF pipeline
  // ══════════════════════════════════════════════════════════

  // Возвращает HTML заглушки-ошибки (нет LibreOffice или ошибка конвертации)
  function _pptxFallbackHtml(file, reason, showInstall) {
    const installNote = showInstall
      ? `<p class="viewer-unsupported-sub" style="max-width:340px;margin-top:6px;">
           Установите <a class="pptx-lo-link" href="#" id="pptx-lo-link">LibreOffice</a>
           для автоматического предпросмотра.
         </p>`
      : `<p class="viewer-unsupported-sub" style="max-width:340px;margin-top:6px;">${_escHtml(reason)}</p>`;

    return `
      <div class="viewer-unsupported">
        <div class="pptx-icon">
          <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" width="64" height="64">
            <rect x="6" y="4" width="38" height="50" rx="4"
              fill="color-mix(in srgb,var(--accent) 10%,transparent)"
              stroke="var(--accent)" stroke-width="2"/>
            <path d="M44 4v14h14" stroke="var(--accent)" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="14" y="20" width="30" height="18" rx="3"
              fill="color-mix(in srgb,var(--accent) 18%,transparent)"
              stroke="var(--accent)" stroke-width="1.5"/>
            <path d="M14 43h22M14 50h14" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <p class="viewer-unsupported-name">${_escHtml(file.name)}</p>
        ${installNote}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;justify-content:center;">
          <button class="btn-primary" id="pptx-open-btn">↗ Открыть в системе</button>
          <button class="btn-secondary" id="pptx-retry-btn" style="display:none;">↻ Попробовать снова</button>
        </div>
      </div>`;
  }

  // Рендерит состояние «идёт конвертация»
  function _pptxConvertingHtml(file) {
    return `
      <div class="viewer-unsupported">
        <div class="pptx-converting-spinner"></div>
        <p class="viewer-unsupported-name" style="margin-top:16px;">${_escHtml(file.name)}</p>
        <p class="viewer-unsupported-sub">Конвертация в PDF через LibreOffice…</p>
        <p class="viewer-unsupported-sub" style="font-size:11px;opacity:.5;margin-top:4px;">
          Это может занять несколько секунд
        </p>
      </div>`;
  }

  async function _renderPptxViewer($viewer, file) {
    const api = window.electronAPI;

    // Инициализируем состояние для этого файла, если его нет
    if (!_pptxState[file.id]) {
      _pptxState[file.id] = { status: 'idle', pdfPath: null, error: null, libreOfficePath: null };
    }
    const ps = _pptxState[file.id];

    // Если PDF уже готов — сразу открываем его через встроенный PDF-вьювер
    if (ps.status === 'ready' && ps.pdfPath) {
      _renderPptxAsPdf($viewer, file, ps.pdfPath);
      return;
    }

    // Базовый скелет toolbar (одинаков для всех состояний)
    $viewer.innerHTML = `
      <div class="viewer-content" data-viewer="pptx">
        <div class="viewer-toolbar">
          <span class="vt-label" style="font-weight:600;">${_escHtml(file.name)}</span>
          <div class="vt-sep" style="flex:1"></div>
          <span class="pptx-lo-badge" id="pptx-lo-badge" style="display:none;"></span>
          <button class="vt-btn" id="pptx-open-system" title="Открыть в PowerPoint / LibreOffice">↗ Открыть в системе</button>
        </div>
        <div class="viewer-canvas-wrap" id="pptx-canvas-wrap">
          <div class="viewer-unsupported">
            <div class="pptx-converting-spinner"></div>
            <p class="viewer-unsupported-sub" style="margin-top:16px;">Проверка LibreOffice…</p>
          </div>
        </div>
      </div>`;


    document.getElementById('pptx-open-system')?.addEventListener('click', () => _openInSystem(file.path));

    const $wrap = document.getElementById('pptx-canvas-wrap');

    // Нет Electron API — сразу показываем заглушку
    if (!api?.checkLibreOffice) {
      $wrap.innerHTML = _pptxFallbackHtml(file, 'Просмотр PPTX доступен только в десктопном приложении.', false);
      _pptxBindFallbackButtons(file, $wrap, false);
      return;
    }

    // ── Шаг 1: проверяем LibreOffice (с кэшем на сессию) ────
    if (!_loCheck) {
      ps.status = 'checking';
      try {
        _loCheck = await api.checkLibreOffice();
      } catch (e) {
        _loCheck = { found: false, path: null, version: null };
      }
    }

    if (!_loCheck.found) {
      // LibreOffice не найден
      const badge = document.getElementById('pptx-lo-badge');
      if (badge) {
        badge.style.display = '';
        badge.textContent   = '⚠ LibreOffice не найден';
        badge.title         = 'Установите LibreOffice для предпросмотра PPTX';
      }
      $wrap.innerHTML = _pptxFallbackHtml(file, '', true);
      _pptxBindFallbackButtons(file, $wrap, true);
      return;
    }

    // LibreOffice найден — показываем версию в тулбаре
    const badge = document.getElementById('pptx-lo-badge');
    if (badge) {
      badge.style.display = '';
      badge.textContent   = '✓ ' + (_loCheck.version || 'LibreOffice');
      badge.className     = 'pptx-lo-badge pptx-lo-badge--ok';
      badge.title         = 'Будет использован: ' + _loCheck.path;
    }

    // ── Шаг 2: конвертация ───────────────────────────────────
    ps.status         = 'converting';
    ps.libreOfficePath = _loCheck.path;
    $wrap.innerHTML   = _pptxConvertingHtml(file);

    let result;
    try {
      result = await api.convertPptxToPdf(file.path, _loCheck.path);
    } catch (e) {
      result = { ok: false, pdfPath: null, error: String(e) };
    }

    if (!result.ok) {
      ps.status = 'error';
      ps.error  = result.error;
      $wrap.innerHTML = _pptxFallbackHtml(file, 'Ошибка конвертации: ' + result.error, false);
      _pptxBindFallbackButtons(file, $wrap, false, true);
      return;
    }

    // ── Шаг 3: показываем PDF ────────────────────────────────
    ps.status  = 'ready';
    ps.pdfPath = result.pdfPath;
    _renderPptxAsPdf($viewer, file, result.pdfPath);
  }

  // Привязывает кнопки к fallback-панели (открыть в системе, повтор, ссылка на LO)
  function _pptxBindFallbackButtons(file, $wrap, showInstall, showRetry = false) {
    $wrap.querySelector('#pptx-open-btn')?.addEventListener('click', () => _openInSystem(file.path));

    if (showRetry) {
      const retryBtn = $wrap.querySelector('#pptx-retry-btn');
      if (retryBtn) {
        retryBtn.style.display = '';
        retryBtn.addEventListener('click', () => {
          // Сбросить состояние и перерисовать
          _pptxState[file.id] = { status: 'idle', pdfPath: null, error: null, libreOfficePath: null };
          const $viewer = document.getElementById('file-viewer-' + file.id) || document.querySelector('[data-fileid="' + file.id + '"]');
          if ($viewer) _renderPptxViewer($viewer, file);
        });
      }
    }

    if (showInstall) {
      $wrap.querySelector('#pptx-lo-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        _openInSystem('https://www.libreoffice.org/download/libreoffice-fresh/');
      });
    }
  }

  // Встраивает PDF (конвертированный из PPTX) через стандартный PDF-вьювер.
  // Полностью делегирует _renderPdfViewer — интерфейс, колёсико, аннотации, зум идентичны PDF.
  function _renderPptxAsPdf($viewer, file, pdfPath) {
    // Создаём «виртуальный» PDF-record с тем же file.id, но путём к конвертированному PDF
    const fakePdfRecord = {
      ...file,
      _originalPath: file.path,
      path: pdfPath,
      ext:  'pdf',
      type: 'pdf',
    };

    // Инициализируем состояние страницы/зума если ещё нет
    if (!_currentPage[file.id]) _currentPage[file.id] = 1;
    if (!_pdfZoom[file.id])     _pdfZoom[file.id]     = 0; // fit-width

    // Рендерим стандартный PDF-вьювер (со всеми функциями)
    _renderPdfViewer($viewer, fakePdfRecord);

    // После рендера добавляем маленький PPTX-badge рядом с именем файла
    // и меняем подпись кнопки «Открыть в системе» на оригинальный файл
    requestAnimationFrame(() => {
      // Вставить badge после первого .vt-label в тулбаре
      const $label = $viewer.querySelector('.viewer-toolbar .vt-label');
      if ($label && !$label.nextElementSibling?.classList.contains('pptx-lo-badge')) {
        const badge = document.createElement('span');
        badge.className = 'pptx-lo-badge pptx-lo-badge--ok';
        badge.title     = 'Конвертировано через LibreOffice';
        badge.textContent = 'PPTX';
        $label.insertAdjacentElement('afterend', badge);
      }

      // «Открыть в системе» и скриншот — перенаправить на оригинальный .pptx
      // Скриншот оставляем как есть (работает с canvas), только «Открыть» переопределяем
      const $openSys = $viewer.querySelector('#pdf-open-system');
      if ($openSys) {
        $openSys.replaceWith($openSys.cloneNode(true)); // снять старый listener
        $viewer.querySelector('#pdf-open-system')
          ?.addEventListener('click', () => _openInSystem(file._originalPath || file.path));
      }
    });

    // Загружаем конвертированный PDF через стандартный _loadPdf
    // (вызов идёт внутри _renderPdfViewer автоматически — дополнительный не нужен)
  }

  // ══════════════════════════════════════════════════════════
  //  OTHER VIEWER
  // ══════════════════════════════════════════════════════════

  function _renderOtherViewer($viewer, file) {
    $viewer.innerHTML = `
      <div class="viewer-content" data-viewer="other">
        <div class="viewer-toolbar">
          <span class="vt-label">${_escHtml(file.name)}</span>
        </div>
        <div class="viewer-canvas-wrap">
          <div class="viewer-unsupported">
            <div class="viewer-unsupported-icon">${_fileIconSvg('other')}</div>
            <p class="viewer-unsupported-name">${_escHtml(file.name)}</p>
            <p class="viewer-unsupported-sub">Тип файла не поддерживается для просмотра</p>
            <button class="btn-secondary" id="other-open-system">Открыть в системе</button>
          </div>
        </div>
      </div>`;


    document.getElementById('other-open-system')?.addEventListener('click', () => _openInSystem(file.path));
  }

  // ══════════════════════════════════════════════════════════
  //  UTILS
  // ══════════════════════════════════════════════════════════

  function _openInSystem(path) {
    if (window.electronAPI?.openPath) {
      window.electronAPI.openPath(path);
    } else {
      window.open('file://' + path);
    }
  }

  function _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _showFlash(msg, type = 'success') {
    const flash = document.createElement('div');
    flash.className = `cb-flash files-flash files-flash-${type}`;
    flash.textContent = (type === 'success' ? '✓ ' : type === 'warn' ? '⚠ ' : '✕ ') + msg;
    document.body.appendChild(flash);
    requestAnimationFrame(() => flash.classList.add('visible'));
    setTimeout(() => {
      flash.classList.remove('visible');
      setTimeout(() => flash.remove(), 300);
    }, 3000);
  }

  // ══════════════════════════════════════════════════════════
  //  PERSIST
  // ══════════════════════════════════════════════════════════

  function _persistOpenFiles() {
    const topicId = AppState.get('currentTopicId');
    if (!topicId) return;
    const topic = AppState.getTopic(topicId);
    if (!topic) return;
    topic.openFiles = _files.map(f => ({ ...f }));
    Persist.save();
  }

  // ══════════════════════════════════════════════════════════
  //  GETTERS
  // ══════════════════════════════════════════════════════════

  function getOpenFiles() { return _files; }

  // ══════════════════════════════════════════════════════════
  //  STARTUP BINDINGS
  // ══════════════════════════════════════════════════════════

  // Кнопка «Открыть файл» в header (если есть в index.html)
  document.getElementById('btn-open-file')?.addEventListener('click', openFile);

  // Переключать файлы при смене темы
  AppState.on('currentTopicId', topicId => {
    _switchToTopic(topicId);
  });

  // Инициализация при переключении на вкладку Files
  AppState.on('mode', mode => {
    if (mode === 'files') {
      // Если panel ещё пустой или нужен re-render
      const hasLayout = $panel?.querySelector('.files-layout');
      if (!hasLayout) _renderAll();
    }
  });

  // Отложенная инициализация (после Persist.load)
  setTimeout(init, 100);

  // ══════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════

  return {
    openFile,
    openFileByPath,
    attachToNode,
    detachFromNode,
    getOpenFiles,
  };

})();


(function injectFilesStyles() {})();
