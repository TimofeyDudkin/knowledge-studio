/**
 * export.js — генерация учебника в HTML (preview) или .docx (Word).
 *
 * HTML-режим: строим self-contained HTML и показываем в iframe panel-tutorial.
 * DOCX-режим:  DocxExport.build() → байты → IPC.saveAndOpen() → Word/LibreOffice.
 */

window.ExportModule = (() => {

  // ─── Dropdown menu ────────────────────────────────────────────
  // Создаём один раз при первом клике, дальше toggle.

  let _menu = null;

  function _getMenu() {
    if (_menu) return _menu;

    _menu = document.createElement('div');
    _menu.id = 'export-dropdown';
    _menu.innerHTML = `
      <button class="export-opt" data-fmt="html">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
          <rect x="2" y="2" width="12" height="12" rx="2"/>
          <path d="M5 6l2 2-2 2M9 10h2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        HTML-учебник
        <span class="export-opt-hint">открыть в приложении</span>
      </button>
      <button class="export-opt" data-fmt="docx">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
          <rect x="2" y="1" width="9" height="14" rx="1.5"/>
          <path d="M11 1l3 3v10a1 1 0 01-1 1" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 6h6M4 9h6M4 12h4" stroke-linecap="round"/>
        </svg>
        Word-документ (.docx)
        <span class="export-opt-hint">открыть в Word / LibreOffice</span>
      </button>`;
    _menu.style.cssText = `
      display:none;position:fixed;z-index:9999;
      background:var(--bg-card,#1a1a2e);border:1px solid var(--border,#2a2a4a);
      border-radius:10px;padding:6px;box-shadow:0 8px 32px rgba(0,0,0,.45);
      min-width:220px;`;

    // Стили кнопок внутри меню
    const style = document.createElement('style');
    style.textContent = `
      #export-dropdown .export-opt {
        display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;
        background:none;border:none;border-radius:7px;cursor:pointer;
        color:var(--text,#e0e0f0);font-size:13px;font-family:inherit;text-align:left;
        transition:background .12s;white-space:nowrap;
      }
      #export-dropdown .export-opt:hover { background:var(--bg-hover,rgba(92,78,245,.15)); }
      #export-dropdown .export-opt-hint {
        margin-left:auto;font-size:11px;color:var(--text-muted,#666888);
      }
      #export-dropdown .export-opt svg { flex-shrink:0;opacity:.75; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(_menu);

    _menu.addEventListener('click', e => {
      const btn = e.target.closest('[data-fmt]');
      if (!btn) return;
      _closeMenu();
      const fmt = btn.dataset.fmt;
      if (fmt === 'html') generateHTML();
      else if (fmt === 'docx') generateDocx();
    });

    // Закрыть при клике вне меню
    document.addEventListener('mousedown', e => {
      if (_menu.style.display !== 'none' && !_menu.contains(e.target) && e.target.id !== 'btn-export') {
        _closeMenu();
      }
    });

    return _menu;
  }

  function _openMenu() {
    const menu = _getMenu();
    const btn  = document.getElementById('btn-export');
    const rect = btn.getBoundingClientRect();
    menu.style.display = 'block';
    // Позиционируем ниже кнопки, выравниваем по правому краю
    menu.style.top  = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, rect.right - 224) + 'px';
  }

  function _closeMenu() {
    if (_menu) _menu.style.display = 'none';
  }

  function _toggleMenu() {
    const menu = _getMenu();
    if (menu.style.display === 'none' || !menu.style.display) _openMenu();
    else _closeMenu();
  }

  // ─── Общая проверка темы ──────────────────────────────────────
  function _getNodes() {
    const topic = AppState.getCurrentTopic();
    if (!topic) { alert('Выбери тему для экспорта'); return null; }
    const flat = TreeHelpers.flatten(topic.nodes).filter(n => n.answer);
    if (flat.length === 0) { alert('Нет заполненных вопросов. Изучи хотя бы один.'); return null; }
    return { topic, flat };
  }

  // ══════════════════════════════════════════════════════════════
  //  HTML — как раньше, показываем во вкладке Tutorial
  // ══════════════════════════════════════════════════════════════
  function generateHTML() {
    const r = _getNodes(); if (!r) return;
    const html = _buildHTML(r.topic, r.flat);
    _openHTMLPreview(html);
  }

  function _buildHTML(topic, nodes) {
    const toc = nodes.map(n =>
      `<li style="margin-left:${n._depth * 16}px"><a href="#node-${n.id}">${escHtml(n.label)}</a></li>`
    ).join('');

    const sections = nodes.map(n => `
      <section id="node-${n.id}" class="ks-section">
        <h2 class="ks-h2">${escHtml(n.label)}</h2>
        <div class="ks-answer">${AnswerPanel.renderMarkdown(n.answer)}</div>
      </section>
    `).join('');

    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<title>${escHtml(topic.name)} — Knowledge Studio</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; color: #1a1a2e; background: #fafafa; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  .ks-toc { background: #f0f0f8; border-radius: 12px; padding: 20px 24px; margin: 24px 0; }
  .ks-toc ul { list-style: none; padding: 0; }
  .ks-toc a { color: #5c4ef5; text-decoration: none; font-size: 14px; }
  .ks-section { margin: 40px 0; padding-top: 24px; border-top: 1px solid #e0e0f0; }
  .ks-h2 { font-size: 20px; color: #2a2a4a; }
  .ks-answer { font-size: 15px; line-height: 1.75; }
  code { background: #f0f0f8; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  pre { background: #f0f0f8; padding: 16px; border-radius: 8px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; border: 1px solid #ddd; }
  th { background: #f0f0f8; }
</style>
</head>
<body>
<h1>${escHtml(topic.name)}</h1>
<p style="color:#888;font-size:13px">Сгенерировано Knowledge Studio · ${new Date().toLocaleDateString('ru')}</p>
<nav class="ks-toc"><h3 style="margin:0 0 12px">Содержание</h3><ul>${toc}</ul></nav>
${sections}
</body></html>`;
  }

  function _openHTMLPreview(html) {
    const $panel = document.getElementById('panel-tutorial');
    $panel.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:none;';
    iframe.srcdoc = html;
    $panel.appendChild(iframe);
    Render.switchMode('tutorial');
  }

  // ══════════════════════════════════════════════════════════════
  //  DOCX — генерируем и сохраняем
  // ══════════════════════════════════════════════════════════════
  async function generateDocx() {
    const r = _getNodes(); if (!r) return;

    const btn = document.getElementById('btn-export');
    const origTitle = btn.title;
    btn.title = 'Генерация…';
    btn.style.opacity = '0.5';
    btn.disabled = true;

    try {
      // Генерируем байты (синхронно, но даём UI отрисоваться)
      await new Promise(r => setTimeout(r, 0));
      const bytes = DocxExport.build(r.topic, r.flat);

      const safeName = r.topic.name.replace(/[<>:"/\\|?*]/g, '_');
      const result = await IPC.saveAndOpen({
        defaultName: `${safeName}.docx`,
        bytes,
        filters: [{ name: 'Word Document', extensions: ['docx'] }],
        open: true,
      });

      if (!result.ok && !result.canceled) {
        alert('Не удалось сохранить файл: ' + (result.error || 'неизвестная ошибка'));
      }
    } catch (e) {
      console.error('[DocxExport]', e);
      alert('Ошибка генерации .docx:\n' + e.message);
    } finally {
      btn.title = origTitle;
      btn.style.opacity = '';
      btn.disabled = false;
    }
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ─── Инициализация кнопки ─────────────────────────────────────
  document.getElementById('btn-export')?.addEventListener('click', e => {
    e.stopPropagation();
    _toggleMenu();
  });

  return { generateHTML, generateDocx };
})();