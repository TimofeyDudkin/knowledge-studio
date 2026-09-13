/**
 * browser.js — встроенный браузер с вкладками.
 *
 * Этап 3: реальный inject вопроса в поле ввода ИИ.
 *
 * Стратегия inject по сайту:
 *   claude.ai   → contenteditable div[data-testid="composer-content"]
 *   chatgpt.com → textarea или contenteditable div#prompt-textarea
 *   gemini      → textarea[placeholder] в rich-text editor
 *   fallback    → ищем любой крупный textarea / contenteditable
 *
 * Inject делаем через webview.executeJavaScript() — вставляем текст,
 * диспатчим нативные события (input, change) чтобы React/Vue подхватили,
 * опционально — нажимаем Submit.
 */

window.BrowserModule = (() => {
  const TABS = [
    { id: 'claude',  label: 'Claude',  favicon: '🤖', url: 'https://claude.ai',         inject: injectClaude  },
    { id: 'chatgpt', label: 'ChatGPT', favicon: '💬', url: 'https://chatgpt.com',        inject: injectChatGPT },
    { id: 'gemini',  label: 'Gemini',  favicon: '♊', url: 'https://gemini.google.com',  inject: injectGemini  },
  ];

  let _customTabs  = [];
  let _activeTabId = 'claude';
  let _webview     = null;
  let _injecting   = false; // дебаунс

  const $panel     = document.getElementById('browser-panel');
  const $container = document.getElementById('browser-webview-container');
  const $urlInput  = document.getElementById('browser-url');
  const $tabsBar   = document.getElementById('browser-tabs');
  const $sendBtn   = document.getElementById('btn-send-question');

  // ─── Open / Close ────────────────────────────────────────

  function toggle() {
    $panel.classList.contains('collapsed') ? open() : close();
  }

  function open() {
    // Применяем сохранённую ширину ДО снятия .collapsed
    const savedW = AppState.get('layout')?.browserWidth;
    if (savedW && savedW >= 100) $panel.style.width = savedW + 'px';
    $panel.classList.remove('collapsed');
    AppState.set('browser', { ...AppState.get('browser'), open: true });
    if (!_webview) initWebview();
    document.getElementById('btn-toggle-browser').classList.add('active');
  }

  function close() {
    $panel.classList.add('collapsed');
    $panel.style.width = '';   // сбрасываем inline — CSS .collapsed даёт width:0
    AppState.set('browser', { ...AppState.get('browser'), open: false });
    document.getElementById('btn-toggle-browser').classList.remove('active');
  }

  // Публичный хелпер для index.js: инициализировать webview без открытия
  function _ensureWebview() {
    if (!_webview) initWebview();
  }

  // ─── Webview init ────────────────────────────────────────

  function initWebview() {
    $container.innerHTML = '';
    _webview = document.createElement('webview');
    _webview.setAttribute('allowpopups', 'true');
    _webview.setAttribute('partition', 'persist:ks-browser');
    _webview.src = getActiveUrl();
    _webview.style.cssText = 'width:100%;height:100%;border:none;display:flex;';
    $container.appendChild(_webview);

    _webview.addEventListener('did-navigate',     onNavigate);
    _webview.addEventListener('did-navigate-in-page', onNavigate);
    _webview.addEventListener('load-commit',      onLoadCommit);
    _webview.addEventListener('did-start-loading',  () => setLoading(true));
    _webview.addEventListener('did-stop-loading',   () => setLoading(false));
  }

  function onNavigate(e) {
    const url = e.url || _webview?.getURL?.() || '';
    if (url) $urlInput.value = url;
  }

  function onLoadCommit(e) {
    if (!e.isMainFrame) return;
    $urlInput.value = e.url || '';
  }

  function setLoading(on) {
    $sendBtn?.classList.toggle('loading', on);
  }

  // ─── Navigation ──────────────────────────────────────────

  function navigate(url) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (_webview) _webview.src = url;
    $urlInput.value = url;
  }

  // ─── Tabs ────────────────────────────────────────────────

  function getAllTabs() { return [...TABS, ..._customTabs]; }

  function getActiveUrl() {
    return getAllTabs().find(t => t.id === _activeTabId)?.url || 'https://claude.ai';
  }

  function switchTab(tabId) {
    _activeTabId = tabId;
    const tab = getAllTabs().find(t => t.id === tabId);
    if (tab && _webview) navigate(tab.url);
    renderTabsBar();
    Persist.save();
  }

  function _escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function addCustomTab(url, label) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let hostname;
    try { hostname = new URL(url).hostname; }
    catch { showBrowserStatus('Некорректный URL', 'warn'); return; }
    const id = 'custom_' + Date.now();
    _customTabs.push({ id, label: label || hostname, favicon: '🌐', url, inject: injectFallback });
    renderTabsBar();
    switchTab(id);
  }

  function renderTabsBar() {
    const tabs = getAllTabs();
    $tabsBar.innerHTML = tabs.map(t => `
      <button class="browser-tab ${t.id === _activeTabId ? 'active' : ''}" data-tab-id="${_escHtml(t.id)}">
        <span class="tab-favicon">${_escHtml(t.favicon)}</span>${_escHtml(t.label)}
      </button>`).join('') +
      `<button class="browser-tab-add" id="btn-add-tab" title="Добавить вкладку">+</button>`;

    $tabsBar.querySelectorAll('.browser-tab').forEach(btn =>
      btn.addEventListener('click', () => switchTab(btn.dataset.tabId)));

    document.getElementById('btn-add-tab')?.addEventListener('click', () => {
      const url = window.prompt('URL вкладки:', 'https://');
      if (url) addCustomTab(url);
    });
  }

  // ─── SEND QUESTION ───────────────────────────────────────
  // Главная функция этапа: inject текста в активный ИИ

  async function sendQuestion(autoSubmit = false) {
    if (_injecting) return;
    // Захватываем guard СРАЗУ — иначе двойной клик до первой инициализации
    // webview (await wait(800) ниже) проходит guard дважды и вызывает
    // initWebview() параллельно, пересоздавая <webview> на середине первого вызова.
    _injecting = true;

    try {
      await _sendQuestionInner(autoSubmit);
    } finally {
      _injecting = false;
      setTimeout(() => setSendBtnState('idle'), 2000);
    }
  }

  async function _sendQuestionInner(autoSubmit) {
    const nodeId = AppState.get('selectedNodeId');
    if (!nodeId) {
      showBrowserStatus('⚠ Выбери вопрос в дереве', 'warn');
      return;
    }

    const node  = AppState.findNode(nodeId);
    const topic = AppState.getCurrentTopic();
    if (!node || !topic) return;

    // Строим путь от корня до текущего узла
    const path = TreeHelpers.getPath(topic.nodes, nodeId) || [];

    // Формируем контекст: как мы пришли к этому вопросу
    let contextBlock = '';
    if (path.length > 1) {
      // Есть родительские узлы — показываем цепочку
      const ancestors = path.slice(0, -1); // все кроме текущего
      const chain = ancestors.map((n, i) => {
        const indent = '  '.repeat(i);
        const hasAnswer = n.answer ? ' [есть ответ]' : '';
        return `${indent}${i + 1}. ${n.label}${hasAnswer}`;
      }).join('\n');

      // Добавляем ответ прямого родителя для максимального контекста
      const parent = ancestors[ancestors.length - 1];
      const parentAnswerBlock = parent?.answer
        ? `\n\nОтвет на родительский вопрос «${parent.label}»:\n${parent.answer.slice(0, 800)}${parent.answer.length > 800 ? '\n...' : ''}`
        : '';

      contextBlock = `=== КОНТЕКСТ ===
Тема: ${topic.name}

Цепочка вопросов (как мы пришли к текущему):
${chain}
  → ${path.length}. ${node.label} ← ТЕКУЩИЙ ВОПРОС${parentAnswerBlock}

=== ВОПРОС ===
`;
    } else {
      // Корневой вопрос — только тема
      contextBlock = `=== ТЕМА: ${topic.name} ===\n\n`;
    }

    const questionText = contextBlock + node.label;

    // Собрать итоговый текст: системный промпт + вопрос с контекстом
    const text = topic.prompt
      ? `${topic.prompt}\n\n---\n\n${questionText}`
      : questionText;

    // Убедиться что браузер открыт
    if ($panel.classList.contains('collapsed')) open();

    // Дождаться webview
    if (!_webview) { initWebview(); await wait(800); }

    const tab = getAllTabs().find(t => t.id === _activeTabId);
    const injectFn = tab?.inject || injectFallback;

    setSendBtnState('sending');

    try {
      const ok = await injectFn(text, autoSubmit);
      if (ok) {
        setSendBtnState('done');
        showBrowserStatus('✓ Вопрос отправлен', 'ok');
        // Отметить узел как "изучается"
        if (node.status === 'open') {
          TreeHelpers.updateNode(topic.nodes, nodeId, { status: 'active' });
          Persist.save();
          Render.renderTree();
        }
      } else {
        setSendBtnState('error');
        showBrowserStatus('Не удалось найти поле ввода', 'warn');
      }
    } catch (err) {
      console.warn('[browser] inject error:', err);
      setSendBtnState('error');
      showBrowserStatus('Ошибка: ' + err.message, 'warn');
    }
  }

  function setSendBtnState(state) {
    if (!$sendBtn) return;
    $sendBtn.dataset.state = state;
    const labels = { idle: 'Отправить вопрос', sending: 'Отправка…', done: '✓ Отправлено', error: '✗ Ошибка' };
    $sendBtn.querySelector('.send-label').textContent = labels[state] || 'Отправить вопрос';
  }

  function showBrowserStatus(msg, type = 'ok') {
    let el = document.getElementById('browser-status-bar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'browser-status-bar';
      $container.parentElement.insertBefore(el, $container);
    }
    el.textContent = msg;
    el.className = 'browser-status ' + type;
    el.style.display = 'block';
    clearTimeout(BrowserModule._statusTimer);
    BrowserModule._statusTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  // ─── INJECT STRATEGIES ───────────────────────────────────
  // Каждая функция возвращает Promise<boolean> (успех/нет)

  // Универсальный JS-код для вставки текста в элемент
  // (работает с React/Vue controlled inputs)
  function buildInjectScript(selector, text, autoSubmit, submitSelector) {
    // Экранируем текст для безопасной вставки в JS-строку
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$');

    return `
(async () => {
  const text = \`${escaped}\`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Попытка найти элемент
  let el = null;
  const selectors = ${JSON.stringify(selector)};
  for (let attempt = 0; attempt < 15; attempt++) {
    for (const sel of selectors) {
      try { el = document.querySelector(sel); } catch {}
      if (el) break;
    }
    if (el) break;
    await sleep(300);
  }
  if (!el) return false;

  // Фокус
  el.focus();
  await sleep(80);

  // Очистить текущее содержимое
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    // Нативный setter для React
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // contenteditable
    el.textContent = '';
    // Вставить через execCommand (работает в Electron WebView)
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    await sleep(100);
    // Fallback если paste не сработал
    if (!el.textContent.trim()) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  await sleep(120);

  // Auto-submit
  ${autoSubmit ? `
  const submitSels = ${JSON.stringify(submitSelector || [])};
  let submitBtn = null;
  for (const sel of submitSels) {
    try { submitBtn = document.querySelector(sel); } catch {}
    if (submitBtn && !submitBtn.disabled) break;
  }
  if (submitBtn && !submitBtn.disabled) {
    await sleep(200);
    submitBtn.click();
  } else {
    // Fallback: Shift+Enter или Enter
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  ` : ''}

  return true;
})()`;
  }

  async function execInWebview(script) {
    if (!_webview?.executeJavaScript) return false;
    try {
      return await _webview.executeJavaScript(script);
    } catch (e) {
      console.warn('[inject]', e.message);
      return false;
    }
  }

  // ── claude.ai ────────────────────────────────────────────

  async function injectClaude(text, autoSubmit) {
    const script = buildInjectScript(
      [
        'div[contenteditable="true"][data-testid="composer-content"]',
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"]',
        'textarea[placeholder]',
      ],
      text,
      autoSubmit,
      [
        'button[aria-label="Send message"]',
        'button[data-testid="send-button"]',
        'button[type="submit"]',
      ]
    );
    return execInWebview(script);
  }

  // ── chatgpt.com ──────────────────────────────────────────

  async function injectChatGPT(text, autoSubmit) {
    const script = buildInjectScript(
      [
        'div#prompt-textarea[contenteditable]',
        'textarea#prompt-textarea',
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"]',
      ],
      text,
      autoSubmit,
      [
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Отправить запрос"]',
        'button[type="submit"]',
      ]
    );
    return execInWebview(script);
  }

  // ── gemini.google.com ────────────────────────────────────

  async function injectGemini(text, autoSubmit) {
    const script = buildInjectScript(
      [
        'rich-textarea div[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"][aria-label]',
        'div[contenteditable="true"]',
      ],
      text,
      autoSubmit,
      [
        'button[aria-label="Send message"]',
        'button.send-button',
        'button[jsname]',
        'button[type="submit"]',
      ]
    );
    return execInWebview(script);
  }

  // ── Universal fallback ───────────────────────────────────

  async function injectFallback(text, autoSubmit) {
    const script = buildInjectScript(
      [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea:not([readonly]):not([disabled])',
        'input[type="text"]:not([readonly]):not([disabled])',
      ],
      text,
      autoSubmit,
      ['button[type="submit"]', 'button[aria-label*="send" i]', 'button[aria-label*="отправ" i]']
    );
    return execInWebview(script);
  }

  // ─── Utils ───────────────────────────────────────────────

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Binds ───────────────────────────────────────────────

  document.getElementById('btn-toggle-browser')?.addEventListener('click', toggle);

  // Перепишем кнопку "Отправить вопрос" с новой разметкой через DOM
  if ($sendBtn) {
    $sendBtn.innerHTML = `
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" style="width:13px;height:13px;flex-shrink:0">
        <path d="M2 7h10M8 3l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="send-label">Отправить вопрос</span>`;

    $sendBtn.addEventListener('click', e => {
      const autoSubmit = e.shiftKey; // Shift+Click → отправить без подтверждения
      sendQuestion(autoSubmit);
    });
    $sendBtn.title = 'Вставить вопрос в ИИ (Shift+клик — и сразу отправить)';
  }

  $urlInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') navigate($urlInput.value.trim());
  });

  // Инициализация табов (рендерим из JS, не из HTML)
  renderTabsBar();

  return { toggle, open, close, _ensureWebview, navigate, switchTab, addCustomTab, sendQuestion, getWebview: () => _webview };
})();