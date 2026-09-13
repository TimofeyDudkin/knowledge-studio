/**
 * tree-helpers.js — логика работы с деревом вопросов.
 * Чистые функции (без DOM и без state).
 * Импортирует/экспортирует данные, не касается рендера.
 */

window.TreeHelpers = (() => {

  /**
   * Добавить дочерний узел к родителю (мутирует массив nodes темы).
   * Если parentId === null — добавляет в корень.
   */
  function addNode(nodes, parentId, newNode) {
    if (parentId === null) {
      nodes.push(newNode);
      return true;
    }
    for (const node of nodes) {
      if (node.id === parentId) {
        node.children.push(newNode);
        return true;
      }
      if (addNode(node.children, parentId, newNode)) return true;
    }
    return false;
  }

  /**
   * Удалить узел по id (мутирует).
   */
  function removeNode(nodes, nodeId) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === nodeId) {
        nodes.splice(i, 1);
        return true;
      }
      if (removeNode(nodes[i].children, nodeId)) return true;
    }
    return false;
  }

  /**
   * Обновить поля узла по id.
   */
  function updateNode(nodes, nodeId, fields) {
    for (const node of nodes) {
      if (node.id === nodeId) {
        Object.assign(node, fields);
        return true;
      }
      if (updateNode(node.children, nodeId, fields)) return true;
    }
    return false;
  }

  /**
   * Получить плоский список всех узлов с глубиной.
   * Используется для рендера списка и для поиска.
   */
  function flatten(nodes, depth = 0) {
    const result = [];
    for (const node of nodes) {
      result.push({ ...node, _depth: depth });
      result.push(...flatten(node.children, depth + 1));
    }
    return result;
  }

  /**
   * Получить breadcrumb-путь от корня до узла.
   */
  function getPath(nodes, nodeId, path = []) {
    for (const node of nodes) {
      const current = [...path, node];
      if (node.id === nodeId) return current;
      const found = getPath(node.children, nodeId, current);
      if (found) return found;
    }
    return null;
  }

  /**
   * Статистика дерева: total / done / active / open.
   */
  function getStats(nodes) {
    let total = 0, done = 0, active = 0, open = 0;
    for (const flat of flatten(nodes)) {
      total++;
      if (flat.status === 'done')   done++;
      if (flat.status === 'active') active++;
      if (flat.status === 'open')   open++;
    }
    return { total, done, active, open };
  }

  /**
   * Подготовить узлы для графа (позиции — force-layout позже).
   * Возвращает { nodes: [], edges: [] }
   */
  function toGraphData(nodes) {
    const gNodes = [];
    const gEdges = [];
    function traverse(list, parentId = null) {
      for (const node of list) {
        gNodes.push({ id: node.id, label: node.label, status: node.status });
        if (parentId) gEdges.push({ from: parentId, to: node.id });
        traverse(node.children, node.id);
      }
    }
    traverse(nodes);
    return { nodes: gNodes, edges: gEdges };
  }

  /**
   * Найти следующий незавершённый узел (для авторежима).
   */
  function nextOpenNode(nodes) {
    for (const node of flatten(nodes)) {
      if (node.status === 'open') return node;
    }
    return null;
  }

  /**
   * Простой стеммер для русского и английского.
   * Возвращает основу слова (минимум 4 символа).
   */
  function stem(word) {
    // Русские окончания (порядок важен — от длинных к коротким)
    const ruEndings = [
      'ующего','ующему','ующими','ующегося','ующемуся',
      'ющийся','ющегося','ющемуся',
      'ющийся','ющимся',
      'ующий','ующая','ующее','ующие',
      'ающий','ающая','ающее','ающие',
      'овать','евать','ивать','ывать',
      'ости','ение','ания','ового','овой','овому','овыми',
      'ённый','енный','анный','янный',
      'ьного','ьному','ьными','ьное','ьной',
      'ений','аний','оств',
      'ого','его','ому','ему','ого',
      'ами','ями','ови','ови',
      'ать','ять','еть','ить','уть',
      'ой','ей','ий','ый','ая','яя','ое','ее',
      'ам','ям','ом','ем','ах','ях',
      'ов','ев','ью','ью',
      'ся','сь',
      'ми','ти','ть',
      'ом','ем','ам',
      'ый','ой','ий',
      'ет','ит','ут','ют',
      'ла','ло','ли',
      'ны','на','но',
      'ах','ях',
      'ов','ев',
      'ей','ий',
      'ой','ий',
      'ам','ям',
      'ых','их',
      'ую','юю',
      'ов',
      'ей',
      'ах',
      'ую',
      'ем','ом',
      'ие','ые',
      'ий','ый',
      'ая','яя',
      'ое','ее',
      'ни','ть',
      'й','а','е','и','о','у','ы','ь','э','я',
    ];
    // Английские окончания
    const enEndings = [
      'ational','tional','enci','anci','izer','ising','izing',
      'alism','ness','ment','ness','ful','ous','ive','ize','ise',
      'ation','ator','alism','aliti','fulness','ousness','iveness',
      'isation','ization',
      'ings','edly','edly','ingly',
      'hood','ship','ward','wards','wise',
      'tion','sion','ing','ness','ment','ful','ous','ive',
      'ers','ies','ied','ies',
      'ed','er','ly','al','ic','en',
      'es','er','ed',
      'ing','ion',
      's',
    ];

    const w = word.toLowerCase();
    const isRu = /[а-яё]/.test(w);
    const endings = isRu ? ruEndings : enEndings;
    const minLen = isRu ? 4 : 4;

    for (const end of endings) {
      if (w.endsWith(end) && w.length - end.length >= minLen) {
        return w.slice(0, w.length - end.length);
      }
    }
    return w;
  }

  /**
   * Разбить текст на слова-основы (длина ≥ 4).
   */
  function tokenize(text) {
    if (!text) return [];
    return text
      .replace(/[#*`_~\[\]()\-—]/g, ' ')
      .split(/\s+/)
      .map(w => w.replace(/[^а-яёa-z0-9]/gi, '').toLowerCase())
      .filter(w => w.length >= 4)
      .map(stem);
  }

  /**
   * Собрать индекс слов из меток и ответов всех узлов.
   * Индексируем по основе слова для максимального совпадения.
   * Возвращает Map<stem → Set<nodeId>>
   */
  function buildWordIndex(nodes) {
    const index = new Map();

    function addWords(text, nodeId) {
      if (!text) return;
      for (const s of tokenize(text)) {
        if (!index.has(s)) index.set(s, new Set());
        index.get(s).add(nodeId);
      }
    }

    for (const node of flatten(nodes)) {
      // Индексируем только названия вопросов/подвопросов — не ответы.
      // Это даёт осмысленные ссылки: подсвечиваются слова, которые
      // реально фигурируют в дереве вопросов, а не случайные совпадения.
      addWords(node.label, node.id);
    }
    return index;
  }

  /**
   * Получить основу слова (публичный доступ для crossref).
   */
  function stemWord(word) { return stem(word); }

  return {
    addNode,
    removeNode,
    updateNode,
    flatten,
    getPath,
    getStats,
    toGraphData,
    nextOpenNode,
    buildWordIndex,
    stemWord,
    tokenize,
  };
})();

