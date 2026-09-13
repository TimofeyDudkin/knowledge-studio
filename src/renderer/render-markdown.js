/**
 * render-markdown.js — замена renderMarkdown в answer-panel.js
 *
 * Исправления:
 *  1. Таблицы: правильный парсер — нормализует <br>, убирает | в начале/конце,
 *     корректно обрабатывает многострочные ячейки (через \n внутри |...|)
 *  2. Математические формулы:
 *     - Блочные: $$...$$ и \[...\]  → рендеринг через встроенный ASCII-math или KaTeX
 *     - Строчные: $...$ и \(...\)   → inline
 *  3. Порядок обработки: сначала защищаем блоки (код, math), потом парсим
 *
 * Подключать ПОСЛЕ answer-panel.js — патчит window.AnswerPanel.renderMarkdown
 */

(function patchRenderMarkdown() {
  'use strict';

  // KaTeX загружен синхронно через index.html — просто проверяем готовность
  // Если вдруг ещё не готов (edge case) — ждём через requestAnimationFrame
  function _waitForKatex(cb) {
    if (typeof window.katex !== 'undefined') { cb(); return; }
    let attempts = 0;
    const check = () => {
      attempts++;
      if (typeof window.katex !== 'undefined') { cb(); return; }
      if (attempts < 50) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  // Заглушка для совместимости со старым кодом
  function _loadKatex(cb) {
    if (cb) _waitForKatex(cb);
  }

  // ── Рендер одной формулы ─────────────────────────────────────
  function _renderMath(tex, displayMode) {
    if (typeof window.katex !== 'undefined') {
      try {
        return window.katex.renderToString(tex, {
          displayMode,
          throwOnError: false,
          output: 'html',
          trust: true,
          strict: false,
        });
      } catch (e) {
        return `<span class="md-math-err">${_escHtml(tex)}</span>`;
      }
    }
    // Fallback до загрузки KaTeX: стилизованный pending-спан
    // data-tex хранит оригинал — _rerenderMath заменит его после загрузки
    const cls = displayMode ? 'md-math-block md-math-pending' : 'md-math-inline md-math-pending';
    return `<span class="${cls}" data-tex="${_escHtml(tex)}" data-display="${displayMode ? '1' : '0'}">${_escHtml(tex)}</span>`;
  }

  // ── Ре-рендер всех формул в контейнере ──────────────────────
  function _rerenderMath(container) {
    if (typeof window.katex === 'undefined') return;

    // Проход 1 — pending элементы (span и div)
    container.querySelectorAll('.md-math-pending').forEach(el => {
      const tex     = el.dataset.tex || el.textContent;
      const display = el.dataset.display === '1' || el.tagName === 'DIV';
      try {
        el.innerHTML = window.katex.renderToString(tex, {
          displayMode: display, throwOnError: false, output: 'html', trust: true, strict: false,
        });
        el.classList.remove('md-math-pending');
      } catch(_) {
        el.classList.remove('md-math-pending');
        el.classList.add('md-math-err');
      }
    });

    // Проход 2 — md-math-block без KaTeX внутри
    container.querySelectorAll('.md-math-block').forEach(el => {
      if (el.querySelector('.katex')) return;
      const tex = el.dataset.tex;
      if (!tex) return;
      try {
        el.innerHTML = window.katex.renderToString(tex, {
          displayMode: true, throwOnError: false, output: 'html', trust: true, strict: false,
        });
      } catch(_) {}
    });

    // Проход 3 — auto-render для сырого $...$ текста
    if (typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(container, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false, trust: true, strict: false,
          ignoredTags: ['script','noscript','style','textarea','pre','code'],
          ignoredClasses: ['md-math-block','md-math-inline','md-inline-code','code-ln'],
        });
      } catch(_) {}
    }
  }

  // ── Рендер всего видимого контента ───────────────────────────
  function _rerenderAllVisible() {
    const containers = [
      document.getElementById('ap-answer-body'),
      document.getElementById('answer-content'),
      document.querySelector('.ap-answer-body'),
    ].filter(Boolean);
    containers.forEach(c => { try { _rerenderMath(c); } catch(_) {} });
  }

  // ── Mermaid lazy loader ──────────────────────────────────────
  let _mermaidReady = false;
  let _mermaidLoading = false;
  let _mermaidQueue = [];

  function _loadMermaid(cb) {
    if (_mermaidReady) { cb(); return; }
    _mermaidQueue.push(cb);
    if (_mermaidLoading) return;
    _mermaidLoading = true;

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.6.1/mermaid.min.js';
    script.onload = () => {
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });
      } catch(_) {}
      _mermaidReady = true;
      _mermaidLoading = false;
      _mermaidQueue.forEach(fn => fn());
      _mermaidQueue = [];
    };
    script.onerror = () => {
      _mermaidLoading = false;
      _mermaidQueue = [];
    };
    document.head.appendChild(script);
  }

  // ── Рендер Mermaid-диаграмм в контейнере ──────────────────
  /**
   * Автоисправление mermaid-кода сгенерированного AI.
   * AI часто нарушает синтаксис: пишет русский текст без кавычек,
   * использует скобки и спецсимволы в узлах.
   */
  function _sanitizeMermaid(src) {
    const lines = src.split('\n');
    const result = [];

    for (const line of lines) {
      let fixed = line;

      // Исправляем текст узлов не в кавычках: A[Текст] → A["Текст"]
      // Паттерн: идентификатор, затем [текст без кавычек]
      fixed = fixed.replace(/([A-Za-z0-9_]+)\[([^"\[\]]*)\]/g, (m, id, txt) => {
        // Уже в кавычках — не трогаем
        if (txt.startsWith('"') || txt.startsWith("'")) return m;
        // Убираем проблемные символы внутри текста
        const clean = txt
          .replace(/[()]/g, '')          // скобки
          .replace(/[→⟶⇒]/g, '->')     // стрелки-символы
          .replace(/[|#&\\]/g, ' ')    // спецсимволы
          .replace(/"/g, "'")            // двойные кавычки → одинарные
          .trim();
        return `${id}["${clean}"]`;
      });

      // То же для круглых скобок: A(Текст) → A("Текст")
      fixed = fixed.replace(/([A-Za-z0-9_]+)\(([^"()]*)\)/g, (m, id, txt) => {
        if (txt.startsWith('"') || txt.startsWith("'")) return m;
        const clean = txt.replace(/[|#&\\→⟶]/g, ' ').replace(/"/g, "'").trim();
        return `${id}("${clean}")`;
      });

      result.push(fixed);
    }
    return result.join('\n');
  }

  // ── Zoom/Pan для Mermaid-диаграммы ─────────────────────────
  function _attachMermaidZoom(el) {
    const svg = el.querySelector('svg');
    if (!svg) return;

    // Убираем фиксированные размеры SVG — пусть масштабируется
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.style.cursor = 'grab';
    svg.style.touchAction = 'none';
    svg.style.userSelect = 'none';
    svg.style.transformOrigin = '0 0';
    svg.style.transition = 'none';

    let scale = 1;
    let ox = 0, oy = 0;       // текущий offset
    let startX, startY;        // drag start
    let dragging = false;

    function applyTransform() {
      svg.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
    }

    // Колесо — зум
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left - ox;
      const mouseY = e.clientY - rect.top  - oy;
      const newScale = Math.max(0.3, Math.min(8, scale * delta));
      // Зумируем относительно курсора
      ox -= mouseX * (newScale - scale);
      oy -= mouseY * (newScale - scale);
      scale = newScale;
      applyTransform();
    }, { passive: false });

    // Drag — перемещение
    svg.addEventListener('pointerdown', e => {
      dragging = true;
      startX = e.clientX - ox;
      startY = e.clientY - oy;
      svg.style.cursor = 'grabbing';
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', e => {
      if (!dragging) return;
      ox = e.clientX - startX;
      oy = e.clientY - startY;
      applyTransform();
    });
    svg.addEventListener('pointerup', () => {
      dragging = false;
      svg.style.cursor = 'grab';
    });

    // Двойной клик — сброс
    svg.addEventListener('dblclick', () => {
      scale = 1; ox = 0; oy = 0;
      svg.style.transition = 'transform 0.25s ease';
      applyTransform();
      setTimeout(() => svg.style.transition = 'none', 260);
    });

    // Toolbar: кнопки zoom-in / zoom-out / reset
    const toolbar = document.createElement('div');
    toolbar.className = 'mmd-toolbar';
    toolbar.innerHTML = `
      <button class="mmd-btn" data-action="in"  title="Увеличить">＋</button>
      <button class="mmd-btn" data-action="out" title="Уменьшить">－</button>
      <button class="mmd-btn" data-action="fit" title="Сбросить">⊡</button>
    `;
    toolbar.addEventListener('click', e => {
      const action = e.target.dataset.action;
      if (!action) return;
      if (action === 'in')  { scale = Math.min(8, scale * 1.25); applyTransform(); }
      if (action === 'out') { scale = Math.max(0.3, scale / 1.25); applyTransform(); }
      if (action === 'fit') {
        scale = 1; ox = 0; oy = 0;
        svg.style.transition = 'transform 0.2s ease';
        applyTransform();
        setTimeout(() => svg.style.transition = 'none', 220);
      }
    });

    // Хинт
    const hint = document.createElement('div');
    hint.className = 'mmd-hint';
    hint.textContent = 'Колесо — зум · Перетащи · Двойной клик — сброс';
    el.style.position = 'relative';
    el.style.overflow = 'hidden';
    el.appendChild(toolbar);
    el.appendChild(hint);
  }

  async function _renderMermaidInContainer(container) {
    if (typeof window.mermaid === 'undefined') return;
    const pending = container.querySelectorAll('.md-mermaid-pending');
    if (!pending.length) return;

    for (const el of pending) {
      el.classList.remove('md-mermaid-pending');
      el.classList.add('md-mermaid-rendering');
      const rawSrc = el.dataset.src || '';
      // Заменяем $формулы$ в тексте узлов на plain-text (KaTeX не работает внутри SVG)
      const src = _sanitizeMermaid(rawSrc.replace(/\$([^$\n]+)\$/g, (_, tex) => {
        // Убираем LaTeX-команды, оставляем читаемый текст
        return tex
          .replace(/\\[a-zA-Z]+/g, '')   // \phi → ''
          .replace(/[{}_^]/g, '')         // {} ^ _ → ''
          .trim() || tex;
      }));
      try {
        const id = 'mmd-' + Math.random().toString(36).slice(2, 8);
        const { svg } = await window.mermaid.render(id, src);
        el.innerHTML = svg;
        el.classList.remove('md-mermaid-rendering');
        el.classList.add('md-mermaid-done');
        _attachMermaidZoom(el);
      } catch(e) {
        // Попытка 2: только первые 8 строк
        try {
          const short = src.split('\n').slice(0, 8).join('\n');
          const id2 = 'mmd-' + Math.random().toString(36).slice(2, 8);
          const { svg } = await window.mermaid.render(id2, short);
          el.innerHTML = svg;
          el.classList.remove('md-mermaid-rendering');
          el.classList.add('md-mermaid-done');
          _attachMermaidZoom(el);
        } catch(e2) {
          el.classList.remove('md-mermaid-rendering');
          el.classList.add('md-mermaid-error');
          el.innerHTML = `<details class="md-mermaid-fallback">
            <summary>📊 Диаграмма (ошибка синтаксиса)</summary>
            <pre style="font-size:11px;opacity:.7;padding:8px;overflow:auto">${_escHtml(rawSrc)}</pre>
          </details>`;
        }
      }
    }
  }

  // ── Отложенный ре-рендер формул в уже вставленном HTML ──────
  function _rerenderMath(container) {
    if (typeof window.katex === 'undefined') return;
    // Заменяем fallback-спаны на настоящий KaTeX
    container.querySelectorAll('.md-math-block[data-tex], .md-math-inline[data-tex]').forEach(el => {
      const tex = el.dataset.tex;
      const display = el.classList.contains('md-math-block');
      try {
        el.outerHTML = window.katex.renderToString(tex, { displayMode: display, throwOnError: false });
      } catch(_) {}
    });
  }

  function _escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Санитизация итогового HTML — защита от XSS ───────────────
  // Заголовки, цитаты, списки, обычные параграфы и значения href/src
  // строятся из текста ответа ИИ (или вставленного пользователем текста)
  // без построчного экранирования — единственная надёжная граница защиты
  // здесь одна: перед вставкой в DOM разбираем итоговый HTML через
  // DOMParser (там ресурсы не загружаются и скрипты не выполняются) и
  // вычищаем опасные теги/атрибуты. Это же гасит атаки через "разрыв"
  // атрибута (например href, обрывающий кавычку и добавляющий onerror=...)
  // — такой onerror после парсинга становится обычным атрибутом элемента
  // и удаляется наравне с любым другим on*-обработчиком.
  const SANITIZE_REMOVE_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form']);

  function _isSafeUrl(value) {
    const v = String(value || '').trim();
    if (!v) return true;
    if (v.startsWith('#')) return true;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
      return /^(https?:|mailto:|tel:|data:image\/)/i.test(v);
    }
    return true; // относительный путь — безопасен
  }

  function _sanitizeHtml(html) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (_) {
      return _escHtml(html);
    }

    const toRemove = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (SANITIZE_REMOVE_TAGS.has(tag)) {
        toRemove.push(node);
      } else {
        Array.from(node.attributes || []).forEach(attr => {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on')) {
            node.removeAttribute(attr.name);
          } else if ((name === 'href' || name === 'src' || name === 'xlink:href') && !_isSafeUrl(attr.value)) {
            node.removeAttribute(attr.name);
          }
        });
      }
      node = walker.nextNode();
    }
    toRemove.forEach(n => n.remove());
    return doc.body.innerHTML;
  }

  // ── Нормализация строки таблицы ──────────────────────────────
  // Убирает | по краям, делит на ячейки
  function _parseTableRow(line) {
    // Удалить ведущий/завершающий |, затем разбить
    return line.replace(/^\|/, '').replace(/\|$/, '').split('|');
  }

  function _isSeparatorRow(cells) {
    return cells.every(c => /^[\s\-:]+$/.test(c));
  }

  function _getAlignment(cell) {
    const c = cell.trim();
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  }

  // ── Главный парсер таблиц ────────────────────────────────────
  // Проблема: ячейки с <br>\n в исходнике — это НЕ новые строки таблицы,
  // а продолжение той же ячейки. Сначала нормализуем.
  function _parseTable(rawBlock) {
    // rawBlock — текст таблицы как есть из markdown
    // Шаг 1: заменяем <br>\n на плейсхолдер чтобы не перепутать со строками таблицы
    const BR_PH = '\x01BR\x01';
    let block = rawBlock.replace(/<br\s*\/?>\s*\n/g, BR_PH);

    const rawLines = block.split('\n').filter(l => l.includes('|'));
    if (rawLines.length < 2) return null;

    // Найти строку-разделитель (---|---), она всегда вторая
    let sepIdx = -1;
    for (let i = 0; i < rawLines.length; i++) {
      const cells = _parseTableRow(rawLines[i]);
      if (_isSeparatorRow(cells)) { sepIdx = i; break; }
    }
    if (sepIdx < 0) return null;

    // Заголовки — всё до разделителя
    const headerRows = rawLines.slice(0, sepIdx);
    // Выравнивания из разделителя
    const alignCells = _parseTableRow(rawLines[sepIdx]);
    const aligns = alignCells.map(_getAlignment);
    // Тело — всё после разделителя
    const bodyRows = rawLines.slice(sepIdx + 1);

    const colCount = aligns.length;

    function renderCells(row, tag) {
      const cells = _parseTableRow(row);
      // Выравниваем по количеству столбцов
      while (cells.length < colCount) cells.push('');
      return cells.slice(0, colCount).map((c, i) => {
        const align = aligns[i] || 'left';
        // Восстанавливаем <br>
        const content = c.trim()
          .replace(new RegExp(BR_PH.replace(/\x01/g,'\\x01'), 'g'), '<br>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g,     '<em>$1</em>')
          .replace(/`([^`]+)`/g,     (_, c) => `<code class="md-inline-code">${_escHtml(c)}</code>`);
        return `<${tag} style="text-align:${align}" class="md-table-${tag}">${content}</${tag}>`;
      }).join('');
    }

    const thead = headerRows.map(r => `<tr>${renderCells(r, 'th')}</tr>`).join('');
    const tbody = bodyRows
      .filter(r => r.trim() && r.includes('|'))
      .map(r => `<tr>${renderCells(r, 'td')}</tr>`).join('');

    return `<div class="md-table-wrap"><table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
  }

  // ── Обработка списков с вложенностью ─────────────────────────
  function _processLists(lines) {
    const result = [];
    let i = 0;

    // Проверяем: является ли строка с учётом skip-blank следующей строкой списка
    function peekNextListLine(fromIdx, minIndent) {
      let j = fromIdx;
      // Пропускаем до 2 пустых строк (loose list в markdown)
      while (j < lines.length && lines[j].trim() === '' && j - fromIdx < 3) j++;
      if (j >= lines.length) return null;
      const l = lines[j];
      const ulM = l.match(/^(\s*)[-*•]\s+(.+)$/);
      const olM = l.match(/^(\s*)\d+[.)]\s+(.+)$/);
      const m = ulM || olM;
      if (!m) return null;
      if (m[1].length < minIndent) return null;
      return j; // возвращаем индекс следующего list-элемента
    }

    function parseList(indent, type) {
      const items = []; // { text, children }
      while (i < lines.length) {
        const line = lines[i];

        // Пропускаем пустые строки внутри списка если впереди ещё есть элементы
        if (line.trim() === '') {
          const nextIdx = peekNextListLine(i + 1, indent);
          if (nextIdx !== null) {
            i++; // пропускаем пустую строку
            continue;
          }
          break; // за пустой строкой нет продолжения — конец списка
        }

        const ulM  = line.match(/^(\s*)[-*•]\s+(.+)$/);
        const olM  = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
        const m    = ulM || olM;
        if (!m) break;

        const lineIndent = m[1].length;
        if (lineIndent < indent) break;

        if (lineIndent > indent) {
          const nestedType = ulM ? 'ul' : 'ol';
          const nested = parseList(lineIndent, nestedType);
          if (items.length > 0) items[items.length - 1].children += nested;
          continue;
        }

        const lineType = ulM ? 'ul' : 'ol';
        if (lineType !== type) break;

        i++;
        items.push({ text: m[2], children: '' });
      }
      const cls = type === 'ul' ? 'md-ul' : 'md-ol';
      const liHtml = items.map(it => `<li class="md-li">${it.text}${it.children}</li>`).join('');
      return `\x00LIST<${type} class="${cls}">${liHtml}</${type}>LIST\x00`;
    }

    while (i < lines.length) {
      const line = lines[i];
      const ulM  = line.match(/^(\s*)[-*•]\s+(.+)$/);
      const olM  = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
      if (ulM || olM) {
        const type   = ulM ? 'ul' : 'ol';
        const indent = (ulM || olM)[1].length;
        result.push(parseList(indent, type));
      } else {
        result.push(line);
        i++;
      }
    }
    return result.join('\n');
  }

  // ── Основная функция рендеринга ──────────────────────────────
  function renderMarkdown(md) {
    if (!md) return { html: '', imgSrcs: [] };

    let html = md;
    const blocks = []; // защищённые блоки — [placeholder → html]
    const _imgSrcs = []; // base64 src картинок — назначаются через DOM после рендера

    const protect = (content) => {
      const idx = blocks.length;
      blocks.push(content);
      return `\x00BLK${idx}\x00`;
    };

    // 1. Блочные формулы $$...$$ и \[...\]
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      // Исправляем двойные бэкслеши \\cmd → \cmd (возникают при JSON-сериализации)
      const t = tex.trim().replace(/\\\\/g, '\\');
      const rendered = _renderMath(t, true);
      return protect(`<div class="md-math-block" data-tex="${_escHtml(t)}">${rendered}</div>`);
    });
    html = html.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {
      const t = tex.trim().replace(/\\\\/g, '\\');
      const rendered = _renderMath(t, true);
      return protect(`<div class="md-math-block" data-tex="${_escHtml(t)}">${rendered}</div>`);
    });

    // 2. Блоки кода ```lang\n...\n```
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      // Mermaid → специальный рендер
      if (lang && lang.toLowerCase() === 'mermaid') {
        return protect(
          `<div class="md-mermaid md-mermaid-pending" data-src="${_escHtml(code.trim())}">` +
          `<div class="md-mermaid-placeholder"><span class="md-mermaid-spinner"></span> Строим диаграмму…</div>` +
          `</div>`
        );
      }

      const trimmed = code.trim();
      const lineCount = trimmed.split('\n').length;
      const langLabel = lang ? `<span class="code-lang">${_escHtml(lang)}</span>` : '<span class="code-lang">text</span>';
      const lineCountBadge = lineCount > 1 ? `<span class="code-lines">${lineCount} строк</span>` : '';
      const copyBtn = `<button class="md-copy-code" onclick="(function(b){const code=b.closest('.md-code-block').querySelector('code');navigator.clipboard?.writeText(code.textContent).then(()=>{b.textContent='✓ скопировано';b.style.color='var(--status-done)';setTimeout(()=>{b.textContent='копировать';b.style.color=''},1800)})})(this)">копировать</button>`;

      // Подсветка синтаксиса через highlight.js если загружен
      let highlighted = _escHtml(trimmed);
      if (typeof window.hljs !== 'undefined' && lang) {
        try {
          const result = window.hljs.highlight(trimmed, { language: lang, ignoreIllegals: true });
          highlighted = result.value;
        } catch(_) {
          highlighted = _escHtml(trimmed);
        }
      }

      // Нумерация строк
      const lines = highlighted.split('\n');
      const numberedLines = lines.map((line, i) =>
        `<span class="code-line"><span class="code-ln">${i + 1}</span>${line || ' '}</span>`
      ).join('\n');

      return protect(
        `<div class="md-code-block">` +
        `<div class="md-code-header">${langLabel}${lineCountBadge}${copyBtn}</div>` +
        `<pre><code class="hljs lang-${lang || 'text'}">${numberedLines}</code></pre>` +
        `</div>`
      );
    });

    // 3. Callout-блоки > [!TYPE]
    html = html.replace(/^>\s*\[!(NOTE|WARNING|TIP|INFO|DANGER)\]\s*\n((?:>.*\n?)*)/gmi, (_, type, body) => {
      const icons = { NOTE:'💡', WARNING:'⚠️', TIP:'✨', INFO:'ℹ️', DANGER:'🚨' };
      const cleaned = body.replace(/^>\s?/gm, '').trim();
      return protect(
        `<div class="md-callout callout-${type.toLowerCase()}">` +
        `<span class="callout-icon">${icons[type] || '📌'}</span>` +
        `<div class="callout-body">${renderMarkdown(cleaned).html || ''}</div>` +
        `</div>`
      );
    });

    // 4. Таблицы — извлекаем все таблицы целиком
    // Таблица: строки содержащие |, сгруппированные вместе
    html = html.replace(/((?:[ \t]*\|[^\n]+\n?){2,})/g, (match) => {
      const parsed = _parseTable(match);
      return parsed ? protect(parsed) : match;
    });

    // 5. Строчные формулы $...$ и \(...\)
    // ВАЖНО: оборачиваем в protect() — иначе _ внутри data-tex="..." будет съеден шагом 9
    html = html.replace(/\\\((.+?)\\\)/g, (_, tex) => {
      const t = tex.trim().replace(/\\\\/g, '\\');
      const rendered = _renderMath(t, false);
      return protect(`<span class="md-math-inline" data-tex="${_escHtml(t)}">${rendered}</span>`);
    });
    // $...$ — только если не в начале строки чтобы не путать с ценами
    html = html.replace(/(?<![\\$])\$([^$\n]{1,200}?)\$/g, (_, tex) => {
      if (/^\d+$/.test(tex.trim())) return `$${tex}$`;
      const t = tex.trim().replace(/\\\\/g, '\\');
      const rendered = _renderMath(t, false);
      return protect(`<span class="md-math-inline" data-tex="${_escHtml(t)}">${rendered}</span>`);
    });

    // 6. Inline-код (после формул)
    html = html.replace(/`([^`\n]+)`/g, (_, c) =>
      `<code class="md-inline-code">${_escHtml(c)}</code>`
    );

    // 7. Заголовки
    html = html.replace(/^#{6}\s+(.+)$/gm, (_, t) => `<h6 class="md-h6">${t}</h6>`);
    html = html.replace(/^#{5}\s+(.+)$/gm, (_, t) => `<h5 class="md-h5">${t}</h5>`);
    html = html.replace(/^#{4}\s+(.+)$/gm, (_, t) => `<h4 class="md-h4">${t}</h4>`);
    html = html.replace(/^#{3}\s+(.+)$/gm, (_, t) => `<h3 class="md-h3">${t}</h3>`);
    html = html.replace(/^#{2}\s+(.+)$/gm, (_, t) => `<h2 class="md-h2">${t}</h2>`);
    html = html.replace(/^#{1}\s+(.+)$/gm,  (_, t) => `<h1 class="md-h1">${t}</h1>`);

    // 8. Цитата
    html = html.replace(/^>\s+(.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');

    // 9. Жирный / курсив / зачёркнутый
    // Формулы уже в protect(blocks[]) — их _ не тронуты.
    // _ как курсив — только между пробелами/знаками препинания, не внутри слов
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g,      '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g,           '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g,           '<del>$1</del>');
    html = html.replace(/__(.+?)__/g,           '<strong>$1</strong>');
    // _ курсив _ — только если до и после стоит пробел/знак препинания/начало-конец строки
    html = html.replace(/(^|[\s(,;:.!?])_([^_\s][^_\n]*[^_\s]|[^_\s])_(?=[\s),.;:!?\n]|$)/gm,
      (_, before, inner) => `${before}<em>${inner}</em>`);

    // 10. Списки
    html = _processLists(html.split('\n'));

    // 11. Ссылки и картинки
    // base64 data-URL — НЕ вставляем в src атрибут HTML (браузер зависает при парсинге)
    html = html.replace(/!\[([^\]]*)\]\((data:[^)]{20,})\)/g, (_, alt, src) => {
      const idx = _imgSrcs.length;
      _imgSrcs.push(src);
      return `<img class="md-img" data-src-idx="${idx}" alt="${_escHtml(alt)}" loading="lazy">`;
    });
    // обычные URL — вставляем как раньше
    html = html.replace(/!\[([^\]]*)\]\((?!data:)([^)]+)\)/g,
      (_, alt, src) => `<img class="md-img" src="${_escHtml(src)}" alt="${_escHtml(alt)}" loading="lazy">`);
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
      (_, text, href) => `<a class="md-link" href="${_escHtml(href)}" target="_blank" rel="noopener">${text}</a>`);

    // 12. HR
    html = html.replace(/^(---|\*\*\*|___)\s*$/gm, '<hr class="md-hr">');

    // 13. Параграфы
    const tagRx = /^<(h[1-6]|ul|ol|pre|div|blockquote|table|hr|img|figure)/;
    html = html.split(/\n{2,}/).map(block => {
      block = block.trim();
      if (!block) return '';
      if (tagRx.test(block)) return block;
      if (/^\x00BLK/.test(block)) return block;
      if (/\x00LIST/.test(block)) return block; // список — не оборачивать в <p>
      // Одиночные переносы внутри параграфа → <br>
      return `<p class="md-p">${block.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');

    // 14. Восстанавливаем защищённые блоки
    html = html.replace(/\x00BLK(\d+)\x00/g, (_, i) => blocks[+i] || '');

    // 15. Снимаем маркер списков
    html = html.replace(/\x00LIST([\s\S]*?)LIST\x00/g, (_, inner) => inner);

    return { html: _sanitizeHtml(html), imgSrcs: _imgSrcs };
  }

  // ── CSS для формул и улучшенных таблиц ──────────────────────
  function _injectMathStyles() {}

  // ── CSS для нумерации строк кода ─────────────────────────────
  function _injectCodeStyles() {}

  // ── CSS для Mermaid zoom/pan toolbar ────────────────────────
  function _injectMermaidZoomStyles() {}

  // ── Патч AnswerPanel ─────────────────────────────────────────
  function _patch() {
    if (typeof window.AnswerPanel === 'undefined') {
      // AnswerPanel ещё не загружен — попробуем позже
      setTimeout(_patch, 100);
      return;
    }

    _injectMathStyles();
    _injectCodeStyles();
    _injectMermaidZoomStyles();

    // Переключение темы highlight.js при смене темы приложения
    const _syncHljsTheme = () => {
      const isDark = document.body.dataset.theme !== 'light';
      const darkLink  = document.getElementById('hljs-theme-dark');
      const lightLink = document.getElementById('hljs-theme-light');
      if (darkLink)  darkLink.disabled  = !isDark;
      if (lightLink) lightLink.disabled = isDark;
    };
    _syncHljsTheme();
    // Следим за изменением темы
    new MutationObserver(_syncHljsTheme).observe(document.body, {
      attributes: true, attributeFilter: ['data-theme']
    });

    // Заменяем renderMarkdown
    window.AnswerPanel.renderMarkdown = renderMarkdown;

    // Хелпер: рендер формул
    function _applyMathToBody() {
      const body = document.getElementById('ap-answer-body');
      if (!body) return;
      _waitForKatex(() => _rerenderMath(body));
      if (body.querySelector('.md-mermaid-pending')) {
        _loadMermaid(() => _renderMermaidInContainer(body));
      }
    }

    // Патч open()
    const originalOpen = window.AnswerPanel.open;
    if (originalOpen) {
      window.AnswerPanel.open = function(nodeId) {
        originalOpen.call(this, nodeId);
        // Двойной rAF: ждём полной отрисовки DOM
        requestAnimationFrame(() => requestAnimationFrame(() => {
          _applyMathToBody();
          setTimeout(_applyMathToBody, 150); // страховка
        }));
      };
    }

    // Патч setAnswer() — вызывается после автоответа ИИ
    const originalSetAnswer = window.AnswerPanel.setAnswer;
    if (originalSetAnswer) {
      window.AnswerPanel.setAnswer = function(nodeId, text, status) {
        originalSetAnswer.call(this, nodeId, text, status);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          _applyMathToBody();
          setTimeout(_applyMathToBody, 150);
        }));
      };
    }

    // При первом открытии страницы
    _waitForKatex(() => {
      requestAnimationFrame(() => {
        if (document.getElementById('ap-answer-body')) _applyMathToBody();
      });
    });

    console.log('[render-markdown] ✓ patched — KaTeX sync + math + mermaid');
  }

  // Запуск после загрузки DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _patch);
  } else {
    _patch();
  }

  // Экспортируем для использования в других местах (autobreakdown mdToHtml)
  window.renderMarkdownFixed = renderMarkdown;
  // Ключевой экспорт — answer-panel.js проверяет это имя
  window._renderMarkdownPatched = renderMarkdown;

})();
