
//




//







const MIN_PX = 40;
const EDGE_PX = 24;
const TRASH_HIT_PX = 46;
const TRASH_GLOW_PX = 150;
const PREVIEW_DELAY = 350;
const SURFACE_EDGE_PX = 8;

const DOCK_PALETTE = ['#7a8294', '#6382b8', '#8a7462', '#6c8d7a', '#8b6f85', '#b8794f', '#5f9ea0', '#9a6f9a'];
const LAYOUT_KEY = 'segment_layout_v1';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class Workspace {
  constructor(root, panels) {
    this.root = root;
    this.panels = panels.slice();
    this.frames = {};       // id -> { wrapper, dispose }
    this.docked = [];
    this._unread = new Set();
    this._surface = null;

    this.tree = this._defaultTree(this.panels);
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
      const ids = new Set(this.panels.map((p) => p.id));
      const valid = (n) => n && (n.type === 'leaf' ? ids.has(n.id) : n.type === 'split' && ['row', 'col'].includes(n.dir) && n.children?.every(valid));
      if (valid(saved?.tree)) this.tree = saved.tree;
      if (Array.isArray(saved?.docked)) this.docked = saved.docked.filter((d) => ids.has(d.id) && ['left', 'right'].includes(d.side));
    } catch {}

    this._buildOverlays();
    for (const panel of this.panels) this._buildFrame(panel);
    this._apply();
    this._renderDocks();
  }

  _persist() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tree: this.tree, docked: this.docked })); } catch {}
  }

  resetLayout() {
    this.docked = [];
    this.tree = this._defaultTree(this.panels.filter((p) => !p.removable));
    this._renderDocks(true); this._apply(true); this._persist();
  }


  _def(id) { return this.panels.find((p) => p.id === id); }
  _removable(id) { return !!this._def(id)?.removable; }
  _hideable(id) { return !!this._def(id)?.hideable; }


  _defaultTree(panels) {
    const leaf = (id) => panels.find((p) => p.id === id) && { type: 'leaf', id, weight: 1 };
    const profile = leaf('profile');
    const chatList = leaf('chat-list');
    const chatRoom = leaf('chat-room');

    if (profile && chatList && chatRoom) {
      profile.weight = 0;
      chatList.weight = 1;
      return {
        type: 'split', dir: 'row', weight: 1,
        children: [
          { type: 'split', dir: 'col', weight: 1, children: [profile, chatList] },
          { ...chatRoom, weight: 1.6 },
        ],
      };
    }
    return {
      type: 'split', dir: 'row', weight: 1,
      children: panels.map((p) => ({ type: 'leaf', id: p.id, weight: p.weight ?? 1 })),
    };
  }



  _buildOverlays() {
    this.trashEl = document.createElement('div');
    this.trashEl.className = 'ws-trash';
    document.body.appendChild(this.trashEl);

    this.dockEls = {};
    this.dockHints = {};
    for (const side of ['left', 'right']) {
      const dock = document.createElement('div');
      dock.className = `ws-dock ws-dock-${side}`;
      document.body.appendChild(dock);
      this.dockEls[side] = dock;

      const hint = document.createElement('div');
      hint.className = `ws-dockhint ws-dockhint-${side}`;
      document.body.appendChild(hint);
      this.dockHints[side] = hint;
    }

    this.previewEl = document.createElement('div');
    this.previewEl.className = 'ws-preview';
    document.body.appendChild(this.previewEl);
    this.previewEl.addEventListener('pointerenter', () => clearTimeout(this._previewHideT));
    this.previewEl.addEventListener('pointerleave', () => this._hidePreview());


    this.paletteEl = document.createElement('div');
    this.paletteEl.className = 'ws-dock-palette';
    document.body.appendChild(this.paletteEl);
    for (const c of DOCK_PALETTE) {
      const sw = document.createElement('div');
      sw.className = 'ws-dock-swatch';
      sw.style.background = c;
      sw.addEventListener('pointerdown', (e) => { e.preventDefault(); this._pickDockColor(c); });
      this.paletteEl.appendChild(sw);
    }
    const reset = document.createElement('div');
    reset.className = 'ws-dock-swatch reset';
    reset.textContent = '⭯';
    reset.setAttribute('aria-label', 'Сбросить цвет');
    reset.addEventListener('pointerdown', (e) => { e.preventDefault(); this._pickDockColor(null); });
    this.paletteEl.appendChild(reset);

    this.paletteEl.addEventListener('pointerenter', () => clearTimeout(this._previewHideT));
    this.paletteEl.addEventListener('pointerleave', () => this._hidePreview());
  }


  _horizontalSizingTarget(id, node = this.tree) {
    if (!node || node.type === 'leaf') return null;
    for (let index = 0; index < node.children.length; index++) {
      const child = node.children[index];
      if (!this._containsLeaf(child, id)) continue;
      return this._horizontalSizingTarget(id, child)
        || (node.dir === 'row' ? { node, index } : null);
    }
    return null;
  }

  _containsLeaf(node, id) {
    if (!node) return false;
    if (node.type === 'leaf') return node.id === id;
    return node.children.some((child) => this._containsLeaf(child, id));
  }

  _resizePanelWidth(id, requestedWidth) {
    const frame = this.frames[id]?.wrapper;
    const target = this._horizontalSizingTarget(id);
    if (!frame?.isConnected || !target) return requestedWidth;

    let branchEl = frame;
    while (branchEl.parentElement && !branchEl.parentElement.classList.contains('split-row')) {
      branchEl = branchEl.parentElement;
    }
    const splitEl = branchEl.parentElement;
    if (!splitEl?.classList.contains('split-row')) return requestedWidth;

    const childEls = [...splitEl.children].filter((child) => !child.classList.contains('splitter'));
    if (childEls.length !== target.node.children.length || childEls[target.index] !== branchEl) return requestedWidth;

    const available = childEls.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
    const otherMin = childEls.reduce((sum, child, index) => (
      index === target.index ? sum : sum + this._minSize(child, true)
    ), 0);
    const minTarget = this._minSize(branchEl, true);
    const width = clamp(requestedWidth, minTarget, Math.max(minTarget, available - otherMin));
    const totalWeight = target.node.children.reduce((sum, child) => sum + (child.weight || 0), 0) || 1;
    const targetWeight = totalWeight * (width / available);
    const remainingWeight = Math.max(0, totalWeight - targetWeight);
    const otherWeight = target.node.children.reduce((sum, child, index) => (
      index === target.index ? sum : sum + (child.weight || 0)
    ), 0) || 1;

    target.node.children.forEach((child, index) => {
      child.weight = index === target.index
        ? targetWeight
        : remainingWeight * ((child.weight || 0) / otherWeight);
      childEls[index].style.flex = `${child.weight / totalWeight} 1 0`;
    });
    this._persist();
    return width;
  }

  openSurface({ id, sourceId, minWidth = 300, maxWidth = 680, className = '', mount }) {
    if (!id || !sourceId || typeof mount !== 'function') return null;
    if (this._surface?.id === id) return this._surface.element;
    this.closeSurface();

    const source = this.frames[sourceId]?.wrapper;
    if (!source?.isConnected) return null;
    const sourceRect = source.getBoundingClientRect();
    const side = sourceRect.left + sourceRect.width / 2 <= window.innerWidth / 2 ? 'left' : 'right';
    const widthLimit = () => Math.max(0, Math.min(maxWidth, window.innerWidth - SURFACE_EDGE_PX * 2));
    const effectiveMinWidth = () => Math.min(minWidth, widthLimit());
    let width = clamp(sourceRect.width, effectiveMinWidth(), widthLimit());

    const element = document.createElement('section');
    element.className = `workspace-surface workspace-surface-${side}${className ? ` ${className}` : ''}`;
    element.dataset.surfaceId = id;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    element.innerHTML = `
      <button class="workspace-surface-close" type="button" aria-label="Закрыть"></button>
      <div class="workspace-surface-body"></div>
      <div class="workspace-surface-resizer" aria-hidden="true"></div>`;
    document.body.appendChild(element);

    const place = () => {
      const rect = source.getBoundingClientRect();
      width = clamp(width, effectiveMinWidth(), widthLimit());
      element.style.width = `${width}px`;
      if (side === 'left') {
        element.style.left = `${clamp(rect.left, SURFACE_EDGE_PX, window.innerWidth - width - SURFACE_EDGE_PX)}px`;
        element.style.right = 'auto';
      } else {
        element.style.right = `${clamp(window.innerWidth - rect.right, SURFACE_EDGE_PX, window.innerWidth - width - SURFACE_EDGE_PX)}px`;
        element.style.left = 'auto';
      }
    };
    place();

    let dispose = mount(element.querySelector('.workspace-surface-body'), () => this.closeSurface(id));
    if (typeof dispose !== 'function') dispose = () => {};
    const syncFromSource = () => {
      if (!source.isConnected || this._surface?.element !== element) return;
      width = clamp(source.getBoundingClientRect().width, effectiveMinWidth(), widthLimit());
      place();
    };
    const sourceResizeObserver = new ResizeObserver(syncFromSource);
    sourceResizeObserver.observe(source);
    this._surface = { id, sourceId, element, dispose, place, syncFromSource, sourceResizeObserver };

    element.querySelector('.workspace-surface-close').addEventListener('click', () => this.closeSurface(id));
    element.querySelector('.workspace-surface-resizer').addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const onMove = (moveEvent) => {
        const delta = (moveEvent.clientX - startX) * (side === 'left' ? 1 : -1);
        const desired = clamp(startWidth + delta, effectiveMinWidth(), widthLimit());
        width = this._resizePanelWidth(sourceId, desired);
        place();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('is-resizing-surface');
      };
      document.body.classList.add('is-resizing-surface');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    this._surfaceResizeController?.abort();
    this._surfaceResizeController = new AbortController();
    window.addEventListener('resize', syncFromSource, { signal: this._surfaceResizeController.signal });
    requestAnimationFrame(() => element.classList.add('is-open'));
    return element;
  }

  closeSurface(id = null) {
    const surface = this._surface;
    if (!surface || (id && surface.id !== id)) return false;
    this._surface = null;
    this._surfaceResizeController?.abort();
    this._surfaceResizeController = null;
    surface.sourceResizeObserver?.disconnect();
    surface.dispose?.();
    surface.element.classList.remove('is-open');
    surface.element.classList.add('is-closing');
    setTimeout(() => surface.element.remove(), 300);
    return true;
  }



  _buildFrame(panel) {
    const wrapper = document.createElement('div');
    wrapper.className = 'panel';
    wrapper.dataset.id = panel.id;

    const head = document.createElement('div');
    head.className = 'panel-head';
    head.innerHTML = '<span class="panel-grip"></span>';

    const body = document.createElement('div');
    body.className = 'panel-body';
    wrapper.append(head, body);

    const dispose = panel.mount(body) || (() => {});
    this.frames[panel.id] = { wrapper, dispose };

    head.addEventListener('pointerdown', (e) => this._drag(e, panel.id, this.isDocked(panel.id)));
  }



  _apply(animate = false) {
    const first = animate ? this._snapshot() : null;
    this.root.innerHTML = '';
    if (this.tree) {
      const top = this._buildNode(this.tree);
      top.style.flex = '1';
      this.root.appendChild(top);
    }
    if (animate) this._playFlip(first);
    this._persist();
  }

  _buildNode(node) {
    if (node.type === 'leaf') return this.frames[node.id].wrapper;

    const el = document.createElement('div');
    el.className = `split split-${node.dir}`;

    const total = node.children.reduce((s, c) => s + (c.weight || 0), 0) || 1;
    const childEls = node.children.map((child) => {
      const ce = this._buildNode(child);
      ce.style.flex = `${(child.weight || 0) / total} 1 0`;
      return ce;
    });

    childEls.forEach((ce, i) => {
      el.appendChild(ce);
      if (i < childEls.length - 1) {
        el.appendChild(this._splitter(node, i, childEls[i], childEls[i + 1]));
      }
    });
    return el;
  }

  _snapshot() {
    const map = {};
    for (const id in this.frames) {
      const el = this.frames[id].wrapper;
      if (el.isConnected) { const r = el.getBoundingClientRect(); map[id] = { x: r.left, y: r.top }; }
    }
    return map;
  }

  _playFlip(first) {
    for (const id in this.frames) {
      const el = this.frames[id].wrapper;
      const was = first[id];
      if (!was || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const dx = was.x - r.left;
      const dy = was.y - r.top;
      if (!dx && !dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform .18s ease';
        el.style.transform = '';
      });
    }
  }



  _renderDocks(animate = false) {
    const first = animate ? this._dockSnapshot() : null;
    this._slot = null;
    for (const side of ['left', 'right']) {
      const dock = this.dockEls[side];
      dock.innerHTML = '';
      const items = this.docked.filter((d) => d.side === side);
      dock.classList.toggle('has-items', items.length > 0);
      items.forEach(({ id }) => {
        const item = document.createElement('div');
        item.className = 'ws-dock-item';
        item.dataset.id = id;
        const color = this._def(id)?._dockColor;
        if (color) item.style.setProperty('--dock-color', color);
        if (this._unread.has(id)) item.appendChild(this._makeDot());
        item.addEventListener('pointerdown', (e) => this._startDockItem(e, id));
        item.addEventListener('pointerenter', () => this._queuePreview(id, item));
        item.addEventListener('pointerleave', () => this._hidePreview());
        dock.appendChild(item);
      });
    }

    this.root.style.paddingLeft = this.docked.some((d) => d.side === 'left') ? '16px' : '';
    this.root.style.paddingRight = this.docked.some((d) => d.side === 'right') ? '16px' : '';
    if (animate) this._dockFlip(first);
  }

  _dockItemEl(id) { return this.dockEls.left.querySelector(`[data-id="${CSS.escape(id)}"]`) || this.dockEls.right.querySelector(`[data-id="${CSS.escape(id)}"]`); }
  _makeDot() { const d = document.createElement('div'); d.className = 'ws-dock-dot'; return d; }


  flagDockUnread(id) {
    if (!this.isDocked(id) || this._unread.has(id)) return;
    this._unread.add(id);
    const item = this._dockItemEl(id);
    if (item && !item.querySelector('.ws-dock-dot')) item.appendChild(this._makeDot());
  }

  _clearDockUnread(id) {
    if (!this._unread.delete(id)) return;
    this._dockItemEl(id)?.querySelector('.ws-dock-dot')?.remove();
  }


  _showPalette(id) {
    this._paletteId = id;
    const p = this.paletteEl;
    const pv = this.previewEl;


    const pvTop = parseFloat(pv.style.top) || 0;
    const pvW = pv.offsetWidth, pvH = pv.offsetHeight;
    const pvLeft = (pv.style.left && pv.style.left !== 'auto')
      ? parseFloat(pv.style.left)
      : window.innerWidth - parseFloat(pv.style.right || 0) - pvW;
    const w = p.offsetWidth || 150;
    p.style.left = `${clamp(pvLeft + (pvW - w) / 2, 8, window.innerWidth - w - 8)}px`;
    p.style.top = `${pvTop + pvH + 8}px`;
    p.style.right = 'auto';
    p.classList.add('show');
  }

  _hidePalette() { this.paletteEl.classList.remove('show'); this._paletteId = null; }

  _pickDockColor(color) {
    const id = this._paletteId;
    const def = id && this._def(id);
    if (def) {
      if (color) def._dockColor = color; else delete def._dockColor;
      const item = this._dockItemEl(id);
      if (item) { if (color) item.style.setProperty('--dock-color', color); else item.style.removeProperty('--dock-color'); }
    }

  }


  _dockSnapshot() {
    const m = {};
    for (const side of ['left', 'right']) {
      for (const el of this.dockEls[side].querySelectorAll('.ws-dock-item')) {
        m[el.dataset.id] = el.getBoundingClientRect().top;
      }
    }
    return m;
  }

  _dockFlip(first) {
    for (const side of ['left', 'right']) {
      for (const el of this.dockEls[side].querySelectorAll('.ws-dock-item')) {
        const was = first[el.dataset.id];
        if (was == null) continue;
        const dy = was - el.getBoundingClientRect().top;
        if (!dy) continue;
        el.style.transition = 'none';
        el.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = 'transform .2s ease';
          el.style.transform = '';
        });
      }
    }
  }



  _showDockSlot(side, index) {
    if (this._slot && this._slot.side === side && this._slot.index === index) return;
    const first = this._dockSnapshot();
    if (this._slot) this._slot.el.remove();
    const dock = this.dockEls[side];
    dock.classList.add('has-items');
    const items = [...dock.querySelectorAll('.ws-dock-item')];
    const slot = document.createElement('div');
    slot.className = 'ws-dock-slot';
    if (index >= items.length) dock.appendChild(slot);
    else dock.insertBefore(slot, items[index]);
    this._slot = { side, index, el: slot };

    this._slotH = slot.getBoundingClientRect().height;
    this._dockFlip(first);
  }

  _clearDockSlot() {
    if (!this._slot) return;
    const first = this._dockSnapshot();
    const dock = this._slot.el.parentElement;
    this._slot.el.remove();
    this._slot = null;
    if (dock) dock.classList.toggle('has-items', !!dock.querySelector('.ws-dock-item'));
    this._dockFlip(first);
  }



  _queuePreview(id, itemEl) {
    clearTimeout(this._previewHideT);
    clearTimeout(this._previewShowT);
    this._previewShowT = setTimeout(() => this._showPreview(id, itemEl), PREVIEW_DELAY);
  }

  _showPreview(id, itemEl) {
    const f = this.frames[id];
    if (!f || this._dragging) return;
    const side = this.docked.find((d) => d.id === id)?.side;
    if (!side) return;
    this._clearDockUnread(id);
    f.wrapper.style.flex = '';
    this.previewEl.innerHTML = '';
    this.previewEl.appendChild(f.wrapper);

    const r = itemEl.getBoundingClientRect();
    const top = clamp(r.top - 10, 8, Math.max(8, window.innerHeight - 430));
    this.previewEl.style.top = `${top}px`;
    this.previewEl.classList.toggle('ws-preview-left', side === 'left');
    this.previewEl.classList.toggle('ws-preview-right', side === 'right');
    if (side === 'left') { this.previewEl.style.left = `${r.right + 2}px`; this.previewEl.style.right = 'auto'; }
    else { this.previewEl.style.right = `${window.innerWidth - r.left + 2}px`; this.previewEl.style.left = 'auto'; }
    this.previewEl.classList.add('show');
    this._showPalette(id);
  }

  _hidePreview() {
    clearTimeout(this._previewShowT);
    this._previewHideT = setTimeout(() => {
      this.previewEl.classList.remove('show');
      this._hidePalette();

      if (this.previewEl.firstElementChild) this.previewEl.firstElementChild.remove();
    }, 260);
  }

  _hidePreviewNow() {
    clearTimeout(this._previewShowT);
    clearTimeout(this._previewHideT);
    this.previewEl.classList.remove('show');
    this._hidePalette();
    if (this.previewEl.firstElementChild) this.previewEl.firstElementChild.remove();
  }



  _splitter(node, i, aEl, bEl) {
    const bar = document.createElement('div');
    bar.className = 'splitter';
    bar.addEventListener('pointerdown', (e) => this._startResize(e, node, i, aEl, bEl));
    bar.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const sum = node.children[i].weight + node.children[i + 1].weight;
      node.children[i].weight = sum / 2; node.children[i + 1].weight = sum / 2;
      this._apply(true);
    });
    return bar;
  }

  _minSize(el, horizontal) {
    if (el.classList.contains('split')) {
      const kids = [...el.children].filter((c) => !c.classList.contains('splitter'));
      if (!kids.length) return MIN_PX;
      const sizes = kids.map((k) => this._minSize(k, horizontal));
      const alongAxis = el.classList.contains(horizontal ? 'split-row' : 'split-col');
      return alongAxis ? sizes.reduce((a, b) => a + b, 0) : Math.max(...sizes);
    }
    const v = parseFloat(getComputedStyle(el)[horizontal ? 'minWidth' : 'minHeight']);
    return Number.isFinite(v) && v > 0 ? v : MIN_PX;
  }

  _startResize(e, node, i, aEl, bEl) {
    e.preventDefault();
    const horizontal = node.dir === 'row';
    const start = horizontal ? e.clientX : e.clientY;
    const aSize = horizontal ? aEl.getBoundingClientRect().width : aEl.getBoundingClientRect().height;
    const bSize = horizontal ? bEl.getBoundingClientRect().width : bEl.getBoundingClientRect().height;
    const pair = aSize + bSize;
    const pairWeight = node.children[i].weight + node.children[i + 1].weight;
    const total = node.children.reduce((s, c) => s + (c.weight || 0), 0) || 1;
    const minA = this._minSize(aEl, horizontal);
    const minB = this._minSize(bEl, horizontal);

    const onMove = (ev) => {
      const now = horizontal ? ev.clientX : ev.clientY;
      const newA = clamp(aSize + (now - start), minA, pair - minB);
      const ratio = newA / pair;
      node.children[i].weight = pairWeight * ratio;
      node.children[i + 1].weight = pairWeight * (1 - ratio);
      aEl.style.flex = `${node.children[i].weight / total} 1 0`;
      bEl.style.flex = `${node.children[i + 1].weight / total} 1 0`;
      this._surface?.syncFromSource?.();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-resizing');
      this._persist();
    };
    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }



  _drag(e, id, fromDock) {
    if (e.button !== 0) return;
    e.preventDefault();
    const wrapper = this.frames[id].wrapper;

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ghost = null;
    let offsetX = 0;
    let offsetY = 0;
    let drop = null; // { kind:'trash' } | { kind:'dock', side } | { kind:'panel', id, zone }

    const removable = this._removable(id);
    const hideable = this._hideable(id);




    let rootRect = null, trashRect = null, panelRects = [];
    const dockMids = { left: [], right: [] };
    const buildRects = () => {
      rootRect = this.root.getBoundingClientRect();
      trashRect = this.trashEl.getBoundingClientRect();
      panelRects = [];
      for (const pid in this.frames) {
        if (pid === id) continue;
        const el = this.frames[pid].wrapper;
        if (el.isConnected) panelRects.push({ id: pid, rect: el.getBoundingClientRect() });
      }
      for (const side of ['left', 'right']) {
        dockMids[side] = [...this.dockEls[side].querySelectorAll('.ws-dock-item')]
          .filter((el) => el.dataset.id !== id)
          .map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
      }
    };
    const panelAt = (x, y) => panelRects.find((p) => this._inRect(p.rect, x, y)) || null;
    const dockIndexAt = (side, y) => { const m = dockMids[side]; let i = 0; while (i < m.length && y >= m[i]) i++; return i; };



    const edgeDock = (x, y) => {
      if (!hideable) return null;
      if (x <= rootRect.left + EDGE_PX) return { kind: 'dock', side: 'left', index: dockIndexAt('left', y) };
      if (x >= rootRect.right - EDGE_PX) return { kind: 'dock', side: 'right', index: dockIndexAt('right', y) };
      return null;
    };

    const moveGhost = (x, y) => { ghost.style.transform = `translate3d(${Math.round(x - offsetX)}px, ${Math.round(y - offsetY)}px, 0)`; };


    const STRIP_W = 9;
    let ghostW = 0, ghostH = 0, stripped = false;
    let stripH = 0;
    const stripGhost = (side, y) => {

      const h = this._slotH || clamp(ghostH, 52, window.innerHeight - 24);
      const gx = side === 'left' ? 3 : window.innerWidth - STRIP_W - 3;
      const gy = clamp(y - h / 2, 12, window.innerHeight - h - 12);
      ghost.style.transform = `translate3d(${gx}px, ${Math.round(gy)}px, 0)`;
      if (!stripped) { ghost.style.width = `${STRIP_W}px`; ghost.classList.add('as-dock-strip'); stripped = true; }
      if (stripH !== h) { stripH = h; ghost.style.height = `${h}px`; }
    };
    const unstripGhost = () => {
      if (!stripped) return;
      ghost.style.width = `${ghostW}px`;
      ghost.style.height = `${ghostH}px`;
      ghost.classList.remove('as-dock-strip');
      stripped = false;
      stripH = 0;
    };

    const begin = () => {
      dragging = true;
      this._dragging = true;



      const inPreview = this.previewEl.contains(wrapper);
      const rect = inPreview ? wrapper.getBoundingClientRect()
        : (fromDock ? { left: startX - 140, top: startY - 20, width: 280, height: 360 }
                    : wrapper.getBoundingClientRect());
      offsetX = inPreview ? (startX - rect.left) : (fromDock ? 140 : startX - rect.left);
      offsetY = inPreview ? (startY - rect.top) : (fromDock ? 20 : startY - rect.top);

      clearTimeout(this._previewShowT);
      this._hidePreviewNow();
      if (this.previewEl.contains(wrapper)) wrapper.remove();

      ghost = wrapper.cloneNode(true);
      ghost.classList.add('panel-ghost');

      ghost.querySelectorAll('.feed').forEach((f) => { f.innerHTML = ''; });
      ghost.style.transform = '';



      ghost.style.transition = 'width .24s cubic-bezier(.22,1,.36,1), height .24s cubic-bezier(.22,1,.36,1), border-radius .24s cubic-bezier(.22,1,.36,1)';
      ghostW = rect.width; ghostH = rect.height;
      ghost.style.width = `${ghostW}px`;
      ghost.style.height = `${ghostH}px`;
      document.body.appendChild(ghost);

      this._hint = document.createElement('div');
      this._hint.className = 'drop-hint';
      this._hint.style.display = 'none';
      document.body.appendChild(this._hint);



      let origSide = null, origIndex = -1;
      if (fromDock) {
        const entry = this.docked.find((d) => d.id === id);
        origSide = entry?.side;
        origIndex = this.docked.filter((d) => d.side === origSide).findIndex((d) => d.id === id);
        this.docked = this.docked.filter((d) => d.id !== id);
        this._renderDocks();
      } else {
        wrapper.classList.add('is-placeholder');
      }

      document.body.classList.add('is-dragging-panel');
      this.trashEl.classList.toggle('armed', removable);
      this._setTrashHeat(0);
      moveGhost(startX, startY);
      buildRects();
      if (fromDock && origSide) this._showDockSlot(origSide, origIndex);
    };




    let shownHint = '', trashHot = false;
    const showHint = (key, rect, zone) => {
      if (key === shownHint) return;
      shownHint = key;
      if (key) { this._hint.style.display = 'block'; this._showHint(rect, zone); }
      else this._hint.style.display = 'none';
    };
    const setTrashHot = (on) => { if (on !== trashHot) { trashHot = on; this.trashEl.classList.toggle('hot', on); } };


    const handleMove = (x, y) => {
      if (!dragging) {
        if (Math.hypot(x - startX, y - startY) < 6) return;
        begin();
      }
      moveGhost(x, y);


      if (this._trashState(x, y, removable, trashRect)) {
        unstripGhost();
        this._clearDockSlot();
        drop = { kind: 'trash' };
        setTrashHot(true);
        showHint('');
        return;
      }
      setTrashHot(false);


      const ed = edgeDock(x, y);
      if (ed) { drop = ed; showHint(''); this._showDockSlot(ed.side, ed.index); stripGhost(ed.side, y); return; }
      unstripGhost();
      this._clearDockSlot();

      const target = panelAt(x, y);
      if (target) {
        const zone = this._zone(target.rect, x, y);
        drop = { kind: 'panel', id: target.id, zone };
        showHint(`${target.id}|${zone}`, target.rect, zone);
        return;
      }
      drop = null;
      showHint('');
    };

    let rafPending = false, lastX = startX, lastY = startY;
    const onMove = (ev) => {
      lastX = ev.clientX; lastY = ev.clientY;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; handleMove(lastX, lastY); });
    };

    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      try { this.root.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (!dragging) { if (fromDock) this.restorePanel(id); return; }

      if (this._trashState(ev.clientX, ev.clientY, removable, trashRect)) {
        drop = { kind: 'trash' };
      } else {
        const ed = edgeDock(ev.clientX, ev.clientY);
        if (ed) drop = ed;
      }

      this._dragging = false;

      if (drop?.kind === 'dock') this._slot = null;
      else this._clearDockSlot();
      wrapper.classList.remove('is-placeholder');
      document.body.classList.remove('is-dragging-panel');
      this.trashEl.classList.remove('armed', 'hot');
      this._setTrashHeat(0);
      this.dockHints.left.classList.remove('armed', 'show');
      this.dockHints.right.classList.remove('armed', 'show');
      ghost?.remove();
      this._hint?.remove();
      this._hint = null;

      if (drop?.kind === 'trash') this.removePanel(id);
      else if (drop?.kind === 'dock') this.dockPanel(id, drop.side, drop.index);
      else if (drop?.kind === 'panel' && drop.id !== id) {
        if (fromDock) { this._placePanel(id, drop.id, drop.zone === 'center' ? 'right' : drop.zone); this.tree = this._normalize(this.tree); this._apply(true); }
        else this._applyDrop(id, drop.id, drop.zone);
      } else if (fromDock) {
        this.dockPanel(id, this._def(id)?._lastSide || 'right');
      }
    };



    try { this.root.setPointerCapture(e.pointerId); } catch { /* unsupported — fine */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  _startDockItem(e, id) { this._drag(e, id, true); }

  _inRect(r, x, y) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }

  _setTrashHeat(heat) {
    const h = clamp(heat, 0, 1);
    const key = h.toFixed(3);
    if (this._trashHeatKey === key) return;
    this._trashHeatKey = key;
    this.trashEl.style.setProperty('--trash-heat', h.toFixed(3));
    this.trashEl.style.setProperty('--trash-height', `${3 + h * 3}px`);
    this.trashEl.style.setProperty('--trash-opacity', (0.38 + h * 0.56).toFixed(3));
    this.trashEl.style.setProperty('--trash-alpha', (0.58 + h * 0.35).toFixed(3));
    this.trashEl.style.setProperty('--trash-scale', (1 + h * 0.08).toFixed(3));
    this.trashEl.style.setProperty('--trash-shadow', `${Math.round(h * 26)}px`);
  }

  _trashState(x, y, enabled, cachedRect = null) {
    if (!enabled) {
      this._setTrashHeat(0);
      return false;
    }
    const r = cachedRect || this.trashEl.getBoundingClientRect();
    const padX = 42;
    const inX = x >= r.left - padX && x <= r.right + padX;
    const heatY = 1 - clamp(y / TRASH_GLOW_PX, 0, 1);
    const edgeDx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
    const heatX = 1 - clamp(edgeDx / 140, 0, 1);
    const heat = Math.max(0, heatX * heatY);
    this._setTrashHeat(heat);
    return inX && y <= TRASH_HIT_PX;
  }

  _zone(rect, x, y) {
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;
    const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
    const min = Math.min(d.left, d.right, d.top, d.bottom);
    if (min > 0.28) return 'center';
    return Object.keys(d).find((k) => d[k] === min);
  }

  _showHint(rect, zone) {
    const h = this._hint;
    h.style.display = 'block';
    const half = { left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5], center: [0, 0, 1, 1] }[zone];
    h.style.left = `${rect.left + rect.width * half[0]}px`;
    h.style.top = `${rect.top + rect.height * half[1]}px`;
    h.style.width = `${rect.width * half[2]}px`;
    h.style.height = `${rect.height * half[3]}px`;
  }


  isOpen(id) { return !!this._find(id); }
  isDocked(id) { return this.docked.some((d) => d.id === id); }



  addPanel(def, nearId = null, zone = null) {
    if (this._def(def.id)) return;
    this.panels.push(def);
    this._buildFrame(def);


    if (!nearId || !zone) {
      const smart = this._smartTarget();
      nearId = smart.id;
      zone = smart.zone;
    }
    if (this._find(nearId)) this._placePanel(def.id, nearId, zone);
    else this._placePanel(this.tree?.type === 'leaf' ? this.tree.id : this._firstLeafId(), nearId, zone);
    this.tree = this._normalize(this.tree);
    this._apply(true);
  }



  _smartTarget() {
    const skip = new Set(['profile', 'chat-list']);
    let best = null;
    for (const pid in this.frames) {
      const el = this.frames[pid].wrapper;
      if (!el.isConnected || skip.has(pid) || !this._find(pid)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (!best || area > best.area) best = { id: pid, area, rect: r };
    }
    if (!best) return { id: this._find('chat-room') ? 'chat-room' : this._firstLeafId(), zone: 'right' };
    const zone = best.rect.width >= best.rect.height ? 'right' : 'bottom';
    return { id: best.id, zone };
  }

  removePanel(id) {
    if (!this._removable(id)) return;
    if (this._find(id)) this._removeLeaf(id);
    this.docked = this.docked.filter((d) => d.id !== id);
    const f = this.frames[id];
    if (f) { f.dispose?.(); f.wrapper.remove(); }
    delete this.frames[id];
    this.panels = this.panels.filter((p) => p.id !== id);
    this._renderDocks();
    this._apply(true);
  }

  dockPanel(id, side, index = null) {
    if (!this._hideable(id)) return;
    if (this._find(id)) this._removeLeaf(id);
    this.docked = this.docked.filter((d) => d.id !== id);
    const def = this._def(id);
    if (def) def._lastSide = side;
    const entry = { id, side };
    if (index == null) {
      this.docked.push(entry);
    } else {

      const sideItems = this.docked.filter((d) => d.side === side);
      const others = this.docked.filter((d) => d.side !== side);
      sideItems.splice(clamp(index, 0, sideItems.length), 0, entry);
      this.docked = [...others, ...sideItems];
    }
    this._renderDocks(true);
    this._apply(true);
  }

  restorePanel(id, nearId = null, zone = null) {
    if (!this.docked.some((d) => d.id === id)) return;
    this._unread.delete(id);
    this._hidePreviewNow();
    this.docked = this.docked.filter((d) => d.id !== id);

    if (!nearId || !zone) {
      const smart = this._smartTarget();
      nearId = smart.id; zone = smart.zone;
    }
    const near = this._find(nearId) ? nearId : this._firstLeafId();
    this._placePanel(id, near, zone);
    this.tree = this._normalize(this.tree);
    this._renderDocks();
    this._apply(true);
  }



  _placePanel(id, targetId, zone) {
    if (!this.tree) { this.tree = { type: 'leaf', id, weight: 1 }; return; }
    const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
    const before = zone === 'left' || zone === 'top';
    this._splitAt(targetId, { type: 'leaf', id, weight: 1 }, dir, before);
  }

  _firstLeafId(node = this.tree) {
    if (!node) return null;
    if (node.type === 'leaf') return node.id;
    for (const c of node.children) { const r = this._firstLeafId(c); if (r) return r; }
    return null;
  }

  _applyDrop(draggedId, targetId, zone) {
    if (zone === 'center') {
      this._swapIds(draggedId, targetId);
    } else {
      const dragged = this._find(draggedId).node;
      this._removeLeaf(draggedId);
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
      const before = zone === 'left' || zone === 'top';
      this._splitAt(targetId, dragged, dir, before);
      this.tree = this._normalize(this.tree);
    }
    this._apply(true);
  }

  _find(id, node = this.tree, parent = null, index = -1) {
    if (!node) return null;
    if (node.type === 'leaf') return node.id === id ? { node, parent, index } : null;
    for (let i = 0; i < node.children.length; i++) {
      const r = this._find(id, node.children[i], node, i);
      if (r) return r;
    }
    return null;
  }

  _swapIds(a, b) {
    const na = this._find(a)?.node;
    const nb = this._find(b)?.node;
    if (!na || !nb) return;
    const t = na.id; na.id = nb.id; nb.id = t;
  }

  _removeLeaf(id) {
    const found = this._find(id);
    if (!found) return;
    if (!found.parent) { this.tree = null; return; }
    found.parent.children.splice(found.index, 1);
    this.tree = this._normalize(this.tree);
  }

  _splitAt(targetId, draggedNode, dir, before) {
    const found = this._find(targetId);
    if (!found) {
      if (!this.tree) this.tree = draggedNode;
      else this.tree = { type: 'split', dir, weight: 1, children: before ? [draggedNode, this.tree] : [this.tree, draggedNode] };
      return;
    }
    const target = found.node;
    draggedNode.weight = 1;
    const kept = { ...target, weight: 1 };
    const split = {
      type: 'split', dir, weight: target.weight || 1,
      children: before ? [draggedNode, kept] : [kept, draggedNode],
    };
    if (found.parent) found.parent.children[found.index] = split;
    else this.tree = split;
  }

  _normalize(node) {
    if (!node || node.type === 'leaf') return node;
    node.children = node.children.map((c) => this._normalize(c));

    const flat = [];
    for (const c of node.children) {
      if (c.type === 'split' && c.dir === node.dir) {
        const sum = c.children.reduce((s, x) => s + x.weight, 0) || 1;
        for (const gc of c.children) { gc.weight = (gc.weight / sum) * c.weight; flat.push(gc); }
      } else flat.push(c);
    }
    node.children = flat;

    if (node.children.length === 1) {
      const only = node.children[0];
      only.weight = node.weight ?? 1;
      return only;
    }
    return node;
  }

  swap(a, b) { this._swapIds(a, b); this._apply(true); }
}