// ─── DnD helpers (добавлены в этапе 2) ──────────────────────

/**
 * Извлечь узел из дерева (удалить из текущей позиции, вернуть объект).
 */
TreeHelpers.extractNode = function(nodes, nodeId) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === nodeId) {
      return nodes.splice(i, 1)[0];
    }
    const found = TreeHelpers.extractNode(nodes[i].children, nodeId);
    if (found) return found;
  }
  return null;
};

/**
 * Вставить узел before/after относительно targetId.
 */
TreeHelpers.insertAdjacent = function(nodes, targetId, newNode, position) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === targetId) {
      const idx = position === 'before' ? i : i + 1;
      nodes.splice(idx, 0, newNode);
      return true;
    }
    if (TreeHelpers.insertAdjacent(nodes[i].children, targetId, newNode, position)) return true;
  }
  return false;
};

/**
 * Найти parentId узла (null если корень).
 */
TreeHelpers.findParentId = function(nodes, nodeId, parentId = null) {
  for (const node of nodes) {
    if (node.id === nodeId) return parentId;
    const found = TreeHelpers.findParentId(node.children, nodeId, node.id);
    if (found !== undefined) return found;
  }
  return undefined; // не найден в этом поддереве
};

/**
 * Проверить, является ли ancestorId предком nodeId.
 */
TreeHelpers.isAncestor = function(nodes, ancestorId, nodeId) {
  function check(list) {
    for (const node of list) {
      if (node.id === ancestorId) {
        return containsNode(node.children, nodeId);
      }
      if (check(node.children)) return true;
    }
    return false;
  }
  function containsNode(list, id) {
    for (const n of list) {
      if (n.id === id || containsNode(n.children, id)) return true;
    }
    return false;
  }
  return check(nodes);
};