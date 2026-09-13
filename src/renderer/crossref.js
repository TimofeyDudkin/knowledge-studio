/**
 * crossref.js — подсветка перекрёстных ссылок по основе слова.
 *
 * Улучшения:
 *  • Матчинг по основе слова (стемминг) — максимальное совпадение
 *  • Индекс кэшируется и инвалидируется только при смене темы
 *  • Подсветка через requestAnimationFrame — не блокирует UI
 *  • Tooltip позиционируется относительно viewport, не вылезает за края
 */

window.CrossRef = (() => {
  // ─── Кэш индекса ────────────────────────────────────────────
  let _wordIndex   = new Map();   // stem → Set<nodeId>
  let _indexTopicId = null;       // для инвалидации кэша
  let _tooltip     = null;

  // ─── Построение индекса ─────────────────────────────────────

  function buildIndex() {
    const topic = AppState.getCurrentTopic();
    if (!topic) { _wordIndex = new Map(); return; }

    // Пересобираем только если тема изменилась
    if (_indexTopicId === topic.id && _wordIndex.size > 0) return;

    _wordIndex = TreeHelpers.buildWordIndex(topic.nodes);

    // Дополнительно индексируем название самой темы (без nodeId — используем 'topic')
    const topicStems = TreeHelpers.tokenize(topic.name);
    for (const s of topicStems) {
      if (!_wordIndex.has(s)) _wordIndex.set(s, new Set());
      _wordIndex.get(s).add('topic:' + topic.id);
    }

    _indexTopicId = topic.id;
  }

  /** Сбросить кэш (вызывать при добавлении/изменении ответа) */
  function invalidate() {
    _indexTopicId = null;
  }

  // ─── Highlight ───────────────────────────────────────────────

  /**
   * Обойти текстовые ноды внутри container и обернуть совпадения.
   * Используем requestAnimationFrame чтобы не блокировать рендер.
   */
  function highlight(container) {
    buildIndex();
    if (_wordIndex.size === 0) return;

    const currentNodeId = AppState.get('selectedNodeId');

    // Собираем все текстовые ноды заранее (до мутаций DOM)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) {
      // Пропускаем code/pre и уже обёрнутые
      if (n.parentNode?.closest('code, pre, .crossref-word')) continue;
      if (!n.textContent.trim()) continue;
      textNodes.push(n);
    }

    if (!textNodes.length) { ensureTooltip(); return; }

    // Обрабатываем пакетами через rAF чтобы не фризить UI
    let idx = 0;
    const BATCH = 20;

    function processBatch() {
      const end = Math.min(idx + BATCH, textNodes.length);
      for (; idx < end; idx++) {
        const textNode = textNodes[idx];
        if (!textNode.parentNode) continue; // уже заменён
        const frag = wrapWords(textNode.textContent, currentNodeId);
        if (frag) textNode.parentNode.replaceChild(frag, textNode);
      }
      if (idx < textNodes.length) {
        requestAnimationFrame(processBatch);
      }
    }

    requestAnimationFrame(processBatch);
    ensureTooltip();
  }

  // ─── Обёртка слов ───────────────────────────────────────────

  // Разбиваем на «слова» (≥5 символов) — короткие слова («это», «для», «что») не подсвечиваем
  const WORD_RE = /([а-яёa-z]{5,})/giu;

  function wrapWords(text, currentNodeId) {
    // Быстрая проверка: есть ли вообще совпадения
    const test = text.replace(/[^а-яёa-z]/gi, ' ').split(/\s+/);
    const hasMatch = test.some(w => {
      if (w.length < 5) return false;
      const s = TreeHelpers.stemWord(w.toLowerCase());
      const ids = _wordIndex.get(s);
      // Совпадение есть если слово встречается в ДРУГОМ узле (не текущем)
      return ids && ids.size > 0 && ![...ids].every(id => id === currentNodeId);
    });
    if (!hasMatch) return null;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let changed = false;

    // Находим слова через regex
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text)) !== null) {
      const word    = m[0];
      const wordPos = m.index;

      // Текст до слова
      if (wordPos > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, wordPos)));
      }

      const stemmed  = TreeHelpers.stemWord(word.toLowerCase());
      const ids      = _wordIndex.get(stemmed);
      // Исключаем: только текущий узел, или topic-записи где слово есть и в узле
      const otherIds = ids ? [...ids].filter(id => id !== currentNodeId) : [];

      if (otherIds.length > 0) {
        changed = true;
        const span = document.createElement('span');
        span.className = 'crossref-word';
        span.textContent = word;
        span.dataset.stem    = stemmed;
        span.dataset.nodeIds = otherIds.join(',');
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(word));
      }

      lastIndex = wordPos + word.length;
    }

    // Остаток
    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    return changed ? frag : null;
  }

  // ─── Tooltip (делегированный) ────────────────────────────────

  function ensureTooltip() {
    if (_tooltip) return;
    _tooltip = document.createElement('div');
    _tooltip.className = 'crossref-tooltip';
    _tooltip.style.cssText = 'display:none;position:fixed;z-index:9999;';
    document.body.appendChild(_tooltip);

    // Скрываем при клике в любом месте
    document.addEventListener('click', hideTooltip, { capture: true });
  }

  // Делегируем события mouseenter/mouseleave на уровне document
  // вместо навешивания на каждый span — это намного быстрее
  let _hoverTimer = null;

  document.addEventListener('mouseover', e => {
    const span = e.target.closest?.('.crossref-word');
    if (!span) return;
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(() => _showForSpan(span, e), 120);
  });

  document.addEventListener('mouseout', e => {
    const span = e.target.closest?.('.crossref-word');
    if (!span) return;
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(hideTooltip, 80);
  });

  function _showForSpan(span, e) {
    const ids = span.dataset.nodeIds?.split(',') || [];
    const topic = AppState.getCurrentTopic();
    if (!topic || !ids.length) return;

    const items = ids.map(id => {
      // Запись для названия темы
      if (id.startsWith('topic:')) {
        return `<li><span class="cr-path cr-topic-badge">тема</span>${escHtml(topic.name)}</li>`;
      }
      const node = AppState.findNode(id);
      if (!node) return '';
      // Показываем путь к узлу для контекста
      const path = TreeHelpers.getPath(topic.nodes, id) || [];
      const pathStr = path.length > 1
        ? path.slice(0, -1).map(p => escHtml(p.label)).join(' › ') + ' › '
        : '';
      return `<li><span class="cr-path">${pathStr}</span>${escHtml(node.label)}</li>`;
    }).filter(Boolean);

    if (!items.length) return;

    ensureTooltip();
    _tooltip.innerHTML = `
      <div class="crossref-tooltip-title">Встречается в:</div>
      <ul class="crossref-tooltip-list">${items.join('')}</ul>`;
    _tooltip.style.display = 'block';

    // Позиционирование с учётом краёв экрана
    const rect = span.getBoundingClientRect();
    let top  = rect.bottom + 6;
    let left = rect.left;

    _tooltip.style.left = '0';
    _tooltip.style.top  = '0';
    requestAnimationFrame(() => {
      const tw = _tooltip.offsetWidth;
      const th = _tooltip.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (left + tw > vw - 8) left = vw - tw - 8;
      if (left < 8) left = 8;
      if (top + th > vh - 8) top = rect.top - th - 6;

      _tooltip.style.left = left + 'px';
      _tooltip.style.top  = top  + 'px';
    });
  }

  function hideTooltip() {
    if (_tooltip) _tooltip.style.display = 'none';
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { highlight, buildIndex, invalidate };
})();