/**
 * graph.js — Graph v6
 *
 *  • Полный экран: канвас занимает 100%, панель ответа — slide-in overlay
 *  • Улучшенная визуалка: градиентные ноды, dot-grid фон, gradient edges
 *  • Прямое чтение AppState (без compatibility shim)
 *  • Те же функции что и в tree: статус, редактирование, навигация
 */

(function () {
  'use strict';

  // ── Константы ───────────────────────────────────────────────────────────
  const NODE_W    = 192;
  const NODE_MH   = 56;
  const LINE_H    = 16;
  const FONT_SZ   = 11.5;
  const PAD_X     = 16;
  const PAD_Y     = 11;
  const GAP_H     = 72;
  const GAP_V     = 22;
  const NODE_R    = 10;
  const MIN_SC    = 0.08;
  const MAX_SC    = 3.2;
  const MM_W      = 126;
  const MM_H      = 88;

  // ── Состояние ────────────────────────────────────────────────────────────
  const gS = {
    nodes: [], edges: [], nodeMap: new Map(),
    tr: { x: 0, y: 0, s: 1 },
    selected: null,
    filter: 'all', search: '',
    pan: { on: false, sx: 0, sy: 0, tx: 0, ty: 0 },
    svgEl: null, canvasEl: null, mmEl: null,
    _mmPending: false,
  };

  let _vis        = false;
  let _panNodeId  = null;
  let _panMode    = 'view';  // 'view' | 'edit'

  const isLight = () => document.body.dataset.theme === 'light';

  // ── Цвета статусов ────────────────────────────────────────────────────────
  function sColor(status) {
    return isLight()
      ? ({
          open:   { bg:'rgba(218,218,238,0.72)', border:'rgba(120,120,170,0.55)', accent:'#8080b0', text:'#404060', dot:'#9090b8' },
          active: { bg:'rgba(245,166,35,0.13)',  border:'rgba(170,110,0,0.55)',   accent:'#c97d00', text:'#6a4200', dot:'#c97d00' },
          done:   { bg:'rgba(16,155,70,0.10)',   border:'rgba(16,130,60,0.55)',   accent:'#16a34a', text:'#0d5c28', dot:'#16a34a' },
          root:   { bg:'rgba(100,82,235,0.12)',  border:'rgba(90,70,220,0.6)',    accent:'#6650e8', text:'#3020a0', dot:'#5c4ef5' },
        }[status] || { bg:'rgba(218,218,238,0.72)', border:'rgba(120,120,170,0.55)', accent:'#8080b0', text:'#404060', dot:'#9090b8' })
      : ({
          open:   { bg:'rgba(44,44,72,0.52)',    border:'rgba(96,96,150,0.45)',   accent:'#5a5a90', text:'#aaaacc', dot:'#5a5a90' },
          active: { bg:'rgba(251,191,36,0.11)',  border:'rgba(251,191,36,0.55)',  accent:'#fbbf24', text:'#fbbf24', dot:'#fbbf24' },
          done:   { bg:'rgba(52,211,153,0.11)',  border:'rgba(52,211,153,0.55)', accent:'#34d399', text:'#34d399', dot:'#34d399' },
          root:   { bg:'rgba(167,139,250,0.18)', border:'rgba(167,139,250,0.65)', accent:'#a78bfa', text:'#c4b5fd', dot:'#a78bfa' },
        }[status] || { bg:'rgba(44,44,72,0.52)', border:'rgba(96,96,150,0.45)', accent:'#5a5a90', text:'#aaaacc', dot:'#5a5a90' });
  }

  // ── Утилиты ───────────────────────────────────────────────────────────────
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  function wrapText(text, maxW, charPx) {
    const max = Math.floor(maxW / charPx);
    const words = String(text || '').split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (test.length <= max) {
        line = test;
      } else {
        if (line) lines.push(line);
        if (w.length > max) {
          let ch = w;
          while (ch.length > max) { lines.push(ch.slice(0, max-1) + '…'); ch = ch.slice(max-1); }
          line = ch;
        } else line = w;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  // ── Данные из AppState ────────────────────────────────────────────────────
  function buildData() {
    const topic = AppState.getCurrentTopic();
    if (!topic?.nodes?.length) return { nodes:[], edges:[], nodeMap: new Map() };

    const nodes=[], edges=[], nodeMap=new Map();
    const innerW = NODE_W - PAD_X*2 - 6;
    const charPx = 6.5;

    let rootList = topic.nodes;
    if (rootList.length > 1) {
      rootList = [{ id:'_groot_'+topic.id, label:topic.name, status:'root', answer:null, children:topic.nodes, _syn:true }];
    }

    function traverse(node, parentId, depth) {
      const lines = wrapText(node.label, innerW, charPx);
      const h     = Math.max(NODE_MH, lines.length * LINE_H + PAD_Y*2 + 18);
      const nd    = { id:node.id, label:node.label,
        status: node.status || (node._syn ? 'root':'open'),
        answer: node.answer||'', w:NODE_W, h, lines, depth, parentId,
        x:0, y:0, _syn:!!node._syn, hasAnswer:!!(node.answer?.trim()) };
      nodes.push(nd); nodeMap.set(nd.id, nd);
      if (parentId) edges.push({ from:parentId, to:nd.id });
      for (const child of (node.children||[])) traverse(child, nd.id, depth+1);
    }
    for (const n of rootList) traverse(n, null, 0);

    // Layout: horizontal tree
    nodes.forEach(n => { n.x = n.depth * (NODE_W + GAP_H); });
    const childrenOf = new Map();
    for (const nd of nodes) {
      if (!childrenOf.has(nd.parentId)) childrenOf.set(nd.parentId, []);
      childrenOf.get(nd.parentId).push(nd);
    }
    function assignY(nd, startY) {
      const ch = childrenOf.get(nd.id) || [];
      if (!ch.length) { nd.y = startY; return startY + nd.h + GAP_V; }
      let cy = startY;
      for (const c of ch) cy = assignY(c, cy);
      const f=ch[0], l=ch[ch.length-1];
      nd.y = (f.y + l.y + l.h) / 2 - nd.h / 2;
      return cy;
    }
    let y = 80;
    for (const r of (childrenOf.get(null)||[])) y = assignY(r, y);

    let mx=Infinity, my=Infinity;
    nodes.forEach(n => { mx=Math.min(mx,n.x); my=Math.min(my,n.y); });
    nodes.forEach(n => { n.x -= mx-80; n.y -= my-80; });

    return { nodes, edges, nodeMap };
  }

  // ── Build DOM ─────────────────────────────────────────────────────────────
  function buildDOM(panel) {
    const root = document.createElement('div');
    root.id = 'graph-view';

    // Toolbar
    const tb = document.createElement('div');
    tb.id = 'graph-toolbar';
    tb.innerHTML = `
      <div class="g-search-wrap">
        <svg class="g-search-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="5.5" cy="5.5" r="4"/><path d="M9 9l3 3" stroke-linecap="round"/>
        </svg>
        <input id="g-search" class="g-search-input" placeholder="Поиск…" autocomplete="off" spellcheck="false">
        <button id="g-sc" class="g-search-clear">
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2l6 6M8 2l-6 6" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="g-sep"></div>
      <div class="g-chips">
        <button class="g-chip active" data-f="all">Все</button>
        <button class="g-chip" data-f="open">
          <span class="g-chip-dot" style="background:#5a5a90"></span>Открыто
        </button>
        <button class="g-chip" data-f="active">
          <span class="g-chip-dot" style="background:#fbbf24"></span>Изучается
        </button>
        <button class="g-chip" data-f="done">
          <span class="g-chip-dot" style="background:#34d399"></span>Готово
        </button>
      </div>
      <div class="g-toolbar-spacer"></div>
      <div class="g-zoom-row">
        <button class="g-zoom-btn" id="g-zo">
          <svg viewBox="0 0 10 2" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 1h8" stroke-linecap="round"/></svg>
        </button>
        <span class="g-zoom-pct" id="g-zp">100%</span>
        <button class="g-zoom-btn" id="g-zi">
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 1v8M1 5h8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <button class="g-icon-btn" id="g-fit" title="По размеру (F)">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    `;
    root.appendChild(tb);

    // Canvas (100% of remaining space)
    const canvas = document.createElement('div');
    canvas.id = 'graph-canvas';
    gS.canvasEl = canvas;

    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.id = 'graph-svg';
    gS.svgEl = svg;
    const defs = document.createElementNS('http://www.w3.org/2000/svg','defs');
    svg.appendChild(defs);
    for (const id of ['g-bg','g-edges','g-nodes']) {
      const g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.id = id; svg.appendChild(g);
    }
    canvas.appendChild(svg);

    // Minimap
    const mm = document.createElement('div');
    mm.id = 'graph-minimap'; canvas.appendChild(mm); gS.mmEl = mm;

    // Hint
    const hint = document.createElement('div');
    hint.id = 'graph-hint';
    hint.innerHTML = '<kbd>Scroll</kbd> zoom &nbsp;·&nbsp; <kbd>Drag</kbd> pan &nbsp;·&nbsp; <kbd>F</kbd> fit';
    canvas.appendChild(hint);

    // Empty state
    const empty = document.createElement('div');
    empty.id = 'graph-empty';
    empty.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="13" r="5" stroke="currentColor" stroke-width="1.5" opacity=".45"/>
            <circle cx="10" cy="37" r="5" stroke="currentColor" stroke-width="1.5" opacity=".45"/>
            <circle cx="38" cy="37" r="5" stroke="currentColor" stroke-width="1.5" opacity=".45"/>
            <path d="M24 18L10 32M24 18L38 32" stroke="currentColor" stroke-width="1.2" opacity=".28" stroke-linecap="round"/>
          </svg>
        </div>
        <h3>Выбери тему или создай новую</h3>
        <p>Граф знаний появится здесь</p>
      </div>`;
    canvas.appendChild(empty);

    // Context menu (app-style)
    const ctx = document.createElement('div');
    ctx.id = 'graph-ctx-menu';
    ctx.innerHTML = `
      <button class="ctx-menu-item" id="g-ctx-add">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2v8M2 6h8" stroke-linecap="round"/></svg>
        Добавить подвопрос
      </button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" id="g-ctx-rename">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 1.5l1.5 1.5-6 6H3v-1.5l6-6z" stroke-linejoin="round"/></svg>
        Переименовать
      </button>
      <button class="ctx-menu-item" id="g-ctx-cycle">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="3.5"/></svg>
        Сменить статус
      </button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item danger" id="g-ctx-del">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h8M4 3V2h4v1M5 5v4M7 5v4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Удалить
      </button>`;
    canvas.appendChild(ctx);

    // Node panel backdrop (click-outside to close)
    const backdrop = document.createElement('div');
    backdrop.id = 'graph-panel-backdrop';
    backdrop.addEventListener('click', _closePan);
    canvas.appendChild(backdrop);

    // Node panel — overlay inside canvas (doesn't cover toolbar)
    const pan = document.createElement('div');
    pan.id = 'graph-node-panel';
    pan.innerHTML = `
      <div id="gnp-header">
        <div class="ap-header-left">
          <span class="ap-panel-title" id="gnp-title">Ответ</span>
        </div>
        <div class="ap-header-actions" id="gnp-actions"></div>
      </div>
      <div id="gnp-content"></div>`;
    canvas.appendChild(pan);

    root.appendChild(canvas);

    _bindTb(tb);
    _bindCanvas(canvas);
    _bindCtx(ctx);

    return root;
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────
  function _bindTb(tb) {
    const si=tb.querySelector('#g-search'), sc=tb.querySelector('#g-sc');
    si.addEventListener('input',()=>{ gS.search=si.value; sc.classList.toggle('vis',!!si.value); renderGraph(); });
    sc.addEventListener('click',()=>{ si.value=''; gS.search=''; sc.classList.remove('vis'); renderGraph(); });
    tb.querySelectorAll('.g-chip').forEach(c => {
      c.addEventListener('click',()=>{
        gS.filter=c.dataset.f;
        tb.querySelectorAll('.g-chip').forEach(x=>x.classList.toggle('active',x.dataset.f===gS.filter));
        renderGraph();
      });
    });
    tb.querySelector('#g-zo').addEventListener('click',()=>zoomBy(-0.2));
    tb.querySelector('#g-zi').addEventListener('click',()=>zoomBy(0.2));
    tb.querySelector('#g-fit').addEventListener('click',()=>fitView(true));
  }

  // ── Canvas events ─────────────────────────────────────────────────────────
  function _bindCanvas(canvas) {
    canvas.addEventListener('mousedown', e => {
      if (e.target.closest('.gn-group')||e.target.closest('#graph-ctx-menu')||e.target.closest('#graph-node-panel')) return;
      gS.pan = { on:true, sx:e.clientX, sy:e.clientY, tx:gS.tr.x, ty:gS.tr.y };
      canvas.classList.add('panning'); e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!gS.pan.on) return;
      gS.tr.x = gS.pan.tx + (e.clientX-gS.pan.sx);
      gS.tr.y = gS.pan.ty + (e.clientY-gS.pan.sy);
      _applyTr(); _updateMM();
    });
    window.addEventListener('mouseup', () => {
      if (gS.pan.on) { gS.pan.on=false; canvas.classList.remove('panning'); }
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const r=canvas.getBoundingClientRect();
      zoomAt(e.clientX-r.left, e.clientY-r.top, gS.tr.s+(e.deltaY>0?-0.15:0.15));
    }, {passive:false});
    canvas.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (e.target.closest('#graph-ctx-menu')) return;
      const ng=e.target.closest('.gn-group');
      if (ng) { const nd=gS.nodeMap.get(ng.dataset.id); if(nd){ gS.selected=nd.id; renderGraph(); _showCtx(e.clientX,e.clientY,nd); return; } }
      _hideCtx();
    });
    window.addEventListener('click', e => { if(!document.getElementById('graph-ctx-menu')?.contains(e.target)) _hideCtx(); });
    document.addEventListener('keydown', e => {
      if (!_vis) return;
      if (e.key==='f'||e.key==='F') fitView(true);
      if (e.key==='+'||e.key==='=') zoomBy(0.2);
      if (e.key==='-') zoomBy(-0.2);
      if (e.key==='Escape') _closePan();
    });
    gS.mmEl.addEventListener('click', e => {
      const r=gS.mmEl.getBoundingClientRect(); _mmNav(e.clientX-r.left, e.clientY-r.top);
    });
  }

  // ── Context menu ──────────────────────────────────────────────────────────
  let _ctxTgt = null;
  function _showCtx(x,y,nd) {
    _ctxTgt=nd;
    const m=document.getElementById('graph-ctx-menu'); if(!m) return;
    m.classList.add('vis');
    m.style.left=x+'px'; m.style.top=y+'px';
    const isSyn=nd._syn;
    m.querySelector('#g-ctx-rename').style.display=isSyn?'none':'';
    m.querySelector('#g-ctx-cycle').style.display=isSyn?'none':'';
    m.querySelector('#g-ctx-del').style.display=isSyn?'none':'';
    requestAnimationFrame(()=>{
      const r=m.getBoundingClientRect();
      if(r.right>window.innerWidth) m.style.left=(x-r.width)+'px';
      if(r.bottom>window.innerHeight) m.style.top=(y-r.height)+'px';
    });
  }
  function _hideCtx() { document.getElementById('graph-ctx-menu')?.classList.remove('vis'); _ctxTgt=null; }
  function _bindCtx(m) {
    m.querySelector('#g-ctx-add').addEventListener('click',()=>{
      _hideCtx();
      const pid=_ctxTgt?._syn?null:_ctxTgt?.id;
      if(typeof Render!=='undefined') Render.addNodeInline(pid);
    });
    m.querySelector('#g-ctx-rename').addEventListener('click',()=>{
      _hideCtx();
      if(_ctxTgt&&typeof Render!=='undefined') Render.selectNode(_ctxTgt.id);
    });
    m.querySelector('#g-ctx-cycle').addEventListener('click',()=>{
      _hideCtx(); if(!_ctxTgt) return;
      _cycleStatus(_ctxTgt.id);
    });
    m.querySelector('#g-ctx-del').addEventListener('click',()=>{
      _hideCtx(); if(!_ctxTgt) return;
      const node=AppState.findNode(_ctxTgt.id);
      const msg=node?.children?.length?'Удалить вопрос и все подвопросы?':'Удалить вопрос?';
      if(!confirm(msg)) return;
      const topic=AppState.getCurrentTopic(); if(!topic) return;
      TreeHelpers.removeNode(topic.nodes,_ctxTgt.id); Persist.save();
      if(_panNodeId===_ctxTgt.id) _closePan();
      if(typeof Render!=='undefined'){ Render.renderTree(); Render.renderBreadcrumb(); }
      refreshGraph();
    });
  }

  // ── Node panel (slide-in overlay) ─────────────────────────────────────────
  function _openPan(nodeId) {
    const node=AppState.findNode(nodeId); if(!node) return;
    _panNodeId=nodeId; _panMode='view';
    AppState.set('selectedNodeId',nodeId);
    if(typeof Render!=='undefined') Render.renderBreadcrumb();
    const pan=document.getElementById('graph-node-panel');
    const bd=document.getElementById('graph-panel-backdrop');
    if(pan){ pan.classList.add('open'); pan.style.width=''; }
    if(bd) bd.classList.add('vis');
    gS.selected=nodeId; renderGraph();
    _renderPanelView(node); _updatePanHeader(node);
  }

  function _closePan() {
    _panNodeId=null;
    const pan=document.getElementById('graph-node-panel');
    const bd=document.getElementById('graph-panel-backdrop');
    if(pan) pan.classList.remove('open');
    if(bd) bd.classList.remove('vis');
    gS.selected=null; AppState.set('selectedNodeId',null); renderGraph();
  }

  function _updatePanHeader(node) {
    const titleEl=document.getElementById('gnp-title');
    const actEl=document.getElementById('gnp-actions');
    if(!titleEl||!actEl||!node) return;
    titleEl.textContent=_panMode==='edit'?'✏ Редактор':'Ответ';
    actEl.innerHTML=_panMode==='view'?`
      <button class="icon-btn-sm ap-hdr-btn" id="gnp-hdr-edit" title="Редактировать (E)">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2l2 2-7 7H3v-2l7-7z" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn-sm ap-hdr-btn" id="gnp-hdr-copy" title="Копировать">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="9" rx="1.5"/><path d="M2 10V2.5A1.5 1.5 0 013.5 1H10" stroke-linecap="round"/></svg>
      </button>
      <button class="icon-btn-sm ap-hdr-btn" id="gnp-hdr-close" title="Закрыть (Esc)">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l8 8M11 3l-8 8" stroke-linecap="round"/></svg>
      </button>`:`
      <button class="icon-btn-sm ap-hdr-btn" id="gnp-hdr-close" title="Закрыть (Esc)">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l8 8M11 3l-8 8" stroke-linecap="round"/></svg>
      </button>`;
    document.getElementById('gnp-hdr-edit')?.addEventListener('click',()=>{ _panMode='edit'; _renderPanelEdit(node); _updatePanHeader(node); });
    document.getElementById('gnp-hdr-copy')?.addEventListener('click',()=>{ if(node.answer) navigator.clipboard?.writeText(node.answer); });
    document.getElementById('gnp-hdr-close')?.addEventListener('click',_closePan);
  }

  function _renderPanelView(node) {
    const topic=AppState.getCurrentTopic();
    const path=TreeHelpers.getPath(topic?.nodes||[],node.id)||[];
    const stats=TreeHelpers.getStats(topic?.nodes||[]);
    const siblings=_getSiblings(node.id);
    const prevId=siblings[siblings.indexOf(node.id)-1];
    const nextId=siblings[siblings.indexOf(node.id)+1];
    const pct=Math.round(stats.done/Math.max(stats.total,1)*100);
    const sl={open:'○ Открыт',active:'◐ Изучается',done:'● Готово'};
    const pl=n=>n===1?'':n>=2&&n<=4?'а':'ов';

    const bc=[
      `<span class="ap-bc-topic">${esc(topic?.name||'')}</span>`,
      ...path.slice(0,-1).map(n=>`<span class="ap-bc-node" data-open-node="${n.id}">${esc(n.label)}</span>`),
    ].join('<span class="ap-bc-sep"> › </span>');

    const cont=document.getElementById('gnp-content'); if(!cont) return;
    cont.innerHTML=`
      <div class="ap-view">
        <div class="ap-breadcrumb">${bc}</div>
        <h1 class="ap-question-title">${esc(node.label)}</h1>
        <div class="ap-meta-row">
          <button class="ap-status-pill status-${node.status}" data-cycle-status="${node.id}">${sl[node.status]||node.status}</button>
          ${node.children?.length?`<span class="ap-meta-chip">↳ ${node.children.length} подвопрос${pl(node.children.length)}</span>`:''}
          <span class="ap-meta-chip">${stats.done}/${stats.total} готово</span>
          <div class="ap-progress-bar" title="${pct}%"><div class="ap-progress-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="ap-answer-body" id="gnp-ans-body">
          ${node.answer?'<!-- render by JS -->':`<div class="ap-no-answer">
            <div class="ap-no-answer-icon">✦</div><p>Ответа пока нет</p>
            <p class="ap-no-answer-hint">Нажми «Редактировать» или скопируй ответ из ИИ.</p>
            <button class="btn-primary gnp-write-btn">Написать ответ</button></div>`}
        </div>
        ${node.children?.length?`
          <div class="ap-children-section">
            <div class="ap-children-title">Подвопросы</div>
            <div class="ap-children-list">
              ${node.children.map(ch=>`
                <div class="ap-child-item" data-open-node="${ch.id}">
                  <span class="ap-child-status status-dot-${ch.status}"></span>
                  <span class="ap-child-label">${esc(ch.label)}</span>
                  ${ch.answer?'<span class="ap-child-badge">✓</span>':''}
                </div>`).join('')}
            </div>
          </div>`:''}
        <div class="ap-nav-row">
          <button class="ap-nav-btn" ${!prevId?'disabled':''} data-nav-node="${prevId||''}">
            <svg viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 1L1 5l5 4M1 5h12" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Предыдущий
          </button>
          <button class="ap-nav-btn" ${!nextId?'disabled':''} data-nav-node="${nextId||''}">
            Следующий
            <svg viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1l5 4-5 4M13 5H1" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>`;

    cont.querySelector('.gnp-write-btn')?.addEventListener('click',()=>{ _panMode='edit'; _renderPanelEdit(node); _updatePanHeader(node); });
    cont.querySelectorAll('[data-cycle-status]').forEach(el=>el.addEventListener('click',()=>{ _cycleStatus(el.dataset.cycleStatus); }));
    cont.querySelectorAll('[data-open-node]').forEach(el=>el.addEventListener('click',()=>{ _openPan(el.dataset.openNode); }));
    cont.querySelectorAll('[data-nav-node]').forEach(el=>el.addEventListener('click',()=>{ if(!el.disabled&&el.dataset.navNode) _openPan(el.dataset.navNode); }));

    const bodyEl=document.getElementById('gnp-ans-body');
    if(bodyEl&&node.answer&&typeof AnswerPanel!=='undefined') AnswerPanel._renderIntoContainer(bodyEl,node.answer);
  }

  function _renderPanelEdit(node) {
    const cont=document.getElementById('gnp-content'); if(!cont) return;
    cont.innerHTML=`
      <div class="ap-edit">
        <div class="ap-edit-header">
          <div class="ap-edit-question">${esc(node.label)}</div>
          <div class="ap-edit-hint">Ctrl+S — сохранить · Esc — отмена</div>
        </div>
        <div class="ap-fmt-toolbar" id="gnp-fmt">
          <button class="ap-fmt-btn" data-fmt="bold"><b>B</b></button>
          <button class="ap-fmt-btn" data-fmt="italic"><i>I</i></button>
          <button class="ap-fmt-btn" data-fmt="strike"><s>S</s></button>
          <div class="ap-fmt-sep"></div>
          <button class="ap-fmt-btn" data-fmt="h2">H2</button>
          <button class="ap-fmt-btn" data-fmt="h3">H3</button>
          <div class="ap-fmt-sep"></div>
          <button class="ap-fmt-btn" data-fmt="ul">• ul</button>
          <button class="ap-fmt-btn" data-fmt="ol">1. ol</button>
          <button class="ap-fmt-btn" data-fmt="quote">❝</button>
          <div class="ap-fmt-sep"></div>
          <button class="ap-fmt-btn mono" data-fmt="code">&lt;/&gt;</button>
          <button class="ap-fmt-btn mono" data-fmt="codeblock">&#96;&#96;&#96;</button>
        </div>
        <div class="ap-editor-area">
          <textarea class="ap-textarea" id="gnp-ta" spellcheck="true" placeholder="Напиши ответ в Markdown…"></textarea>
        </div>
        <div class="ap-edit-footer">
          <span class="ap-char-count" id="gnp-cc">${(node.answer||'').length} симв.</span>
          <div class="ap-edit-footer-right">
            <button class="btn-secondary" id="gnp-cancel">Отмена</button>
            <button class="btn-primary" id="gnp-save">Сохранить</button>
          </div>
        </div>
      </div>`;
    const ta=document.getElementById('gnp-ta');
    if(ta){ ta.value=node.answer||''; ta.addEventListener('input',()=>{ const cc=document.getElementById('gnp-cc'); if(cc) cc.textContent=ta.value.length+' симв.'; }); ta.focus(); ta.selectionStart=ta.selectionEnd=ta.value.length; ta.addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();_saveEdit(node.id);} if(e.key==='Escape'){e.preventDefault();_cancelEdit(node.id);} }); }
    document.getElementById('gnp-fmt')?.querySelectorAll('[data-fmt]').forEach(btn=>btn.addEventListener('click',e=>{e.preventDefault();_applyFmt(btn.dataset.fmt,ta);}));
    document.getElementById('gnp-save').addEventListener('click',()=>_saveEdit(node.id));
    document.getElementById('gnp-cancel').addEventListener('click',()=>_cancelEdit(node.id));
  }

  function _saveEdit(nodeId) {
    const ta=document.getElementById('gnp-ta'); if(!ta) return;
    const text=ta.value.trim();
    if(typeof AnswerPanel!=='undefined') AnswerPanel.setAnswer(nodeId,text);
    else { const t=AppState.getCurrentTopic(); if(t){ TreeHelpers.updateNode(t.nodes,nodeId,{answer:text,status:'done'}); Persist.save(); } }
    const nd=gS.nodeMap.get(nodeId); if(nd){ nd.answer=text; nd.hasAnswer=!!text; nd.status='done'; }
    _panMode='view'; const node=AppState.findNode(nodeId); if(node){ _renderPanelView(node); _updatePanHeader(node); } renderGraph();
  }
  function _cancelEdit(nodeId) {
    _panMode='view'; const node=AppState.findNode(nodeId); if(node){ _renderPanelView(node); _updatePanHeader(node); }
  }

  function _cycleStatus(nodeId) {
    const topic=AppState.getCurrentTopic(); if(!topic) return;
    const node=AppState.findNode(nodeId); if(!node) return;
    const order=['open','active','done'];
    const next=order[(order.indexOf(node.status)+1)%order.length];
    TreeHelpers.updateNode(topic.nodes,nodeId,{status:next}); Persist.save();
    const nd=gS.nodeMap.get(nodeId); if(nd) nd.status=next;
    renderGraph();
    if(_panNodeId===nodeId){ const n=AppState.findNode(nodeId); if(n){_renderPanelView(n);_updatePanHeader(n);} }
  }

  function _getSiblings(nodeId) {
    const topic=AppState.getCurrentTopic(); if(!topic) return [];
    const pid=TreeHelpers.findParentId(topic.nodes,nodeId);
    const s=pid==null?topic.nodes:(AppState.findNode(pid)?.children||[]);
    return s.map(n=>n.id);
  }

  function _applyFmt(fmt,ta) {
    if(!ta) return;
    const s=ta.selectionStart,e=ta.selectionEnd,sel=ta.value.slice(s,e),pre=ta.value.slice(0,s),suf=ta.value.slice(e);
    const map={
      bold:{wrap:['**','**'],ph:'текст'},italic:{wrap:['*','*'],ph:'текст'},strike:{wrap:['~~','~~'],ph:'текст'},
      code:{wrap:['`','`'],ph:'код'},h2:{line:'## ',ph:'Заголовок'},h3:{line:'### ',ph:'Заголовок'},
      ul:{line:'- ',ph:'пункт'},ol:{line:'1. ',ph:'пункт'},quote:{line:'> ',ph:'цитата'},
      codeblock:{insert:`\n\`\`\`\n${sel||'код'}\n\`\`\`\n`},
    };
    const rule=map[fmt]; if(!rule) return;
    let ins,cur;
    if(rule.insert!==undefined){ins=rule.insert;cur=s+ins.length;}
    else if(rule.wrap){const[o,c]=rule.wrap,t=sel||rule.ph;ins=o+t+c;cur=sel?s+ins.length:s+o.length+t.length;}
    else{ins=rule.line+(sel||rule.ph);cur=s+ins.length;}
    ta.value=pre+ins+suf;ta.selectionStart=ta.selectionEnd=cur;ta.focus();
  }

  // ── Transform ──────────────────────────────────────────────────────────────
  function _applyTr() {
    if(!gS.svgEl) return;
    const {x,y,s}=gS.tr;
    gS.svgEl.style.transform=`translate(${x}px,${y}px) scale(${s})`;
    const el=document.getElementById('g-zp'); if(el) el.textContent=Math.round(s*100)+'%';
  }
  function zoomBy(d){ const c=gS.canvasEl; if(!c) return; const r=c.getBoundingClientRect(); zoomAt(r.width/2,r.height/2,gS.tr.s+d); }
  function zoomAt(cx,cy,ns){
    const s=Math.max(MIN_SC,Math.min(MAX_SC,ns)),ratio=s/gS.tr.s;
    gS.tr.x=cx-ratio*(cx-gS.tr.x); gS.tr.y=cy-ratio*(cy-gS.tr.y); gS.tr.s=s;
    _applyTr(); _updateMM();
  }
  function fitView(anim) {
    const c=gS.canvasEl; if(!c||!gS.nodes.length) return;
    const pad=80,cw=c.clientWidth,ch=c.clientHeight;
    let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
    gS.nodes.forEach(n=>{ x1=Math.min(x1,n.x);y1=Math.min(y1,n.y);x2=Math.max(x2,n.x+n.w);y2=Math.max(y2,n.y+n.h); });
    const gw=x2-x1+pad*2,gh=y2-y1+pad*2;
    const sc=Math.min(cw/gw,ch/gh,1.5);
    const tx=(cw-(x2-x1)*sc)/2-x1*sc,ty=(ch-(y2-y1)*sc)/2-y1*sc;
    if(anim) _animTo(tx,ty,sc,320); else{ gS.tr={x:tx,y:ty,s:sc}; _applyTr(); _updateMM(); }
  }
  function _animTo(tx,ty,sc,dur){
    const s0={...gS.tr},t0=performance.now();
    function tick(now){ const t=Math.min(1,(now-t0)/dur),e=1-Math.pow(1-t,3); gS.tr={x:s0.x+(tx-s0.x)*e,y:s0.y+(ty-s0.y)*e,s:s0.s+(sc-s0.s)*e}; _applyTr(); _updateMM(); if(t<1) requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  }
  function _centerOn(nd){ const c=gS.canvasEl; if(!c||!nd) return; const sc=Math.min(gS.tr.s,1.1); _animTo(c.clientWidth/2-(nd.x+nd.w/2)*sc,c.clientHeight/2-(nd.y+nd.h/2)*sc,sc,260); }

  // ── Minimap ────────────────────────────────────────────────────────────────
  function _updateMM(){ if(gS._mmPending) return; gS._mmPending=true; requestAnimationFrame(()=>{ gS._mmPending=false; _doMM(); }); }
  function _doMM(){
    const mm=gS.mmEl,c=gS.canvasEl; if(!mm||!c||!gS.nodes.length) return;
    let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
    gS.nodes.forEach(n=>{ x1=Math.min(x1,n.x);y1=Math.min(y1,n.y);x2=Math.max(x2,n.x+n.w);y2=Math.max(y2,n.y+n.h); });
    const pad=16,gw=x2-x1+pad*2,gh=y2-y1+pad*2;
    const ms=Math.min(MM_W/gw,MM_H/gh);
    const ox=(MM_W-gw*ms)/2-x1*ms+pad*ms,oy=(MM_H-gh*ms)/2-y1*ms+pad*ms;
    const {x:tx,y:ty,s:scale}=gS.tr;
    const cw=c.clientWidth,ch=c.clientHeight;
    const vpx=(-tx)/scale,vpy=(-ty)/scale,vpw=cw/scale,vph=ch/scale;
    const light=isLight();
    const ec=light?'rgba(92,78,245,0.18)':'rgba(167,139,250,0.22)';
    const vf=light?'rgba(92,78,245,0.07)':'rgba(167,139,250,0.08)';
    const vs=light?'rgba(92,78,245,0.4)':'rgba(167,139,250,0.45)';
    const lines=gS.edges.map(e=>{ const f=gS.nodeMap.get(e.from),t=gS.nodeMap.get(e.to); if(!f||!t) return ''; return `<line x1="${(f.x+f.w/2)*ms+ox}" y1="${(f.y+f.h/2)*ms+oy}" x2="${(t.x+t.w/2)*ms+ox}" y2="${(t.y+t.h/2)*ms+oy}" stroke="${ec}" stroke-width="0.7"/>`; }).join('');
    const rects=gS.nodes.map(n=>{ const col=sColor(n.status),sel=n.id===gS.selected; return `<rect x="${n.x*ms+ox}" y="${n.y*ms+oy}" width="${n.w*ms}" height="${n.h*ms}" rx="2" fill="${col.bg}" stroke="${sel?col.accent:col.border}" stroke-width="${sel?1.2:0.5}"/>`; }).join('');
    const vpr=`<rect x="${vpx*ms+ox}" y="${vpy*ms+oy}" width="${vpw*ms}" height="${vph*ms}" fill="${vf}" stroke="${vs}" stroke-width="0.8" rx="1"/>`;
    mm.innerHTML=`<svg viewBox="0 0 ${MM_W} ${MM_H}" xmlns="http://www.w3.org/2000/svg">${lines}${rects}${vpr}</svg>`;
    mm._mi={ms,ox,oy};
  }
  function _mmNav(mx,my){ const mm=gS.mmEl,c=gS.canvasEl; if(!mm||!c||!mm._mi) return; const {ms,ox,oy}=mm._mi; const gx=(mx-ox)/ms,gy=(my-oy)/ms,sc=gS.tr.s; _animTo(c.clientWidth/2-gx*sc,c.clientHeight/2-gy*sc,sc,220); }

  // ── Render graph ──────────────────────────────────────────────────────────
  function renderGraph() {
    const svg=gS.svgEl; if(!svg) return;
    const empty=document.getElementById('graph-empty');
    if(empty) empty.style.display=gS.nodes.length===0?'flex':'none';
    if(!gS.nodes.length){ ['g-bg','g-edges','g-nodes'].forEach(id=>{ const g=svg.querySelector('#'+id); if(g) g.innerHTML=''; }); return; }

    const q=gS.search.toLowerCase().trim(), filt=gS.filter, light=isLight();
    const inFilt=n=>filt==='all'||n.status===filt||n.status==='root';
    const inSearch=n=>!q||n.label.toLowerCase().includes(q);

    // ── Defs + background: всё одним вызовом (без дробного innerHTML +=) ──
    const defs=svg.querySelector('defs');
    if(defs){
      const dc=light?'rgba(0,0,0,0.06)':'rgba(255,255,255,0.055)';
      const sf=light?'rgba(0,0,0,0.16)':'rgba(0,0,0,0.5)';
      const sg=light?'rgba(92,78,245,0.28)':'rgba(167,139,250,0.45)';
      const grads={
        open:  light?['rgba(210,210,232,0.80)','rgba(190,190,220,0.55)']:['rgba(52,52,84,0.62)','rgba(36,36,68,0.42)'],
        active:light?['rgba(245,166,35,0.18)','rgba(245,166,35,0.08)']:['rgba(251,191,36,0.18)','rgba(251,191,36,0.06)'],
        done:  light?['rgba(16,155,70,0.14)','rgba(16,155,70,0.06)']:['rgba(52,211,153,0.18)','rgba(52,211,153,0.06)'],
        root:  light?['rgba(100,82,235,0.16)','rgba(100,82,235,0.07)']:['rgba(167,139,250,0.24)','rgba(167,139,250,0.09)'],
      };
      const gradHTML=Object.entries(grads).map(([name,[c1,c2]])=>
        `<linearGradient id="gf-${name}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient>`
      ).join('');
      // Единственный innerHTML = для всего содержимого defs
      defs.innerHTML=`
        <pattern id="g-dot-pat" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="14" cy="14" r="1.2" fill="${dc}"/>
        </pattern>
        <filter id="gn-sh" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="${light?2:4}" flood-color="${sf}" flood-opacity="1"/>
        </filter>
        <filter id="gn-sh-sel" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation="${light?6:10}" flood-color="${sg}" flood-opacity="1"/>
          <feDropShadow dx="0" dy="2" stdDeviation="${light?2:4}" flood-color="${sf}" flood-opacity="0.6"/>
        </filter>
        ${gradHTML}`;
    }
    const bgG=svg.querySelector('#g-bg');
    if(bgG) bgG.innerHTML=`<rect x="-10000" y="-10000" width="20000" height="20000" fill="url(#g-dot-pat)"/>`;

    // ── Edges ─────────────────────────────────────────────────────────────
    const edgeG=svg.querySelector('#g-edges');
    if(edgeG){
      edgeG.innerHTML=gS.edges.map(e=>{
        const f=gS.nodeMap.get(e.from),t=gS.nodeMap.get(e.to); if(!f||!t) return '';
        const fx=f.x+f.w,fy=f.y+f.h/2,tx=t.x,ty=t.y+t.h/2,cx=(fx+tx)/2;
        const path=`M${fx},${fy} C${cx},${fy} ${cx},${ty} ${tx},${ty}`;
        const vis=inFilt(f)&&inSearch(f)&&inFilt(t)&&inSearch(t);
        const op=vis?1:(q?0.04:0.07);
        const col=sColor(t.status);
        const isDone=t.status==='done', isActive=t.status==='active';
        const sw=isDone?1.5:isActive?1.8:1.2;
        const dash=(!isDone&&!isActive)?'stroke-dasharray="5 4"':'';
        const anim=isActive?'class="g-edge-anim"':'';
        return `<path ${anim} d="${path}" fill="none" stroke="${col.accent}" stroke-width="${sw}" ${dash} opacity="${op}" stroke-linecap="round"/>`;
      }).join('');
    }

    // ── Nodes ──────────────────────────────────────────────────────────────
    const nodeG=svg.querySelector('#g-nodes'); if(!nodeG) return;
    nodeG.innerHTML='';
    gS.nodes.forEach(n=>{
      const col=sColor(n.status);
      const sel=n.id===gS.selected;
      const vis=inFilt(n);
      const op=!vis?0.07:(q&&!inSearch(n)?0.06:1);
      const {w,h,lines}=n;

      const g=document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('class','gn-group');
      g.setAttribute('data-id',n.id);
      g.setAttribute('transform',`translate(${n.x},${n.y})`);
      g.style.opacity=op;

      // Main rect with gradient fill
      const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
      rect.setAttribute('class','gn-rect');
      rect.setAttribute('width',w); rect.setAttribute('height',h);
      rect.setAttribute('rx',NODE_R); rect.setAttribute('ry',NODE_R);
      rect.setAttribute('fill',`url(#gf-${n.status})`);
      rect.setAttribute('stroke',col.border);
      rect.setAttribute('stroke-width',sel?'1.6':'0.8');
      rect.setAttribute('filter',sel?'url(#gn-sh-sel)':'url(#gn-sh)');
      g.appendChild(rect);

      // Top highlight (glass shimmer)
      const shine=document.createElementNS('http://www.w3.org/2000/svg','rect');
      shine.setAttribute('x','1'); shine.setAttribute('y','1');
      shine.setAttribute('width',w-2); shine.setAttribute('height',Math.min(22,h/2));
      shine.setAttribute('rx',NODE_R-1);
      shine.setAttribute('fill',isLight()?'rgba(255,255,255,0.35)':'rgba(255,255,255,0.07)');
      g.appendChild(shine);

      // Left accent stripe
      const stripe=document.createElementNS('http://www.w3.org/2000/svg','rect');
      stripe.setAttribute('x','0'); stripe.setAttribute('y',String(NODE_R));
      stripe.setAttribute('width','3'); stripe.setAttribute('height',String(h-NODE_R*2));
      stripe.setAttribute('rx','1.5'); stripe.setAttribute('fill',col.accent);
      stripe.setAttribute('opacity',isLight()?'0.85':'0.8');
      g.appendChild(stripe);

      // Selected: animated ring
      if(sel){
        const ring=document.createElementNS('http://www.w3.org/2000/svg','rect');
        ring.setAttribute('class','gn-sel-ring');
        ring.setAttribute('x','-3'); ring.setAttribute('y','-3');
        ring.setAttribute('width',w+6); ring.setAttribute('height',h+6);
        ring.setAttribute('rx',NODE_R+2);
        ring.setAttribute('fill','none');
        ring.setAttribute('stroke',col.accent);
        ring.setAttribute('stroke-width','1.5');
        ring.setAttribute('stroke-dasharray','6 3');
        ring.setAttribute('opacity','0.75');
        g.appendChild(ring);
      }

      // Label text
      const textX=PAD_X+2, textFill=isLight()?'#1a1a32':'#e4e8f4';
      let textY=PAD_Y+FONT_SZ;
      lines.forEach(line=>{
        const t=document.createElementNS('http://www.w3.org/2000/svg','text');
        t.setAttribute('class','gn-text'); t.setAttribute('x',textX); t.setAttribute('y',textY);
        t.setAttribute('font-size',FONT_SZ); t.setAttribute('fill',textFill);
        t.textContent=line; g.appendChild(t); textY+=LINE_H;
      });

      // Status dot (bottom-right) + answer indicator
      const dotY=h-9,dotX=w-11;
      const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');
      dot.setAttribute('cx',dotX); dot.setAttribute('cy',dotY);
      dot.setAttribute('r','4'); dot.setAttribute('fill',col.dot);
      dot.setAttribute('opacity',n.status==='open'?'0.45':'0.9');
      g.appendChild(dot);

      if(n.hasAnswer){
        const check=document.createElementNS('http://www.w3.org/2000/svg','text');
        check.setAttribute('x',String(w-PAD_X)); check.setAttribute('y',String(h-PAD_Y+2));
        check.setAttribute('font-size','9'); check.setAttribute('fill',col.accent);
        check.setAttribute('text-anchor','end'); check.setAttribute('opacity','0.7');
        check.textContent='✓'; g.appendChild(check);
      }

      // Search highlight dot
      if(q&&inSearch(n)){
        const hl=document.createElementNS('http://www.w3.org/2000/svg','circle');
        hl.setAttribute('cx',String(w-8)); hl.setAttribute('cy','8');
        hl.setAttribute('r','4'); hl.setAttribute('fill','var(--accent)'); hl.setAttribute('opacity','0.85');
        g.appendChild(hl);
      }

      g.addEventListener('click',()=>{ _openPan(n.id); _centerOn(n); });
      nodeG.appendChild(g);
    });

    _applyTr(); _updateMM();
  }

  // ── Show / hide ────────────────────────────────────────────────────────────
  function applyViewMode(mode) {
    if(mode==='graph'){ if(!_vis) _show(); }
    else { if(_vis) _hide(); }
  }
  function _show(){
    _vis=true;
    const panel=document.getElementById('panel-graph'); if(!panel) return;
    let gv=document.getElementById('graph-view');
    if(!gv){ gv=buildDOM(panel); } else { gv.style.display='flex'; if(gv.parentElement!==panel) panel.appendChild(gv); }
    void panel.offsetHeight; refreshGraph();
    if(!panel._ro){ panel._ro=new ResizeObserver(()=>{ if(_vis) fitView(false); }); panel._ro.observe(panel); }
  }
  function _hide(){
    _vis=false;
    const gv=document.getElementById('graph-view'); if(gv) gv.style.display='none';
    document.getElementById('panel-graph')?.classList.remove('active');
    _closePan();
  }

  function refreshGraph(){
    if(!_vis) return;
    const data=buildData();
    gS.nodes=data.nodes; gS.edges=data.edges; gS.nodeMap=data.nodeMap;
    if(!gS.nodeMap.has(gS.selected)) { gS.selected=null; }
    renderGraph();
    _fitWhenReady(0);
    if(_panNodeId){
      const node=AppState.findNode(_panNodeId);
      if(node&&_panMode==='view'){ _renderPanelView(node); _updatePanHeader(node); }
      else if(!node) _closePan();
    }
  }
  function _fitWhenReady(n){
    const c=gS.canvasEl;
    if(c&&c.clientWidth>0&&c.clientHeight>0) fitView(false);
    else if(n<20) requestAnimationFrame(()=>_fitWhenReady(n+1));
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init(){
    new MutationObserver(()=>{ if(_vis) renderGraph(); }).observe(document.body,{attributes:true,attributeFilter:['data-theme']});
    AppState.on('currentTopicId',()=>{ if(_panNodeId) _closePan(); if(_vis) setTimeout(refreshGraph,40); });
    AppState.on('topics',()=>{ if(_vis) setTimeout(refreshGraph,20); });
    document.addEventListener('keydown',e=>{ if(!_vis||_panMode==='edit') return; if(e.key==='e'&&!e.ctrlKey&&!e.metaKey&&_panNodeId&&document.activeElement===document.body){ e.preventDefault(); const n=AppState.findNode(_panNodeId); if(n){_panMode='edit';_renderPanelEdit(n);_updatePanHeader(n);} } });
    window.graphModule={refresh:refreshGraph,fitView,applyViewMode};
    console.log('[graph v6] init');
  }

  // Edge animation CSS
  if(!document.getElementById('g-anim-css')){
    const s=document.createElement('style'); s.id='g-anim-css';
    s.textContent=`
      @keyframes g-flow{to{stroke-dashoffset:-18}}
      .g-edge-anim{animation:g-flow .9s linear infinite}
      @keyframes gn-sel-spin{to{stroke-dashoffset:-18}}
      .gn-sel-ring{animation:gn-sel-spin 3s linear infinite}`;
    document.head.appendChild(s);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(init,100));
  else setTimeout(init,100);
})();
