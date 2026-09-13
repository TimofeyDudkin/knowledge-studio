/**
 * settings.js — настройки Knowledge Studio v2
 *
 * Исправления:
 *  - Хранение через localStorage напрямую (нет IPC.save/load для настроек)
 *  - Нет конфликта с index.js nav-settings listener (Settings регистрируется
 *    позже и stopPropagation не нужен — index.js перезаписан ниже патчем)
 *  - Нет конфликта с .modal-overlay click-outside (Settings исп. свой ID)
 *  - Нет конфликта с Escape (проверяем что Settings открыт)
 *  - Нет прямого доступа к AppState._state (используем публичный API)
 *  - Дублирующийся #btn-theme — используем querySelectorAll по классу
 *  - Интеграция с autobreakdown CFG при открытии/изменении
 *  - Реальная статистика через AppState + TreeHelpers
 *  - _applyAll() применяет ВСЕ настройки к DOM сразу
 */

window.Settings = (() => {
  'use strict';

  const LS_KEY = 'ks_settings_v2';

  // ─── Дефолты ────────────────────────────────────────────────
  const DEFAULTS = {
    theme: 'dark',

    decomp_depth:    3,
    decomp_width:    5,
    decomp_pool:     2,
    decomp_timeout:  300,
    decomp_retries:  1,
    decomp_strategy: 'Классическая',
    decomp_autoleaf: true,
    decomp_resume:   true,
    decomp_adaptive: true,
    decomp_lang:     'Русский',
    ab_advanced:     false,
    ab_show_logs:    false,

    prompt_system:   'Ты опытный ментор. Объясняй тему «{{topic}}» системно, от простого к сложному. Используй аналогии и примеры. Не более 300 слов на вопрос. Если уместно, добавь схему в блоке ```mermaid (flowchart LR, sequenceDiagram или classDiagram). Формулы пиши в LaTeX: $формула$ или $$формула$$.',
    prompt_enabled:  true,
    prompt_parents:  true,
    prompt_history:  false,
    prompt_template: 'Ментор',

    study_order:     'По уровням',
    study_autonext:  false,
    study_session:   10,
    study_timer:     false,
    study_hints:     true,
    study_srs:       true,
    study_shownotes: true,
    study_statuses:  ['Открыт', 'В процессе', 'Разобрался'],

    tree_autoexpand: true,
    tree_staticons:  true,
    tree_counters:   true,
    tree_crossref:   true,
    tree_dnd:        true,
    tree_lines:      '2 строки',
    tree_indent:     16,
    tree_colorscheme:'По умолчанию',

    graph_repel:     200,
    graph_edgelen:   130,
    graph_edgeanim:  true,
    graph_minimap:   true,
    graph_floatwin:  true,
    graph_grid:      true,
    graph_nodetype:  'Прямоугольник',

    accent:          '#7c6af7',
    font_ui:         'DM Sans',
    ui_density:      'Стандартная',
    ui_animations:   true,

    stats_tracking:  true,
    stats_reminders: true,

    gemini_api_key:  '',
    gemini_api_mode: 'hybrid',
  };

  const PROMPT_TEMPLATES = {
    'Ментор':  'Ты опытный ментор. Объясняй тему «{{topic}}» системно, от простого к сложному. Используй аналогии и примеры. Не более 300 слов на вопрос.\n\nФОРМАТИРОВАНИЕ:\n- Формулы — в LaTeX: $инлайн$ или $$блочная$$\n- Если нужна схема процесса или структуры — добавь блок ```mermaid с flowchart LR, sequenceDiagram или classDiagram\n- Заголовки markdown для структуры ответа',
    'Сократ':  'Не давай прямых ответов. Веди студента к пониманию через наводящие вопросы. Тема: «{{topic}}». Текущий вопрос: «{{node}}».\n\nЕсли студент явно просит объяснение — можешь использовать схему ```mermaid и формулы в LaTeX ($...$).',
    'Научный': 'Отвечай строго и академично. Используй термины, ссылайся на принципы и теоремы. Тема: «{{topic}}».\n\nОБЯЗАТЕЛЬНО:\n- Математические формулы — в LaTeX: $инлайн$ или $$блочная на отдельной строке$$\n- Структурные и процессные схемы — в блоке ```mermaid (flowchart, sequenceDiagram, classDiagram)\n- Таблицы для сравнения понятий\n- Научный стиль без упрощений',
    'ELI5':    'Объясни как пятилетнему ребёнку: простые слова, аналогии из повседневной жизни. Тема: «{{topic}}».\n\nМожно добавить простую схему ```mermaid flowchart LR чтобы показать связи. Формулы если нужны — пиши максимально просто, в LaTeX: $формула$.',
    'Практик': 'Фокусируйся на практике: примеры кода, решения задач, реальные случаи использования. Тема: «{{topic}}».\n\nФОРМАТИРОВАНИЕ:\n- Алгоритмы и потоки — схемой ```mermaid flowchart или sequenceDiagram\n- Математические формулы — в LaTeX: $инлайн$ или $$блочная$$\n- Код в блоках с указанием языка\n- Конкретные числа и примеры вместо общих слов',
  };

  // ─── Состояние ───────────────────────────────────────────────
  let _cfg = {};
  let _modal = null;
  let _isOpen = false;

  // ─── Персистентность (localStorage) ─────────────────────────
  function _loadFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { ...DEFAULTS, study_statuses: [...DEFAULTS.study_statuses] };
      const saved = JSON.parse(raw);
      const result = { ...DEFAULTS, ...saved };
      if (Array.isArray(saved.study_statuses)) result.study_statuses = saved.study_statuses;
      else result.study_statuses = [...DEFAULTS.study_statuses];
      return result;
    } catch (e) {
      return { ...DEFAULTS, study_statuses: [...DEFAULTS.study_statuses] };
    }
  }

  function _saveToStorage() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(_cfg)); } catch (e) {}
  }

  function get(key) { return _cfg[key]; }
  function set(key, val) { _cfg[key] = val; _saveToStorage(); _applyAll(); }

  // ─── Применение темы ─────────────────────────────────────────
  function _applyTheme(theme) {
    const resolved = theme === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : (theme || 'dark');
    document.body.dataset.theme = resolved;
  }

  function _applyAccent(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--accent', color);
    // Вычислить hover-версию
    try {
      const n = parseInt(color.replace('#', ''), 16);
      const darken = v => Math.max(0, v - 18);
      const r = darken(n >> 16), g = darken((n >> 8) & 0xff), b = darken(n & 0xff);
      const hover = '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
      document.documentElement.style.setProperty('--accent-hover', hover);
    } catch (_) {}
  }

  // ─── Применение ВСЕХ настроек к DOM ─────────────────────────
  function _applyAll() {
    const b = document.body;
    const r = document.documentElement;

    _applyTheme(_cfg.theme);
    _applyAccent(_cfg.accent);

    // Font
    const fontMap = {
      'DM Sans':   '"DM Sans", sans-serif',
      'Inter':     '"Inter", sans-serif',
      'System UI': 'system-ui, -apple-system, sans-serif'
    };
    const font = fontMap[_cfg.font_ui] || fontMap['DM Sans'];
    r.style.setProperty('--font-ui', font);
    b.style.fontFamily = font;

    // Density
    b.classList.remove('ks-compact', 'ks-spacious');
    if (_cfg.ui_density === 'Компактная') b.classList.add('ks-compact');
    if (_cfg.ui_density === 'Просторная') b.classList.add('ks-spacious');

    // Animations
    b.classList.toggle('ks-no-anim', !_cfg.ui_animations);

    // Tree indent
    r.style.setProperty('--ks-indent', (_cfg.tree_indent || 16) + 'px');

    // Tree line-clamp
    const clampMap = { '1 строка': '1', '2 строки': '2', '3 строки': '3' };
    r.style.setProperty('--ks-clamp', clampMap[_cfg.tree_lines] || '2');

    // Tree status icons
    b.classList.toggle('ks-hide-staticons', !_cfg.tree_staticons);

    // Tree counters
    b.classList.toggle('ks-hide-counters', !_cfg.tree_counters);

    // Tree crossref
    b.classList.toggle('ks-no-crossref', !_cfg.tree_crossref);

    // Tree DnD flag
    window.KS_DND_ENABLED = (_cfg.tree_dnd !== false);

    // Tree autoexpand flag
    window.KS_AUTOEXPAND = (_cfg.tree_autoexpand !== false);

    // Graph edge animation
    b.classList.toggle('ks-no-edge-anim', !_cfg.graph_edgeanim);

    // Graph minimap
    const mm = document.getElementById('graph-minimap');
    if (mm) mm.style.display = _cfg.graph_minimap !== false ? '' : 'none';

    // Graph grid
    b.classList.toggle('ks-no-graph-grid', !_cfg.graph_grid);

    // Autobreakdown sync
    _syncAutobreakdown();

    // Expose global KS settings object for other modules
    window.KS = { ..._cfg };

    // Notify modules
    document.dispatchEvent(new CustomEvent('ks:settings', { detail: { ..._cfg }, bubbles: false }));
  }

  function toggleTheme() {
    const cur = document.body.dataset.theme || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    _cfg.theme = next;
    _saveToStorage();
    _applyAll();
    // Обновить тему-карточки в модале если открыт
    _modal?.querySelectorAll('.stt-theme-card').forEach(c => {
      c.classList.toggle('stt-on', c.dataset.themeVal === next);
    });
  }

  // ─── Синхронизация с autobreakdown CFG ───────────────────────
  function _syncAutobreakdown() {
    const ab = window.autoBreakdown;
    if (!ab?.CFG) return;
    // parseInt обязателен: select хранит значения как строки,
    // без него "3" + 2 = "32" (конкатенация) вместо 5
    ab.CFG.MAX_CHILDREN  = parseInt(_cfg.decomp_width,   10) || 5;
    // decomp_pool убран в v20: пул фиксирован (DS×2 + GM×2 = 4 воркера)
    ab.CFG.NODE_TIMEOUT  = Math.max((parseInt(_cfg.decomp_timeout, 10) || 300) * 1000, 300_000);
    ab.CFG.MAX_RETRIES   = (parseInt(_cfg.decomp_retries, 10) || 1) + 2;
  }

  // ─── CSS ─────────────────────────────────────────────────────
  function _injectCSS() {}

  // ─── HTML модального окна ─────────────────────────────────────
  function _buildModal() {
    _injectCSS();

    const SHORTCUTS = [
      ['Авторазбор темы', '⌘R'],
      ['Открыть граф',    '⌘G'],
      ['Новая тема',      '⌘N'],
      ['Поиск',           '⌘F'],
      ['Браузер',         '⌘B'],
      ['Экспорт',         '⌘E'],
      ['Настройки',       '⌘,'],
      ['Закрыть',         'Esc'],
    ];

    const el = document.createElement('div');
    el.id = 'modal-settings';
    el.className = 'modal-overlay hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Настройки');
    el.innerHTML = `
<div class="stt-modal">
  <div class="stt-inner">

    <!-- NAV -->
    <div class="stt-sidebar">
      <div class="stt-logo">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" width="13" height="13" aria-hidden="true">
          <circle cx="8" cy="8" r="2.5"/>
          <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7" stroke-linecap="round"/>
        </svg>
        Настройки
      </div>

      <div class="stt-nav-group">Обучение</div>
      <button class="stt-nav-item active" data-sec="decomp">Авторазбор</button>
      <button class="stt-nav-item" data-sec="prompt">Промпты</button>
      <button class="stt-nav-item" data-sec="study">Изучение</button>

      <div class="stt-nav-group">Интерфейс</div>
      <button class="stt-nav-item" data-sec="tree">Дерево</button>
      <button class="stt-nav-item" data-sec="graph">Граф</button>
      <button class="stt-nav-item" data-sec="appear">Внешний вид</button>

      <div class="stt-nav-group">Прочее</div>
      <button class="stt-nav-item" data-sec="stats">Статистика</button>
      <button class="stt-nav-item" data-sec="apikeys">API ключи</button>
      <button class="stt-nav-item" data-sec="shortcuts">Клавиши</button>

      <div class="stt-version">Knowledge Studio</div>
    </div>

    <!-- CONTENT -->
    <div class="stt-content" id="stt-content-area">

      <!-- АВТОРАЗБОР -->
      <div class="stt-sec active" id="stt-sec-decomp">
        <div class="stt-sec-head">
          <div class="stt-sec-title">Авторазбор</div>
        </div>
        <div class="stt-group">
          <div class="stt-row">
            <span class="stt-lbl" title="Количество уровней вложенности подвопросов. 3 = три уровня от корня до листа.">Глубина</span>
            <div class="stt-slider-wrap">
              <input type="range" min="1" max="6" step="1" class="stt-slider" data-key="decomp_depth" id="sl-depth">
              <span class="stt-sval" id="sv-depth">3</span>
            </div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Максимум подвопросов у каждого узла. Больше = шире охват, но дольше генерация.">Ширина (детей на узел)</span>
            <div class="stt-slider-wrap">
              <input type="range" min="2" max="10" step="1" class="stt-slider" data-key="decomp_width" id="sl-width">
              <span class="stt-sval" id="sv-width">5</span>
            </div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Параллельные воркеры фиксированы: DS×2 + GM×2 = 4 воркера">Воркеры</span>
            <div style="display:flex;gap:4px;flex-shrink:0;">
              <span style="font-size:9px;font-family:'DM Mono',monospace;padding:2px 7px;border-radius:10px;background:rgba(94,234,212,.1);border:1px solid rgba(94,234,212,.25);color:#5eead4;">DS×2</span>
              <span style="font-size:9px;font-family:'DM Mono',monospace;padding:2px 7px;border-radius:10px;background:rgba(66,133,244,.1);border:1px solid rgba(66,133,244,.25);color:#4285f4;">GM×2</span>
            </div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="После этого времени узел помечается как ошибка и переходит к следующему.">Таймаут узла</span>
            <div class="stt-slider-wrap">
              <input type="range" min="60" max="600" step="30" class="stt-slider" data-key="decomp_timeout" id="sl-timeout">
              <span class="stt-sval" id="sv-timeout">300с</span>
            </div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Сколько раз повторить запрос при сбое сети или лимите API.">Повторы при ошибке</span>
            <select class="stt-select" data-key="decomp_retries">
              <option value="0">0 — не повторять</option>
              <option value="1">1 попытка</option>
              <option value="2">2 попытки</option>
              <option value="3">3 попытки</option>
            </select>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Как AI дробит тему на подвопросы. Классическая — от общего к частному.">Стратегия декомпозиции</span>
            <select class="stt-select" data-key="decomp_strategy">
              <option>Классическая</option>
              <option>Сократовская</option>
              <option>Проблемная</option>
              <option>Концептуальная</option>
              <option>Практическая</option>
            </select>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="На каком языке AI формулирует вопросы и ответы.">Язык</span>
            <select class="stt-select" data-key="decomp_lang">
              <option>Русский</option>
              <option>Как вопрос</option>
              <option>English</option>
              <option>Deutsch</option>
            </select>
          </div>
        </div>
        <div class="stt-group">
          <div class="stt-row">
            <span class="stt-lbl" title="AI сам выбирает глубину разбивки исходя из сложности темы.">Адаптивная глубина</span>
            <div class="stt-toggle" data-key="decomp_adaptive"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Сразу запрашивать ответ на конечные узлы — ускоряет генерацию.">Авто-ответ для листьев</span>
            <div class="stt-toggle" data-key="decomp_autoleaf"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Продолжать с последнего готового узла при сбое — экономит лимиты API.">Возобновление при сбое</span>
            <div class="stt-toggle" data-key="decomp_resume"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Разблокирует раздел «Продвинутые настройки» при запуске авторазбора.">Продвинутые настройки</span>
            <div class="stt-toggle" data-key="ab_advanced"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Отображать детальный лог операций в панели мониторинга.">Показывать логи</span>
            <div class="stt-toggle" data-key="ab_show_logs"></div>
          </div>
        </div>
      </div>

      <!-- ПРОМПТЫ -->
      <div class="stt-sec" id="stt-sec-prompt">
        <div class="stt-sec-head">
          <div class="stt-sec-title">Промпты</div>
        </div>
        <div class="stt-group">
          <div class="stt-row stt-row-col">
            <span class="stt-lbl">Системный промпт</span>
            <div class="stt-hint">Переменные: <code class="stt-code">{{topic}}</code> <code class="stt-code">{{node}}</code> <code class="stt-code">{{depth}}</code></div>
            <textarea class="stt-textarea" id="ta-prompt-sys" rows="5" placeholder="Ты опытный ментор..."></textarea>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Если выключено — запросы идут без дополнительных инструкций.">Включить</span>
            <div class="stt-toggle" data-key="prompt_enabled"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="AI видит путь от корня до текущего вопроса — помогает давать связные ответы.">Контекст родителей</span>
            <div class="stt-toggle" data-key="prompt_parents"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="AI учитывает уже изученные смежные узлы — избегает повторений.">Предыдущие ответы</span>
            <div class="stt-toggle" data-key="prompt_history"></div>
          </div>
        </div>
        <div class="stt-group">
          <div class="stt-row stt-row-col">
            <span class="stt-lbl">Шаблоны</span>
            <div class="stt-chips" id="prompt-chips">
              <div class="stt-chip" data-tpl="Ментор">Ментор</div>
              <div class="stt-chip" data-tpl="Сократ">Сократ</div>
              <div class="stt-chip" data-tpl="Научный">Научный</div>
              <div class="stt-chip" data-tpl="ELI5">ELI5</div>
              <div class="stt-chip" data-tpl="Практик">Практик</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ИЗУЧЕНИЕ -->
      <div class="stt-sec" id="stt-sec-study">
        <div class="stt-sec-head">
          <div class="stt-sec-title">Изучение</div>
        </div>
        <div class="stt-group">
          <div class="stt-row">
            <span class="stt-lbl" title="В каком порядке предлагать следующий вопрос при авторежиме.">Порядок обхода</span>
            <select class="stt-select" data-key="study_order">
              <option>По уровням</option>
              <option>В глубину</option>
              <option>Случайный</option>
              <option>По сложности</option>
              <option>По дате создания</option>
            </select>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="После отметки статуса автоматически переходить к следующему вопросу.">Автопереход</span>
            <div class="stt-toggle" data-key="study_autonext"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Максимум вопросов за одну сессию, затем пауза.">Длина сессии</span>
            <div class="stt-slider-wrap">
              <input type="range" min="3" max="50" step="1" class="stt-slider" data-key="study_session" id="sl-sess">
              <span class="stt-sval" id="sv-sess">10</span>
            </div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Показывать обратный отсчёт для каждого вопроса.">Таймер</span>
            <div class="stt-toggle" data-key="study_timer"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Кнопка «Намекни» перед раскрытием ответа.">Подсказки</span>
            <div class="stt-toggle" data-key="study_hints"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Напоминать о пройденных узлах по алгоритму SM-2.">Интервальное повторение (SRS)</span>
            <div class="stt-toggle" data-key="study_srs"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Показывать ответ сразу или скрывать до нажатия «Готов».">Ответ виден сразу</span>
            <div class="stt-toggle" data-key="study_shownotes"></div>
          </div>
        </div>
        <div class="stt-group">
          <div class="stt-row stt-row-col">
            <span class="stt-lbl">Статусы узлов</span>
            <div class="stt-chips" id="status-chips">
              <div class="stt-chip stt-chip-multi" data-val="Открыт">Открыт</div>
              <div class="stt-chip stt-chip-multi" data-val="В процессе">В процессе</div>
              <div class="stt-chip stt-chip-multi" data-val="Разобрался">Разобрался</div>
              <div class="stt-chip stt-chip-multi" data-val="Пропустить">Пропустить</div>
              <div class="stt-chip stt-chip-multi" data-val="Сложно">Сложно</div>
              <div class="stt-chip stt-chip-multi" data-val="Повторить">Повторить</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ДЕРЕВО -->
      <div class="stt-sec" id="stt-sec-tree">
        <div class="stt-sec-head">
          <div class="stt-sec-title">Дерево вопросов</div>
        </div>
        <div class="stt-group">
          <div class="stt-row">
            <span class="stt-lbl" title="Автоматически раскрывать дочерние узлы при клике.">Раскрывать при выборе</span>
            <div class="stt-toggle" data-key="tree_autoexpand"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Показывать иконку статуса (✓, ⟳, !) на каждом узле.">Иконки статуса</span>
            <div class="stt-toggle" data-key="tree_staticons"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Показывать «3/7» — выполнено из всех дочерних узлов.">Счётчики прогресса</span>
            <div class="stt-toggle" data-key="tree_counters"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Подсвечивать термины из других узлов в тексте ответов.">Перекрёстные ссылки</span>
            <div class="stt-toggle" data-key="tree_crossref"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Перетаскивать узлы для реорганизации дерева.">Drag &amp; Drop</span>
            <div class="stt-toggle" data-key="tree_dnd"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Сколько строк текста узла показывать до обрезки.">Строк в превью</span>
            <select class="stt-select" data-key="tree_lines">
              <option>1 строка</option>
              <option>2 строки</option>
              <option>3 строки</option>
            </select>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Смещение дочерних узлов относительно родителя в пикселях.">Отступ уровней</span>
            <div class="stt-slider-wrap">
              <input type="range" min="8" max="32" step="2" class="stt-slider" data-key="tree_indent" id="sl-indent">
              <span class="stt-sval" id="sv-indent">16px</span>
            </div>
          </div>
        </div>
        <div class="stt-group">
          <div class="stt-row stt-row-col">
            <span class="stt-lbl">Цветовая схема</span>
            <div class="stt-preset-grid">
              <div class="stt-preset" data-pkey="tree_colorscheme" data-pval="По умолчанию">
                <div class="stt-preset-preview" style="background:linear-gradient(90deg,#7c6af730,#4ade8030,#f5a62330);border:1px solid var(--border-subtle)"></div>
                <div class="stt-preset-label">По умолчанию</div>
              </div>
              <div class="stt-preset" data-pkey="tree_colorscheme" data-pval="Синяя гамма">
                <div class="stt-preset-preview" style="background:linear-gradient(90deg,#3b82f630,#22c55e30,#f5962230);border:1px solid var(--border-subtle)"></div>
                <div class="stt-preset-label">Синяя гамма</div>
              </div>
              <div class="stt-preset" data-pkey="tree_colorscheme" data-pval="Монохром">
                <div class="stt-preset-preview" style="background:var(--bg-active);border:1px solid var(--border-default)"></div>
                <div class="stt-preset-label">Монохром</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ГРАФ -->
      <div class="stt-sec" id="stt-sec-graph">
        <div class="stt-sec-head">
          <div class="stt-sec-title">Граф знаний</div>
        </div>
        <div class="stt-group">
          <div class="stt-row">
            <span class="stt-lbl" title="Как сильно узлы расталкивают друг друга.">Отталкивание</span>
            <div class="stt-slider-wrap">
              <input type="range" min="50" max="500" step="10" class="stt-slider" data-key="graph_repel" id="sl-repel">
              <span class="stt-sval" id="sv-repel">200</span>
            </div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Целевое расстояние между связанными узлами.">Длина рёбер</span>
            <div class="stt-slider-wrap">
              <input type="range" min="60" max="300" step="5" class="stt-slider" data-key="graph_edgelen" id="sl-edge">
              <span class="stt-sval" id="sv-edge">130</span>
            </div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Анимированные пунктиры вдоль рёбер. Отключи для экономии ресурсов.">Анимация рёбер</span>
            <div class="stt-toggle" data-key="graph_edgeanim"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Обзорная карта в углу для навигации по большим деревьям.">Мини-карта</span>
            <div class="stt-toggle" data-key="graph_minimap"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Открывать ответ поверх графа при клике на узел.">Плавающее окно</span>
            <div class="stt-toggle" data-key="graph_floatwin"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Отображать сетку на фоне графа.">Сетка</span>
            <div class="stt-toggle" data-key="graph_grid"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Геометрическая форма узлов на графе.">Форма узлов</span>
            <select class="stt-select" data-key="graph_nodetype">
              <option>Прямоугольник</option>
              <option>Закруглённый</option>
              <option>Эллипс</option>
            </select>
          </div>
        </div>
      </div>

      <!-- ВНЕШНИЙ ВИД -->
      <div class="stt-sec" id="stt-sec-appear">
        <div class="stt-sec-head">
          <div class="stt-sec-title">Внешний вид</div>
        </div>
        <div class="stt-group">
          <div class="stt-row stt-row-col">
            <span class="stt-lbl">Тема</span>
            <div class="stt-theme-grid">
              <div class="stt-theme-card" data-theme-val="dark">
                <div class="stt-theme-preview" style="background:#0d0d0f">
                  <div style="width:40%;height:100%;background:#111114;border-right:1px solid #2a2a36"></div>
                </div>
                <div class="stt-theme-label">Тёмная</div>
              </div>
              <div class="stt-theme-card" data-theme-val="light">
                <div class="stt-theme-preview" style="background:#f9f9fb">
                  <div style="width:40%;height:100%;background:#f2f2f5;border-right:1px solid #d8d8e5"></div>
                </div>
                <div class="stt-theme-label">Светлая</div>
              </div>
              <div class="stt-theme-card" data-theme-val="auto">
                <div class="stt-theme-preview" style="background:linear-gradient(135deg,#0d0d0f 50%,#f9f9fb 50%)"></div>
                <div class="stt-theme-label">Авто (ОС)</div>
              </div>
            </div>
          </div>
          <div class="stt-row stt-row-col">
            <span class="stt-lbl">Акцентный цвет</span>
            <div class="stt-accent-row">
              <div class="stt-swatch" data-accent="#7c6af7" style="background:#7c6af7" title="Индиго"></div>
              <div class="stt-swatch" data-accent="#3b82f6" style="background:#3b82f6" title="Синий"></div>
              <div class="stt-swatch" data-accent="#10b981" style="background:#10b981" title="Зелёный"></div>
              <div class="stt-swatch" data-accent="#f59e0b" style="background:#f59e0b" title="Янтарный"></div>
              <div class="stt-swatch" data-accent="#ef4444" style="background:#ef4444" title="Красный"></div>
              <div class="stt-swatch" data-accent="#ec4899" style="background:#ec4899" title="Розовый"></div>
              <div class="stt-swatch" data-accent="#6b7280" style="background:#6b7280" title="Серый"></div>
              <div class="stt-swatch" data-accent="#f97316" style="background:#f97316" title="Оранжевый"></div>
              <div class="stt-swatch" data-accent="#06b6d4" style="background:#06b6d4" title="Голубой"></div>
              <input type="color" class="stt-color-custom" id="stt-accent-custom" value="${DEFAULTS.accent}" title="Свой цвет">
            </div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Шрифт для всех текстовых элементов UI.">Шрифт</span>
            <select class="stt-select" data-key="font_ui">
              <option>DM Sans</option>
              <option>Inter</option>
              <option>System UI</option>
            </select>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Компактная — больше контента; Просторная — крупнее отступы.">Плотность</span>
            <select class="stt-select" data-key="ui_density">
              <option>Компактная</option>
              <option>Стандартная</option>
              <option>Просторная</option>
            </select>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Плавные переходы. Отключи для повышения отзывчивости на слабых машинах.">Анимации</span>
            <div class="stt-toggle" data-key="ui_animations"></div>
          </div>
        </div>
      </div>

      <!-- СТАТИСТИКА -->
      <div class="stt-sec" id="stt-sec-stats">
        <div class="stt-sec-head">
          <div class="stt-sec-title">Статистика</div>
        </div>
        <div class="stt-stats-grid">
          <div class="stt-stat-card">
            <div class="stt-stat-n" id="stt-stat-done">—</div>
            <div class="stt-stat-l">изучено</div>
          </div>
          <div class="stt-stat-card">
            <div class="stt-stat-n" id="stt-stat-total">—</div>
            <div class="stt-stat-l">всего</div>
          </div>
          <div class="stt-stat-card">
            <div class="stt-stat-n" id="stt-stat-topics">—</div>
            <div class="stt-stat-l">тем</div>
          </div>
        </div>
        <div class="stt-group">
          <div class="stt-row stt-row-col" style="gap:7px">
            <span class="stt-lbl">Общий прогресс</span>
            <div class="stt-progress-wrap">
              <div class="stt-progress-bar" id="stt-progress-bar" style="width:0%"></div>
            </div>
            <div class="stt-progress-label" id="stt-progress-label">нет данных</div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Фиксировать время и смену статусов узлов — необходимо для точной статистики и SRS.">Трекинг прогресса</span>
            <div class="stt-toggle" data-key="stats_tracking"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Уведомление если не заходил более 2 дней.">Напоминания</span>
            <div class="stt-toggle" data-key="stats_reminders"></div>
          </div>
          <div class="stt-row">
            <span class="stt-lbl" title="Скачать прогресс всех тем в формате CSV.">Экспорт</span>
            <button class="stt-btn" id="btn-stt-export-csv">Скачать CSV</button>
          </div>
        </div>
      </div>

      <!-- API КЛЮЧИ -->
      <div class="stt-sec" id="stt-sec-apikeys">
        <div class="stt-sec-head">
          <div class="stt-sec-title">API ключи</div>
          <div class="stt-sec-desc">
            Модель: <code class="stt-code">gemini-2.5-flash</code> ·
            Каждый ключ — независимый воркер (15 RPM / 1500 RPD). ·
            <a href="#" id="gapi-get-key-link" style="color:var(--accent);text-decoration:none;">Получить ключ ↗</a>
          </div>
        </div>

        <div class="stt-group">
          <div class="stt-row stt-row-col">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
              <span class="stt-lbl">Ключи <span id="gapi-keys-count" style="font-size:10px;font-weight:400;color:var(--text-muted);">(0)</span></span>
              <div style="display:flex;gap:4px;align-items:center;">
                <span id="gapi-eff-rpm" style="font-size:9px;font-family:'DM Mono',monospace;color:#4ade80;background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.2);padding:1px 7px;border-radius:8px;"></span>
                <span id="gapi-eff-rpd" style="font-size:9px;font-family:'DM Mono',monospace;color:#60a5fa;background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.2);padding:1px 7px;border-radius:8px;"></span>
              </div>
            </div>
            <div id="gapi-key-list" style="display:flex;flex-direction:column;gap:6px;width:100%;margin-bottom:2px;"></div>
            <div style="display:flex;gap:6px;align-items:center;width:100%">
              <input type="password" id="gapi-new-key-input" placeholder="AIzaSy… (новый ключ)"
                style="flex:1;height:32px;padding:0 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:var(--text-primary);font-family:'DM Mono',monospace;font-size:11px;outline:none;"/>
              <input type="text" id="gapi-new-key-label" placeholder="Название (необяз.)"
                style="width:120px;height:32px;padding:0 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:var(--text-primary);font-size:11px;outline:none;"/>
              <button class="stt-btn" id="gapi-add-btn" style="height:32px;padding:0 14px;flex-shrink:0;">+ Добавить</button>
            </div>
            <div id="gapi-add-result" style="display:none;font-size:11px;font-family:'DM Mono',monospace;padding:5px 10px;border-radius:7px;width:100%;"></div>
          </div>
        </div>

        <div class="stt-group">
          <div class="stt-row">
            <span class="stt-lbl" title="Гибридный — API с fallback на webview; Только API — быстро; Только webview — старый режим.">Режим авторазбора</span>
            <select class="stt-select" id="gapi-mode-select" data-key="gemini_api_mode">
              <option value="hybrid">Гибридный (API → webview)</option>
              <option value="api">Только API</option>
              <option value="webview">Только webview</option>
            </select>
          </div>
        </div>

        <div class="stt-group">
          <div class="stt-row stt-row-col">
            <span class="stt-lbl">Использование сегодня</span>
            <div style="width:100%">
              <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-muted);font-family:'DM Mono',monospace;margin-bottom:5px;">
                <span id="gapi-quota-used">0 запросов</span>
                <span id="gapi-quota-max">из 0/день</span>
              </div>
              <div style="height:5px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden;">
                <div id="gapi-quota-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#7c6af7,#4ade80);border-radius:3px;transition:width .4s;"></div>
              </div>
            </div>
            <button class="stt-btn" id="gapi-reset-counter-btn" style="font-size:11px;height:28px;padding:0 12px;background:rgba(255,255,255,.04);">
              Сбросить счётчики
            </button>
          </div>
        </div>
      </div>

      <!-- ГОРЯЧИЕ КЛАВИШИ -->
      <div class="stt-sec" id="stt-sec-shortcuts">
        <div class="stt-sec-head">
          <div class="stt-sec-title">Горячие клавиши</div>
        </div>
        <div class="stt-group">
          ${SHORTCUTS.map(([label, keys]) => `
          <div class="stt-row">
            <span class="stt-lbl">${label}</span>
            <div class="stt-keys">${keys.split('').map(ch => `<span class="stt-key">${ch}</span>`).join('')}</div>
          </div>`).join('')}
        </div>
      </div>

    </div><!-- /stt-content-area -->
  </div><!-- /stt-inner -->

  <div class="stt-footer">
    <button class="stt-btn stt-btn-ghost" id="btn-stt-reset">Сбросить всё</button>
    <button class="stt-btn stt-btn-primary" id="btn-stt-close">Готово</button>
  </div>
</div><!-- /stt-modal -->
    `;

    document.body.appendChild(el);
    return el;
  }

  // ─── Значение слайдера для отображения ───────────────────────
  function _sliderDisplay(key, v) {
    if (key === 'decomp_timeout') return v + 'с';
    if (key === 'tree_indent')    return v + 'px';
    return String(v);
  }

  // ─── Привязка событий ─────────────────────────────────────────
  function _bindEvents() {

    // Навигация
    _modal.querySelectorAll('.stt-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        _modal.querySelectorAll('.stt-nav-item').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        _modal.querySelectorAll('.stt-sec').forEach(x => x.classList.remove('active'));
        const sec = _modal.querySelector('#stt-sec-' + btn.dataset.sec);
        if (sec) {
          sec.classList.add('active');
          if (btn.dataset.sec === 'stats') _refreshStats();
        }
      });
    });

    // Закрытие через кнопку
    _modal.querySelector('#btn-stt-close')?.addEventListener('click', close);

    // Клик на оверлей — закрываем только если клик прямо на оверлей
    _modal.addEventListener('mousedown', e => {
      if (e.target === _modal) close();
    });

    // Тоглы
    _modal.querySelectorAll('.stt-toggle').forEach(tgl => {
      tgl.addEventListener('click', () => {
        const key = tgl.dataset.key;
        if (!key) return;
        const newVal = !_cfg[key];
        _cfg[key] = newVal;
        tgl.classList.toggle('stt-on', newVal);
        _saveToStorage();
        _applyAll();
      });
    });

    // Слайдеры
    _modal.querySelectorAll('.stt-slider').forEach(sl => {
      const key = sl.dataset.key;
      const svId = sl.id?.replace('sl-', 'sv-');
      const svEl = svId ? _modal.querySelector('#' + svId) : null;
      sl.addEventListener('input', () => {
        const v = Number(sl.value);
        _cfg[key] = v;
        if (svEl) svEl.textContent = _sliderDisplay(key, v);
        _saveToStorage();
        _applyAll();
      });
    });

    // Селекты
    _modal.querySelectorAll('.stt-select').forEach(sel => {
      sel.addEventListener('change', () => {
        _cfg[sel.dataset.key] = sel.value;
        _saveToStorage();
        _applyAll();
      });
    });

    // Textarea промпта
    _modal.querySelector('#ta-prompt-sys')?.addEventListener('input', e => {
      _cfg.prompt_system = e.target.value;
      _saveToStorage();
    });

    // Чипы шаблонов промпта (одиночный)
    _modal.querySelectorAll('#prompt-chips .stt-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tpl = PROMPT_TEMPLATES[chip.dataset.tpl];
        if (!tpl) return;
        _cfg.prompt_system = tpl;
        _cfg.prompt_template = chip.dataset.tpl;
        const ta = _modal.querySelector('#ta-prompt-sys');
        if (ta) ta.value = tpl;
        // Подсветить выбранный
        _modal.querySelectorAll('#prompt-chips .stt-chip').forEach(c => c.classList.remove('stt-on'));
        chip.classList.add('stt-on');
        _saveToStorage();
      });
    });

    // Чипы статусов (мультивыбор)
    _modal.querySelectorAll('#status-chips .stt-chip-multi').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('stt-on');
        _cfg.study_statuses = [..._modal.querySelectorAll('#status-chips .stt-chip-multi.stt-on')]
          .map(c => c.dataset.val);
        _saveToStorage();
      });
    });

    // Пресеты дерева
    _modal.querySelectorAll('.stt-preset').forEach(p => {
      p.addEventListener('click', () => {
        const key = p.dataset.pkey;
        _modal.querySelectorAll(`.stt-preset[data-pkey="${key}"]`).forEach(x => x.classList.remove('stt-on'));
        p.classList.add('stt-on');
        _cfg[key] = p.dataset.pval;
        _saveToStorage();
        _applyAll();
      });
    });

    // Тема
    _modal.querySelectorAll('.stt-theme-card').forEach(card => {
      card.addEventListener('click', () => {
        _modal.querySelectorAll('.stt-theme-card').forEach(x => x.classList.remove('stt-on'));
        card.classList.add('stt-on');
        _cfg.theme = card.dataset.themeVal;
        _saveToStorage();
        _applyAll();
      });
    });

    // Акцент — цветовые свотчи
    _modal.querySelectorAll('.stt-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        _modal.querySelectorAll('.stt-swatch').forEach(x => x.classList.remove('stt-on'));
        sw.classList.add('stt-on');
        _cfg.accent = sw.dataset.accent;
        // Синхронизировать custom color picker
        const customInput = _modal.querySelector('#stt-accent-custom');
        if (customInput) customInput.value = sw.dataset.accent;
        _saveToStorage();
        _applyAll();
      });
    });

    // Акцент — кастомный цвет
    _modal.querySelector('#stt-accent-custom')?.addEventListener('input', e => {
      _cfg.accent = e.target.value;
      // Снять выделение со свотчей
      _modal.querySelectorAll('.stt-swatch').forEach(x => x.classList.remove('stt-on'));
      _saveToStorage();
      _applyAll();
    });

    // Сброс всего
    _modal.querySelector('#btn-stt-reset')?.addEventListener('click', () => {
      if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
      _cfg = { ...DEFAULTS, study_statuses: [...DEFAULTS.study_statuses] };
      _saveToStorage();
      _fillUI();
      _applyAll();
    });

    // Экспорт CSV
    _modal.querySelector('#btn-stt-export-csv')?.addEventListener('click', _exportCSV);

    // ── Gemini API — мульти-ключ ──────────────────────────────────

    const _gapiAddResult = _modal.querySelector('#gapi-add-result');
    const _gapiKeyList   = _modal.querySelector('#gapi-key-list');

    // Рендер одной строки ключа
    const _renderKeyRow = (k) => {
      const row = document.createElement('div');
      row.dataset.kid = k.id;
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:7px 10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:9px;';
      const pct = Math.round(k.rpdUsed / k.rpdLimit * 100);
      const statusColor = k.exhausted ? '#f87171' : k.enabled ? '#4ade80' : '#64748b';
      const statusText  = k.exhausted ? 'исчерпан' : k.enabled ? 'активен' : 'выкл.';
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="font-size:11px;font-weight:600;color:var(--text-primary);">${k.label || ('Ключ ' + k.id.slice(-4))}</span>
            <span style="font-size:9px;padding:1px 6px;border-radius:6px;background:rgba(0,0,0,.2);color:${statusColor};border:1px solid ${statusColor}40;">${statusText}</span>
            <span style="font-size:9px;color:var(--text-muted);font-family:'DM Mono',monospace;">${k.keyMasked}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="flex:1;height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:${pct>80?'#f87171':pct>50?'#fbbf24':'#4ade80'};border-radius:2px;transition:width .3s;"></div>
            </div>
            <span style="font-size:9px;color:var(--text-muted);font-family:'DM Mono',monospace;white-space:nowrap;">${k.rpdUsed}/${k.rpdLimit} RPD</span>
          </div>
        </div>
        <button class="stt-btn gapi-test-key" data-kid="${k.id}" style="height:28px;padding:0 10px;font-size:10px;flex-shrink:0;">Тест</button>
        <button class="stt-btn gapi-toggle-key" data-kid="${k.id}" style="height:28px;padding:0 10px;font-size:10px;flex-shrink:0;${k.enabled?'':'background:rgba(255,255,255,.03);color:var(--text-muted);'}">${k.enabled?'Вкл':'Выкл'}</button>
        <button class="stt-btn gapi-del-key" data-kid="${k.id}" style="height:28px;padding:0 10px;font-size:10px;flex-shrink:0;background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.18);color:#f87171;">✕</button>`;

      // Тест ключа
      row.querySelector('.gapi-test-key').onclick = async (e) => {
        const btn = e.target; btn.disabled = true; btn.textContent = '…';
        try {
          const res = await window.GeminiAPI?.testConnection(k.id);
          _showGapiResult(_gapiAddResult, `✓ Ключ "${k.label||k.id.slice(-4)}" работает: ${res}`, 'ok');
        } catch(err) {
          _showGapiResult(_gapiAddResult, `✗ ${err.message.slice(0,100)}`, 'error');
        } finally { btn.disabled = false; btn.textContent = 'Тест'; }
      };
      // Вкл/Выкл
      row.querySelector('.gapi-toggle-key').onclick = () => {
        window.GeminiAPI?.toggleKey(k.id, !k.enabled);
        _refreshGapiUI();
      };
      // Удалить
      row.querySelector('.gapi-del-key').onclick = () => {
        if (confirm(`Удалить ключ "${k.label || k.keyMasked}"?`)) {
          window.GeminiAPI?.removeKey(k.id);
          _refreshGapiUI();
        }
      };
      return row;
    };

    // Обновление всего UI
    const _refreshGapiUI = () => {
      const gapi = window.GeminiAPI;
      if (!gapi) return;
      const stats = gapi.getStats();
      const keys  = stats.keys || [];

      // Счётчик ключей
      const countEl = _modal.querySelector('#gapi-keys-count');
      if (countEl) countEl.textContent = `(${keys.length})`;

      // RPM/RPD бейджи
      const rpmEl = _modal.querySelector('#gapi-eff-rpm');
      const rpdEl = _modal.querySelector('#gapi-eff-rpd');
      if (rpmEl) rpmEl.textContent = stats.keysActive > 0 ? `${stats.effectiveRPM} RPM` : '';
      if (rpdEl) rpdEl.textContent = stats.keysActive > 0 ? `${stats.effectiveRPD} RPD` : '';

      // Список ключей
      if (_gapiKeyList) {
        _gapiKeyList.innerHTML = '';
        if (keys.length === 0) {
          _gapiKeyList.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px 4px;">Нет ключей — добавьте хотя бы один</div>';
        } else {
          keys.forEach(k => _gapiKeyList.appendChild(_renderKeyRow(k)));
        }
      }

      // Суммарная квота
      const usedEl  = _modal.querySelector('#gapi-quota-used');
      const maxEl   = _modal.querySelector('#gapi-quota-max');
      const barEl   = _modal.querySelector('#gapi-quota-bar');
      if (usedEl) usedEl.textContent = `${stats.rpdUsed} запросов`;
      if (maxEl)  maxEl.textContent  = `из ${stats.rpdLimit}/день`;
      if (barEl) {
        const pct = Math.min(100, stats.rpdPercent || 0);
        barEl.style.width = pct + '%';
        barEl.style.background = pct > 80
          ? 'linear-gradient(90deg,#f59e0b,#ef4444)'
          : 'linear-gradient(90deg,#7c6af7,#4ade80)';
      }

      // Режим
      const modeEl = _modal.querySelector('#gapi-mode-select');
      if (modeEl) modeEl.value = _cfg.gemini_api_mode || 'hybrid';
    };

    // Добавить ключ
    _modal.querySelector('#gapi-add-btn')?.addEventListener('click', () => {
      const inp   = _modal.querySelector('#gapi-new-key-input');
      const lblIn = _modal.querySelector('#gapi-new-key-label');
      const key   = (inp?.value || '').trim();
      const label = (lblIn?.value || '').trim();
      if (!key) { _showGapiResult(_gapiAddResult, '✗ Введите API ключ', 'error'); return; }
      try {
        window.GeminiAPI?.addKey(key, label || '');
        inp.value = ''; if (lblIn) lblIn.value = '';
        _showGapiResult(_gapiAddResult, `✓ Ключ добавлен${label ? ' — ' + label : ''}`, 'ok');
        _refreshGapiUI();
      } catch(e) {
        _showGapiResult(_gapiAddResult, '✗ ' + e.message, 'error');
      }
    });

    // Enter в поле ключа
    _modal.querySelector('#gapi-new-key-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') _modal.querySelector('#gapi-add-btn')?.click();
    });

    // Сброс счётчиков
    _modal.querySelector('#gapi-reset-counter-btn')?.addEventListener('click', () => {
      window.GeminiAPI?.resetDayCounter();
      _refreshGapiUI();
    });

    // Режим (у селекта нет data-key в _buildModal для gemini_api_mode,
    // но он обработан выше через querySelectorAll('.stt-select') — здесь дублируем
    // только для немедленного обновления UI GeminiAPI при смене режима)
    _modal.querySelector('#gapi-mode-select')?.addEventListener('change', (e) => {
      _cfg.gemini_api_mode = e.target.value;
      _saveToStorage();
      _applyAll();
    });

    // Ссылка на AI Studio
    _modal.querySelector('#gapi-get-key-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      try { window.electronAPI?.openExternal?.('https://aistudio.google.com/app/apikey'); }
      catch (_) { window.open('https://aistudio.google.com/app/apikey', '_blank'); }
    });

    // Обновить при переключении на вкладку
    _modal.querySelector('[data-sec="apikeys"]')?.addEventListener('click', _refreshGapiUI);

    // Первичный рендер
    _refreshGapiUI();
  } // конец _bindEvents

  function _showGapiResult(el, msg, type) {
    if (!el) return;
    if (!msg) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.textContent = msg;
    const colors = {
      ok:    { bg: 'rgba(74,222,128,.1)',  color: '#4ade80',  border: 'rgba(74,222,128,.2)' },
      error: { bg: 'rgba(248,113,113,.1)', color: '#f87171',  border: 'rgba(248,113,113,.2)' },
      info:  { bg: 'rgba(96,165,250,.08)', color: '#60a5fa',  border: 'rgba(96,165,250,.15)' },
    };
    const c = colors[type] || { bg: 'rgba(255,255,255,.04)', color: '#94a3b8', border: 'rgba(255,255,255,.1)' };
    Object.assign(el.style, { background: c.bg, color: c.color, border: '1px solid ' + c.border });
  }

  // ─── Заполнение UI из _cfg ────────────────────────────────────
  function _fillUI() {
    if (!_modal) return;

    // Тоглы
    _modal.querySelectorAll('.stt-toggle[data-key]').forEach(tgl => {
      tgl.classList.toggle('stt-on', !!_cfg[tgl.dataset.key]);
    });

    // Слайдеры
    _modal.querySelectorAll('.stt-slider[data-key]').forEach(sl => {
      const key = sl.dataset.key;
      const val = _cfg[key] ?? DEFAULTS[key] ?? Number(sl.getAttribute('min'));
      sl.value = val;
      const svId = sl.id?.replace('sl-', 'sv-');
      const svEl = svId ? _modal.querySelector('#' + svId) : null;
      if (svEl) svEl.textContent = _sliderDisplay(key, val);
    });

    // Селекты
    _modal.querySelectorAll('.stt-select[data-key]').forEach(sel => {
      const val = _cfg[sel.dataset.key];
      if (val !== undefined) sel.value = val;
    });

    // Textarea
    const ta = _modal.querySelector('#ta-prompt-sys');
    if (ta) ta.value = _cfg.prompt_system || '';

    // Шаблоны промпта
    _modal.querySelectorAll('#prompt-chips .stt-chip').forEach(c => {
      c.classList.toggle('stt-on', c.dataset.tpl === _cfg.prompt_template);
    });

    // Статусы
    const statuses = _cfg.study_statuses || [];
    _modal.querySelectorAll('#status-chips .stt-chip-multi').forEach(c => {
      c.classList.toggle('stt-on', statuses.includes(c.dataset.val));
    });

    // Пресеты
    _modal.querySelectorAll('.stt-preset[data-pkey]').forEach(p => {
      p.classList.toggle('stt-on', p.dataset.pval === _cfg[p.dataset.pkey]);
    });

    // Тема
    _modal.querySelectorAll('.stt-theme-card').forEach(card => {
      card.classList.toggle('stt-on', card.dataset.themeVal === _cfg.theme);
    });

    // Акцент — свотчи
    _modal.querySelectorAll('.stt-swatch').forEach(sw => {
      sw.classList.toggle('stt-on', sw.dataset.accent === _cfg.accent);
    });

    // Акцент — custom color picker
    const customInput = _modal.querySelector('#stt-accent-custom');
    if (customInput && _cfg.accent) customInput.value = _cfg.accent;

    // Gemini API — режим
    const gapiMode = _modal.querySelector('#gapi-mode-select');
    if (gapiMode) gapiMode.value = _cfg.gemini_api_mode || 'hybrid';
  }

  // ─── Статистика из AppState ───────────────────────────────────
  function _refreshStats() {
    if (!_modal) return;
    let totalNodes = 0, doneNodes = 0, topicsCount = 0;

    try {
      const topicsMap = AppState.get('topics');
      if (topicsMap) {
        const topics = [...topicsMap.values()];
        topicsCount = topics.length;
        topics.forEach(t => {
          if (!Array.isArray(t.nodes)) return;
          const flat = (typeof TreeHelpers !== 'undefined')
            ? TreeHelpers.flatten(t.nodes)
            : _flattenNodes(t.nodes);
          totalNodes += flat.length;
          doneNodes  += flat.filter(n => n.status === 'done').length;
        });
      }
    } catch (e) { console.warn('[Settings] stats error', e); }

    const pct = totalNodes > 0 ? Math.round(doneNodes / totalNodes * 100) : 0;

    const q = id => _modal.querySelector('#' + id);
    const setTxt = (id, v) => { const el = q(id); if (el) el.textContent = v; };

    setTxt('stt-stat-done',   doneNodes);
    setTxt('stt-stat-total',  totalNodes);
    setTxt('stt-stat-topics', topicsCount);

    const bar = q('stt-progress-bar');
    if (bar) bar.style.width = pct + '%';

    const lbl = q('stt-progress-label');
    if (lbl) lbl.textContent = totalNodes > 0
      ? `${doneNodes} из ${totalNodes} вопросов — ${pct}%`
      : 'Нет данных';
  }

  function _flattenNodes(nodes, result = []) {
    if (!Array.isArray(nodes)) return result;
    nodes.forEach(n => { result.push(n); _flattenNodes(n.children || [], result); });
    return result;
  }

  // ─── Экспорт CSV ─────────────────────────────────────────────
  function _exportCSV() {
    try {
      const topicsMap = AppState.get('topics');
      const rows = ['Тема,Вопрос,Статус,Ответ'];
      if (topicsMap) {
        [...topicsMap.values()].forEach(t => {
          const flat = typeof TreeHelpers !== 'undefined'
            ? TreeHelpers.flatten(t.nodes)
            : _flattenNodes(t.nodes);
          flat.forEach(n => {
            const ans = (n.answer || '').replace(/"/g, '""').slice(0, 100).replace(/\n/g, ' ');
            rows.push(`"${(t.name||'').replace(/"/g,'""')}","${(n.label||'').replace(/"/g,'""')}","${n.status}","${ans}"`);
          });
        });
      }
      const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), { href: url, download: 'ks-stats.csv' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (e) { console.error('[Settings] export error', e); }
  }

  // ─── Открытие / закрытие ─────────────────────────────────────
  function open() {
    if (!_modal) {
      _modal = _buildModal();
      _bindEvents();
    }
    _fillUI();
    _refreshStats();
    _modal.classList.remove('hidden');
    _isOpen = true;

    // Сбросить навигацию на первый пункт
    _modal.querySelectorAll('.stt-nav-item').forEach((b, i) => b.classList.toggle('active', i === 0));
    _modal.querySelectorAll('.stt-sec').forEach((s, i) => s.classList.toggle('active', i === 0));
  }

  function close() {
    if (!_modal) return;
    _modal.classList.add('hidden');
    _isOpen = false;
  }

  function isOpen() { return _isOpen; }

  // ─── Инициализация ────────────────────────────────────────────
  function init() {
    _cfg = _loadFromStorage();
    // Применить ВСЕ настройки сразу при запуске
    _applyAll();

    // Кнопки переключения темы (может быть несколько с классом tb-btn / rail-btn)
    // Используем querySelectorAll чтобы не зависеть от уникальности ID
    document.querySelectorAll('#btn-theme').forEach(btn => {
      btn.addEventListener('click', toggleTheme);
    });

    // Инициализация Gemini API ключа из сохранённых настроек
    if (_cfg.gemini_api_key && _cfg.gemini_api_key.length > 10) {
      // GeminiAPI загружается раньше (стоит перед autobreakdown.js в index.html)
      // и уже пытается загрузить ключ из localStorage сам.
      // Но подстрахуемся — синхронизируем из Settings LS-ключа
      window.GeminiAPI?.setApiKey(_cfg.gemini_api_key);
      console.log('[Settings] Gemini API ключ загружен из настроек');
    }
  }

  // Запускаем после загрузки DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { open, close, isOpen, get, set, toggleTheme };
})();


// ══════════════════════════════════════════════════════════════
//  ПАТЧ index.js: перехватываем nav-settings и Escape
//  Делаем это через DOMContentLoaded чтобы гарантированно
//  выполниться после index.js (который тоже ждёт load)
// ══════════════════════════════════════════════════════════════
(function patchIndexJS() {
  // Ждём пока index.js добавит свой listener на nav-settings
  // Затем заменяем его нашим — используем capture на document
  // чтобы обработать клик раньше любого listener на элементе

  function attachSettingsBtn() {
    const btn = document.getElementById('nav-settings');
    if (!btn) return;

    // Клонируем кнопку — это убирает все ранее добавленные listeners
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);

    clone.addEventListener('click', e => {
      e.stopPropagation();
      Settings.open();
    });
  }

  // Клавиатурный хук — перехватываем Escape и Cmd+,
  // Используем capture=true чтобы сработать до index.js
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      e.stopPropagation();
      Settings.open();
      return;
    }
    if (e.key === 'Escape' && Settings.isOpen()) {
      e.stopPropagation();
      Settings.close();
    }
  }, true);

  // Предотвращаем захват клика оверлея index.js для нашего модала
  // index.js вешает listener на все .modal-overlay — мы исключаем #modal-settings
  // через stopPropagation при клике внутри .stt-modal (уже сделано в _bindEvents)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(attachSettingsBtn, 0));
  } else {
    setTimeout(attachSettingsBtn, 0);
  }
})();
