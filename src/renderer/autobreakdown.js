/**
 * autobreakdown.js — Авторазбор v36
 *
 * v36 vs v35:
 *  1. _apiSem — семафор: не более 2 параллельных запросов к Gemini API на ключ.
 *     Устраняет 429 RPM при параллельном Promise.allSettled дочерних узлов.
 *  2. Пауза: while(RUN.paused) в askViaGeminiAPI перед каждым запросом.
 *  3. Стоп: abortAll() сбрасывает очередь семафора мгновенно.
 */
(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════════════════
  // КОНФИГ
  // ════════════════════════════════════════════════════════════════════════════

  const CFG = {
    DEEPSEEK_URL: 'https://chat.deepseek.com/',
    GEMINI_URL: 'https://gemini.google.com/app',
    MAX_CHILDREN: 5,
    MAX_RETRIES: 4,
    MAX_RECOVERY: 3,
    DS_DELAY: 2800,
    GM_DELAY: 3500,
    ANSWER_TIMEOUT: 300_000,
    STALL_TIMEOUT: 60_000,
    POLL_MS: 1_800,
    STABLE_ROUNDS: 4,
    MIN_GROWTH: 8,
    MIN_TEXT_LEN: 60,
    NODE_TIMEOUT: 300_000,  // v33: увеличен с 170с до 300с — d2/d3 не тайм-аутят в очереди
    DEBUG: false,
  };

  // RUN через Proxy: при изменении .active диспатчит CustomEvent 'ab:statechange'
  // index.js слушает это событие для подсветки кнопки — без polling setInterval
  const _runRaw = {
    active: false, cancelled: false, paused: false,
    done: 0, errors: 0, total: 0, recovered: 0,
    phase: 'idle', log: [],
  };
  const RUN = new Proxy(_runRaw, {
    set(target, prop, value) {
      target[prop] = value;
      if (prop === 'active') {
        try {
          document.dispatchEvent(new CustomEvent('ab:statechange', { detail: { active: value } }));
        } catch (_) {}
      }
      return true;
    },
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dbg = (...a) => console.log('[AB v35]', ...a);

  // ── Семафор: не более N параллельных HTTP-запросов к Gemini API ─────────────
  // Важно: слот (_running++) захватывается СИНХРОННО в момент, когда waiter
  // реально забирается из очереди — иначе несколько waiter'ов могут пройти
  // проверку `_running < _max` за один и тот же синхронный проход _flush(),
  // до того как асинхронный .then() успеет увеличить _running (race condition,
  // сводившая на нет весь смысл семафора).
  const _apiSem = (() => {
    let _max = 2, _running = 0;
    const _q = [];
    const _release = () => { _running = Math.max(0, _running - 1); _flush(); };
    const _flush = () => {
      while (_running < _max && _q.length) {
        _running++;
        _q.shift()(null);
      }
    };
    return {
      setMax(n) { _max = n; _flush(); },
      acquire(cancelCheck) {
        if (_running < _max) { _running++; return Promise.resolve(); }
        return new Promise((res, rej) => {
          _q.push(err => err ? rej(err) : res());
        }).then(() => {
          if (cancelCheck?.()) { _release(); throw new Error('Отменено'); }
        });
      },
      release: _release,
      abortAll() {
        const e = new Error('Отменено');
        while (_q.length) _q.shift()(e);
      },
    };
  })();


  // ════════════════════════════════════════════════════════════════════════════
  // AUTH ERROR — специальный класс для ошибок авторизации
  // ════════════════════════════════════════════════════════════════════════════

  class AuthError extends Error {
    constructor(provider) {
      super(`${provider}: не авторизован или поле чата не найдено`);
      this.name = 'AuthError';
      this.provider = provider;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ЕДИНЫЙ АДАПТЕР ДАННЫХ
  // ════════════════════════════════════════════════════════════════════════════

  const Tree = {
    topic() { return AppState.getCurrentTopic(); },
    findNode(nodeId) { return AppState.findNode(nodeId); },
    findInNodes(nodes, nodeId) {
      for (const n of nodes) {
        if (n.id === nodeId) return n;
        const f = this.findInNodes(n.children || [], nodeId);
        if (f) return f;
      }
      return null;
    },
    getQuestion(nodeId) {
      const node = AppState.findNode(nodeId);
      return node?.label || '';
    },
    saveAnswer(nodeId, answerText, status = 'done') {
      const topic = AppState.getCurrentTopic();
      if (!topic) return;
      TreeHelpers.updateNode(topic.nodes, nodeId, { answer: answerText, status });
      Persist.save();
      this._notifyUI();
    },
    saveChildren(nodeId, labels) {
      const topic = AppState.getCurrentTopic();
      if (!topic) return labels.map(l => ({ id: _uid(), label: l }));
      const parent = AppState.findNode(nodeId);
      if (!parent) return labels.map(l => ({ id: _uid(), label: l }));
      parent.children = parent.children || [];
      const created = [];
      for (const label of labels) {
        const child = { id: _uid(), label, status: 'open', answer: null, children: [], parentId: nodeId, attachments: [] };
        parent.children.push(child);
        // Регистрируем в O(1) индексе
        AppState.indexNode(child);
        created.push({ id: child.id, label });
      }
      Persist.save();
      this._notifyUI();
      return created;
    },
    _notifyUI() {
      if (typeof Render !== 'undefined') Render.renderTree?.();
      if (typeof window.graphModule !== 'undefined') window.graphModule.refresh?.();
    },
  };

  function _uid() {
    return 'node_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARKDOWN → HTML
  // ════════════════════════════════════════════════════════════════════════════

  function mdToHtml(src) {
    if (!src) return '';
    const blocks = [];
    let h = src.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
      const i = blocks.length;
      blocks.push(`<pre><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim()}</code></pre>`);
      return `\x00B${i}\x00`;
    });
    h = h
      .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>').replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>').replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^[-*_]{3,}$/gm, '<hr>');
    h = h.replace(/((?:^\d+\.\s+.+\n?)+)/gm, m =>
      `<ol>${m.trim().split('\n').map(l => `<li>${l.replace(/^\d+\.\s+/, '').trim()}</li>`).join('')}</ol>`);
    h = h.replace(/((?:^[-*•]\s+.+\n?)+)/gm, m =>
      `<ul>${m.trim().split('\n').map(l => `<li>${l.replace(/^[-*•]\s+/, '').trim()}</li>`).join('')}</ul>`);
    h = h.split(/\n{2,}/).map(b => {
      b = b.trim();
      if (!b || /^<(h[1-6]|ul|ol|pre|hr)/.test(b) || /^\x00B\d+\x00$/.test(b)) return b;
      return `<p>${b.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    return h.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[+i] || '');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ПРОМПТЫ
  // ════════════════════════════════════════════════════════════════════════════

  // ─── Языковые утилиты ────────────────────────────────────────────────────────
  function _getLang() { return window.Settings?.get('decomp_lang') || 'Русский'; }

  function _getLangBlock() {
    const lang = _getLang();
    if (lang === 'Русский')
      return '\n\n!!! ОБЯЗАТЕЛЬНО: Все подвопросы пиши ИСКЛЮЧИТЕЛЬНО на РУССКОМ языке. Никакого английского. Даже если тема звучит по-английски — подвопросы всё равно ТОЛЬКО на русском !!!';
    if (lang === 'English')
      return '\n\n!!! MANDATORY: Write ALL subquestions in ENGLISH only. No other language !!!';
    if (lang === 'Deutsch')
      return '\n\n!!! PFLICHT: Alle Teilfragen NUR auf DEUTSCH schreiben !!!';
    return ''; // «Как вопрос»
  }

  function _getLangAnswerLine() {
    const lang = _getLang();
    if (lang === 'Русский') return 'Только русский язык';
    if (lang === 'English') return 'English only';
    if (lang === 'Deutsch') return 'Nur Deutsch';
    return 'Используй язык вопроса';
  }

  // Проверяет что подвопросы соответствуют выбранному языку.
  // Для «Русский» — латиница не должна составлять большинство символов.
  function _checkQsLang(qs) {
    const lang = _getLang();
    if (lang === 'Как вопрос' || !qs || qs.length === 0) return true;
    const text = qs.join(' ');
    const latin  = (text.match(/[a-zA-Z]/g) || []).length;
    const cyril  = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
    const german = (text.match(/[äöüßÄÖÜ]/g) || []).length;
    if (lang === 'Русский') return cyril > latin;       // кириллица должна преобладать
    if (lang === 'English') return latin > cyril;        // латиница должна преобладать
    if (lang === 'Deutsch') return (latin + german) > cyril;
    return true;
  }

  // v35: принимает siblings — массив меток уже существующих соседних вопросов
  const pDecompose = (q, depth, chain, siblings = []) => {
    const n = depth === 0 ? CFG.MAX_CHILDREN : clamp(CFG.MAX_CHILDREN - depth * 2, 2, CFG.MAX_CHILDREN);
    const rootTopic = chain.length > 0 ? chain[0] : q;
    const ctx = chain.length
      ? `Дисциплина / тема: «${rootTopic}».\nТекущий раздел для разбиения: «${q}».\n`
      : `Дисциплина / тема: «${q}».\n`;

    const lb = _getLangBlock();

    // Описание требуемой глубины проработки
    const depthHint = depth === 0
      ? `Глубина: обзорный уровень. Вопросы должны покрывать РАЗНЫЕ ключевые аспекты дисциплины:\n  • Классификация и виды / типы объекта\n  • Морфология, строение, состав\n  • Биохимия, молекулярные механизмы\n  • Физиология, функции, регуляция\n  • Патология, нарушения, клиническое значение\n  • Методы исследования и визуализации`
      : depth === 1
        ? `Глубина: механистический уровень. Вопросы должны раскрывать конкретные процессы, структуры и механизмы:\n  • Точные морфологические или молекулярные детали\n  • Конкретные биохимические реакции или пути\n  • Функциональные взаимосвязи\n  • Регуляторные механизмы`
        : `Глубина: детальный молекулярно-клеточный уровень. Вопросы — конкретные узкие аспекты:\n  • Молекулярные структуры, домены, взаимодействия\n  • Ферментативные реакции, субстраты, кофакторы\n  • Генетическая регуляция, экспрессия\n  • Количественные параметры, клиническая трактовка`;

    // Anti-дублирование: показываем AI уже существующих братьев
    const siblingsBlock = siblings.length > 0
      ? `\nУЖЕ СУЩЕСТВУЮЩИЕ вопросы-братья (НЕ повторять и НЕ пересекаться с ними):\n${siblings.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`
      : '';

    const ex = Array.from({ length: n }, (_, i) => `"Вопрос ${i + 1}"`).join(', ');

    return `${ctx}
ЗАДАЧА: Раздели раздел «${q}» на ровно ${n} СТРОГО РАЗЛИЧАЮЩИХСЯ научных подвопроса.

${depthHint}
${siblingsBlock}
ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Каждый подвопрос охватывает ОДИН уникальный аспект — без пересечений с другими
2. Подвопросы НЕ повторяют и НЕ перефразируют друг друга
3. Совокупность вопросов даёт ПОЛНОЕ понимание раздела
4. Формулировка: «Каков/Как/Что представляет собой/Каковы/Каким образом…» + конкретный объект
5. Научный стиль: точная терминология, без упрощений
6. Порядок: от общего к частному, от строения к функции к регуляции${lb}

Ответь ТОЛЬКО одной строкой JSON без пояснений:
{"questions":[${ex}]}
Ровно ${n} элементов.${lb}`;
  };

  // v35: retry с научным стилем
  const pDecomposeRetry = (q, n, siblings = []) => {
    const lb = _getLangBlock();
    const siblingsBlock = siblings.length > 0
      ? `Уже существующие вопросы (НЕ дублировать): ${siblings.map((s, i) => `${i+1}) ${s}`).join('; ')}\n`
      : '';
    return `Тема: «${q}».${lb}
${siblingsBlock}Сформулируй ровно ${n} научных подвопроса для академического изучения темы.
Каждый вопрос — отдельный уникальный аспект (строение, механизм, функция, регуляция, патология и т.д.).
Без повторов и пересечений между вопросами. Научная терминология.${lb}

Ответь СТРОГО в формате JSON одной строкой:
{"questions":[${Array.from({ length: n }, (_, i) => `"Вопрос ${i + 1}"`).join(', ')}]}${lb}`;
  };

  /**
   * Убирает из ответа AI случайно попавший в него промпт.
   * Ищем самый ранний из канонических заголовков ответа (см. pAnswer ниже)
   * и берём текст начиная с него — так эхо промпта отрезается, даже если
   * модель пропустила первый раздел (он не всегда применим к вопросу).
   */
  const ANSWER_SECTION_HEADINGS = [
    '## Определение и общая характеристика',
    '## Строение и состав',
    '## Механизм и физиология',
    '## Функции и значение',
    '## Клиническое и прикладное значение',
    '## Ключевые термины',
  ];
  function _stripPromptEcho(text) {
    let bestIdx = -1;
    for (const marker of ANSWER_SECTION_HEADINGS) {
      const idx = text.indexOf(marker);
      if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
    }
    return bestIdx > 0 ? text.slice(bestIdx) : text;
  }

  // v35: научный промпт уровня учебника/лекции
  const pAnswer = (q, chain) => {
    const rootTopic = chain.length > 0 ? chain[0] : q;
    const breadcrumb = chain.length > 1
      ? `Дисциплина: «${rootTopic}». Раздел: ${chain.slice(1).join(' → ')}.\n`
      : chain.length === 1
        ? `Дисциплина: «${rootTopic}».\n`
        : '';

    return `${breadcrumb}
ВОПРОС: «${q}»

Дай развёрнутый академический ответ уровня университетского учебника или лекции.
НАЧНИ СРАЗУ с раздела "## Определение и общая характеристика" — БЕЗ вводных фраз и повтора вопроса.

Структура ответа (Markdown):

## Определение и общая характеристика
Точное научное определение. Место в классификации. Ключевые отличительные признаки.

## Строение и состав (морфология / молекулярная структура)
Детальная характеристика структурных компонентов. Уровни организации. Важные структурные особенности.

## Механизм и физиология
Как это функционирует на молекулярном/клеточном/тканевом уровне. Регуляторные механизмы. Биохимические реакции если применимо.

## Функции и значение
Роль в организме / системе. Функциональные взаимосвязи с другими структурами.

## Клиническое и прикладное значение
Патологии, связанные с нарушением. Диагностическое и терапевтическое значение. Методы исследования.

## Ключевые термины
Глоссарий 4–6 терминов с краткими определениями в формате: **Термин** — определение.

ТРЕБОВАНИЯ:
- Язык: ${_getLangAnswerLine()}
- Научный стиль: точная терминология, без упрощений
- **Жирный** для каждого термина при первом появлении
- Конкретные данные вместо общих слов (числа, названия, формулы если уместно)
- Если раздел неприменим к данному вопросу — пропусти его
- НЕ включай этот промпт, инструкции или список требований в ответ
- КРИТИЧНО: завершай каждый раздел полностью — не обрывай список или предложение на середине

ФОРМАТИРОВАНИЕ (ОБЯЗАТЕЛЬНО):
- Математические формулы — ТОЛЬКО в LaTeX: $инлайн-формула$ или $$блочная формула на отдельной строке$$
- Таблицы markdown для сравнения нескольких объектов или параметров

ДИАГРАММЫ mermaid (только если реально помогают понять тему):
- Используй flowchart TD или LR для процессов и цепочек
- КРИТИЧЕСКИЕ ПРАВИЛА СИНТАКСИСА — строго соблюдай:
  1. Текст узлов ТОЛЬКО в двойных кавычках: A["Текст узла"]
  2. НИКАКИХ скобок () внутри текста узла — заменяй на запятую или двоеточие
  3. НИКАКИХ спецсимволов внутри кавычек: нет →, ⟶, /, \, |, #, &
  4. Стрелки только: --> или --- или ==>
  5. Максимум 8 узлов, текст узла максимум 4 слова
  6. Пример правильного узла: A["Фотон поглощается"] --> B["Электрон возбуждён"]
  7. Если не уверен в синтаксисе — не добавляй диаграмму`;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // СКРЫТЫЙ КОНТЕЙНЕР ВОРКЕРОВ
  // ════════════════════════════════════════════════════════════════════════════

  function getHiddenContainer() {
    let c = document.getElementById('ab-hidden-pool');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'ab-hidden-pool';
    c.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0;z-index:-1;';
    document.body.appendChild(c);
    return c;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // WORKER MANAGER
  // ════════════════════════════════════════════════════════════════════════════

  const WM = {
    dsPool: [],
    gmPool: [],

    createWorker(id, provider, url) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'width:1px;height:1px;overflow:hidden;';
      const wv = document.createElement('webview');
      wv.style.cssText = 'width:1280px;height:800px;';
      wv.src = url;
      wrap.appendChild(wv);
      getHiddenContainer().appendChild(wrap);
      return { id, provider, wv, wrap, busy: false, dead: false, ready: false, recoveries: 0 };
    },

    setBusy(e, v) { if (e) e.busy = v; },
    setReady(e, v) { if (e) e.ready = v; },

    killEntry(e) {
      if (!e) return;
      try { e.wv.stop?.(); } catch (_) { }
      try { e.wv.src = 'about:blank'; } catch (_) { }
      try { e.wrap.remove(); } catch (_) { }
      e.dead = true; e.ready = false; e.busy = false;
    },

    killAll() {
      // Сначала корректно убиваем каждый воркер (stop + about:blank),
      // только потом очищаем контейнер — иначе webview-процессы остаются в фоне
      [...this.dsPool, ...this.gmPool].forEach(e => this.killEntry(e));
      this.dsPool.length = 0;
      this.gmPool.length = 0;
      const c = document.getElementById('ab-hidden-pool');
      if (c) c.innerHTML = '';
    },

    async replaceWorker(entry) {
      const pool = entry.provider === 'ds' ? this.dsPool : this.gmPool;
      const idx = pool.indexOf(entry);
      const url = entry.provider === 'ds' ? CFG.DEEPSEEK_URL : CFG.GEMINI_URL;
      const tag = `${entry.provider.toUpperCase()}#${entry.id}`;
      entry.busy = false;
      this.killEntry(entry);
      dbg(`replaceWorker: ${tag} убит, создаём новый...`);
      panelLog?.(`  🔧 ${tag} пересоздание webview...`);
      const newEntry = this.createWorker(entry.id, entry.provider, url);
      if (idx >= 0) pool[idx] = newEntry;
      dbg(`replaceWorker: ${tag} ждём dom-ready...`);
      await waitReady(newEntry);
      dbg(`replaceWorker: ${tag} dom-ready, ждём delay...`);
      if (newEntry.provider === 'ds') await sleep(CFG.DS_DELAY);
      else await sleep(CFG.GM_DELAY);
      newEntry.ready = true;
      dbg(`replaceWorker: ${tag} пересоздан и готов`);
      panelLog?.(`  ✓ ${tag} воркер готов после пересоздания`);
      return newEntry;
    },
  };

  function waitReady(entry, ms = 45_000) {
    return new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      const ok = () => { clearTimeout(t); resolve(); };
      entry.wv.addEventListener('dom-ready', ok, { once: true });
      entry.wv.addEventListener('did-finish-load', ok, { once: true });
    });
  }

  // ─── Инициализация пула ────────────────────────────────────────────────────

  let _poolInited = false;

  async function initPool() {
    if (_poolInited) return;
    _poolInited = true;
    dbg('initPool: запуск DS×2 + GM×2...');
    const tasks = [];
    for (let i = 0; i < 2; i++) {
      const e = WM.createWorker(i, 'ds', CFG.DEEPSEEK_URL);
      WM.dsPool.push(e);
      tasks.push(
        waitReady(e)
          .then(() => { dbg(`DS#${i} dom-ready`); return sleep(CFG.DS_DELAY); })
          .then(() => { e.ready = true; dbg(`DS#${i} готов (delay ${CFG.DS_DELAY}ms)`); panelLog?.(`  ✓ DS#${i} готов`); })
      );
    }
    for (let i = 0; i < 2; i++) {
      const e = WM.createWorker(i, 'gm', CFG.GEMINI_URL);
      WM.gmPool.push(e);
      tasks.push(
        waitReady(e)
          .then(() => { dbg(`GM#${i} dom-ready`); return sleep(CFG.GM_DELAY); })
          .then(() => { e.ready = true; dbg(`GM#${i} готов (delay ${CFG.GM_DELAY}ms)`); panelLog?.(`  ✓ GM#${i} готов`); })
      );
    }
    await Promise.all(tasks);
    dbg('initPool: DS×2 + GM×2 готовы');
  }

  // ─── Захват воркера ────────────────────────────────────────────────────────

  // _workerFreeListeners — очередь ожидающих промисов.
  // Когда воркер освобождается (releaseWorker), он нотифицирует первого в очереди.
  // Нет активного polling — нет нагрузки на UI.
  const _workerFreeListeners = [];

  function _notifyWorkerFree() {
    if (_workerFreeListeners.length > 0) {
      const resolve = _workerFreeListeners.shift();
      resolve();
    }
  }

  const _reviving = new Set(); // guard: не запускать replaceWorker дважды на один entry

  async function acquireWorker() {
    const deadline = Date.now() + 300_000;

    while (true) {
      if (RUN.cancelled) throw new Error('Отменено');
      if (Date.now() > deadline) {
        const st = [...WM.dsPool, ...WM.gmPool].map(e =>
          `${e.provider.toUpperCase()}#${e.id}:${e.dead ? 'DEAD' : e.busy ? 'BUSY' : e.ready ? 'IDLE' : 'INIT'}`).join(' ');
        dbg(`acquireWorker timeout. Статус: ${st}`);
        throw new Error('acquireWorker timeout');
      }

      // 1. Ищем свободный живой готовый воркер
      for (const pool of [WM.dsPool, WM.gmPool]) {
        const e = pool.find(x => !x.busy && !x.dead && x.ready);
        if (e) {
          // Проверяем что webview всё ещё в DOM, иначе помечаем dead
          if (!document.body.contains(e.wrap)) {
            dbg(`acquireWorker: ${e.provider.toUpperCase()}#${e.id} detached от DOM → dead`);
            panelLog?.(`  ⚠ ${e.provider.toUpperCase()}#${e.id} detached → помечаем dead`);
            e.dead = true; e.ready = false; e.busy = false;
            continue;
          }
          WM.setBusy(e, true);
          dbg(`acquireWorker: захвачен ${e.provider.toUpperCase()}#${e.id}`);
          return e;
        }
      }

      // 2. Запускаем пересоздание мёртвых незанятых воркеров (без await — фоново)
      const dead = [...WM.dsPool, ...WM.gmPool].filter(x => x.dead && !x.busy && !_reviving.has(x));
      for (const old of dead) {
        _reviving.add(old);
        const tag = `${old.provider.toUpperCase()}#${old.id}`;
        panelLog?.(`🔁 Авто-пересоздание ${tag}...`);
        dbg(`acquireWorker: запускаем revive ${tag}`);
        WM.replaceWorker(old).then(fresh => {
          fresh.ready = true;
          _reviving.delete(old);
          dbg(`acquireWorker: ${tag} revived успешно`);
          panelLog?.(`  ✓ ${tag} пересоздан`);
          // Нотифицируем ожидающих — появился свободный воркер
          _notifyWorkerFree();
        }).catch(e => {
          _reviving.delete(old);
          dbg(`acquireWorker: revive ${tag} провал: ${e.message}`);
          panelLog?.(`  ✗ ${tag} пересоздание провалилось: ${e.message}`);
        });
      }

      // 3. Ждём события освобождения воркера — без активного polling.
      // Максимальное ожидание = min(оставшееся до deadline, 30с) для защиты от потерянных событий.
      const remaining = deadline - Date.now();
      const waitMs = Math.min(remaining, 30_000);
      dbg(`acquireWorker: нет свободных воркеров, ждём события (до ${Math.round(waitMs/1000)}с)...`);
      panelLog?.(`  ⏳ ожидание свободного воркера...`);

      await new Promise(resolve => {
        const timer = setTimeout(() => {
          // Убираем себя из очереди если сработал таймаут
          const idx = _workerFreeListeners.indexOf(resolve);
          if (idx >= 0) _workerFreeListeners.splice(idx, 1);
          resolve();
        }, waitMs);

        _workerFreeListeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  const releaseWorker = e => {
    if (e && !e.dead) WM.setBusy(e, false);
    // Нотифицируем ожидающих в acquireWorker — появился свободный воркер
    _notifyWorkerFree();
  };

  // ════════════════════════════════════════════════════════════════════════════
  // НАВИГАЦИЯ И ОТПРАВКА
  // ════════════════════════════════════════════════════════════════════════════

  function _waitLoad(wv, ms = 30_000) {
    return new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      const ok = () => { clearTimeout(t); resolve(); };
      wv.addEventListener('did-finish-load', ok, { once: true });
      wv.addEventListener('did-fail-load', ok, { once: true });
    });
  }

  async function _waitSelector(wv, sel, ms = 15_000) {
    // Вместо polling каждые 400мс — MutationObserver внутри webview.
    // Резолвится сразу когда элемент появляется в DOM, без активного ожидания.
    // Fallback: если уже есть при вызове — возвращает true немедленно.
    try {
      const result = await wv.executeJavaScript(`
        (function(sel, timeout) {
          return new Promise(function(resolve) {
            // Проверяем сразу
            if (document.querySelector(sel)) { resolve(true); return; }
            var timer = setTimeout(function() { obs.disconnect(); resolve(false); }, timeout);
            var obs = new MutationObserver(function() {
              if (document.querySelector(sel)) {
                clearTimeout(timer);
                obs.disconnect();
                resolve(true);
              }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          });
        })(${JSON.stringify(sel)}, ${ms})
      `);
      return !!result;
    } catch (_) {
      // Fallback на polling если executeJavaScript недоступен (webview detached и т.д.)
      const dead = Date.now() + ms;
      while (Date.now() < dead) {
        try { if (await wv.executeJavaScript(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; } catch (_2) { }
        await sleep(400);
      }
      return false;
    }
  }

  const DS_INPUT_SEL = [
    '#chat-input',
    'textarea[class*="ds-scroll"]',
    'textarea[class*="chat"]',
    'textarea[placeholder]',
    'div[contenteditable="true"][class*="input"]',
    'div[contenteditable="true"]',
    'textarea',
  ].join(',');

  const DS_LOGIN_SEL = 'input[type="email"], input[type="password"], [class*="login-form"], [class*="sign-in-form"]';

  // ── v23: бросает AuthError вместо обычной Error ──
  async function navDeepSeek(wv) {
    try { await wv.executeJavaScript(`window.location.href=${JSON.stringify(CFG.DEEPSEEK_URL)}`); } catch (_) { }
    await _waitLoad(wv, 25_000);

    await _waitSelector(wv, `${DS_INPUT_SEL}, ${DS_LOGIN_SEL}`, 20_000);
    await sleep(CFG.DS_DELAY);

    if (CFG.DEBUG) {
      try {
        const dbgInfo = await wv.executeJavaScript(`JSON.stringify({
            url: location.href,
            title: document.title,
            textareas: Array.from(document.querySelectorAll('textarea')).map(e=>({id:e.id,cls:e.className.slice(0,60),ph:e.placeholder})),
            contenteditable: Array.from(document.querySelectorAll('[contenteditable="true"]')).map(e=>({tag:e.tagName,id:e.id,cls:e.className.slice(0,60)})),
            loginInputs: Array.from(document.querySelectorAll('input[type="email"],input[type="password"]')).length,
            buttons: Array.from(document.querySelectorAll('button')).filter(b=>!b.disabled&&b.offsetWidth>0).map(b=>({lbl:b.getAttribute('aria-label'),cls:b.className.slice(0,40),hasSvg:!!b.querySelector('svg')})).slice(0,10)
          })`);
        dbg('[navDeepSeek DOM]', dbgInfo);
      } catch (e) { dbg('[navDeepSeek DOM err]', e.message); }
    }

    let isLoggedIn = false;
    try {
      isLoggedIn = await wv.executeJavaScript(`
          (function(){
            var hasLogin = !!document.querySelector(${JSON.stringify(DS_LOGIN_SEL)});
            var hasChat  = !!document.querySelector(${JSON.stringify(DS_INPUT_SEL)});
            return !hasLogin && hasChat;
          })()
        `);
    } catch (_) { }

    if (!isLoggedIn) throw new AuthError('DeepSeek');

    // v30: кликаем «New Chat» чтобы гарантировать чистый диалог без истории
    // Это устраняет дублирование промпта — старые .ds-markdown не попадают в EXTRACT_DS
    try {
      const clicked = await wv.executeJavaScript(`(function(){
        var sels=[
          'a[href="/"][class*="new"i]','button[class*="new"i]',
          'a[href="/"]','[aria-label*="new chat"i]','[aria-label*="новый"i]',
          '[class*="new-chat"]','[class*="newChat"]'
        ];
        for(var s of sels){var el=document.querySelector(s);if(el){el.click();return true;}}
        return false;
      })()`);
      if (clicked) {
        dbg('navDeepSeek: new chat clicked');
        await sleep(800);
        await _waitSelector(wv, DS_INPUT_SEL, 8_000);
      } else {
        dbg('navDeepSeek: new chat button not found — proceeding with current page');
      }
    } catch (_) { }

    // Ждём пока закончится предыдущая генерация
    for (let i = 0; i < 20; i++) {
      try { if (!await wv.executeJavaScript(`!!(document.querySelector('[aria-label="Stop"]')||document.querySelector('[class*="stop-btn"]'))`)) break; } catch (_) { }
      await sleep(500);
    }
    // Ждём очистки поля от предыдущего ответа
    for (let i = 0; i < 15; i++) {
      try { if ((await wv.executeJavaScript(`(document.querySelector('.ds-markdown')?.textContent||'').trim().length`)) === 0) break; } catch (_) { }
      await sleep(500);
    }
    await _waitSelector(wv, 'button[aria-label*="Send"i], button[data-testid*="send"i], button:not([disabled])', 5_000);
  }

  // ── v22: showAuthDialog — диалог с webview DeepSeek для авторизации ────────

  let _authDialogActive = false;

  function showAuthDialog(provider = 'DeepSeek') {
    // Если диалог уже открыт — дождаться его закрытия
    if (_authDialogActive) {
      return new Promise((res, rej) => {
        const iv = setInterval(() => {
          if (!_authDialogActive) { clearInterval(iv); res(); }
        }, 600);
      });
    }
    _authDialogActive = true;

    return new Promise((resolve, reject) => {
      injectCSS();

      const wasPaused = RUN.paused;
      RUN.paused = true;
      panelLog?.('🔐 Требуется авторизация — ожидаю входа в ' + provider + '...');

      const overlay = document.createElement('div');
      overlay.id = 'ab20-auth-overlay';
      overlay.innerHTML = `
          <div class="ab20-auth-backdrop"></div>
          <div class="ab20-auth-modal">
            <div class="ab20-auth-hdr">
              <div class="ab20-auth-icon">🔐</div>
              <div class="ab20-auth-titles">
                <div class="ab20-auth-title">Требуется авторизация</div>
                <div class="ab20-auth-sub">${esc(provider)} · войдите в аккаунт в окне ниже</div>
              </div>
              <button class="ab20-auth-close" id="ab20-auth-cancel-x" title="Отменить разбор">✕</button>
            </div>

            <div class="ab20-auth-wv-wrap">
              <div class="ab20-auth-wv-loader" id="ab20-auth-loader">
                <div class="ab20-auth-spinner"></div>
                <div class="ab20-auth-loader-txt">Загрузка ${esc(provider)}…</div>
              </div>
              <webview
                id="ab20-auth-wv"
                src="${CFG.DEEPSEEK_URL}"
                style="width:100%;height:100%;border:none;"
              ></webview>
            </div>

            <div class="ab20-auth-hint">
              <span class="ab20-auth-hint-icon">ℹ</span>
              Войдите в аккаунт ${esc(provider)} выше, затем нажмите «Продолжить»
            </div>

            <div class="ab20-auth-ftr">
              <button class="ab20-auth-btn-cancel" id="ab20-auth-cancel">Отменить разбор</button>
              <button class="ab20-auth-btn-ok"     id="ab20-auth-ok">✓ Продолжить</button>
            </div>
          </div>`;

      document.body.appendChild(overlay);

      // Скрыть спиннер после загрузки страницы
      const wv = overlay.querySelector('#ab20-auth-wv');
      const loader = overlay.querySelector('#ab20-auth-loader');
      const hideLoader = () => { loader.style.display = 'none'; };
      wv.addEventListener('dom-ready', hideLoader, { once: true });
      wv.addEventListener('did-finish-load', hideLoader, { once: true });

      const close = (success) => {
        _authDialogActive = false;
        try { wv.stop?.(); wv.src = 'about:blank'; } catch (_) { }
        overlay.classList.add('ab20-auth-leaving');
        setTimeout(() => overlay.remove(), 260);
        if (!success) RUN.paused = wasPaused;
      };

      overlay.querySelector('#ab20-auth-ok').onclick = () => {
        close(true);
        panelLog?.('✓ Авторизация подтверждена — перезапуск воркеров DeepSeek...');
        resolve();
      };

      const cancelFn = () => {
        close(false);
        RUN.cancelled = true;
        panelLog?.('✗ Авторизация отменена — разбор остановлен');
        reject(new Error('Авторизация отменена пользователем'));
      };
      overlay.querySelector('#ab20-auth-cancel').onclick = cancelFn;
      overlay.querySelector('#ab20-auth-cancel-x').onclick = cancelFn;
    });
  }

  async function navGemini(wv) {
    const t0 = Date.now();
    dbg('navGemini: навигация...');
    try { await wv.executeJavaScript(`window.location.href=${JSON.stringify(CFG.GEMINI_URL)}`); } catch (_) { }
    await _waitLoad(wv, 30_000);
    dbg(`navGemini: load завершён (${Date.now() - t0}мс), ожидаем input...`);
    await sleep(CFG.GM_DELAY);

    const inputFound = await _waitSelector(wv, 'rich-textarea .ql-editor,[contenteditable="true"],textarea', 20_000);
    dbg(`navGemini: input ${inputFound ? 'найден' : 'НЕ НАЙДЕН'} (${Date.now() - t0}мс)`);
    // v33: если поле не найдено — reload и ещё раз ждём (сессия могла протухнуть)
    if (!inputFound) {
      panelLog?.('  ⚠ navGemini: поле ввода не найдено — перезагружаю страницу...');
      dbg('navGemini: поле не найдено, выполняем reload...');
      try { await wv.executeJavaScript(`window.location.href=${JSON.stringify(CFG.GEMINI_URL)}`); } catch (_) { }
      await _waitLoad(wv, 25_000);
      await sleep(CFG.GM_DELAY + 1000);
      const inputFound2 = await _waitSelector(wv, 'rich-textarea .ql-editor,[contenteditable="true"],textarea', 20_000);
      dbg(`navGemini: после reload input ${inputFound2 ? 'найден' : 'НЕ НАЙДЕН'}`);
      if (!inputFound2) panelLog?.('  ⚠ navGemini: поле ввода не найдено после reload — возможна проблема авторизации');
    }

    // v27: ждём кнопку отправки (как DS в v25) — ищем и по EN и по RU label
    const sendSel = 'button[aria-label*="Send"i], button[aria-label*="Отправ"i], button[aria-label*="сообщени"i]';
    const btnFound = await _waitSelector(wv, sendSel, 15_000);
    dbg(`navGemini: кнопка отправки ${btnFound ? 'найдена' : 'НЕ НАЙДЕНА'} (${Date.now() - t0}мс)`);
    if (!btnFound) panelLog?.('  ⚠ navGemini: кнопка отправки не найдена — возможна проблема загрузки Gemini');

    // Ждём пока закончится предыдущая генерация
    let stopWaits = 0;
    for (let i = 0; i < 20; i++) {
      try {
        const gen = await wv.executeJavaScript(`!!(document.querySelector('button[aria-label*="Stop"i]')||document.querySelector('.loading-indicator'))`);
        if (!gen) break;
        if (++stopWaits === 1) dbg('navGemini: ждём завершения предыдущей генерации...');
      } catch (_) { }
      await sleep(500);
    }
    if (stopWaits > 0) dbg(`navGemini: предыдущая генерация завершилась (${stopWaits * 500}мс)`);

    // Диагностический снимок DOM
    try {
      const info = await wv.executeJavaScript(`JSON.stringify({
          url: location.href.slice(0,80),
          inputSel: (function(){
            var sels=['rich-textarea .ql-editor','[contenteditable="true"]','textarea'];
            for(var s of sels){ var el=document.querySelector(s); if(el) return s+'[found, len='+((el.textContent||el.value||'').length)+']'; }
            return 'none';
          })(),
          sendBtn: (function(){
            var sels=['button[aria-label*="Send"i]','button[aria-label*="Отправ"i]','button[aria-label*="сообщени"i]'];
            for(var s of sels){ var b=document.querySelector(s); if(b) return s+'[lbl='+b.getAttribute('aria-label')+']'; }
            return 'none';
          })(),
          allBtns: Array.from(document.querySelectorAll('button')).filter(b=>!b.disabled&&b.offsetWidth>0).slice(0,6).map(b=>(b.getAttribute('aria-label')||'').slice(0,50)).filter(Boolean)
        })`);
      dbg('navGemini DOM:', info);
      panelLog?.(`  🔍 GM DOM: ${info}`);
    } catch (e) { dbg('navGemini DOM probe err:', e.message); }

    dbg(`navGemini: завершён за ${Date.now() - t0}мс`);
  }

  const SEND_DS = `(async function(text){
      var selectors=${JSON.stringify(DS_INPUT_SEL.split(',').map(s => s.trim()))};
      var inp=null;
      for(var attempt=0;attempt<20;attempt++){
        for(var s of selectors){inp=document.querySelector(s);if(inp)break;}
        if(inp)break;
        console.log('[DS_SEND] input not found, attempt '+attempt+', url='+location.href+', waiting...');
        await new Promise(r=>setTimeout(r,500));
      }
      if(!inp){
        console.log('[DS_SEND] NO_INPUT: all selectors failed. url='+location.href+' body='+document.body.innerHTML.slice(0,500));
        return'NO_INPUT';
      }
      console.log('[DS_SEND] found input: tag='+inp.tagName+' ce='+inp.getAttribute('contenteditable')+' class='+inp.className.slice(0,60));
      inp.focus();
      await new Promise(r=>setTimeout(r,400));

      var isContentEditable=(inp.getAttribute('contenteditable')==='true');
      if(isContentEditable){
        try{document.execCommand('selectAll',false,null);document.execCommand('delete',false,null);}catch(_){}
        await new Promise(r=>setTimeout(r,200));
        try{document.execCommand('insertText',false,text);}catch(_){inp.textContent=text;}
        inp.dispatchEvent(new InputEvent('input',{bubbles:true,data:text}));
        await new Promise(r=>setTimeout(r,700));
        if(!(inp.textContent||'').trim()){console.log('[DS_SEND] TEXT_FAIL: contenteditable empty after set');return'TEXT_FAIL';}
      } else {
        var ns=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
        if(ns&&ns.set)ns.set.call(inp,text);else inp.value=text;
        inp.dispatchEvent(new Event('focus',{bubbles:true}));
        inp.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
        inp.dispatchEvent(new Event('change',{bubbles:true}));
        await new Promise(r=>setTimeout(r,700));
        if(!(inp.value||'').trim()){console.log('[DS_SEND] TEXT_FAIL: value empty after set');return'TEXT_FAIL';}
      }

      // ── v23: расширенный поиск кнопки отправки ──
      function _findSendBtn(inputEl) {
        // 1. По aria-label / data-testid
        var b = document.querySelector('button[aria-label*="Send"i]')
            || document.querySelector('button[aria-label*="Отправ"i]')
            || document.querySelector('button[data-testid*="send"i]');
        if (b && !b.disabled) return b;
        // 2. По SVG-пути (DeepSeek использует разные иконки)
        var svgPaths = ['M8.3125','M.5 ','M2 12','M22 2','M3.478 2.405'];
        for (var dp of svgPaths) {
          var p = document.querySelector('path[d*="'+dp+'"]');
          if (p) { var pb = p.closest('button'); if (pb && !pb.disabled) return pb; }
        }
        // 3. Кнопка в правом нижнем углу поля ввода (поднимаемся до 6 уровней)
        var w = inputEl;
        for (var i = 0; i < 6; i++) {
          w = w.parentElement; if (!w) break;
          var btns = Array.from(w.querySelectorAll('button')).filter(function(b){
            return !b.disabled && b.offsetWidth > 0 && b.offsetHeight > 0;
          });
          if (btns.length) {
            // предпочитаем кнопку с SVG внутри
            var withSvg = btns.filter(function(b){ return !!b.querySelector('svg'); });
            return (withSvg.length ? withSvg : btns)[btns.length - 1];
          }
        }
        // 4. Кнопка с SVG в нижней половине viewport
        var fallback = Array.from(document.querySelectorAll('button')).filter(function(b){
          if (b.disabled || !b.offsetWidth) return false;
          var r = b.getBoundingClientRect();
          return r.bottom > window.innerHeight * 0.4 && !!b.querySelector('svg');
        });
        if (fallback.length) return fallback[fallback.length - 1];
        // 5. Последняя активная кнопка на странице
        var all = Array.from(document.querySelectorAll('button')).filter(function(b){
          return !b.disabled && b.offsetWidth > 0 && b.offsetHeight > 0;
        });
        return all.length ? all[all.length - 1] : null;
      }

      // Пробуем отправить — до 3 попыток (кнопка может появиться с задержкой)
      for (var sendAttempt = 0; sendAttempt < 3; sendAttempt++) {
        if (sendAttempt > 0) await new Promise(r=>setTimeout(r,1500));
        var btn = _findSendBtn(inp);
        console.log('[DS_SEND] sendAttempt='+sendAttempt+' btn='+( btn ? btn.outerHTML.slice(0,120) : 'null'));
        if (btn) {
          btn.click();
          for (var i = 0; i < 15; i++) {
            await new Promise(r=>setTimeout(r,200));
            var cur = isContentEditable ? (inp.textContent||'').trim() : (inp.value||'').trim();
            if (!cur) return 'SENT';
          }
          // Поле не очистилось — возможно кнопка была не той, пробуем Enter
        }
        // Fallback 1: обычный Enter (v28: добавлен composed:true для Shadow DOM)
        ['keydown','keypress','keyup'].forEach(function(t){
          inp.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true,composed:true}));
        });
        await new Promise(r=>setTimeout(r,600));
        var afterEnter = isContentEditable ? (inp.textContent||'').trim() : (inp.value||'').trim();
        if (!afterEnter) return 'SENT_ENTER';
        // Fallback 2: Ctrl+Enter (v28: добавлен composed:true)
        inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,ctrlKey:true,bubbles:true,cancelable:true,composed:true}));
        await new Promise(r=>setTimeout(r,600));
        var afterCtrl = isContentEditable ? (inp.textContent||'').trim() : (inp.value||'').trim();
        if (!afterCtrl) return 'SENT_CTRL_ENTER';
      }
      return 'FAIL_ENTER';
    })(__TEXT__)`;

  const SEND_GM = `(async function(text){
      // ── v27: расширенные логи + поиск кнопки по русскому aria-label ──
      console.log('[GM_SEND] start, url='+location.href);

      // Ищем поле ввода
      var inp = document.querySelector('rich-textarea .ql-editor')
            || document.querySelector('.input-area-container [contenteditable="true"]')
            || document.querySelector('[contenteditable="true"]');
      if(!inp){
        console.log('[GM_SEND] NO_INPUT: selectors failed. ce_count='+document.querySelectorAll('[contenteditable]').length);
        return 'NO_INPUT';
      }
      console.log('[GM_SEND] input найден: tag='+inp.tagName+' ce='+inp.getAttribute('contenteditable')+' cls='+inp.className.slice(0,60));

      inp.focus();
      await new Promise(r=>setTimeout(r,400));

      // Очищаем поле
      try{document.execCommand('selectAll',false,null);document.execCommand('delete',false,null);}catch(_){}
      await new Promise(r=>setTimeout(r,200));

      // Вставляем текст
      try{
        document.execCommand('insertText',false,text);
        console.log('[GM_SEND] insertText успех, len='+inp.textContent.length);
      }catch(e){
        inp.textContent=text;
        console.log('[GM_SEND] insertText провал, fallback textContent, len='+inp.textContent.length);
      }
      inp.dispatchEvent(new InputEvent('input',{bubbles:true,data:text}));
      await new Promise(r=>setTimeout(r,800));

      var afterInsert=(inp.textContent||inp.value||'').trim();
      console.log('[GM_SEND] после вставки: len='+afterInsert.length+' preview='+afterInsert.slice(0,40));
      if(!afterInsert){
        console.log('[GM_SEND] TEXT_FAIL: поле пустое после вставки');
        return 'TEXT_FAIL';
      }

      // ── v27: расширенный поиск кнопки (EN + RU + fallback) ──
      function _findGmSendBtn(){
        // 1. По aria-label (EN + RU)
        var candidates=[
          'button[aria-label*="Send message"i]',
          'button[aria-label*="Send"i]',
          'button[aria-label*="Отправить сообщение"i]',
          'button[aria-label*="Отправить"i]',
          'button[aria-label*="Отправ"i]',
          'button[aria-label*="сообщени"i]',
          'button[data-test-id="send-button"]',
          'button[jsname][aria-label]',
        ];
        for(var sel of candidates){
          var b=document.querySelector(sel);
          if(b&&!b.disabled&&b.offsetWidth>0){
            console.log('[GM_SEND] кнопка найдена по: '+sel+' lbl="'+b.getAttribute('aria-label')+'"');
            return b;
          }
        }
        // 2. По тексту (любая кнопка содержащая "send"/"отправ")
        var byText=Array.from(document.querySelectorAll('button')).find(function(b){
          if(b.disabled||!b.offsetWidth) return false;
          var lbl=(b.getAttribute('aria-label')||b.textContent||'').toLowerCase();
          return lbl.includes('send')||lbl.includes('отправ');
        });
        if(byText){
          console.log('[GM_SEND] кнопка по тексту: lbl="'+byText.getAttribute('aria-label')+'" txt="'+byText.textContent.slice(0,30)+'"');
          return byText;
        }
        // 3. Fallback: последняя активная кнопка в нижней части страницы
        var fallback=Array.from(document.querySelectorAll('button')).filter(function(b){
          if(b.disabled||!b.offsetWidth) return false;
          var r=b.getBoundingClientRect();
          return r.bottom>window.innerHeight*0.5&&r.right>window.innerWidth*0.5;
        });
        if(fallback.length){
          var fb=fallback[fallback.length-1];
          console.log('[GM_SEND] кнопка fallback: lbl="'+fb.getAttribute('aria-label')+'" bottom='+Math.round(fb.getBoundingClientRect().bottom));
          return fb;
        }
        // Лог всех доступных кнопок для диагностики
        var allBtns=Array.from(document.querySelectorAll('button')).filter(function(b){return!b.disabled&&b.offsetWidth>0;});
        console.log('[GM_SEND] кнопка НЕ НАЙДЕНА. Доступные кнопки ('+allBtns.length+'):');
        allBtns.slice(0,8).forEach(function(b,i){
          console.log('  #'+i+' lbl="'+(b.getAttribute('aria-label')||'').slice(0,50)+'" txt="'+b.textContent.slice(0,30)+'"');
        });
        return null;
      }

      var btn=_findGmSendBtn();
      if(btn){
        btn.click();
        await new Promise(r=>setTimeout(r,700));
        var afterClick=(inp.textContent||inp.value||'').trim();
        console.log('[GM_SEND] после клика кнопки: field_len='+afterClick.length);
        if(!afterClick) return 'SENT';
        console.log('[GM_SEND] поле не очистилось после клика, пробуем Enter...');
      } else {
        console.log('[GM_SEND] кнопка не найдена, используем Enter');
      }

      // Fallback: Enter (с полным набором флагов для Gemini)
      ['keydown','keypress','keyup'].forEach(function(t){
        inp.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true,composed:true}));
      });
      await new Promise(r=>setTimeout(r,600));
      var afterEnter=(inp.textContent||inp.value||'').trim();
      console.log('[GM_SEND] после Enter: field_len='+afterEnter.length);
      if(!afterEnter) return 'SENT_ENTER';

      // Fallback 2: Ctrl+Enter
      inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,ctrlKey:true,bubbles:true,cancelable:true,composed:true}));
      await new Promise(r=>setTimeout(r,600));
      var afterCtrl=(inp.textContent||inp.value||'').trim();
      console.log('[GM_SEND] после Ctrl+Enter: field_len='+afterCtrl.length);
      if(!afterCtrl) return 'SENT_CTRL_ENTER';

      console.log('[GM_SEND] все способы отправки провалились → FAIL_ENTER');
      return 'FAIL_ENTER';
    })(__TEXT__)`;

  async function _sendToWorker(entry, text, onLog) {
    const tag = `${entry.provider.toUpperCase()}#${entry.id}`;
    const tmpl = entry.provider === 'ds' ? SEND_DS : SEND_GM;
    const code = tmpl.replace('__TEXT__', JSON.stringify(text));

    // v24: убедиться что webview прикреплён к DOM и готов
    if (!document.body.contains(entry.wrap)) {
      const c = getHiddenContainer();
      c.appendChild(entry.wrap);
      await waitReady(entry, 10_000);
      entry.ready = true;
      dbg(`_sendToWorker: ${tag} re-attached to DOM`);
    }

    // v33: для DS дополнительно ждём кнопку отправки (увеличено 10s→20s — устраняет FAIL_ENTER)
    if (entry.provider === 'ds') {
      const btnReady = await _waitSelector(entry.wv, 'button[aria-label*="Send"i], button[data-testid*="send"i]', 20_000);
      if (!btnReady) {
        onLog?.(`  ⚠ [${tag}] кнопка DS не появилась за 20с — продолжаем...`);
        dbg(`_sendToWorker: ${tag} DS send button not found after 20s`);
      } else {
        dbg(`_sendToWorker: ${tag} DS send button ready`);
      }
    }
    // v27: для GM ждём кнопку отправки (EN + RU)
    if (entry.provider === 'gm') {
      const gmSendSel = 'button[aria-label*="Send"i], button[aria-label*="Отправ"i], button[aria-label*="сообщени"i]';
      const btnReady = await _waitSelector(entry.wv, gmSendSel, 12_000);
      if (!btnReady) {
        onLog?.(`  ⚠ [${tag}] кнопка GM не появилась за 12с — продолжаем...`);
        dbg(`_sendToWorker: ${tag} GM send button not found after 12s`);
      } else {
        dbg(`_sendToWorker: ${tag} GM send button ready`);
      }
    }

    // v28: при FAIL_ENTER делаем click+focus на поле ввода и ждём 2.5с
    //      (было: просто sleep 1.5с — недостаточно для React-рендера кнопки)
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res;
      try {
        res = await entry.wv.executeJavaScript(code);
      } catch (e) {
        onLog?.(`  send[${tag}] err: ${e.message}`);
        dbg(`_sendToWorker: ${tag} executeJavaScript error: ${e.message}`);
        // v34: если WebView отсоединён от DOM — помечаем dead и пересоздаём
        if (e.message && e.message.includes('WebView must be attached')) {
          dbg(`_sendToWorker: ${tag} WebView detached → помечаем dead`);
          entry.dead = true; entry.busy = false;
          panelLog?.(`  ⚠ ${tag} WebView detached → пересоздаём...`);
          try {
            const fresh = await WM.replaceWorker(entry);
            fresh.ready = true;
          } catch (_) {}
        }
        throw e;
      }
      onLog?.(`  send[${tag}] → ${res} (попытка ${attempt})`);
      dbg(`_sendToWorker: ${tag} result=${res} attempt=${attempt}`);
      if (['NO_INPUT', 'TEXT_FAIL'].includes(res)) {
        dbg(`_sendToWorker: ${tag} критическая ошибка ${res}`);
        throw new Error(`send: ${res}`);
      }
      if (res === 'FAIL_ENTER' && attempt < 3) {
        onLog?.(`  ⚠ send[${tag}] FAIL_ENTER — фокус + повтор через 2.5с...`);
        dbg(`_sendToWorker: ${tag} FAIL_ENTER, сбрасываем фокус и ждём 2.5с...`);
        // Принудительно кликаем в поле ввода — сбрасывает «замороженное» состояние UI
        try {
          const inputSel = entry.provider === 'ds'
            ? JSON.stringify(DS_INPUT_SEL)
            : '"[contenteditable=\\"true\\"]"';
          await entry.wv.executeJavaScript(
            `(function(){var el=document.querySelector(${inputSel});if(el){el.click();el.focus();}})();`
          );
        } catch (_) { }
        await sleep(2500);
        continue;
      }
      if (res === 'FAIL_ENTER') {
        dbg(`_sendToWorker: ${tag} FAIL_ENTER после ${attempt} попыток → помечаем dead`);
        // v34: вместо throw — помечаем dead чтобы acquireWorker его пересоздал,
        // а текущая задача уйдёт к другому воркеру через retry в askAny
        entry.dead = true; entry.busy = false;
        try {
          WM.replaceWorker(entry).then(fresh => { fresh.ready = true; }).catch(() => {});
        } catch (_) {}
        throw new Error(`send: ${res}`);
      }
      dbg(`_sendToWorker: ${tag} отправлено успешно (${res})`);
      return; // SENT / SENT_ENTER / SENT_CTRL_ENTER / SENT_SLOW
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ИЗВЛЕЧЕНИЕ ОТВЕТА
  // ════════════════════════════════════════════════════════════════════════════

  const _extractFn = `function extractText(el){
      var c=el.cloneNode(true);
      c.querySelectorAll('button,svg,details,[class*="action"],[class*="btn"],[class*="copy"],[class*="toolbar"]').forEach(x=>{try{x.parentNode.removeChild(x);}catch(_){}});
      c.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,br').forEach(x=>{try{x.insertBefore(document.createTextNode('\\n'),x.firstChild);}catch(_){}});
      return(c.textContent||'').trim();
    }`;

  const EXTRACT_DS = `(function(){${_extractFn}
      // v30: берём ПОСЛЕДНИЙ блок ответа (не все подряд), чтобы не захватывать
      // предыдущие сообщения из истории чата и не дублировать промпт в ответе
      var sels=[
        '.ds-markdown',
        '[class*="markdown-body"]',
        '[class*="message-content"]',
        '[data-role="assistant"]',
        '[data-testid*="assistant"]',
        '[data-testid*="message"]',
        '[class*="chat-message"]',
        '[class*="ChatMessage"]',
        '[class*="reply"]',
        '[class*="response"]',
        '[class*="prose"]',
        '[class*="output"]',
        '[class*="assistant"]',
        'article'
      ];
      var best='';
      for(var s of sels){
        var els=Array.from(document.querySelectorAll(s));
        if(!els.length)continue;
        // v30: берём только ПОСЛЕДНИЙ элемент (последний ответ AI), не все
        var t=extractText(els[els.length-1]);
        if(t.length>best.length)best=t;
        if(best.length>40)break;
      }
      // v29: универсальный fallback
      if(best.length<40){
        var allDivs=Array.from(document.querySelectorAll('div,section,main')).filter(function(el){
          var t=(el.textContent||'').trim();
          return t.length>100 && !el.querySelector('input,textarea,button');
        });
        if(allDivs.length){
          var biggest=allDivs.reduce(function(a,b){
            return(b.textContent||'').length>(a.textContent||'').length?b:a;
          },allDivs[0]);
          var fb=extractText(biggest);
          if(fb.length>best.length)best=fb;
        }
      }
      best=best
        .replace(/<think[\\s\\S]*?<\\/think>/gi,'')
        .replace(/^(Copy|Copy code|Like|Dislike|Share|Regenerate|Run|Retry|Edit)$/gm,'')
        .replace(/\\n{3,}/g,'\\n\\n').trim();
      var gen=[
        '[aria-label="Stop"]',
        'button[aria-label*="Stop"i]',
        '[class*="stop-btn"]',
        '[class*="generating"]',
        '[class*="loading"]',
        '[class*="spinner"]',
        '[class*="typing"]'
      ].some(function(s){return!!document.querySelector(s);});
      return JSON.stringify({text:best,gen});
    })()`;

  const EXTRACT_GM = `(function(){${_extractFn}
      var sels=['model-response .markdown','model-response','[class*="model-response"]','message-content','[data-message-author-role="model"]','.response-content','p-paragraph'];
      var best='';
      for(var s of sels){var els=Array.from(document.querySelectorAll(s));if(!els.length)continue;var t=extractText(els[els.length-1]);if(t.length>best.length)best=t;if(best.length>40)break;}
      best=best.replace(/^(Copy|Edit|Share|Thumb up|Thumb down)$/gm,'').replace(/\\n{3,}/g,'\\n\\n').trim();
      var gen=!!(document.querySelector('button[aria-label*="Stop"i]')||document.querySelector('.loading-indicator')||document.querySelector('[class*="pending"]'));
      return JSON.stringify({text:best,gen});
    })()`;

  // ════════════════════════════════════════════════════════════════════════════
  // readReply — POLLING
  // ════════════════════════════════════════════════════════════════════════════

  async function readReply(entry, onLog, cancel) {
    const extract = entry.provider === 'ds' ? EXTRACT_DS : EXTRACT_GM;
    const tag = `${entry.provider.toUpperCase()}#${entry.id}`;
    const t0 = Date.now();
    let best = '', lastLen = 0, stable = 0, phase = 'wait';
    let lastGrowth = null, startWait = Date.now();
    onLog?.(`  ⏳ [${tag}] жду ответа...`);
    dbg(`readReply: ${tag} начало polling`);

    return new Promise(resolve => {
      let done = false, tick = false;
      const finish = (reason, stalled = false) => {
        if (done) return; done = true; clearInterval(iv);
        const elapsed = Math.round((Date.now() - t0) / 1000);
        const msg = `  ${stalled ? '⚠ зависание' : '✓'} [${tag}] ${reason} · ${best.length} симв.`;
        onLog?.(msg);
        dbg(`readReply: ${tag} finish: ${reason} stalled=${stalled} len=${best.length} elapsed=${elapsed}s`);
        resolve({ text: best.trim(), stalled });
      };
      const iv = setInterval(async () => {
        if (done || tick) return; tick = true;
        try { await _tick(); } finally { tick = false; }
      }, CFG.POLL_MS);

      async function _tick() {
        while (RUN.paused && !RUN.cancelled && !cancel?.v) await sleep(300);
        if (done) return;
        if (RUN.cancelled || cancel?.v) { finish('отменён'); return; }
        if (Date.now() - t0 > CFG.ANSWER_TIMEOUT) {
          dbg(`readReply: ${tag} ANSWER_TIMEOUT (${CFG.ANSWER_TIMEOUT}мс)`);
          finish('таймаут'); return;
        }
        const stallElapsed = Math.round((Date.now() - startWait) / 1000);
        if (phase === 'wait' && Date.now() - startWait > CFG.STALL_TIMEOUT) {
          dbg(`readReply: ${tag} STALL on start (${stallElapsed}s)`);
          finish('завис на старте', true); return;
        }
        if (phase === 'read' && lastGrowth !== null && Date.now() - lastGrowth > CFG.STALL_TIMEOUT) {
          dbg(`readReply: ${tag} STALL mid-response`);
          finish('завис в середине', true); return;
        }

        // v25: не вызывать executeJavaScript на отсоединённом webview
        if (!document.body.contains(entry.wrap)) {
          dbg(`readReply: ${tag} webview detached`);
          finish('отменён (detached)'); return;
        }

        let raw;
        try { raw = JSON.parse(await entry.wv.executeJavaScript(extract) || '{}'); }
        catch (e) { onLog?.(`  ⚠ extract: ${e.message}`); dbg(`readReply: ${tag} extract err: ${e.message}`); return; }

        const txt = (raw.text || '').trim();
        if (txt.length > best.length) best = txt;
        const cur = txt.length;

        if (phase === 'wait') {
          if (cur >= 20) {
            phase = 'read'; lastLen = cur; lastGrowth = Date.now();
            onLog?.(`  🔄 [${tag}] текст (${cur} симв.)`);
            dbg(`readReply: ${tag} первый текст ${cur} симв.`);
          } else {
            onLog?.(`  ⏳ [${tag}] пусто (${stallElapsed}с)`);
            return;
          }
        }

        const growth = cur - lastLen; lastLen = cur;
        if (growth > 0) lastGrowth = Date.now();
        onLog?.(`  📊 [${tag}] len=${cur} Δ=${growth} stb=${stable} gen=${raw.gen}`);

        if (cur < CFG.MIN_TEXT_LEN) { stable = 0; return; }
        if (growth < CFG.MIN_GROWTH) stable++; else stable = 0;

        if (stable >= CFG.STABLE_ROUNDS) {
          await sleep(1500);
          if (!done && document.body.contains(entry.wrap)) {
            try { const r2 = JSON.parse(await entry.wv.executeJavaScript(extract) || '{}'); if ((r2.text || '').length > best.length) best = r2.text.trim(); } catch (_) { }
          }
          finish(`стабилен ${stable}×`); return;
        }
        if (!raw.gen && stable >= 2 && cur >= CFG.MIN_TEXT_LEN) {
          await sleep(1200);
          if (!done && document.body.contains(entry.wrap)) {
            try { const r3 = JSON.parse(await entry.wv.executeJavaScript(extract) || '{}'); if ((r3.text || '').length > best.length) best = r3.text.trim(); } catch (_) { }
          }
          if (best.length >= CFG.MIN_TEXT_LEN) finish('gen=false+stable≥2');
        }
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // GEMINI API — дополнительный движок (прямые HTTP-запросы)
  // Активируется если window.GeminiAPI.isEnabled() === true
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * askViaGeminiAPI — отправить промпт через REST API вместо webview.
   * Возвращает текст ответа или выбрасывает ошибку.
   * Учитывает ограничения бесплатного тарифа через window.GeminiAPI.
   */
  async function askViaGeminiAPI(prompt, onLog, cancel) {
    const gapi = window.GeminiAPI;
    if (!gapi?.isEnabled()) throw new Error('GeminiAPI не активен');

    const cancelled = () => RUN.cancelled || !!cancel?.v;

    if (cancelled()) throw new Error('Отменено');

    // Пауза — ждём пока не снята
    while (RUN.paused && !cancelled()) await sleep(300);
    if (cancelled()) throw new Error('Отменено');

    const stats = gapi.getStats();
    if (stats.rpdRemaining <= 0) {
      throw new Error(`Gemini API: исчерпан дневной лимит (${gapi.FREE_TIER.RPD}/день). Попробуйте завтра или используйте webview-режим.`);
    }

    // Семафор — ждём свободный слот (не более 2 параллельных запросов на ключ)
    await _apiSem.acquire(cancelled);
    if (cancelled()) { _apiSem.release(); throw new Error('Отменено'); }

    onLog?.(`  🌐 [GAPI] запрос (осталось RPD: ${gapi.getRPDRemaining()})…`);
    dbg(`askViaGeminiAPI: промпт ${prompt.length} симв., RPD: ${gapi.getRPDUsed()}/${gapi.FREE_TIER.RPD}`);

    try {
      const text = await gapi.ask(prompt, {}, cancel);
      if (cancelled()) throw new Error('Отменено');
      onLog?.(`  ✓ [GAPI] ответ ${text.length} симв. (RPD: ${gapi.getRPDUsed()}/${gapi.FREE_TIER.RPD})`);
      dbg(`askViaGeminiAPI: успех, len=${text.length}`);
      return text;
    } catch (err) {
      onLog?.(`  ⚠ [GAPI] ${err.message}`);
      throw err;
    } finally {
      _apiSem.release();
    }
  }

  /**
   * Режим работы авторазбора:
   *   'api'    — только Gemini API (нет webview, быстро, лимиты бесплатного тарифа)
   *   'hybrid' — сначала Gemini API, при ошибке/исчерпании — fallback на webview
   *   'webview'— только webview DS+GM (старый режим, без API ключа)
   *
   * Читается из Settings или напрямую через window.GeminiAPI.isEnabled()
   */
  function _getEngineMode() {
    const gapi = window.GeminiAPI;
    if (!gapi?.isEnabled()) return 'webview';
    const mode = window.Settings?.get?.('gemini_api_mode') || 'hybrid';
    return mode; // 'api' | 'hybrid' | 'webview'
  }

  // ════════════════════════════════════════════════════════════════════════════
  // askAny — v36: + Gemini API движок (дополнение к webview)
  // ════════════════════════════════════════════════════════════════════════════

  let panelLog = null;

  async function askAny(prompt, onLog, cancel) {
    const promptPreview = prompt.slice(0, 60).replace(/\n/g, ' ');
    const mode = _getEngineMode();
    dbg(`askAny: старт «${promptPreview}…» [режим: ${mode}]`);

    // ── Режим API: только Gemini REST API ──
    if (mode === 'api') {
      return await askViaGeminiAPI(prompt, onLog, cancel);
    }

    // ── Гибридный режим: сначала Gemini API, fallback на webview ──
    if (mode === 'hybrid') {
      const gapi = window.GeminiAPI;
      if (gapi?.isEnabled() && gapi.getRPDRemaining() > Math.ceil(gapi.FREE_TIER.RPD * 0.05)) {
        try {
          return await askViaGeminiAPI(prompt, onLog, cancel);
        } catch (apiErr) {
          if (cancel?.v || RUN.cancelled) throw apiErr;
          // 429 — API сам делает retry с backoff внутри GeminiAPI.ask()
          // Сюда попадаем только если все MAX_RETRIES исчерпаны
          if (apiErr.message.includes('дневной лимит')) {
            // Реально исчерпан дневной лимит — переходим на webview
            onLog?.(`  ⚡ [GAPI] дневной лимит исчерпан → webview резерв`);
            dbg(`askAny hybrid: RPD исчерпан, fallback → webview`);
          } else if (apiErr.message.includes('403') || apiErr.message.includes('неверный API')) {
            onLog?.(`  ⚡ [GAPI] неверный ключ → webview резерв`);
            gapi.setApiKey('');
          } else if (apiErr.message.includes('429')) {
            // Все retry исчерпаны — пробуем webview
            onLog?.(`  ⚡ [GAPI] rate limit после всех retry → webview резерв`);
          } else {
            onLog?.(`  ⚡ [GAPI] ошибка → webview резерв: ${apiErr.message.slice(0,60)}`);
          }
        }
      }
    }

    // ── Webview режим (старый путь DS+GM) ──
    let recoveryCount = 0;
    let authRetryCount = 0;
    for (let attempt = 1; attempt <= CFG.MAX_RETRIES; attempt++) {
      if (cancel?.v || RUN.cancelled) throw new Error('Отменено');
      let entry = null;
      try {
        dbg(`askAny: попытка ${attempt}/${CFG.MAX_RETRIES} — захватываем воркер...`);
        entry = await acquireWorker();
        const tag = `${entry.provider.toUpperCase()}#${entry.id}`;
        onLog?.(`  [${tag}] попытка ${attempt}/${CFG.MAX_RETRIES}...`);
        dbg(`askAny: воркер ${tag} захвачен`);

        // ── v22: навигация с перехватом AuthError ──
        dbg(`askAny: ${tag} навигация...`);
        try {
          if (entry.provider === 'ds') await navDeepSeek(entry.wv);
          else await navGemini(entry.wv);
        } catch (navErr) {
          if (navErr instanceof AuthError) {
            authRetryCount++;
            if (authRetryCount > CFG.MAX_RECOVERY) {
              dbg(`askAny: ${tag} AuthError повторился ${authRetryCount} раз подряд — прекращаем`);
              throw new Error(`Не удалось авторизоваться в ${navErr.provider} после ${authRetryCount} попыток`);
            }
            dbg(`askAny: ${tag} AuthError → диалог авторизации`);
            releaseWorker(entry); entry = null;

            // Показать диалог авторизации (выбрасывает если пользователь отменил)
            await showAuthDialog(navErr.provider);

            // Пересоздать все незанятые DS-воркеры
            panelLog?.('🔁 Пересоздание DS-воркеров после авторизации...');
            for (let i = 0; i < WM.dsPool.length; i++) {
              const old = WM.dsPool[i];
              if (!old.busy) {
                try {
                  const fresh = await WM.replaceWorker(old);
                  fresh.ready = true;
                } catch (re) { dbg('replaceWorker error:', re.message); }
              }
            }
            RUN.paused = false; // снять паузу, выставленную showAuthDialog
            panelLog?.('✓ Воркеры обновлены — продолжаю разбор...');

            // Не считать эту итерацию за попытку
            attempt--;
            await sleep(600);
            continue;
          }
          dbg(`askAny: ${tag} navErr: ${navErr.message}`);
          throw navErr;
        }

        if (cancel?.v || RUN.cancelled) throw new Error('Отменено');

        dbg(`askAny: ${tag} отправляем промпт (${prompt.length} симв.)...`);
        await _sendToWorker(entry, prompt, onLog);
        await sleep(800);
        dbg(`askAny: ${tag} ждём ответ...`);
        let { text, stalled } = await readReply(entry, onLog, cancel);
        dbg(`askAny: ${tag} ответ: len=${text.length} stalled=${stalled}`);

        if (!stalled && text && text.length >= 20) {
          releaseWorker(entry);
          // Обрезаем эхо промпта: если ответ содержит наши заголовки, берём с первого ## Суть
          text = _stripPromptEcho(text);
          dbg(`askAny: ${tag} успех, len=${text.length}`);
          return text;
        }

        recoveryCount++;
        RUN.recovered++;
        _updateRecoveryCounter();
        const tag2 = `${entry.provider.toUpperCase()}#${entry.id}`;
        const reason = stalled ? '🔴 завис' : '🟡 пустой ответ';
        onLog?.(`  ${reason} [${tag2}]`);
        dbg(`askAny: ${tag2} ${reason} (recoveryCount=${recoveryCount})`);

        if (recoveryCount >= CFG.MAX_RECOVERY) {
          releaseWorker(entry);
          dbg(`askAny: ${tag2} превышено MAX_RECOVERY (${CFG.MAX_RECOVERY})`);
          throw new Error('Превышено макс. восстановлений');
        }

        if (!stalled && recoveryCount === 1) { releaseWorker(entry); entry = null; await sleep(2500); continue; }

        entry.busy = false;
        const old = entry; entry = null;
        panelLog?.(`🔁 ${old.provider.toUpperCase()}#${old.id} пересоздаётся...`);
        dbg(`askAny: пересоздание ${old.provider.toUpperCase()}#${old.id}...`);
        const newE = await WM.replaceWorker(old);
        WM.setBusy(newE, true);
        try {
          dbg(`askAny: повтор на новом воркере ${newE.provider.toUpperCase()}#${newE.id}`);
          if (newE.provider === 'ds') await navDeepSeek(newE.wv); else await navGemini(newE.wv);
          if (cancel?.v || RUN.cancelled) { releaseWorker(newE); throw new Error('Отменено'); }
          await _sendToWorker(newE, prompt, onLog);
          await sleep(800);
          const { text: t2, stalled: s2 } = await readReply(newE, onLog, cancel);
          releaseWorker(newE);
          if (!s2 && t2 && t2.length >= 20) {
            dbg(`askAny: успех на новом воркере, len=${t2.length}`);
            return t2;
          }
          throw new Error('Повторное зависание');
        } catch (ie) {
          dbg(`askAny: ошибка на новом воркере: ${ie.message}`);
          releaseWorker(newE); throw ie;
        }

      } catch (err) {
        onLog?.(`  ⚠ попытка ${attempt}: ${err.message}`);
        dbg(`askAny: ошибка попытка ${attempt}: ${err.message}`);
        if (entry && !entry.dead) releaseWorker(entry);
        entry = null;
        if (cancel?.v || RUN.cancelled) throw err;
        if (attempt < CFG.MAX_RETRIES) {
          const delay = 3000 * attempt;
          dbg(`askAny: ждём ${delay}мс перед попыткой ${attempt + 1}`);
          await sleep(delay);
          continue;
        }
        throw err;
      } finally {
        if (entry && !entry.dead) releaseWorker(entry);
      }
    }
    throw new Error('askAny: все попытки исчерпаны');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ПАРСИНГ ПОДВОПРОСОВ
  // ════════════════════════════════════════════════════════════════════════════

  function parseQs(raw) {
    if (!raw) return null;
    let s = raw.trim()
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/Thinking for[^\n]*\n+/gi, '')
      .replace(/Thought for[^\n]*\n+/gi, '')
      .trim();

    const jsonCandidates = [
      s.match(/\{\s*"questions"\s*:\s*\[[\s\S]*?\]\s*\}/)?.[0],
      ...[...s.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(m => m[1]),
      s.match(/`(\{[\s\S]*?\})`/)?.[1],
      s.startsWith('{') ? s : null,
    ].filter(Boolean);
    // Заглушки из промпта («Подвопрос N» и т.п.) — фильтруем эхо-промпт.
    const _isPlaceholder = s => /^(подвопрос|subquestion|вопрос|question|пример|example)\s*\d+$/i.test(s.trim());


    for (const candidate of jsonCandidates) {
      try {
        const o = JSON.parse(candidate.trim());
        const arr = o.questions || o['вопросы'] || o.items || o.subtopics || o.topics || o.подвопросы || o.subquestions;
        if (Array.isArray(arr) && arr.length >= 2) {
          const r = arr.map(x => String(x).trim()).filter(x => x.length > 5 && !_isPlaceholder(x)).slice(0, CFG.MAX_CHILDREN);
          if (r.length >= 2) return r;
        }
        for (const v of Object.values(o)) {
          if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'string') {
            const r = v.map(x => String(x).trim()).filter(x => x.length > 5 && !_isPlaceholder(x)).slice(0, CFG.MAX_CHILDREN);
            if (r.length >= 2) return r;
          }
        }
      } catch (_) { }
      const arrM = candidate.match(/\[[\s\S]*?\]/);
      if (arrM) {
        const items = [...arrM[0].matchAll(/"([^"]{8,250})"/g)].map(m => m[1].trim()).filter(x => x.length > 8 && !_isPlaceholder(x));
        if (items.length >= 2) return items.slice(0, CFG.MAX_CHILDREN);
      }
    }

    const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
    const numbered = lines
      .map(l => { const m = l.match(/^(?:\*{0,2})?\d+[.):\-]\s*(?:\*{0,2})?(.+)/); return m ? m[1].replace(/\*\*/g, '').trim() : null; })
      .filter(x => x && x.length > 8 && x.length < 300);
    if (numbered.length >= 2) return numbered.slice(0, CFG.MAX_CHILDREN);

    const withQ = lines.map(l => l.replace(/\*\*/g, '').replace(/^\s*[-•*►▶→\d.):\-]+\s*/, '').trim())
      .filter(l => l.endsWith('?') && l.length > 10 && l.length < 250);
    if (withQ.length >= 2) return withQ.slice(0, CFG.MAX_CHILDREN);

    const bull = lines.filter(l => /^[-•*►▶→]\s/.test(l))
      .map(l => l.replace(/^[-•*►▶→]\s+/, '').replace(/\*\*/g, '').trim())
      .filter(l => l.length > 15 && l.length < 250);
    if (bull.length >= 2) return bull.slice(0, CFG.MAX_CHILDREN);

    const any = lines.map(l => l.replace(/\*\*/g, '').replace(/^\s*[-•*\d.):\-]+\s*/, '').trim())
      .filter(l => l.length > 20 && l.length < 200 && !l.startsWith('{') && !l.startsWith('[') && !l.startsWith('```'));
    if (any.length >= 2) return any.slice(0, CFG.MAX_CHILDREN);

    dbg('[parseQs] провал:', s.slice(0, 500));
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ОБРАБОТКА УЗЛОВ
  // ════════════════════════════════════════════════════════════════════════════

  async function processNode(nodeId, question, depth, maxDepth, chain, onLog) {
    // v34: НЕЗАВИСИМЫЙ cancel — таймаут этого узла не отменяет соседей/детей
    const cancel = { v: false };
    let tid;
    // v26: таймаут зависит от глубины — чем выше узел, тем дольше ждёт потомков
    // d0 (корень): ×4, d1 (ветки): ×2.5, d2+ (листья): ×1
    const timeoutMult = depth === 0 ? 4 : depth === 1 ? 2.5 : 1;
    const timeout = Math.round(CFG.NODE_TIMEOUT * timeoutMult);

    return new Promise(resolve => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; clearTimeout(tid); resolve(); } };

      tid = setTimeout(async () => {
        if (settled) return;
        cancel.v = true;
        onLog?.(`⚠ Таймаут узла [d${depth}] «${question.slice(0, 30)}» → пробуем другой ИИ...`);
        RUN.errors++;
        // v34: fallback — пытаемся получить ответ на другом воркере
        try {
          const fallbackCancel = { v: false };
          const fallbackTimeout = setTimeout(() => { fallbackCancel.v = true; }, 180_000);
          const ans = await askAny(pAnswer(question, chain), onLog, fallbackCancel);
          clearTimeout(fallbackTimeout);
          if (ans && ans.length >= 20) {
            Tree.saveAnswer(nodeId, ans, 'done');
            RUN.done++;
            RUN.errors--; // не считаем это ошибкой — мы всё же получили ответ
            onLog?.(`✓ [d${depth}] восстановлено через fallback (${ans.length} симв.)`);
          } else {
            Tree.saveAnswer(nodeId, `⚠ Таймаут: ответ не получен`, 'open');
          }
        } catch (fe) {
          dbg(`processNode fallback error: ${fe.message}`);
          Tree.saveAnswer(nodeId, `⚠ Таймаут узла [d${depth}]: ${fe.message}`, 'open');
        }
        settle();
      }, timeout);

      _nodeImpl(nodeId, question, depth, maxDepth, chain, onLog, cancel)
        .then(settle)
        .catch(err => {
          clearTimeout(tid);
          RUN.errors++;
          onLog?.(`⚠ ${err.message}`);
          Tree.saveAnswer(nodeId, `⚠ Ошибка: ${err.message}`, 'open');
          settle();
        });
    });
  }

  async function _nodeImpl(nodeId, question, depth, maxDepth, chain, onLog, cancel) {
    const cancelled = () => RUN.cancelled || cancel.v;
    while (RUN.paused && !cancelled()) await sleep(300);
    if (cancelled()) return;

    const isLeaf = depth >= maxDepth;
    const nextChain = [...chain, question];

    if (isLeaf) {
      onLog(`✦ [лист d${depth}] «${question.slice(0, 55)}»`);
      const ans = await askAny(pAnswer(question, chain), onLog, cancel);
      if (cancelled()) return;
      Tree.saveAnswer(nodeId, ans, 'done');
      RUN.done++;
      onLog(`✓ [d${depth}] готово (${ans.length} симв.)`);
      return;
    }

    onLog(`⬡ [узел d${depth}] «${question.slice(0, 55)}»`);
    const n = depth === 0 ? CFG.MAX_CHILDREN : clamp(CFG.MAX_CHILDREN - depth * 2, 2, CFG.MAX_CHILDREN);

    // v35: собираем уже существующих братьев (siblings) чтобы AI не дублировал их
    const siblings = (() => {
      try {
        const topic = AppState.getCurrentTopic?.();
        if (!topic) return [];
        const node = AppState.findNode(nodeId);
        if (!node || !node.children?.length) return [];
        return node.children.map(c => c.label).filter(Boolean);
      } catch (_) { return []; }
    })();

    let raw = await askAny(pDecompose(question, depth, chain, siblings), onLog, cancel);
    if (cancelled()) return;
    onLog(`  raw[${raw.length}]: ${raw.slice(0, 80).replace(/\n/g, ' ')}…`);
    let qs = parseQs(raw);
    onLog(`  parse: qs=${qs?.length ?? 'null'}`);

    // Проверка языка — если подвопросы на неверном языке, форсируем retry
    if (qs && qs.length >= 2 && !_checkQsLang(qs)) {
      onLog(`  ⚠ язык подвопросов не совпадает с настройкой → retry...`);
      qs = null;
    }

    if (!qs || qs.length < 2) {
      onLog(`  ↻ retry декомпозиция #1...`);
      await sleep(1500); if (cancelled()) return;
      raw = await askAny(pDecomposeRetry(question, n, siblings), onLog, cancel);
      if (cancelled()) return;
      qs = parseQs(raw);
      if (qs && qs.length >= 2 && !_checkQsLang(qs)) { onLog(`  ⚠ язык retry#1 неверный → retry#2`); qs = null; }
      onLog(`  parse retry: qs=${qs?.length ?? 'null'}`);
    }

    if (!qs || qs.length < 2) {
      onLog(`  ↻ retry декомпозиция #2...`);
      await sleep(1500); if (cancelled()) return;
      const lb = _getLangBlock();
      raw = await askAny(`Тема: «${question}». Напиши ${n} научных подвопроса — каждый на отдельной строке, начиная с цифры и точки. Без повторов.${lb}`, onLog, cancel);
      if (cancelled()) return;
      qs = parseQs(raw);
      onLog(`  parse retry2: qs=${qs?.length ?? 'null'}`);
    }

    if (!qs || qs.length < 2) {
      RUN.errors++;
      onLog(`⚠ Декомпозиция провалилась → лист`);
      const ans = await askAny(pAnswer(question, chain), onLog, cancel);
      if (cancelled()) return;
      Tree.saveAnswer(nodeId, ans, 'done'); RUN.done++;
      return;
    }

    const children = Tree.saveChildren(nodeId, qs);
    RUN.total += children.length;
    onLog(`＋ ${children.length} детей`);

    // v34: nodeAnswerTask использует свой cancel — не зависит от таймаута processNode
    const nodeCancel = { v: false };
    const nodeAnswerTask = (async () => {
      const ans = await askAny(pAnswer(question, chain), onLog, nodeCancel);
      if (!cancelled() && !nodeCancel.v) { Tree.saveAnswer(nodeId, ans, 'done'); RUN.done++; onLog(`✓ [d${depth}] узел готов`); }
    })();

    const childTasks = children.map(({ id, label }) =>
      processNode(id, label, depth + 1, maxDepth, nextChain, onLog)
    );

    await Promise.allSettled([nodeAnswerTask, ...childTasks]);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ГЛАВНЫЙ ЗАПУСК
  // ════════════════════════════════════════════════════════════════════════════

  async function runBreakdown({ rootNodeId, maxDepth, onLog, onDone }) {
    const question = Tree.getQuestion(rootNodeId);
    if (!question) { onDone({ done: 0, errors: 1, cancelled: false, recovered: 0 }); return; }

    const _engineMode = _getEngineMode();
    Object.assign(RUN, { active: true, cancelled: false, paused: false, done: 0, errors: 0, total: 1, recovered: 0, phase: 'init' });

    if (_engineMode === 'api') {
      const gapi = window.GeminiAPI;
      const rpd = gapi?.getStats();
      onLog(`Тема: «${question.slice(0, 60)}» | глубина: ${maxDepth} | Gemini API`);
      onLog(`🌐 Режим: Gemini API (${rpd ? `RPD: ${rpd.rpdUsed}/${rpd.rpdLimit}` : 'без webview'})`);
      _apiSem.setMax(Math.min(Math.max((rpd?.keysActive || 1) * 2, 2), 4));
    } else if (_engineMode === 'hybrid') {
      onLog(`Тема: «${question.slice(0, 60)}» | глубина: ${maxDepth} | API + DS/GM fallback`);
      try {
        onLog('⏳ Инициализация webview воркеров (резерв)...');
        await initPool();
        onLog('✓ Готово: Gemini API + DS×2 + GM×2 в резерве');
      } catch (e) {
        onLog(`⚠ Webview недоступен, работаем только через API: ${e.message}`);
      }
    } else {
      onLog(`Тема: «${question.slice(0, 60)}» | глубина: ${maxDepth} | DS×2 + GM×2`);
      try {
        onLog('⏳ Инициализация воркеров...');
        await initPool();
        onLog('✓ DS×2 + GM×2 готовы');
      } catch (e) {
        onLog(`❌ init: ${e.message}`);
        RUN.active = false;
        onDone({ done: 0, errors: 1, cancelled: false, recovered: 0 });
        return;
      }
    }

    RUN.phase = 'run';
    onLog(_engineMode === 'api' ? '━━━ Авторазбор (Gemini API) ━━━' : _engineMode === 'hybrid' ? '━━━ Авторазбор (API + webview резерв) ━━━' : '━━━ Авторазбор (DS + GM параллельно) ━━━');

    try { await processNode(rootNodeId, question, 0, maxDepth, [], onLog); }
    catch (e) { onLog(`❌ ${e.message}`); RUN.errors++; }

    if (_engineMode !== 'api') { WM.killAll(); _poolInited = false; }
    RUN.active = false; RUN.phase = 'done';
    const stats = { done: RUN.done, errors: RUN.errors, cancelled: RUN.cancelled, recovered: RUN.recovered };
    onDone(stats);
    setTimeout(() => window.graphModule?.fitView?.(true), 700);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ДИАГНОСТИКА — v23
  // ════════════════════════════════════════════════════════════════════════════

  async function runDiagnostics() {
    const diagBtn = document.getElementById('ab20-diag');
    if (diagBtn) { diagBtn.disabled = true; diagBtn.textContent = '⏳ Сбор…'; }

    const lines = [];
    const ts = new Date().toLocaleString('ru-RU');
    lines.push(`=== Диагностика autobreakdown v35 · ${ts} ===`);
    lines.push('');

    // 1. Конфиг
    lines.push('── CFG ──');
    for (const [k, v] of Object.entries(CFG)) lines.push(`  ${k}: ${v}`);
    lines.push('');

    // 2. Состояние RUN
    lines.push('── RUN ──');
    lines.push(`  active:${RUN.active} cancelled:${RUN.cancelled} paused:${RUN.paused}`);
    lines.push(`  done:${RUN.done} errors:${RUN.errors} total:${RUN.total} recovered:${RUN.recovered}`);
    lines.push('');

    // 3. Статус воркеров
    lines.push('── Воркеры ──');
    const allWorkers = [...WM.dsPool, ...WM.gmPool];
    if (allWorkers.length === 0) {
      lines.push('  (пул пуст — разбор не запускался или воркеры уничтожены)');
    } else {
      for (const e of allWorkers) {
        const st = e.dead ? 'DEAD' : e.busy ? 'BUSY' : e.ready ? 'IDLE' : 'INIT';
        const inDom = document.body.contains(e.wrap) ? 'DOM✓' : 'DOM✗';
        lines.push(`  ${e.provider.toUpperCase()}#${e.id}: ${st} · dead=${e.dead} busy=${e.busy} ready=${e.ready} recoveries=${e.recoveries || 0} ${inDom}`);
      }
    }
    lines.push('');

    // 4. DOM-снимок каждого воркера
    lines.push('── DOM воркеров ──');
    const DOM_PROBE = `JSON.stringify({
        url: location.href,
        title: document.title.slice(0,60),
        textareas: Array.from(document.querySelectorAll('textarea')).map(e=>({id:e.id,cls:e.className.slice(0,50),ph:e.placeholder.slice(0,40)})),
        contenteditable: Array.from(document.querySelectorAll('[contenteditable="true"]')).map(e=>({tag:e.tagName,id:e.id,cls:e.className.slice(0,50)})),
        loginInputs: Array.from(document.querySelectorAll('input[type="email"],input[type="password"]')).length,
        buttons: Array.from(document.querySelectorAll('button')).filter(b=>!b.disabled&&b.offsetWidth>0).slice(0,12).map(b=>({
          lbl: (b.getAttribute('aria-label')||'').slice(0,40),
          dtid: (b.getAttribute('data-testid')||'').slice(0,30),
          cls: b.className.slice(0,40),
          hasSvg: !!b.querySelector('svg'),
          rect: (r=>({bottom:Math.round(r.bottom),right:Math.round(r.right)}))(b.getBoundingClientRect())
        })),
        sendPath: (function(){
          var paths=['M8.3125','M.5 ','M2 12','M22 2','M3.478'];
          for(var d of paths){var p=document.querySelector('path[d*="'+d+'"]');if(p)return d;}
          return null;
        })(),
        replySnippet: (function(){
          var sels=['.ds-markdown','[class*="markdown-body"]','[class*="message-content"]','[data-role="assistant"]','[data-testid*="message"]','[class*="chat-message"]','[class*="reply"]','[class*="response"]','[class*="prose"]','article'];
          for(var s of sels){var el=document.querySelector(s);if(el&&(el.textContent||'').trim().length>10)return s+': '+el.textContent.trim().slice(0,80);}
          return 'НЕТ';
        })(),
        topDivClasses: Array.from(document.querySelectorAll('div[class]')).filter(function(el){return(el.textContent||'').trim().length>50&&!el.querySelector('input,textarea');}).slice(0,8).map(function(el){return el.className.slice(0,60);})
      })`;

    if (allWorkers.length === 0) {
      lines.push('  (нет воркеров)');
    } else {
      for (const e of allWorkers) {
        const tag = `${e.provider.toUpperCase()}#${e.id}`;
        if (e.dead) { lines.push(`  [${tag}] DEAD — пропуск`); continue; }
        if (!document.body.contains(e.wrap)) { lines.push(`  [${tag}] не в DOM — пропуск`); continue; }
        try {
          const raw = await e.wv.executeJavaScript(DOM_PROBE);
          const d = JSON.parse(raw);
          lines.push(`  [${tag}] url: ${d.url}`);
          lines.push(`  [${tag}] title: ${d.title}`);
          lines.push(`  [${tag}] textareas: ${d.textareas.length} · ce: ${d.contenteditable.length} · loginInputs: ${d.loginInputs}`);
          lines.push(`  [${tag}] sendPath SVG: ${d.sendPath ?? 'НЕ НАЙДЕН'}`);
          lines.push(`  [${tag}] replySnippet: ${d.replySnippet ?? 'НЕТ'}`);
          if (d.topDivClasses?.length) {
            lines.push(`  [${tag}] topDivClasses: ${d.topDivClasses.join(' | ')}`);
          }
          if (d.buttons.length) {
            lines.push(`  [${tag}] кнопки (${d.buttons.length}):`);
            for (const b of d.buttons) {
              lines.push(`    • lbl="${b.lbl}" dtid="${b.dtid}" svg=${b.hasSvg} bottom=${b.rect.bottom} right=${b.rect.right} cls="${b.cls}"`);
            }
          } else {
            lines.push(`  [${tag}] кнопок не найдено`);
          }
        } catch (e2) {
          lines.push(`  [${tag}] ошибка зонда: ${e2.message}`);
        }
        lines.push('');
      }
    }

    // 5. Дерево узлов (статусы всех узлов)
    lines.push('── Дерево узлов ──');
    try {
      const topic = AppState.getCurrentTopic?.();
      if (topic?.nodes?.length) {
        const _printNodes = (nodes, indent) => {
          for (const n of nodes) {
            const st = n.status || 'open';
            const icon = st === 'done' ? '✓' : st === 'error' ? '✗' : st === 'timeout' ? '⏱' : '○';
            lines.push(`${indent}${icon} [${st}] ${(n.label || '').slice(0, 60)}${n.answer ? ` (${n.answer.length}c)` : ''}`);
            if (n.children?.length) _printNodes(n.children, indent + '  ');
          }
        };
        _printNodes(topic.nodes, '  ');
      } else {
        lines.push('  (нет узлов или тема не выбрана)');
      }
    } catch (e3) {
      lines.push(`  ошибка получения дерева: ${e3.message}`);
    }
    lines.push('');

    // 6. Анализ лога: таймауты и ошибки
    lines.push('── Анализ ошибок ──');
    const timeouts = RUN.log.filter(l => l.includes('Таймаут узла'));
    const errors = RUN.log.filter(l => l.includes('❌') || l.includes('ошибка') || l.includes('err:') || l.includes('FAIL'));
    const recovered = RUN.log.filter(l => l.includes('пересоздаётся') || l.includes('reviv') || l.includes('🔁'));
    lines.push(`  Таймаутов: ${timeouts.length} · Ошибок в логе: ${errors.length} · Пересозданий: ${recovered.length}`);
    if (timeouts.length) {
      lines.push('  Узлы с таймаутом:');
      timeouts.forEach(l => lines.push('    ' + l.trim()));
    }
    if (errors.length) {
      lines.push('  Строки ошибок:');
      errors.forEach(l => lines.push('    ' + l.trim()));
    }
    lines.push('');

    // 7. Полный лог панели
    lines.push(`── Лог панели (всего ${RUN.log.length} строк) ──`);
    if (RUN.log.length) RUN.log.forEach(l => lines.push('    ' + l));
    else lines.push('  (пусто)');
    lines.push('');
    lines.push('=== конец отчёта ===');

    const report = lines.join('\n');

    if (diagBtn) { diagBtn.disabled = false; diagBtn.textContent = '🔍 Диагностика'; }

    // Показать модальное окно с отчётом
    _showDiagModal(report);
  }

  function _showDiagModal(report) {
    document.getElementById('ab20-diag-modal')?.remove();

    const m = document.createElement('div');
    m.id = 'ab20-diag-modal';
    m.innerHTML = `
        <div class="ab20-diag-backdrop"></div>
        <div class="ab20-diag-box">
          <div class="ab20-diag-hdr">
            <span style="font-size:12px;font-weight:700;color:var(--text-primary,#e2e8f0);">🔍 Диагностический отчёт</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <button class="ab20-diag-copy" id="ab20-diag-copy">📋 Копировать</button>
              <button class="ab20-ico ab20-x" id="ab20-diag-close">✕</button>
            </div>
          </div>
          <textarea class="ab20-diag-txt" id="ab20-diag-txt" readonly>${report.replace(/</g, '&lt;')}</textarea>
          <div class="ab20-diag-hint">Скопируй и отправь разработчику для анализа ошибки</div>
        </div>`;
    document.body.appendChild(m);

    const txt = m.querySelector('#ab20-diag-txt');
    txt.value = report;   // textarea.value не экранирует HTML
    txt.select();

    m.querySelector('#ab20-diag-close').onclick = () => m.remove();
    m.querySelector('.ab20-diag-backdrop').onclick = () => m.remove();
    m.querySelector('#ab20-diag-copy').onclick = () => {
      navigator.clipboard?.writeText(report).catch(() => { });
      const btn = m.querySelector('#ab20-diag-copy');
      btn.textContent = '✓ Скопировано!';
      setTimeout(() => { btn.textContent = '📋 Копировать'; }, 2000);
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UI — ПАНЕЛЬ МОНИТОРИНГА
  // ════════════════════════════════════════════════════════════════════════════

  let _panel = null;
  let _recoveryEl = null;
  let panelDone = null;
  // Хранится на уровне модуля — гарантирует что при пересоздании панели
  // старый interval очищается и не продолжает обновлять удалённые DOM-элементы
  let _panelInterval = null;

  function _updateRecoveryCounter() {
    if (_recoveryEl) _recoveryEl.textContent = RUN.recovered > 0 ? ` · ↺${RUN.recovered}` : '';
  }

  function buildPanel(showLogs) {
    if (_panel && document.body.contains(_panel)) return _panel;
    // Очищаем старый interval перед пересозданием панели
    if (_panelInterval !== null) { clearInterval(_panelInterval); _panelInterval = null; }
    _panel?.remove();

    const _panelMode = _getEngineMode();
    const _panelGapi = window.GeminiAPI;
    const _panelTag = _panelMode === 'api' ? 'Gemini API' : _panelMode === 'hybrid' ? 'API+DS+GM' : 'DS×2+GM×2';

    _panel = document.createElement('div');
    _panel.id = 'ab20-panel';
    _panel.innerHTML = `
        <div class="ab20-hdr" id="ab20-hdr">
          <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
            <span class="ab20-spin"></span>
            <span style="font-size:11px;font-weight:700;color:var(--text-primary,#e2e8f0);">⚡ Авторазбор</span>
            <span class="ab20-tag" style="${_panelMode === 'api' ? 'background:rgba(66,133,244,.18);color:#4285f4;border-color:rgba(66,133,244,.35)' : _panelMode === 'hybrid' ? 'background:rgba(124,106,247,.15);color:#a78bfa' : ''}">${_panelTag}</span>
            <span class="ab20-rec" id="ab20-rec"></span>
          </div>
          <div style="display:flex;gap:4px;">
            <button class="ab20-ico" id="ab20-mini" title="Свернуть">⊟</button>
            <button class="ab20-ico ab20-x" id="ab20-close" title="Закрыть">✕</button>
          </div>
        </div>
        <div id="ab20-body">
          <div class="ab20-prog-wrap"><div class="ab20-prog" id="ab20-prog" style="width:0%"></div></div>
          <div class="ab20-status" id="ab20-status">● Готов</div>
          <div class="ab20-workers" id="ab20-workers">
            ${_panelMode === 'api' ? `
              <span class="ab20-wk gm" id="ab20-gapi" style="background:rgba(66,133,244,.15);border-color:rgba(66,133,244,.3);color:#4285f4;">🌐 API</span>
              <span class="ab20-wk gm" id="ab20-rpd" style="font-size:9px;opacity:.7;">RPD: ${_panelGapi ? _panelGapi.getRPDUsed() + '/' + _panelGapi.FREE_TIER.RPD : '?'}</span>
            ` : _panelMode === 'hybrid' ? `
              <span class="ab20-wk gm" style="background:rgba(66,133,244,.12);border-color:rgba(66,133,244,.25);color:#4285f4;">🌐 API</span>
              <span class="ab20-wk ds" id="ab20-ds0" style="opacity:.5">DS#1</span>
              <span class="ab20-wk ds" id="ab20-ds1" style="opacity:.5">DS#2</span>
              <span class="ab20-wk gm" id="ab20-gm0" style="opacity:.5">GM#1</span>
              <span class="ab20-wk gm" id="ab20-gm1" style="opacity:.5">GM#2</span>
            ` : `
              <span class="ab20-wk ds" id="ab20-ds0">DS#1</span>
              <span class="ab20-wk ds" id="ab20-ds1">DS#2</span>
              <span class="ab20-wk gm" id="ab20-gm0">GM#1</span>
              <span class="ab20-wk gm" id="ab20-gm1">GM#2</span>
            `}
          </div>
          <div class="ab20-log" id="ab20-log"></div>
          <div class="ab20-stats" id="ab20-stats">Узлов: 0/0 · Ошибок: 0</div>
        </div>
        <div class="ab20-ctrl" id="ab20-ctrl" style="display:none;">
          <button class="ab20-btn-pause" id="ab20-pause">⏸ Пауза</button>
          <button class="ab20-btn-stop"  id="ab20-stop">⏹ Стоп</button>
          <button class="ab20-btn-diag"  id="ab20-diag" title="Собрать диагностику и показать отчёт">🔍 Диагностика</button>
        </div>`;
    document.body.appendChild(_panel);
    _draggable(_panel, _panel.querySelector('#ab20-hdr'));
    _recoveryEl = _panel.querySelector('#ab20-rec');

    // Показываем/скрываем лог в зависимости от настройки
    const logSection = _panel.querySelector('#ab20-log');
    if (logSection) logSection.style.display = showLogs ? '' : 'none';

    let mini = false;
    // _ctrlVisible — флаг: блок #ab20-ctrl был показан (активный прогон или завершение с кнопкой Диагностики)
    let _ctrlVisible = false;
    _panel.querySelector('#ab20-mini').onclick = () => {
      mini = !mini;
      _panel.querySelector('#ab20-body').style.display = mini ? 'none' : '';
      _panel.querySelector('#ab20-ctrl').style.display = mini ? 'none' : (_ctrlVisible ? '' : 'none');
      _panel.querySelector('#ab20-mini').textContent = mini ? '⊞' : '⊟';
    };
    _panel.querySelector('#ab20-close').onclick = () => _panel.classList.remove('vis');
    _panel.querySelector('#ab20-pause').onclick = () => {
      RUN.paused = !RUN.paused;
      _panel.querySelector('#ab20-pause').textContent = RUN.paused ? '▶ Продолжить' : '⏸ Пауза';
    };
    _panel.querySelector('#ab20-stop').onclick = () => {
      RUN.cancelled = true;
      _panel.querySelector('#ab20-stop').disabled = true;
      _panel.querySelector('#ab20-stop').textContent = '⏹ Останавливается…';
    };
    _panel.querySelector('#ab20-diag').onclick = () => runDiagnostics();

    const logEl = _panel.querySelector('#ab20-log');
    const progEl = _panel.querySelector('#ab20-prog');
    const statEl = _panel.querySelector('#ab20-status');
    const statsEl = _panel.querySelector('#ab20-stats');

    // Живое обновление RPD счётчика (только в API режиме)
    if (_panelMode === 'api' || _panelMode === 'hybrid') {
      const rpdEl = _panel.querySelector('#ab20-rpd');
      if (rpdEl) {
        const rpdInterval = setInterval(() => {
          if (!RUN.active) { clearInterval(rpdInterval); return; }
          const g = window.GeminiAPI;
          if (g) rpdEl.textContent = `RPD: ${g.getRPDUsed()}/${g.FREE_TIER.RPD}`;
        }, 3000);
      }
    }

    panelLog = msg => {
      const line = document.createElement('div');
      line.className = 'ab20-line'; line.textContent = msg;
      logEl.appendChild(line);
      // визуальный лимит DOM: не более 200 строк в #ab20-log
      if (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
      RUN.log.push(msg); // RUN.log не ограничен — диагностика видит всё
    };

    const iv = setInterval(() => {
      if (!document.body.contains(_panel)) { clearInterval(iv); _panelInterval = null; return; }
      if (!RUN.active) return;
      const pct = RUN.total > 0 ? Math.round(RUN.done / RUN.total * 100) : 0;
      progEl.style.width = pct + '%';
      statsEl.textContent = `Узлов: ${RUN.done}/${RUN.total} · Ошибок: ${RUN.errors}`;
      _updateWorkerChips();
    }, 800);
    _panelInterval = iv;

    panelDone = stats => {
      clearInterval(iv); _panelInterval = null;
      progEl.style.width = '100%';
      statEl.innerHTML = `✅ ${stats.done} узлов · ${stats.errors} ошибок${stats.recovered ? ` · ↺${stats.recovered}` : ''}`;
      statsEl.textContent = `Узлов: ${stats.done}/${RUN.total} · Ошибок: ${stats.errors}`;
      // Скрываем Пауза и Стоп, но оставляем блок ctrl видимым ради кнопки Диагностики
      const pauseBtn = _panel.querySelector('#ab20-pause');
      const stopBtn = _panel.querySelector('#ab20-stop');
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'none';
      _ctrlVisible = true;
      _panel.querySelector('#ab20-ctrl').style.display = mini ? 'none' : '';
      _panel.classList.remove('running');
      document.getElementById('ab20-btn-tree')?.classList.remove('run');
      document.getElementById('ab20-btn-graph')?.classList.remove('run');
    };

    return _panel;
  }

  function _updateWorkerChips() {
    [['ab20-ds0', WM.dsPool[0]], ['ab20-ds1', WM.dsPool[1]],
    ['ab20-gm0', WM.gmPool[0]], ['ab20-gm1', WM.gmPool[1]]].forEach(([id, e]) => {
      const el = document.getElementById(id); if (!el) return;
      el.classList.remove('busy', 'dead', 'ready', 'init');
      if (!e) { el.classList.add('init'); return; }
      el.classList.add(e.dead ? 'dead' : e.busy ? 'busy' : e.ready ? 'ready' : 'init');
    });
  }

  function _draggable(el, handle) {
    let ox = 0, oy = 0, ex = 0, ey = 0;
    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault(); ex = e.clientX; ey = e.clientY; ox = el.offsetLeft; oy = el.offsetTop;
      const mv = mv => { el.style.left = (ox + mv.clientX - ex) + 'px'; el.style.top = (oy + mv.clientY - ey) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // РЕЖИМ «ТОЛЬКО ДЕКОМПОЗИЦИЯ» (без ответов)
  // ════════════════════════════════════════════════════════════════════════════

  async function runDecomposeOnly({ rootNodeId, maxDepth, onLog, onDone }) {
    const question = Tree.getQuestion(rootNodeId);
    if (!question) { onDone({ done: 0, errors: 1, cancelled: false, recovered: 0 }); return; }

    const _decompMode = _getEngineMode();
    Object.assign(RUN, { active: true, cancelled: false, paused: false, done: 0, errors: 0, total: 1, recovered: 0, phase: 'init' });
    onLog(`Декомпозиция: «${question.slice(0, 60)}» | глубина: ${maxDepth}`);

    if (_decompMode !== 'api') {
      try {
        onLog('⏳ Инициализация воркеров...');
        await initPool();
        onLog(_decompMode === 'hybrid' ? '✓ API + DS×2 + GM×2 готовы' : '✓ DS×2 + GM×2 готовы');
      } catch (e) {
        if (_decompMode === 'webview') {
          onLog(`❌ init: ${e.message}`);
          RUN.active = false;
          onDone({ done: 0, errors: 1, cancelled: false, recovered: 0 });
          return;
        }
        onLog(`⚠ Webview недоступен, работаем через API: ${e.message}`);
      }
    } else {
      onLog('🌐 Gemini API — воркеры не нужны');
    }

    RUN.phase = 'run';
    onLog('━━━ Только декомпозиция (без ответов) ━━━');

    async function decompNode(nodeId, nodeQ, depth) {
      const cancelled = () => RUN.cancelled;
      while (RUN.paused && !cancelled()) await sleep(300);
      if (cancelled()) return;
      if (depth >= maxDepth) { RUN.done++; onLog(`✦ [лист d${depth}] «${nodeQ.slice(0,45)}»`); return; }

      onLog(`⬡ [узел d${depth}] «${nodeQ.slice(0,45)}»`);
      const n = depth === 0 ? CFG.MAX_CHILDREN : clamp(CFG.MAX_CHILDREN - depth * 2, 2, CFG.MAX_CHILDREN);
      const chain = [];
      let raw, qs;
      try {
        raw = await askAny(pDecompose(nodeQ, depth, chain), onLog, { v: false });
        qs = parseQs(raw);
        if (!qs || qs.length < 2) {
          await sleep(1200); if (cancelled()) return;
          raw = await askAny(pDecomposeRetry(nodeQ, n), onLog, { v: false });
          qs = parseQs(raw);
        }
      } catch(e) { onLog(`⚠ ${e.message}`); RUN.errors++; RUN.done++; return; }

      if (!qs || qs.length < 2) { onLog(`⚠ Нет подвопросов → лист`); RUN.errors++; RUN.done++; return; }

      const children = Tree.saveChildren(nodeId, qs);
      RUN.total += children.length;
      onLog(`＋ ${children.length} детей`);

      await Promise.all(children.map(({ id, label }) => decompNode(id, label, depth + 1)));
      RUN.done++;
    }

    try { await decompNode(rootNodeId, question, 0); }
    catch(e) { onLog(`❌ ${e.message}`); RUN.errors++; }

    if (_decompMode !== 'api') { WM.killAll(); _poolInited = false; }
    RUN.active = false; RUN.phase = 'done';
    onDone({ done: RUN.done, errors: RUN.errors, cancelled: RUN.cancelled, recovered: 0 });
    setTimeout(() => window.graphModule?.fitView?.(true), 700);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UI — ДИАЛОГ ЗАПУСКА (полный)
  // ════════════════════════════════════════════════════════════════════════════

  function showDialog(nodeId, fromToolbar = false) {
    if (!nodeId) {
      nodeId = AppState.get('selectedNodeId');
      if (!nodeId) {
        const topic = AppState.getCurrentTopic();
        nodeId = topic?.nodes?.[0]?.id;
      }
    }
    if (!nodeId) {
      if (typeof showToast !== 'undefined') showToast('Сначала выберите узел');
      return;
    }

    const node = AppState.findNode(nodeId);
    if (!node) return;

    // Собираем дочерние узлы для выбора
    const topic = AppState.getCurrentTopic();
    const allNodes = topic ? _flattenNodes(topic.nodes) : [];

    // Режим (0=только декомпозиция, 1=декомпозиция+ответы)
    let mode = AppState.get('abMode') ?? 1;
    let depth = AppState.get('abDepth') || 2;
    // Показывать ли продвинутые настройки
    const advEnabled = window.Settings?.get('ab_advanced_enabled') ?? false;
    let showAdvanced = false;
    let showLogs = AppState.get('abShowLogs') ?? false;

    // Строим список узлов: всегда все узлы темы.
    // fromToolbar → все выбраны; конкретный узел → выбран только он.
    const allTopicNodes = topic ? _flattenNodes(topic.nodes) : [];
    const childNodes = allTopicNodes;
    const treeRoots  = topic ? topic.nodes : [];
    const hasChildren = childNodes.length > 0;

    // Начальный выбор: toolbar → все (null), конкретный узел → только он
    let selectedNodes = fromToolbar ? null : new Set([nodeId]);
    let selectionMode = fromToolbar ? 'all' : 'only';

    document.getElementById('ab20-dlg')?.remove();
    injectCSS();

    const question = node.label;
    const n = CFG.MAX_CHILDREN;

    const est = () => {
      const totalChildren = childNodes.length || 1;
      const activeChildren = selectedNodes === null ? totalChildren : selectedNodes.size;
      const ratio = totalChildren > 0 ? activeChildren / totalChildren : 1;
      const nodesBase = depth === 1 ? (1 + n) : depth === 2 ? (1 + n + n * Math.max(2, n - 2)) : (1 + n + n * Math.max(2,n-2) + n * Math.max(1,n-3) * Math.max(1,n-3));
      const nodes = Math.max(1, Math.round(nodesBase * (childNodes.length > 0 ? ratio : 1)));
      const reqs = mode === 0 ? nodes : nodes * 2;
      const mins = Math.round(reqs * 0.4);
      return `~${nodes} узлов · ~${reqs} запросов · ~${mins} мин`;
    };

    const dlg = document.createElement('div');
    dlg.id = 'ab20-dlg';

    // Вспомогательные наборы id
    const rootIds = new Set(treeRoots.map(r => r.id));
    const childIds = new Set(childNodes.filter(n => !rootIds.has(n.id)).map(n => n.id));

    // Рекурсивный рендер узла дерева
    const renderTreeNode = (ch, level) => {
      const checked = selectedNodes === null || selectedNodes.has(ch.id);
      const isTarget = ch.id === nodeId && !fromToolbar;
      const hasKids = ch.children && ch.children.length > 0;
      const isRoot = level === 0;
      return `
        <div class="ab20-tree-row" data-level="${level}">
          <label class="ab20-node-item ${checked ? 'checked' : ''} ${isTarget ? 'ab20-target-node' : ''} ab20-lvl-${level}" data-id="${ch.id}" style="margin-left:${level * 18}px">
            ${level > 0 ? `<span class="ab20-tree-indent"></span>` : ''}
            <span class="ab20-node-cb">${checked ? '✓' : ''}</span>
            <span class="ab20-node-lbl">${esc(ch.label.slice(0, 65))}</span>
            ${isTarget ? `<span class="ab20-lvl-badge ab20-lvl-badge--target">выбран</span>` : isRoot ? `<span class="ab20-lvl-badge">корень</span>` : (level === 1 ? `<span class="ab20-lvl-badge ab20-lvl-badge--child">дочерний</span>` : `<span class="ab20-lvl-badge ab20-lvl-badge--deep">глубже</span>`)}
          </label>
          ${hasKids ? ch.children.map(grandch => renderTreeNode(grandch, level + 1)).join('') : ''}
        </div>`;
    };

    const renderChildList = () => {
      if (!hasChildren) return '';
      const totalCount = childNodes.length;
      const selCount = selectedNodes === null ? totalCount : selectedNodes.size;
      const rootCount = treeRoots.length;
      const childCount = totalCount - rootCount;
      const btnAll      = `<button class="ab20-sel-filter ${selectionMode === 'all'      ? 'on' : ''}" id="ab20-sel-all"      data-sel="all">Все <span class="ab20-sel-cnt">${totalCount}</span></button>`;
      const btnOnly     = !fromToolbar ? `<button class="ab20-sel-filter ${selectionMode === 'only'     ? 'on' : ''}" id="ab20-sel-only"     data-sel="only">Только этот</button>` : '';
      const btnRoots    = `<button class="ab20-sel-filter ${selectionMode === 'roots'    ? 'on' : ''}" id="ab20-sel-roots"    data-sel="roots">Корневые <span class="ab20-sel-cnt">${rootCount}</span></button>`;
      const btnChildren = childCount > 0 ? `<button class="ab20-sel-filter ${selectionMode === 'children' ? 'on' : ''}" id="ab20-sel-children" data-sel="children">Дочерние <span class="ab20-sel-cnt">${childCount}</span></button>` : '';
      return `
        <div class="ab20-sec">
          <div class="ab20-sec-hdr">
            <span class="ab20-sec-title">Узлы для обработки</span>
            <span class="ab20-sel-chosen">${selCount < totalCount ? `✓ ${selCount} из ${totalCount}` : ''}</span>
          </div>
          <div class="ab20-sel-row">
            ${btnAll}${btnOnly}${btnRoots}${btnChildren}
          </div>
          <div class="ab20-node-list ab20-node-tree" id="ab20-node-list">
            ${treeRoots.map(r => renderTreeNode(r, 0)).join('')}
          </div>
        </div>`;
    };

    // Собираем все настройки из Settings
    const S = key => window.Settings?.get(key);
    const advHTML = () => {
      if (!advEnabled || !showAdvanced) return '';
      return `
        <div class="ab20-adv-panel" id="ab20-adv">
          <div class="ab20-adv-title">⚙ Продвинутые настройки</div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Ширина (детей на узел)<small>2–10</small></span>
            <div class="ab20-adv-ctrl">
              <input type="range" min="2" max="10" step="1" class="ab20-adv-slider" id="adv-width" value="${S('decomp_width') || CFG.MAX_CHILDREN}">
              <span class="ab20-adv-val" id="adv-width-v">${S('decomp_width') || CFG.MAX_CHILDREN}</span>
            </div>
          </div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Таймаут узла (сек)</span>
            <div class="ab20-adv-ctrl">
              <input type="range" min="30" max="300" step="10" class="ab20-adv-slider" id="adv-timeout" value="${S('decomp_timeout') || 90}">
              <span class="ab20-adv-val" id="adv-timeout-v">${S('decomp_timeout') || 90}с</span>
            </div>
          </div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Повторных попыток</span>
            <select class="ab20-adv-select" id="adv-retries">
              ${[0,1,2,3].map(v=>`<option value="${v}" ${(S('decomp_retries')||1)==v?'selected':''}>
                ${v===0?'0 — не повторять':v+' попытк'+(v===1?'а':v<5?'и':'')}</option>`).join('')}
            </select>
          </div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Стратегия декомпозиции</span>
            <select class="ab20-adv-select" id="adv-strategy">
              ${['Классическая','Сократовская','Проблемная','Концептуальная','Практическая']
                .map(v=>`<option ${(S('decomp_strategy')||'Классическая')===v?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Язык ответов</span>
            <select class="ab20-adv-select" id="adv-lang">
              ${['Русский','Как вопрос','English','Deutsch']
                .map(v=>`<option ${(S('decomp_lang')||'Русский')===v?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Адаптивная глубина</span>
            <div class="ab20-adv-toggle ${S('decomp_adaptive')!==false?'on':''}" id="adv-adaptive"></div>
          </div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Авто-ответ для листьев</span>
            <div class="ab20-adv-toggle ${S('decomp_autoleaf')!==false?'on':''}" id="adv-autoleaf"></div>
          </div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Возобновление при сбое</span>
            <div class="ab20-adv-toggle ${S('decomp_resume')!==false?'on':''}" id="adv-resume"></div>
          </div>

          <div class="ab20-adv-sep"></div>

          <div class="ab20-adv-row">
            <span class="ab20-adv-lbl">Показывать логи во время работы</span>
            <div class="ab20-adv-toggle ${showLogs?'on':''}" id="adv-showlogs"></div>
          </div>
        </div>`;
    };

    const render = () => {
      // Сохраняем позицию скролла тела диалога перед ре-рендером
      const bodyEl = dlg.querySelector('.ab20-dlg-body');
      const savedScroll = bodyEl ? bodyEl.scrollTop : 0;

      dlg.innerHTML = `
        <div class="ab20-back"></div>
        <div class="ab20-box ab20-box-full">
          <!-- Шапка -->
          <div class="ab20-dlg-hdr">
            <span style="font-size:16px;line-height:1;">⚡</span>
            <div style="flex:1;">
              <div style="font-size:13px;font-weight:700;color:var(--text-primary,#e2e8f0);">Авторазбор</div>
              <div style="font-size:9.5px;color:var(--text-muted,#64748b);margin-top:1px;" id="ab20-dlg-engine-sub">DS×2 + GM×2 · скрытые воркеры</div>
            </div>
            <div style="display:flex;gap:5px;align-items:center;">
              ${advEnabled ? `<button class="ab20-adv-btn ${showAdvanced?'on':''}" id="ab20-adv-toggle" title="Продвинутые настройки">⚙</button>` : ''}
              <button class="ab20-dlg-x" id="ab20-dlg-x">✕</button>
            </div>
          </div>

          <!-- Тело -->
          <div class="ab20-dlg-body ab20-dlg-body-scroll">

            <!-- Тема -->
            <div class="ab20-dlg-topic">${esc(question.slice(0, 140))}</div>

            <!-- Воркеры / движок -->
            <div class="ab20-dlg-agents" id="ab20-dlg-agents">
              ${(() => {
                const m = _getEngineMode();
                const gapi = window.GeminiAPI;
                const rpd = gapi?.getStats();
                if (m === 'api') {
                  const rpdText = rpd ? `${rpd.rpdUsed}/${rpd.rpdLimit} RPD` : '';
                  return `<div class="ab20-badge gm" style="background:rgba(66,133,244,.15);border:1px solid rgba(66,133,244,.3);">
                    <span class="ab20-dot" style="background:#4285f4"></span>
                    Gemini API · ${rpdText}
                  </div>
                  <div style="font-size:9px;color:var(--text-muted,#64748b);margin-top:4px;font-family:DM Mono,monospace;">
                    ⚡ прямые запросы · без webview · ~4с/запрос
                  </div>`;
                } else if (m === 'hybrid') {
                  const rpdText = rpd ? `${rpd.rpdUsed}/${rpd.rpdLimit} RPD` : '';
                  return `<div class="ab20-badge gm" style="background:rgba(66,133,244,.1);border:1px solid rgba(66,133,244,.25);">
                    <span class="ab20-dot" style="background:#4285f4"></span>Gemini API ${rpdText}
                  </div>
                  <div class="ab20-badge ds" style="opacity:.6;font-size:9px;">
                    <span class="ab20-dot" style="background:#5eead4"></span>DS×2+GM×2 резерв
                  </div>`;
                } else {
                  return `<div class="ab20-badge ds"><span class="ab20-dot" style="background:#5eead4"></span>DeepSeek ×2</div>
                  <div class="ab20-badge gm"><span class="ab20-dot" style="background:#4285f4"></span>Gemini ×2</div>`;
                }
              })()}
            </div>

            <!-- Режим работы -->
            <div class="ab20-sec">
              <div class="ab20-sec-hdr"><span class="ab20-sec-title">Режим работы</span></div>
              <div class="ab20-mode-cards">
                <label class="ab20-mode-card ${mode===0?'on':''}" id="ab20-mode-0">
                  <div class="ab20-mode-icon">🌿</div>
                  <div class="ab20-mode-info">
                    <div class="ab20-mode-name">Только структура</div>
                    <div class="ab20-mode-desc">Разбить вопросы на подвопросы без ответов. Быстрее — только декомпозиция.</div>
                  </div>
                  <div class="ab20-mode-check">${mode===0?'✓':''}</div>
                </label>
                <label class="ab20-mode-card ${mode===1?'on':''}" id="ab20-mode-1">
                  <div class="ab20-mode-icon">📚</div>
                  <div class="ab20-mode-info">
                    <div class="ab20-mode-name">Структура + ответы</div>
                    <div class="ab20-mode-desc">Разбить на подвопросы и сразу сгенерировать ответы на каждый. Полный разбор.</div>
                  </div>
                  <div class="ab20-mode-check">${mode===1?'✓':''}</div>
                </label>
              </div>
            </div>

            <!-- Глубина -->
            <div class="ab20-sec">
              <div class="ab20-sec-hdr">
                <span class="ab20-sec-title">Глубина рекурсии</span>
                <span class="ab20-sec-sub">Уровней вложенности</span>
              </div>
              <div class="ab20-depth-row">
                ${[1,2,3].map(v=>`
                  <button class="ab20-depth-card ${depth===v?'on':''}" data-d="${v}" id="ab20-d-${v}">
                    <span class="ab20-depth-num">${v}</span>
                    <span class="ab20-depth-lbl">${v===1?'Быстро':v===2?'Баланс':'Глубоко'}</span>
                    <span class="ab20-depth-hint">${v===1?'1 уровень':v===2?'2 уровня':'3 уровня'}</span>
                  </button>`).join('')}
              </div>
            </div>

            <!-- Выбор узлов (если есть дети) -->
            ${renderChildList()}

            <!-- Оценка -->
            <div class="ab20-est" id="ab20-est">${est()}</div>

            <!-- Продвинутые настройки -->
            ${advHTML()}

          </div>

          <!-- Футер -->
          <div class="ab20-dlg-ftr">
            <button class="ab20-cancel" id="ab20-dlg-c">Отмена</button>
            <button class="ab20-start" id="ab20-dlg-s">⚡ Запустить</button>
          </div>
        </div>`;

      // Восстанавливаем позицию скролла после ре-рендера
      const newBodyEl = dlg.querySelector('.ab20-dlg-body');
      if (newBodyEl && savedScroll) newBodyEl.scrollTop = savedScroll;

      // Обновляем подзаголовок движка
      const subEl = dlg.querySelector('#ab20-dlg-engine-sub');
      if (subEl) {
        const m = _getEngineMode();
        const g = window.GeminiAPI;
        const rpd = g?.getStats();
        if (m === 'api') {
          subEl.textContent = `Gemini API · ${rpd ? rpd.rpdUsed + '/' + rpd.rpdLimit + ' RPD сегодня' : 'без webview'}`;
          subEl.style.color = '#4285f4';
        } else if (m === 'hybrid') {
          subEl.textContent = `API + DS×2+GM×2 резерв · ${rpd ? rpd.rpdUsed + '/' + rpd.rpdLimit + ' RPD' : ''}`;
          subEl.style.color = '#a78bfa';
        } else {
          subEl.textContent = 'DS×2 + GM×2 · скрытые воркеры';
          subEl.style.color = '';
        }
      }

      // Привязка событий
      dlg.querySelector('.ab20-back').onclick = () => dlg.remove();
      dlg.querySelector('#ab20-dlg-x').onclick = () => dlg.remove();
      dlg.querySelector('#ab20-dlg-c').onclick = () => dlg.remove();

      // Переключение режима
      [0, 1].forEach(m => {
        dlg.querySelector(`#ab20-mode-${m}`)?.addEventListener('click', () => {
          mode = m;
          render();
        });
      });

      // Глубина
      [1,2,3].forEach(v => {
        dlg.querySelector(`#ab20-d-${v}`)?.addEventListener('click', () => {
          depth = v;
          render();
        });
      });

      // Кнопки быстрого выбора
      dlg.querySelectorAll('.ab20-sel-filter').forEach(btn => {
        btn.onclick = () => {
          const sel = btn.dataset.sel;
          selectionMode = sel;
          if (sel === 'all') {
            selectedNodes = null;
          } else if (sel === 'only') {
            selectedNodes = new Set([nodeId]);
          } else if (sel === 'roots') {
            selectedNodes = new Set(rootIds);
          } else if (sel === 'children') {
            selectedNodes = childIds.size > 0 ? new Set(childIds) : new Set();
          }
          render();
        };
      });
        // Клики по узлам — обновляем без полного ре-рендера (нет прыжка скролла)
        dlg.querySelectorAll('.ab20-node-item').forEach(el => {
          el.addEventListener('click', () => {
            const id = el.dataset.id;
            if (selectedNodes === null) {
              selectedNodes = new Set(childNodes.map(c => c.id));
              selectedNodes.delete(id);
            } else {
              if (selectedNodes.has(id)) selectedNodes.delete(id);
              else selectedNodes.add(id);
              if (selectedNodes.size === childNodes.length) selectedNodes = null;
            }
            // Сброс режима на 'custom' при ручном изменении
            selectionMode = selectedNodes === null ? 'all' : (selectedNodes.size === 1 && selectedNodes.has(nodeId) ? 'only' : 'custom');
            // Обновляем только визуальное состояние узлов и счётчик
            dlg.querySelectorAll('.ab20-node-item').forEach(nodeEl => {
              const nid = nodeEl.dataset.id;
              const checked = selectedNodes === null || selectedNodes.has(nid);
              nodeEl.classList.toggle('checked', checked);
              const cb = nodeEl.querySelector('.ab20-node-cb');
              if (cb) cb.textContent = checked ? '✓' : '';
            });
            // Обновляем счётчик выбранных и подсветку кнопок
            const totalCount = childNodes.length;
            const selCount = selectedNodes === null ? totalCount : selectedNodes.size;
            const chosenEl = dlg.querySelector('.ab20-sel-chosen');
            if (chosenEl) chosenEl.textContent = selCount < totalCount ? `✓ ${selCount}` : '';
            dlg.querySelectorAll('.ab20-sel-filter').forEach(b => b.classList.toggle('on', b.dataset.sel === selectionMode));
            const estEl = dlg.querySelector('#ab20-est');
            if (estEl) estEl.innerHTML = est();
          });
        });

      // Кнопка продвинутых настроек
      dlg.querySelector('#ab20-adv-toggle')?.addEventListener('click', () => {
        showAdvanced = !showAdvanced;
        render();
      });

      // Продвинутые настройки — слушатели
      if (advEnabled && showAdvanced) {
        const bindSlider = (id, valId, suffix, settingKey) => {
          const sl = dlg.querySelector(`#${id}`);
          const vl = dlg.querySelector(`#${valId}`);
          if (!sl || !vl) return;
          sl.oninput = () => {
            vl.textContent = sl.value + (suffix || '');
            window.Settings?.set(settingKey, +sl.value);
            if (settingKey === 'decomp_width') { CFG.MAX_CHILDREN = +sl.value; dlg.querySelector('#ab20-est').innerHTML = est(); }
            if (settingKey === 'decomp_timeout') CFG.NODE_TIMEOUT = +sl.value * 1000;
          };
        };
        bindSlider('adv-width', 'adv-width-v', '', 'decomp_width');
        bindSlider('adv-timeout', 'adv-timeout-v', 'с', 'decomp_timeout');

        dlg.querySelector('#adv-retries')?.addEventListener('change', e => {
          window.Settings?.set('decomp_retries', +e.target.value);
          CFG.MAX_RETRIES = +e.target.value + 2;
        });
        dlg.querySelector('#adv-strategy')?.addEventListener('change', e => window.Settings?.set('decomp_strategy', e.target.value));
        dlg.querySelector('#adv-lang')?.addEventListener('change', e => window.Settings?.set('decomp_lang', e.target.value));

        ['adaptive','autoleaf','resume'].forEach(key => {
          const el = dlg.querySelector(`#adv-${key}`);
          if (!el) return;
          el.onclick = () => {
            const cur = window.Settings?.get(`decomp_${key}`) !== false;
            window.Settings?.set(`decomp_${key}`, !cur);
            el.classList.toggle('on', !cur);
          };
        });

        const logsToggle = dlg.querySelector('#adv-showlogs');
        if (logsToggle) {
          logsToggle.onclick = () => {
            showLogs = !showLogs;
            AppState.set('abShowLogs', showLogs);
            logsToggle.classList.toggle('on', showLogs);
          };
        }
      }

      // Запуск
      dlg.querySelector('#ab20-dlg-s').onclick = () => {
        AppState.set('abMode', mode);
        AppState.set('abDepth', depth);
        const targetIds = selectedNodes !== null && selectedNodes.size > 0
          ? Array.from(selectedNodes)
          : null;
        if (RUN.active) {
          RUN.cancelled = true;
          setTimeout(() => _launch(nodeId, depth, mode, targetIds, showLogs), 1400);
        } else {
          _launch(nodeId, depth, mode, targetIds, showLogs);
        }
        dlg.remove();
      };
    };

    render();
    document.body.appendChild(dlg);
  }

  function _flattenNodes(nodes, arr = []) {
    for (const n of (nodes || [])) { arr.push(n); _flattenNodes(n.children, arr); }
    return arr;
  }

  function _launch(nodeId, depth, mode, targetIds, showLogs) {
    WM.killAll(); _poolInited = false;
    _panel?.remove(); _panel = null;
    const p = buildPanel(showLogs); RUN.log = [];
    p.classList.add('vis', 'running');
    p.querySelector('#ab20-ctrl').style.display = '';
    p.querySelector('#ab20-stop').disabled = false;
    p.querySelector('#ab20-stop').textContent = '⏹ Стоп';
    p.querySelector('#ab20-status').textContent = '⏳ Инициализация...';
    document.getElementById('ab20-btn-tree')?.classList.add('run');
    document.getElementById('ab20-btn-graph')?.classList.add('run');

    // Обновляем CFG из Settings перед запуском
    const S = window.Settings?.get;
    if (S) {
      CFG.MAX_CHILDREN = S('decomp_width') || 5;
      CFG.NODE_TIMEOUT = (S('decomp_timeout') || 90) * 1000;
      CFG.MAX_RETRIES  = (S('decomp_retries') || 1) + 2;
    }

    // Если выбраны конкретные узлы — запускаем по очереди, иначе — обычный запуск
    const runner = mode === 0 ? runDecomposeOnly : runBreakdown;

    if (targetIds && targetIds.length > 0) {
      // Запускаем для каждого выбранного узла последовательно
      let idx = 0;
      const next = async () => {
        if (RUN.cancelled || idx >= targetIds.length) {
          RUN.active = false; RUN.phase = 'done';
          panelDone?.({ done: RUN.done, errors: RUN.errors, cancelled: RUN.cancelled, recovered: RUN.recovered });
          _panel?.classList.remove('running');
          return;
        }
        const id = targetIds[idx++];
        const n = AppState.findNode(id);
        if (!n) { next(); return; }
        panelLog(`\n▶ [${idx}/${targetIds.length}] «${n.label.slice(0,50)}»`);
        Object.assign(RUN, { active: true, cancelled: false, done: 0, errors: 0, total: 1, recovered: 0 });
        await new Promise(res => runner({ rootNodeId: id, maxDepth: depth, onLog: panelLog, onDone: () => res() }));
        next();
      };
      next();
    } else {
      runner({
        rootNodeId: nodeId, maxDepth: depth,
        onLog: panelLog,
        onDone: stats => { _panel?.classList.remove('running'); panelDone?.(stats); },
      });
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CSS
  // ════════════════════════════════════════════════════════════════════════════

  function injectCSS() {
    if (document.getElementById('ab20-css')) return;
    const s = document.createElement('style'); s.id = 'ab20-css';
    s.textContent = `
  @keyframes abSpin  { to{ transform:rotate(360deg); } }
  @keyframes abIn    { from{opacity:0;transform:translateY(10px) scale(.96)} to{opacity:1;transform:none} }
  @keyframes abPulse { 0%,100%{opacity:.5} 50%{opacity:1} }

  .ab20-tb-btn {
    display:flex;align-items:center;gap:6px;padding:0 12px;
    height:27px;border-radius:7px;
    background:color-mix(in srgb,var(--accent,#7c6af7) 12%,transparent);
    border:1px solid color-mix(in srgb,var(--accent,#7c6af7) 35%,transparent);
    color:var(--accent,#7c6af7);font-family:'DM Sans',sans-serif;
    font-size:12px;font-weight:500;cursor:pointer;
    transition:all .14s;flex-shrink:0;
  }
  .ab20-tb-btn:hover { background:color-mix(in srgb,var(--accent,#7c6af7) 20%,transparent); }
  .ab20-tb-btn.run   { animation:ab20-pulse 1.8s ease-in-out infinite; }
  @keyframes ab20-pulse {
    0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent,#7c6af7) 0%,transparent);}
    50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--accent,#7c6af7) 20%,transparent);}
  }
  .ab20-tb-btn .ab20-sp {
    width:6px;height:6px;border-radius:50%;background:var(--accent,#7c6af7);flex-shrink:0;
  }
  .ab20-tb-btn.run .ab20-sp {
    animation:abSpin .6s linear infinite;
    border:1.5px solid color-mix(in srgb,var(--accent,#7c6af7) 35%,transparent);
    border-top-color:var(--accent,#7c6af7);background:none;
  }
  .ab20-tb-btn.run .ab20-ic { display:none; }

  #ab20-panel {
    position:fixed;right:16px;bottom:16px;width:320px;
    background:var(--bg-modal,#0f0f17);border:1px solid rgba(110,142,251,.14);
    border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.7);z-index:9500;
    font-family:'DM Sans','DM Mono',monospace;display:none;flex-direction:column;
    animation:abIn .18s cubic-bezier(.4,0,.2,1);overflow:hidden;
  }
  #ab20-panel.vis { display:flex; }
  .ab20-hdr {
    display:flex;align-items:center;gap:6px;padding:8px 10px;
    background:rgba(255,255,255,.02);border-bottom:1px solid rgba(110,142,251,.1);
    cursor:move;user-select:none;flex-shrink:0;
  }
  .ab20-spin {
    width:7px;height:7px;border-radius:50%;
    border:1.5px solid rgba(94,234,212,.25);border-top-color:#5eead4;
    animation:abSpin .6s linear infinite;flex-shrink:0;display:none;
  }
  #ab20-panel.running .ab20-spin { display:block; }
  .ab20-tag {
    font-size:8.5px;font-family:'DM Mono',monospace;
    background:rgba(94,234,212,.1);border:1px solid rgba(94,234,212,.2);
    color:#5eead4;border-radius:10px;padding:1px 6px;flex-shrink:0;
  }
  .ab20-rec { font-size:9px;color:#f59e0b;font-family:'DM Mono',monospace;flex-shrink:0; }
  .ab20-ico {
    background:none;border:none;color:rgba(255,255,255,.25);cursor:pointer;font-size:11px;
    width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;
    transition:all .1s;flex-shrink:0;
  }
  .ab20-ico:hover { background:rgba(255,255,255,.06);color:rgba(255,255,255,.7); }
  .ab20-x:hover   { background:rgba(248,113,113,.1)!important;color:#f87171!important; }
  #ab20-body { padding:10px;display:flex;flex-direction:column;gap:7px; }
  .ab20-prog-wrap { height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden; }
  .ab20-prog { height:100%;background:linear-gradient(90deg,#5eead4,#4285f4);border-radius:2px;transition:width .4s ease; }
  .ab20-status { font-size:10.5px;color:var(--text-secondary,#94a3b8);font-family:'DM Mono',monospace; }
  .ab20-workers { display:flex;gap:4px;flex-wrap:wrap; }
  .ab20-wk {
    font-size:9px;font-family:'DM Mono',monospace;font-weight:600;
    padding:2px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.1);
    color:rgba(255,255,255,.3);transition:all .2s;
  }
  .ab20-wk.ds { border-color:rgba(94,234,212,.2);color:rgba(94,234,212,.4); }
  .ab20-wk.gm { border-color:rgba(66,133,244,.2);color:rgba(66,133,244,.4); }
  .ab20-wk.ready.ds { color:#5eead4;border-color:rgba(94,234,212,.5); }
  .ab20-wk.ready.gm { color:#4285f4;border-color:rgba(66,133,244,.5); }
  .ab20-wk.busy.ds  { color:#5eead4;border-color:#5eead4;box-shadow:0 0 6px rgba(94,234,212,.3);animation:abPulse .8s infinite; }
  .ab20-wk.busy.gm  { color:#4285f4;border-color:#4285f4;box-shadow:0 0 6px rgba(66,133,244,.3);animation:abPulse .8s infinite; }
  .ab20-wk.dead { color:#f87171;border-color:rgba(248,113,113,.4); }
  .ab20-log { max-height:140px;overflow-y:auto;font-size:9.5px;font-family:'DM Mono',monospace;color:var(--text-muted,#64748b);line-height:1.5; }
  .ab20-log::-webkit-scrollbar { width:3px; }
  .ab20-log::-webkit-scrollbar-thumb { background:rgba(255,255,255,.12);border-radius:2px; }
  .ab20-line { padding:1px 0; }
  .ab20-stats { font-size:9.5px;color:var(--text-muted,#64748b);font-family:'DM Mono',monospace;border-top:1px solid rgba(255,255,255,.05);padding-top:6px; }
  .ab20-ctrl { display:flex;gap:6px;padding:8px 10px;border-top:1px solid rgba(255,255,255,.05);flex-shrink:0; }
  .ab20-btn-pause,.ab20-btn-stop {
    flex:1;height:28px;border:none;border-radius:7px;cursor:pointer;
    font-size:10.5px;font-weight:600;font-family:'DM Sans',sans-serif;transition:all .1s;
  }
  .ab20-btn-pause { background:rgba(255,255,255,.06);color:var(--text-secondary,#94a3b8); }
  .ab20-btn-pause:hover { background:rgba(255,255,255,.1); }
  .ab20-btn-stop  { background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.2); }
  .ab20-btn-stop:hover { background:rgba(248,113,113,.2); }
  .ab20-btn-stop:disabled { opacity:.4;cursor:default; }

  #ab20-dlg { position:fixed;inset:0;z-index:9700;display:flex;align-items:center;justify-content:center; }
  .ab20-back { position:absolute;inset:0;background:rgba(0,0,0,.58);backdrop-filter:blur(7px); }
  .ab20-box  {
    position:relative;width:420px;max-width:95vw;
    background:var(--bg-modal,#0f0f17);border:1px solid var(--border-default,rgba(110,142,251,.14));
    border-radius:14px;box-shadow:0 32px 80px rgba(0,0,0,.6);
    display:flex;flex-direction:column;overflow:hidden;animation:abIn .17s cubic-bezier(.4,0,.2,1);
  }
  .ab20-dlg-hdr {
    display:flex;align-items:center;gap:9px;padding:12px 14px;
    background:rgba(255,255,255,.02);border-bottom:1px solid rgba(110,142,251,.1);
  }
  .ab20-dlg-x {
    background:none;border:none;color:rgba(255,255,255,.25);cursor:pointer;
    font-size:14px;width:26px;height:26px;border-radius:6px;
    display:flex;align-items:center;justify-content:center;transition:all .1s;
  }
  .ab20-dlg-x:hover { background:rgba(248,113,113,.1);color:#f87171; }
  .ab20-dlg-body { padding:13px 14px;display:flex;flex-direction:column;gap:11px; }
  .ab20-dlg-body-scroll { overflow-y:auto;max-height:calc(80vh - 120px); }
  .ab20-dlg-topic {
    font-size:12px;color:var(--text-primary,#e2e8f0);font-family:'DM Mono',monospace;
    background:rgba(255,255,255,.03);border:1px solid rgba(110,142,251,.1);
    border-radius:8px;padding:8px 11px;line-height:1.5;
  }
  .ab20-dot { width:5px;height:5px;border-radius:50%;flex-shrink:0;display:inline-block; }
  .ab20-dlg-agents { display:flex;gap:6px;padding:8px;background:rgba(255,255,255,.02);border:1px solid rgba(110,142,251,.08);border-radius:9px; }
  .ab20-badge {
    display:flex;align-items:center;gap:5px;padding:4px 10px;
    border-radius:20px;font-family:'DM Mono',monospace;font-size:9.5px;font-weight:600;
  }
  .ab20-badge.ds { background:rgba(94,234,212,.08);border:1px solid rgba(94,234,212,.25);color:#5eead4; }
  .ab20-badge.gm { background:rgba(66,133,244,.08);border:1px solid rgba(66,133,244,.25);color:#4285f4; }

  /* Секции диалога */
  .ab20-sec { display:flex;flex-direction:column;gap:7px; }
  .ab20-sec-hdr { display:flex;align-items:baseline;gap:8px; }
  .ab20-sec-title { font-size:11px;font-weight:600;color:var(--text-secondary,#94a3b8);text-transform:uppercase;letter-spacing:.06em; }
  .ab20-sec-sub { font-size:10px;color:var(--text-muted,#64748b); }

  /* Карточки режима */
  .ab20-mode-cards { display:flex;flex-direction:column;gap:7px; }
  .ab20-mode-card {
    display:flex;align-items:flex-start;gap:11px;padding:10px 12px;
    background:rgba(255,255,255,.025);border:1.5px solid rgba(255,255,255,.06);
    border-radius:10px;cursor:pointer;transition:all .13s;
  }
  .ab20-mode-card:hover { background:rgba(255,255,255,.04);border-color:rgba(110,142,251,.2); }
  .ab20-mode-card.on { background:color-mix(in srgb,var(--accent,#7c6af7) 10%,transparent);border-color:color-mix(in srgb,var(--accent,#7c6af7) 50%,transparent); }
  .ab20-mode-icon { font-size:16px;line-height:1;flex-shrink:0;margin-top:1px; }
  .ab20-mode-info { flex:1;min-width:0; }
  .ab20-mode-name { font-size:12px;font-weight:600;color:var(--text-primary,#e2e8f0);margin-bottom:2px; }
  .ab20-mode-desc { font-size:10px;color:var(--text-muted,#64748b);line-height:1.45; }
  .ab20-mode-check { font-size:12px;color:var(--accent,#7c6af7);font-weight:700;flex-shrink:0;width:16px;text-align:center; }

  /* Карточки глубины */
  .ab20-depth-row { display:flex;gap:7px; }
  .ab20-depth-card {
    flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;
    padding:10px 6px;background:rgba(255,255,255,.025);
    border:1.5px solid rgba(255,255,255,.06);border-radius:10px;
    cursor:pointer;transition:all .13s;
  }
  .ab20-depth-card:hover { background:rgba(255,255,255,.04);border-color:rgba(110,142,251,.2); }
  .ab20-depth-card.on { background:color-mix(in srgb,var(--accent,#7c6af7) 12%,transparent);border-color:color-mix(in srgb,var(--accent,#7c6af7) 55%,transparent); }
  .ab20-depth-num { font-size:20px;font-weight:700;color:var(--text-primary,#e2e8f0);font-family:'DM Mono',monospace; }
  .ab20-depth-card.on .ab20-depth-num { color:var(--accent,#7c6af7); }
  .ab20-depth-lbl { font-size:10.5px;font-weight:600;color:var(--text-secondary,#94a3b8); }
  .ab20-depth-hint { font-size:9px;color:var(--text-muted,#64748b); }

  /* Список узлов */
  .ab20-sel-all {
    margin-left:auto;font-size:10px;font-family:'DM Mono',monospace;
    padding:3px 9px;border-radius:6px;background:rgba(110,142,251,.08);
    border:1px solid rgba(110,142,251,.2);color:var(--accent,#7c6af7);cursor:pointer;
    transition:all .1s;
  }
  .ab20-sel-all:hover { background:rgba(110,142,251,.16); }
  .ab20-tree-stats { font-size:10px;color:var(--text-muted,#64748b);font-family:'DM Mono',monospace;margin-left:4px; }
  /* Строка кнопок выбора */
  .ab20-sel-row { display:flex;align-items:center;gap:5px; }
  .ab20-sel-filter {
    font-size:10px;font-family:'DM Sans',sans-serif;font-weight:500;
    padding:3px 9px;border-radius:6px;
    background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
    color:var(--text-muted,#64748b);cursor:pointer;transition:all .13s;
    display:flex;align-items:center;gap:4px;
  }
  .ab20-sel-filter:hover { background:rgba(255,255,255,.06);color:var(--text-secondary,#94a3b8); }
  .ab20-sel-filter.on { background:color-mix(in srgb,var(--accent,#7c6af7) 12%,transparent);border-color:color-mix(in srgb,var(--accent,#7c6af7) 40%,transparent);color:var(--accent,#7c6af7); }
  .ab20-sel-cnt { font-size:9px;font-family:'DM Mono',monospace;opacity:.7; }
  .ab20-sel-chosen { margin-left:auto;font-size:10px;font-family:'DM Mono',monospace;color:#4ade80;min-width:30px;text-align:right; }
  .ab20-node-list { display:flex;flex-direction:column;gap:3px;max-height:200px;overflow-y:auto;padding-right:2px; }
  .ab20-node-tree { gap:2px; }
  .ab20-node-list::-webkit-scrollbar { width:3px; }
  .ab20-node-list::-webkit-scrollbar-thumb { background:rgba(255,255,255,.1);border-radius:2px; }
  .ab20-tree-row { display:flex;flex-direction:column;gap:2px; }
  .ab20-node-item {
    display:flex;align-items:center;gap:8px;padding:6px 10px;
    background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);
    border-radius:7px;cursor:pointer;transition:all .1s;
  }
  .ab20-node-item:hover { background:rgba(255,255,255,.04); }
  .ab20-node-item.checked { background:rgba(74,222,128,.04);border-color:rgba(74,222,128,.2); }
  .ab20-node-item.ab20-lvl-0 { border-color:rgba(110,142,251,.2);background:rgba(110,142,251,.04); }
  .ab20-node-item.ab20-lvl-0.checked { background:rgba(74,222,128,.06);border-color:rgba(74,222,128,.25); }
  .ab20-node-item.ab20-lvl-1 { border-color:rgba(255,255,255,.05); }
  .ab20-node-item.ab20-lvl-2 { border-color:rgba(255,255,255,.03);opacity:.85; }
  .ab20-tree-indent {
    width:10px;height:14px;flex-shrink:0;
    border-left:1.5px solid rgba(255,255,255,.1);border-bottom:1.5px solid rgba(255,255,255,.1);
    border-radius:0 0 0 4px;margin-left:1px;
  }
  .ab20-node-cb {
    width:16px;height:16px;border-radius:4px;flex-shrink:0;
    background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);
    display:flex;align-items:center;justify-content:center;
    font-size:9px;color:#4ade80;font-weight:700;
  }
  .ab20-node-item.checked .ab20-node-cb { background:rgba(74,222,128,.15);border-color:rgba(74,222,128,.4); }
  .ab20-node-lbl { font-size:11px;color:var(--text-secondary,#94a3b8);line-height:1.35;flex:1;min-width:0; }
  .ab20-node-item.ab20-lvl-0 .ab20-node-lbl { color:var(--text-primary,#e2e8f0);font-weight:500; }
  .ab20-lvl-badge { font-size:8.5px;font-family:'DM Mono',monospace;padding:1px 5px;border-radius:4px;flex-shrink:0;background:rgba(110,142,251,.1);border:1px solid rgba(110,142,251,.2);color:rgba(110,142,251,.8); }
  .ab20-lvl-badge--child { background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);color:var(--text-muted,#64748b); }
  .ab20-lvl-badge--deep { background:rgba(255,255,255,.02);border-color:rgba(255,255,255,.05);color:rgba(100,116,139,.6); }
  .ab20-lvl-badge--target { background:color-mix(in srgb,var(--accent,#7c6af7) 15%,transparent);border-color:color-mix(in srgb,var(--accent,#7c6af7) 45%,transparent);color:var(--accent,#7c6af7); }
  .ab20-target-node { border-color:color-mix(in srgb,var(--accent,#7c6af7) 40%,transparent) !important; }

  /* Оценка */
  .ab20-est { font-size:10px;color:var(--text-muted,#64748b);font-family:'DM Mono',monospace;background:rgba(255,255,255,.02);border:1px solid rgba(110,142,251,.08);border-radius:8px;padding:8px 11px;line-height:1.7; }

  /* Кнопка продвинутых настроек */
  .ab20-adv-btn {
    background:none;border:1px solid rgba(255,255,255,.08);border-radius:7px;
    color:rgba(255,255,255,.3);cursor:pointer;font-size:13px;
    width:28px;height:28px;display:flex;align-items:center;justify-content:center;
    transition:all .1s;
  }
  .ab20-adv-btn:hover { background:rgba(255,255,255,.06);color:rgba(255,255,255,.6); }
  .ab20-adv-btn.on { background:rgba(110,142,251,.1);border-color:rgba(110,142,251,.3);color:var(--accent,#7c6af7); }

  /* Панель продвинутых настроек */
  .ab20-adv-panel {
    background:rgba(255,255,255,.02);border:1px solid rgba(110,142,251,.1);
    border-radius:10px;padding:11px 12px;display:flex;flex-direction:column;gap:8px;
    animation:abIn .15s ease;
  }
  .ab20-adv-title { font-size:10.5px;font-weight:600;color:var(--text-secondary,#94a3b8);margin-bottom:3px; }
  .ab20-adv-row { display:flex;align-items:center;gap:10px; }
  .ab20-adv-lbl { flex:1;font-size:11px;color:var(--text-secondary,#94a3b8); }
  .ab20-adv-lbl small { display:block;font-size:9px;color:var(--text-muted,#64748b);margin-top:1px; }
  .ab20-adv-ctrl { display:flex;align-items:center;gap:6px;flex-shrink:0; }
  .ab20-adv-slider {
    -webkit-appearance:none;appearance:none;
    width:90px;height:4px;border-radius:2px;
    background:rgba(255,255,255,.1);outline:none;cursor:pointer;
  }
  .ab20-adv-slider::-webkit-slider-thumb {
    -webkit-appearance:none;width:13px;height:13px;
    border-radius:50%;background:var(--accent,#7c6af7);cursor:pointer;
  }
  .ab20-adv-val { font-size:11px;color:var(--text-muted,#64748b);min-width:28px;text-align:right;font-family:'DM Mono',monospace; }
  .ab20-adv-select {
    font-size:11px;color:var(--text-secondary,#94a3b8);
    background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);
    border-radius:6px;padding:4px 20px 4px 7px;cursor:pointer;font-family:inherit;
    appearance:none;-webkit-appearance:none;flex-shrink:0;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat:no-repeat;background-position:right 5px center;
  }
  .ab20-adv-toggle {
    width:30px;height:17px;border-radius:9px;flex-shrink:0;
    background:rgba(255,255,255,.1);position:relative;cursor:pointer;transition:background .14s;
  }
  .ab20-adv-toggle.on { background:var(--accent,#7c6af7); }
  .ab20-adv-toggle::after {
    content:'';position:absolute;width:11px;height:11px;border-radius:50%;
    background:#fff;top:3px;left:3px;transition:left .14s;
  }
  .ab20-adv-toggle.on::after { left:16px; }
  .ab20-adv-sep { height:1px;background:rgba(255,255,255,.05);margin:2px 0; }

  /* Полный размер диалога */
  .ab20-box-full {
    width:min(520px,95vw) !important;
  }

  .ab20-row { display:flex;align-items:center;gap:10px; }
  .ab20-row-lbl { flex:1;font-size:11.5px;color:var(--text-secondary,#94a3b8); }
  .ab20-row-lbl small { display:block;font-size:9px;color:var(--text-muted,#64748b);margin-top:2px; }
  .ab20-chips { display:flex;border:1px solid rgba(110,142,251,.15);border-radius:7px;overflow:hidden; }
  .ab20-chip {
    background:none;border:none;min-width:36px;height:27px;padding:0 12px;cursor:pointer;
    font-family:'DM Mono',monospace;font-size:10.5px;color:var(--text-muted,#64748b);
    border-left:1px solid rgba(110,142,251,.1);transition:all .1s;
  }
  .ab20-chip:first-child { border-left:none; }
  .ab20-chip.on { background:var(--accent,#7c6af7);color:#fff;font-weight:700; }
  .ab20-chip:hover:not(.on) { background:rgba(255,255,255,.05);color:var(--text-primary,#e2e8f0); }
  .ab20-dlg-ftr { display:flex;gap:7px;padding:11px 14px;border-top:1px solid rgba(255,255,255,.05); }
  .ab20-cancel,.ab20-start {
    flex:1;height:32px;border:none;border-radius:8px;cursor:pointer;
    font-size:11.5px;font-weight:600;font-family:'DM Sans',sans-serif;transition:all .1s;
  }
  .ab20-cancel { background:rgba(255,255,255,.05);color:var(--text-secondary,#94a3b8); }
  .ab20-cancel:hover { background:rgba(255,255,255,.09); }
  .ab20-start  { background:var(--accent,#7c6af7);color:#fff; }
  .ab20-start:hover { filter:brightness(1.1); }

  /* ════ v22: Auth Dialog ════ */
  #ab20-auth-overlay {
    position:fixed;inset:0;z-index:10000;
    display:flex;align-items:center;justify-content:center;
    animation:abIn .2s cubic-bezier(.4,0,.2,1);
  }
  #ab20-auth-overlay.ab20-auth-leaving {
    animation:abAuthOut .26s cubic-bezier(.4,0,.2,1) forwards;
  }
  @keyframes abAuthOut { to { opacity:0; transform:scale(.97); } }
  .ab20-auth-backdrop {
    position:absolute;inset:0;
    background:rgba(0,0,0,.75);
    backdrop-filter:blur(12px);
  }
  .ab20-auth-modal {
    position:relative;
    width:min(820px,95vw);
    height:min(660px,92vh);
    background:var(--bg-modal,#0f0f17);
    border:1px solid rgba(124,106,247,.25);
    border-radius:16px;
    box-shadow:0 32px 100px rgba(0,0,0,.85), 0 0 0 1px rgba(124,106,247,.08);
    display:flex;flex-direction:column;overflow:hidden;
  }
  .ab20-auth-hdr {
    display:flex;align-items:center;gap:10px;
    padding:14px 16px;
    background:rgba(255,255,255,.025);
    border-bottom:1px solid rgba(124,106,247,.14);
    flex-shrink:0;
  }
  .ab20-auth-icon { font-size:20px;line-height:1;flex-shrink:0; }
  .ab20-auth-titles { flex:1;min-width:0; }
  .ab20-auth-title {
    font-size:13.5px;font-weight:700;
    color:var(--text-primary,#e2e8f0);
    font-family:'DM Sans',sans-serif;
  }
  .ab20-auth-sub {
    font-size:10px;margin-top:2px;
    color:var(--text-muted,#64748b);
    font-family:'DM Mono',monospace;
  }
  .ab20-auth-close {
    background:none;border:none;
    color:rgba(255,255,255,.3);cursor:pointer;
    font-size:15px;width:30px;height:30px;border-radius:7px;
    display:flex;align-items:center;justify-content:center;
    transition:all .12s;flex-shrink:0;
  }
  .ab20-auth-close:hover { background:rgba(248,113,113,.14);color:#f87171; }
  .ab20-auth-wv-wrap {
    flex:1;position:relative;
    background:#fff;
    overflow:hidden;
  }
  .ab20-auth-wv-loader {
    position:absolute;inset:0;z-index:2;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    background:var(--bg-modal,#0f0f17);
  }
  .ab20-auth-spinner {
    width:26px;height:26px;border-radius:50%;
    border:2.5px solid rgba(124,106,247,.18);
    border-top-color:var(--accent,#7c6af7);
    animation:abSpin .65s linear infinite;
  }
  .ab20-auth-loader-txt {
    font-size:11.5px;color:var(--text-muted,#64748b);
    font-family:'DM Mono',monospace;
  }
  .ab20-auth-hint {
    display:flex;align-items:center;gap:8px;
    padding:10px 16px;
    background:rgba(124,106,247,.07);
    border-top:1px solid rgba(124,106,247,.12);
    border-bottom:1px solid rgba(124,106,247,.12);
    font-size:11px;color:rgba(167,139,250,.9);
    font-family:'DM Sans',sans-serif;
    flex-shrink:0;
  }
  .ab20-auth-hint-icon {
    width:18px;height:18px;border-radius:50%;
    background:rgba(124,106,247,.22);
    display:flex;align-items:center;justify-content:center;
    font-size:10px;flex-shrink:0;font-style:normal;color:var(--accent,#7c6af7);
  }
  .ab20-auth-ftr {
    display:flex;gap:8px;padding:13px 16px;
    background:rgba(255,255,255,.015);
    border-top:1px solid rgba(255,255,255,.05);
    flex-shrink:0;
  }
  .ab20-auth-btn-cancel {
    flex:0 0 auto;height:36px;padding:0 20px;
    background:rgba(255,255,255,.05);
    border:1px solid rgba(255,255,255,.08);
    border-radius:9px;color:var(--text-secondary,#94a3b8);cursor:pointer;
    font-size:12px;font-weight:500;font-family:'DM Sans',sans-serif;
    transition:all .12s;
  }
  .ab20-auth-btn-cancel:hover {
    background:rgba(248,113,113,.1);color:#f87171;
    border-color:rgba(248,113,113,.22);
  }
  .ab20-auth-btn-ok {
    flex:1;height:36px;
    background:var(--accent,#7c6af7);border:none;
    border-radius:9px;color:#fff;cursor:pointer;
    font-size:13px;font-weight:700;font-family:'DM Sans',sans-serif;
    transition:all .12s;letter-spacing:.01em;
    box-shadow:0 4px 18px rgba(124,106,247,.35);
  }
  .ab20-auth-btn-ok:hover {
    filter:brightness(1.1);
    box-shadow:0 6px 22px rgba(124,106,247,.45);
  }

  /* ── Кнопка диагностики ── */
  .ab20-btn-diag {
    flex:0 0 auto;height:26px;padding:0 10px;
    background:rgba(251,191,36,.08);
    border:1px solid rgba(251,191,36,.18);
    border-radius:7px;color:#fbbf24;cursor:pointer;
    font-size:10px;font-weight:600;font-family:'DM Mono',monospace;
    transition:all .12s;white-space:nowrap;
  }
  .ab20-btn-diag:hover { background:rgba(251,191,36,.15); border-color:rgba(251,191,36,.35); }
  .ab20-btn-diag:disabled { opacity:.45; cursor:default; }

  /* ── Диагностический модал ── */
  .ab20-diag-backdrop {
    position:fixed;inset:0;z-index:9997;
    background:rgba(0,0,0,.55);
    backdrop-filter:blur(3px);
  }
  .ab20-diag-box {
    position:fixed;z-index:9998;
    top:50%;left:50%;transform:translate(-50%,-50%);
    width:min(700px,calc(100vw - 32px));
    max-height:calc(100vh - 60px);
    background:var(--bg-modal,#0f0f17);
    border:1px solid rgba(251,191,36,.2);
    border-radius:14px;
    display:flex;flex-direction:column;
    overflow:hidden;
    box-shadow:0 32px 80px rgba(0,0,0,.7);
    animation:abSlideUp .18s cubic-bezier(.16,1,.3,1);
  }
  .ab20-diag-hdr {
    display:flex;align-items:center;justify-content:space-between;
    padding:12px 14px;
    border-bottom:1px solid rgba(255,255,255,.06);
    flex-shrink:0;
  }
  .ab20-diag-copy {
    height:28px;padding:0 12px;
    background:rgba(251,191,36,.1);
    border:1px solid rgba(251,191,36,.2);
    border-radius:7px;color:#fbbf24;cursor:pointer;
    font-size:11px;font-weight:600;font-family:'DM Mono',monospace;
    transition:all .12s;
  }
  .ab20-diag-copy:hover { background:rgba(251,191,36,.2); }
  .ab20-diag-txt {
    flex:1;resize:none;
    background:rgba(0,0,0,.35);
    border:none;outline:none;
    color:#94a3b8;
    font-family:'DM Mono',monospace;font-size:10.5px;line-height:1.6;
    padding:14px;
    overflow-y:auto;
    white-space:pre;
    min-height:300px;
  }
  .ab20-diag-hint {
    padding:8px 14px;
    font-size:10px;color:var(--text-muted,#64748b);
    font-family:'DM Sans',sans-serif;
    border-top:1px solid rgba(255,255,255,.05);
    flex-shrink:0;
    text-align:center;
  }
  `;
    document.head.appendChild(s);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ТОЧКИ ВХОДА
  // ════════════════════════════════════════════════════════════════════════════

  function _makeToolbarBtn(id) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.className = 'ab20-tb-btn';
    btn.innerHTML = `<span class="ab20-sp"></span><span class="ab20-ic">⚡</span><span>Авторазбор</span>`;
    btn.title = 'Авторазбор — DS×2 + GM×2';
    btn.onclick = () => {
      if (RUN.active) { buildPanel().classList.add('vis'); return; }
      showDialog(null, true);
    };
    return btn;
  }

  function injectTreeBtn() {
    // Button removed from tree header — accessed via topbar btn-auto-breakdown
  }

  function injectGraphBtn() {
    const tb = document.getElementById('graph-toolbar');
    if (!tb || document.getElementById('ab20-btn-graph')) return;
    injectCSS();
    const btn = _makeToolbarBtn('ab20-btn-graph');
    const settingsBtn = tb.querySelector('#g-settings-btn');
    if (settingsBtn) tb.insertBefore(btn, settingsBtn);
    else tb.appendChild(btn);
  }

  function watchContextMenus() {
    new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.id === 'graph-node-ctx-menu') {
            _appendToMenu(node, () => {
              const selId = window.graphModule?.gState?.selected || AppState.get('selectedNodeId');
              showDialog(selId || undefined);
            });
          }
          if (node.classList?.contains('ctx-menu')) {
            _appendToMenu(node, () => { showDialog(AppState.get('selectedNodeId') || undefined); });
          }
        }
      }
    }).observe(document.body, { childList: true });
  }

  function _appendToMenu(menu, onClick) {
    const sep = document.createElement('div');
    sep.className = menu.id === 'graph-node-ctx-menu' ? 'g-ctx-sep' : 'ctx-menu-sep';
    const item = document.createElement('button');
    item.className = menu.id === 'graph-node-ctx-menu' ? 'g-ctx-item' : 'ctx-menu-item';
    item.innerHTML = `<span>⚡</span> Авторазбор этого узла`;
    item.onmouseenter = () => { item.style.background = 'var(--a-dim, rgba(110,142,251,.1))'; };
    item.onmouseleave = () => { item.style.background = ''; };
    item.onclick = () => { menu.remove(); onClick(); };
    menu.appendChild(sep);
    menu.appendChild(item);
  }

  function watchTreeHeader() {
    injectTreeBtn();
    AppState.on('currentTopicId', () => setTimeout(injectTreeBtn, 100));
    const treeContainer = document.getElementById('tree-container');
    if (treeContainer) {
      new MutationObserver(() => {
        if (!document.getElementById('ab20-btn-tree')) injectTreeBtn();
      }).observe(treeContainer, { childList: true, subtree: false });
    }
  }

  function init() {
    injectCSS();
    watchContextMenus();
    watchTreeHeader();

    const iv = setInterval(() => {
      if (document.getElementById('graph-toolbar')) { clearInterval(iv); injectGraphBtn(); }
    }, 400);
    setTimeout(() => clearInterval(iv), 30_000);

    new MutationObserver(() => {
      if (document.getElementById('graph-toolbar') && !document.getElementById('ab20-btn-graph'))
        injectGraphBtn();
    }).observe(document.body, { childList: true, subtree: true });

    const s = window.Settings?.get;
    if (s) {
      CFG.MAX_CHILDREN = s('decomp_width') || 5;
      // v33: минимум 300с — иначе d2/d3 узлы тайм-аутят пока ждут воркера в очереди
      CFG.NODE_TIMEOUT = Math.max((s('decomp_timeout') || 300) * 1000, 300_000);
      CFG.MAX_RETRIES = (s('decomp_retries') || 1) + 2;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 400));
  else setTimeout(init, 400);

  // ════════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════════════════════

  window.autoBreakdown = {
    RUN, WM, CFG, Tree,
    showDialog,
    stop: () => { RUN.cancelled = true; _apiSem.abortAll(); },
    pause: () => { RUN.paused = !RUN.paused; },
    mdToHtml, parseQs,

    setDebug: (v) => { CFG.DEBUG = !!v; dbg('DEBUG =', CFG.DEBUG); },

    async testAny(text = 'Столица Франции?') {
      await initPool();
      const r = await askAny(text, m => dbg('[test]', m), null);
      dbg('[test result]', r.slice(0, 300)); return r;
    },

    async testDecompose(topic = 'Нейронные сети') {
      await initPool();
      const raw = await askAny(pDecompose(topic, 0, []), m => dbg('[decompose]', m), null);
      const qs = parseQs(raw);
      dbg('[raw]', raw.slice(0, 400)); dbg('[parsed]', qs);
      return { raw: raw.slice(0, 400), parsed: qs };
    },

    async debugDeepSeek() {
      const old = CFG.DEBUG; CFG.DEBUG = true;
      await initPool();
      const e = WM.dsPool.find(x => !x.busy && x.ready);
      if (!e) { dbg('нет свободного DS-воркера'); CFG.DEBUG = old; return; }
      try { await navDeepSeek(e.wv); } catch (err) { dbg('navDeepSeek:', err.message); }
      CFG.DEBUG = old;
    },

    workerStatus() {
      return {
        ds: WM.dsPool.map(e => `DS#${e.id} ${e.dead ? 'DEAD' : e.busy ? 'BUSY' : e.ready ? 'IDLE' : 'INIT'}`),
        gm: WM.gmPool.map(e => `GM#${e.id} ${e.dead ? 'DEAD' : e.busy ? 'BUSY' : e.ready ? 'IDLE' : 'INIT'}`),
      };
    },

    // v22 — ручной вызов диалога авторизации для тестирования
    showAuthDialog,

    // v23 — диагностика: собирает DOM-снимок всех воркеров + лог
    runDiagnostics,
  };

  dbg('v35 загружен. Научные промпты + anti-дублирование через siblings.');
})();