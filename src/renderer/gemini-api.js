/**
 * gemini-api.js — Gemini REST API движок v2.1 (multi-key)
 *
 * v2.1: фикс 429 при одном ключе — воркер теперь ждёт cooldown внутри себя
 *       и повторяет запрос, вместо немедленного reject. MAX_RETRIES: 4→8.
 * Каждый ключ — независимый воркер со своим rate limiter (15 RPM).
 * N ключей = N×15 RPM, N×1500 RPD.
 *
 * Архитектура:
 *   - KeyWorker: отдельная очередь + rate limiter для каждого ключа
 *   - Dispatcher: round-robin распределение задач по воркерам
 *   - При 429 на воркере: задача перераспределяется на другой ключ
 *   - При исчерпании RPD ключа: воркер помечается exhausted до следующего дня
 */

window.GeminiAPI = (() => {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // КОНСТАНТЫ
  // ══════════════════════════════════════════════════════════════════

  const MODEL    = 'gemini-2.5-flash';
  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const ENDPOINT = `${API_BASE}/${MODEL}:generateContent`;

  const FREE_TIER = {
    RPM:          15,
    RPD:          1500,
    MAX_OUTPUT:   8192,   // увеличено с 2048 — предотвращает обрезание длинных ответов
    MIN_INTERVAL: 4200,   // мс между запросами одного ключа (60000/15 + запас)
    BACKOFF_BASE: 10_000,
    BACKOFF_MAX:  120_000,
    MAX_RETRIES:  8,
  };

  const LS_KEYS_KEY    = 'gapi_keys_v2';    // список ключей
  const LS_COUNTER_KEY = 'gapi_rpd_v2';     // RPD счётчики по ключам

  // ══════════════════════════════════════════════════════════════════
  // RPD ХРАНИЛИЩЕ — per-key счётчики в localStorage
  // ══════════════════════════════════════════════════════════════════

  function _today() { return new Date().toISOString().slice(0, 10); }

  let _countersCache = null;
  let _countersCacheDay = null;

  function _loadCounters() {
    const today = _today();
    if (_countersCache !== null && _countersCacheDay === today) return _countersCache;
    try {
      const raw = localStorage.getItem(LS_COUNTER_KEY);
      if (!raw) {
        _countersCache = { _day: today };
      } else {
        const d = JSON.parse(raw);
        _countersCache = d._day !== today ? { _day: today } : d;
      }
    } catch (_) {
      _countersCache = { _day: today };
    }
    _countersCacheDay = today;
    return _countersCache;
  }

  function _saveCounters(c) {
    _countersCache = c;
    _countersCacheDay = c._day || _today();
    try { localStorage.setItem(LS_COUNTER_KEY, JSON.stringify(c)); } catch (_) {}
  }

  function _getRPD(keyId) {
    const c = _loadCounters();
    return c[keyId] || 0;
  }

  function _incRPD(keyId) {
    const c = _loadCounters();
    c._day = _today();
    c[keyId] = (c[keyId] || 0) + 1;
    _saveCounters(c);
    return c[keyId];
  }

  function _resetRPD(keyId) {
    const c = _loadCounters();
    if (keyId) delete c[keyId];
    else Object.keys(c).forEach(k => k !== '_day' && delete c[k]);
    _saveCounters(c);
  }

  // ══════════════════════════════════════════════════════════════════
  // СПИСОК КЛЮЧЕЙ — хранение в localStorage
  // ══════════════════════════════════════════════════════════════════

  // Формат: [{ id, key, label, enabled }]
  function _loadKeys() {
    try {
      const raw = localStorage.getItem(LS_KEYS_KEY);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch (_) { return []; }
  }

  function _saveKeys(keys) {
    try { localStorage.setItem(LS_KEYS_KEY, JSON.stringify(keys)); } catch (_) {}
  }

  function _genId() {
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  // ══════════════════════════════════════════════════════════════════
  // KEY WORKER — очередь + rate limiter для одного ключа
  // ══════════════════════════════════════════════════════════════════

  function _createWorker(keyEntry) {
    const w = {
      id:           keyEntry.id,
      key:          keyEntry.key,
      label:        keyEntry.label || ('Ключ ' + keyEntry.id.slice(-4)),
      enabled:      keyEntry.enabled !== false,
      lastRequest:  0,     // timestamp последнего запроса
      processing:   false,
      queue:        [],
      requests:     0,
      success:      0,
      errors:       0,
      exhausted:    false, // RPD исчерпан на сегодня
      cooldownUntil: 0,   // timestamp до которого ключ на паузе после 429
    };

    async function _waitSlot() {
      // Ждём если ключ на cooldown после 429
      if (w.cooldownUntil && Date.now() < w.cooldownUntil) {
        const coolWait = w.cooldownUntil - Date.now();
        console.log(`[GAPI:${w.label}] cooldown ${Math.round(coolWait/1000)}с...`);
        await new Promise(r => setTimeout(r, coolWait));
        w.cooldownUntil = 0;
      }
      const wait = FREE_TIER.MIN_INTERVAL - (Date.now() - w.lastRequest);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      w.lastRequest = Date.now();
    }

    async function _doReq(prompt, options) {
      const maxOutput  = options.maxOutput  || FREE_TIER.MAX_OUTPUT;
      const temperature = options.temperature ?? 0.7;

      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }], role: 'user' }],
        generationConfig: {
          maxOutputTokens: maxOutput,
          temperature,
          topP: 0.95,
          topK: 64,
          // thinking: для коротких промптов (декомпозиция JSON) отключаем полностью.
          // Для длинных ответов НЕ используем thinkingBudget чтобы токены шли в ответ,
          // а не в "размышления" — это главная причина обрезания ответов.
          ...(prompt.length < 800 ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      });

      const r = await fetch(`${ENDPOINT}?key=${w.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!r.ok) {
        let msg = '';
        try { msg = (await r.json())?.error?.message || ''; } catch (_) {}
        if (r.status === 429) {
          const m = msg.match(/retry in ([\d.]+)s/i);
          const retryMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 2000 : FREE_TIER.BACKOFF_BASE;
          throw Object.assign(new Error(`429: ${msg.slice(0, 120)}`), { isRateLimit: true, retryMs });
        }
        if (r.status === 403) throw Object.assign(new Error(`403: неверный ключ. ${msg.slice(0,80)}`), { isFatal: true });
        if (r.status === 400) throw Object.assign(new Error(`400: плохой запрос. ${msg.slice(0,80)}`), { isFatal: true });
        throw new Error(`HTTP ${r.status}: ${msg.slice(0, 100)}`);
      }

      const data = await r.json();
      const candidate = data?.candidates?.[0];
      if (!candidate) {
        const reason = data?.promptFeedback?.blockReason;
        throw new Error(`Нет ответа${reason ? ` (blocked: ${reason})` : ''}`);
      }

      const finishReason = candidate.finishReason;

      // Модель может вернуть кандидата без content вообще (например, при
      // блокировке safety-фильтром) — в этом случае сразу явная ошибка,
      // а не TypeError на text.length ниже.
      if (!candidate.content?.parts?.length) {
        throw Object.assign(new Error(`Нет content в ответе (finishReason: ${finishReason || 'unknown'})`), { isFatal: finishReason === 'SAFETY' });
      }

      const text = candidate.content.parts.map(p => p.text || '').join('').trim();

      // Логируем finishReason для диагностики обрезания
      if (finishReason && finishReason !== 'STOP') {
        console.warn(`[GAPI:${w.label}] finishReason=${finishReason} len=${text.length}`);
      }

      // MAX_TOKENS — модель упёрлась в лимит токенов, текст обрезан
      if (finishReason === 'MAX_TOKENS') {
        // Если текст достаточно большой — возвращаем как есть (лучше частичный чем ничего)
        // Если совсем мало — бросаем ошибку чтобы retry с меньшим промптом
        if (text.length > 200) {
          console.warn(`[GAPI:${w.label}] MAX_TOKENS но текст ${text.length} симв. — возвращаем`);
          // Добавляем маркер чтобы autobreakdown знал что ответ неполный
          return text;
        }
        throw new Error(`MAX_TOKENS: ответ обрезан (${text.length} симв.)`);
      }

      if (!text) throw new Error(`Пустой ответ (finishReason: ${finishReason})`);
      return text;
    }

    // Обработка одной задачи с retry
    async function _runTask(task) {
      let attempt = 0;
      let backoff  = FREE_TIER.BACKOFF_BASE;

      while (attempt < FREE_TIER.MAX_RETRIES) {
        attempt++;

        // Проверка RPD этого ключа
        const rpd = _getRPD(w.id);
        if (rpd >= FREE_TIER.RPD) {
          w.exhausted = true;
          task.reject(Object.assign(new Error(`RPD исчерпан для ключа "${w.label}"`), { isExhausted: true }));
          return;
        }

        try {
          await _waitSlot();
          w.requests++;
          const text = await _doReq(task.prompt, task.options);
          _incRPD(w.id);
          w.success++;
          console.log(`[GAPI:${w.label}] ✓ attempt=${attempt} RPD=${_getRPD(w.id)}/${FREE_TIER.RPD}`);
          task.resolve(text);
          return;

        } catch (err) {
          w.errors++;
          console.warn(`[GAPI:${w.label}] attempt=${attempt} err:`, err.message.slice(0, 80));

          if (err.isFatal) { task.reject(err); return; }
          if (err.isExhausted) { task.reject(err); return; }

          if (err.isRateLimit) {
            const waitMs = err.retryMs || FREE_TIER.BACKOFF_BASE;
            // Если есть другие активные ключи — отдаём задачу диспетчеру немедленно.
            // Если ключ один — ждём cooldown прямо здесь и повторяем сами.
            const otherReady = _workers.filter(
              ow => ow !== w && ow.enabled && !ow.exhausted &&
                    (!ow.cooldownUntil || Date.now() >= ow.cooldownUntil)
            );
            if (otherReady.length > 0) {
              console.log(`[GAPI:${w.label}] 429 → перекидываем задачу на другой ключ, пауза ${Math.round(waitMs/1000)}с`);
              w.cooldownUntil = Date.now() + waitMs;
              task.reject(Object.assign(err, { isRateLimit: true }));
              return;
            }
            // Единственный ключ — ждём и ретраим внутри
            console.log(`[GAPI:${w.label}] 429 (единственный ключ) → ждём ${Math.round(waitMs/1000)}с и повторяем...`);
            w.cooldownUntil = Date.now() + waitMs;
            await new Promise(r => setTimeout(r, waitMs));
            w.cooldownUntil = 0;
            w.lastRequest = 0; // сбрасываем интервал чтобы _waitSlot не добавил ещё задержку
            continue;
          }

          if (attempt >= FREE_TIER.MAX_RETRIES) { task.reject(err); return; }

          await new Promise(r => setTimeout(r, Math.min(backoff, FREE_TIER.BACKOFF_MAX)));
          backoff = Math.min(backoff * 2, FREE_TIER.BACKOFF_MAX);
        }
      }
    }

    // Цикл обработки очереди воркера
    async function _processQueue() {
      if (w.processing) return;
      w.processing = true;
      while (w.queue.length > 0) {
        const task = w.queue.shift();
        await _runTask(task);
      }
      w.processing = false;
    }

    w.enqueue = function(task) {
      w.queue.push(task);
      _processQueue().catch(console.error);
    };

    return w;
  }

  // ══════════════════════════════════════════════════════════════════
  // ПУЛА ВОРКЕРОВ И ДИСПЕТЧЕР
  // ══════════════════════════════════════════════════════════════════

  let _workers = [];       // активные воркеры
  let _roundIdx = 0;       // текущий индекс round-robin

  function _rebuildWorkers() {
    const keys = _loadKeys().filter(k => k.enabled && k.key && k.key.length > 10);
    _workers = keys.map(_createWorker);
    _roundIdx = 0;
    console.log(`[GeminiAPI] воркеры: ${_workers.length} ключей активно`);
  }

  // Выбрать следующий доступный воркер (round-robin, пропускаем exhausted)
  function _nextWorker() {
    if (_workers.length === 0) return null;
    const now = Date.now();
    // Сначала ищем воркер без cooldown
    const ready = _workers.filter(w => w.enabled && !w.exhausted && (!w.cooldownUntil || now >= w.cooldownUntil));
    if (ready.length > 0) {
      const w = ready[_roundIdx % ready.length];
      _roundIdx = (_roundIdx + 1) % ready.length;
      return w;
    }
    // Все на cooldown — берём ближайший освобождающийся
    const active = _workers.filter(w => w.enabled && !w.exhausted);
    if (active.length === 0) return null;
    active.sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0));
    return active[0];
  }

  // ══════════════════════════════════════════════════════════════════
  // PUBLIC: ask() — главный метод
  // ══════════════════════════════════════════════════════════════════

  function ask(prompt, options = {}, cancelRef = null) {
    return new Promise((resolve, reject) => {
      const worker = _nextWorker();
      if (!worker) {
        return reject(new Error('GeminiAPI: нет активных ключей. Добавьте API ключи в Настройки → API ключи.'));
      }

      const wrappedResolve = (text) => {
        if (cancelRef?.v) reject(new Error('Отменено'));
        else resolve(text);
      };

      let _attemptsLeft = _workers.length + 1; // максимум попыток = количество ключей

      // При 429 или exhausted — перекидываем на другой ключ
      const wrappedReject = (err) => {
        _attemptsLeft--;
        const canRetry = (err.isRateLimit || err.isExhausted) && _attemptsLeft > 0;
        if (canRetry) {
          const reason = err.isExhausted ? 'RPD исчерпан' : '429';
          const next = _nextWorker();
          if (next) {
            console.log(`[GeminiAPI] ${reason} на "${worker.label}" → перекидываем на "${next.label}"`);
            next.enqueue({ prompt, options, resolve: wrappedResolve, reject: wrappedReject });
            return;
          }
        }
        reject(err);
      };

      worker.enqueue({ prompt, options, resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PUBLIC: управление ключами
  // ══════════════════════════════════════════════════════════════════

  function addKey(key, label) {
    key = (key || '').trim();
    if (key.length < 10) throw new Error('Слишком короткий ключ');
    const keys = _loadKeys();
    // Проверка дубля
    if (keys.some(k => k.key === key)) throw new Error('Этот ключ уже добавлен');
    const entry = { id: _genId(), key, label: label || '', enabled: true };
    keys.push(entry);
    _saveKeys(keys);
    _rebuildWorkers();
    return entry;
  }

  function removeKey(id) {
    const keys = _loadKeys().filter(k => k.id !== id);
    _saveKeys(keys);
    _resetRPD(id);
    _rebuildWorkers();
  }

  function toggleKey(id, enabled) {
    const keys = _loadKeys();
    const k = keys.find(k => k.id === id);
    if (k) { k.enabled = enabled; _saveKeys(keys); _rebuildWorkers(); }
  }

  function setKeyLabel(id, label) {
    const keys = _loadKeys();
    const k = keys.find(k => k.id === id);
    if (k) { k.label = label; _saveKeys(keys); _rebuildWorkers(); }
  }

  function getKeys() {
    return _loadKeys().map(k => ({
      ...k,
      keyMasked: k.key ? k.key.slice(0, 6) + '…' + k.key.slice(-4) : '',
      rpdUsed:   _getRPD(k.id),
      rpdLimit:  FREE_TIER.RPD,
      exhausted: _workers.find(w => w.id === k.id)?.exhausted || false,
      queueLen:  _workers.find(w => w.id === k.id)?.queue.length || 0,
    }));
  }

  // ── Обратная совместимость с v1 (один ключ) ─────────────────────

  function setApiKey(key) {
    key = (key || '').trim();
    if (!key) {
      // Сброс всех ключей
      _saveKeys([]);
      _rebuildWorkers();
      return;
    }
    try { addKey(key, 'Основной'); } catch (_) {
      // Уже существует — обновляем
      const keys = _loadKeys();
      if (keys.length > 0) { keys[0].key = key; _saveKeys(keys); _rebuildWorkers(); }
    }
  }

  function getApiKey() {
    const keys = _loadKeys();
    return keys.length > 0 ? keys[0].key : '';
  }

  function loadSavedKey() {
    // Миграция со старого формата v1
    try {
      const old = localStorage.getItem('gapi_key');
      if (old && old.length > 10 && _loadKeys().length === 0) {
        addKey(old, 'Основной');
        localStorage.removeItem('gapi_key');
        console.log('[GeminiAPI] мигрирован ключ из v1');
      }
    } catch (_) {}
    _rebuildWorkers();
    return _workers.length > 0;
  }

  function isEnabled() {
    return _workers.some(w => w.enabled && !w.exhausted);
  }

  // ══════════════════════════════════════════════════════════════════
  // PUBLIC: тест ключа
  // ══════════════════════════════════════════════════════════════════

  async function testConnection(keyId) {
    const keys = _loadKeys();
    const entry = keyId ? keys.find(k => k.id === keyId) : keys[0];
    if (!entry) throw new Error('Ключ не найден');

    // Прямой запрос без очереди — для теста
    const w = _createWorker(entry);
    await new Promise(r => setTimeout(r, 0)); // yield
    const body = JSON.stringify({
      contents: [{ parts: [{ text: 'Reply with one word: OK' }], role: 'user' }],
      generationConfig: { maxOutputTokens: 10, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
    });
    const r = await fetch(`${ENDPOINT}?key=${entry.key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    if (!r.ok) {
      let msg = ''; try { msg = (await r.json())?.error?.message || ''; } catch (_) {}
      throw new Error(`HTTP ${r.status}: ${msg.slice(0, 120)}`);
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    _incRPD(entry.id);
    return text.trim() || 'OK';
  }

  // ══════════════════════════════════════════════════════════════════
  // PUBLIC: статистика
  // ══════════════════════════════════════════════════════════════════

  function getStats() {
    const keys = getKeys();
    const totalRPD    = keys.reduce((s, k) => s + k.rpdUsed, 0);
    const totalRPDLim = keys.length * FREE_TIER.RPD;
    const activeKeys  = _workers.filter(w => w.enabled && !w.exhausted).length;
    const effectiveRPM = activeKeys * FREE_TIER.RPM;
    return {
      enabled:      isEnabled(),
      model:        MODEL,
      keysTotal:    keys.length,
      keysActive:   activeKeys,
      effectiveRPM,
      effectiveRPD: activeKeys * FREE_TIER.RPD,
      rpdUsed:      totalRPD,
      rpdLimit:     totalRPDLim,
      rpdRemaining: Math.max(0, totalRPDLim - totalRPD),
      rpdPercent:   totalRPDLim > 0 ? Math.round(totalRPD / totalRPDLim * 100) : 0,
      queueTotal:   _workers.reduce((s, w) => s + w.queue.length, 0),
      keys,
    };
  }

  function getRPDUsed()      { return getStats().rpdUsed; }
  function getRPDRemaining() { return getStats().rpdRemaining; }

  function resetDayCounter(keyId) {
    _resetRPD(keyId || null);
    _workers.forEach(w => { if (!keyId || w.id === keyId) w.exhausted = false; });
    console.log('[GeminiAPI] RPD счётчики сброшены');
  }

  // ══════════════════════════════════════════════════════════════════
  // ИНИЦИАЛИЗАЦИЯ
  // ══════════════════════════════════════════════════════════════════

  loadSavedKey();
  console.log(`[GeminiAPI] v2.0 загружен. Ключей: ${_workers.length}, модель: ${MODEL}`);

  // ══════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════

  return {
    ask,
    // Управление ключами
    addKey, removeKey, toggleKey, setKeyLabel, getKeys,
    // Обратная совместимость
    setApiKey, getApiKey, loadSavedKey, isEnabled,
    // Тест и статистика
    testConnection, getStats, getRPDUsed, getRPDRemaining, resetDayCounter,
    FREE_TIER, MODEL,
  };
})();