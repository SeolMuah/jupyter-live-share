/* drawing.js - Drawing/Annotation overlay module */

const Drawing = (() => {
  'use strict';

  // 2-canvas architecture: staticCanvas (completed strokes) + canvas (active stroke)
  let staticCanvas = null;
  let staticCtx = null;
  let canvas = null; // active stroke canvas
  let ctx = null;    // active stroke context
  let container = null; // #notebook-container
  let cellsDiv = null;  // #notebook-cells (max-width:960px, centered)
  let isTeacher = false;
  let drawingMode = false;

  // Stroke state
  let strokes = []; // completed strokes
  let currentStroke = null; // stroke being drawn
  let currentPoints = []; // points for WS batch sending
  let batchTimer = null;
  let isErasing = false; // eraser drag state (separate from currentStroke)
  let eraseRedrawPending = false; // rAF batch flag for eraser
  const BATCH_INTERVAL = 50; // ms

  // Incremental drawing state
  let lastDrawnIndex = 0; // tracks how many points already rendered

  // Tool state
  let currentTool = 'pen'; // 'pen' | 'highlighter' | 'eraser'
  let currentColor = '#ff6b6b'; // coral red default
  let currentWidth = 4; // medium default

  // Toolbar elements
  let toolsPanel = null; // #draw-tools-panel (right side)

  // ResizeObserver debounce
  let resizeTimer = null;
  let resizeObserver = null;
  const RESIZE_DEBOUNCE_MS = 100;

  // Intermediate stroking state — Map of strokeId → {tool, color, width, alpha, points[]}
  let intermediateStrokes = new Map();

  // Per-stroke DOM read cache (set on pointerdown, cleared on pointerup)
  let cachedCellsRect = null;
  let cachedContainerTop = 0;
  let cachedCW = 0;

  // Viewport canvas scroll tracking
  let cachedScrollOffset = 0;
  let scrollRAFPending = false;

  // Cell position cache — built once per resize/stroke-start
  let cellPosCache = null;

  // --- Cell Position Cache ---

  function invalidateCellCache() {
    cellPosCache = null;
  }

  function buildCellCache() {
    const containerRect = container.getBoundingClientRect();
    const cells = (cellsDiv || container).querySelectorAll('.cell');
    const positions = [];
    for (let i = 0; i < cells.length; i++) {
      const cellRect = cells[i].getBoundingClientRect();
      positions.push({
        top: cellRect.top - containerRect.top + container.scrollTop,
        height: cellRect.height,
      });
    }
    cellPosCache = positions;
    return positions;
  }

  function getCellPositions() {
    return cellPosCache || buildCellCache();
  }

  // --- Viewport Canvas Helpers ---

  // Container's scroll offset (window scroll based — #notebook-container has no overflow-y)
  function getScrollOffset() {
    return Math.max(0, -container.getBoundingClientRect().top);
  }

  // Clear viewport-sized canvas safely (reset transform before clearing)
  function clearCanvas(context, canvasEl) {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvasEl.width, canvasEl.height);
    context.restore();
  }

  // Apply DPR + scroll offset transform (absolute coords → viewport coords)
  function applyScrollTransform(context) {
    const dpr = isTeacher ? 1 : (window.devicePixelRatio || 1);
    context.setTransform(dpr, 0, 0, dpr, 0, -cachedScrollOffset * dpr);
  }

  // --- Coordinate Conversion ---
  // Cell-relative coordinate system:
  //   { cellIndex, xRatio, yOffset } for WS transmission
  //   + _x, _y (absolute pixel coords) cached for fast local drawing

  // Find cell index from absolute Y using binary search (O(log n))
  // positions array is sorted by top ascending
  function findCellIndex(absY, positions) {
    let lo = 0, hi = positions.length - 1, result = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (positions[mid].top <= absY) { result = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return result;
  }

  // Full coordinate conversion — used by onPointerDown and eraser
  // X is relative to cellsDiv (centered content area) for consistent alignment
  // Y is relative to container (scroll context)
  function toCoords(e) {
    // Use per-stroke cache if available, otherwise read DOM
    const cellsRect = cachedCellsRect || (cellsDiv ? cellsDiv.getBoundingClientRect() : container.getBoundingClientRect());
    const x = e.clientX - cellsRect.left;
    const containerTop = cachedContainerTop || container.getBoundingClientRect().top;
    const absY = e.clientY - containerTop + container.scrollTop;
    const cw = cachedCW || (cellsDiv ? cellsDiv.clientWidth : container.clientWidth);
    const xRatio = cw > 0 ? x / cw : 0;

    const positions = getCellPositions();
    if (positions.length > 0) {
      const ci = findCellIndex(absY, positions);
      return { cellIndex: ci, xRatio, yOffset: absY - positions[ci].top, _x: x, _y: absY };
    }
    return { cellIndex: -1, xRatio, yOffset: absY, _x: x, _y: absY };
  }

  // Convert cell-relative point → absolute pixel (for received/stored strokes)
  function ptToPixelXY(pt, cw, positions) {
    const x = pt.xRatio * cw;
    let y;
    if (pt.cellIndex >= 0 && positions && pt.cellIndex < positions.length) {
      y = positions[pt.cellIndex].top + pt.yOffset;
    } else {
      y = pt.yOffset;
    }
    return { x, y };
  }

  // --- Transmission Helpers ---

  // Strip internal pixel coords (_x, _y) before WS send
  function stripInternalCoords(points) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      out[i] = { cellIndex: p.cellIndex, xRatio: p.xRatio, yOffset: p.yOffset };
    }
    return out;
  }

  // Ramer-Douglas-Peucker point simplification (reduces WS payload 50-70%)
  // Normalizes yOffset to xRatio scale using container width for uniform distance
  function simplifyPoints(points, epsilon) {
    if (points.length <= 2) return points;
    if (epsilon === undefined) epsilon = 0.002;

    // Normalize yOffset → same scale as xRatio (0-1 range relative to container width)
    const cw = (cellsDiv ? cellsDiv.clientWidth : (container ? container.clientWidth : 960)) || 960;

    let maxDist = 0, maxIdx = 0;
    const first = points[0], last = points[points.length - 1];
    const firstYNorm = first.yOffset / cw;
    const lastYNorm = last.yOffset / cw;
    const dx = last.xRatio - first.xRatio;
    const dy = lastYNorm - firstYNorm;
    const lenSq = dx * dx + dy * dy;

    for (let i = 1; i < points.length - 1; i++) {
      const ptYNorm = points[i].yOffset / cw;
      let dist;
      if (lenSq === 0) {
        const ex = points[i].xRatio - first.xRatio;
        const ey = ptYNorm - firstYNorm;
        dist = Math.sqrt(ex * ex + ey * ey);
      } else {
        const t = Math.max(0, Math.min(1,
          ((points[i].xRatio - first.xRatio) * dx + (ptYNorm - firstYNorm) * dy) / lenSq));
        const px = first.xRatio + t * dx - points[i].xRatio;
        const py = firstYNorm + t * dy - ptYNorm;
        dist = Math.sqrt(px * px + py * py);
      }
      if (dist > maxDist) { maxDist = dist; maxIdx = i; }
    }

    if (maxDist > epsilon) {
      const left = simplifyPoints(points.slice(0, maxIdx + 1), epsilon);
      const right = simplifyPoints(points.slice(maxIdx), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  // --- Canvas Setup ---

  function createCtx(cvs) {
    // Note: desynchronized:true is intentionally NOT used here.
    // It silently breaks rendering in Electron/Webview sandboxed iframes
    // (VS Code Teacher Preview) — returns a non-null context that draws nothing.
    return cvs.getContext('2d');
  }

  function init(isTeacherPreview) {
    isTeacher = isTeacherPreview;
    container = document.getElementById('notebook-container');
    cellsDiv = document.getElementById('notebook-cells');
    if (!container || !cellsDiv) return;

    // Teacher preview: fix container width to match student view's max-width (960px).
    // Different container widths cause different text wrapping -> different scrollHeight
    // -> coordinate positions drift. Fixed width ensures identical layout.
    // border-box (global CSS) includes padding 16px×2, so 960+32=992px needed for 960px content area.
    if (isTeacher) {
      container.style.minWidth = '992px';
      document.body.style.overflowX = 'auto';
    }

    container.style.position = 'relative';

    // Create static canvas (completed strokes, bottom layer)
    staticCanvas = document.createElement('canvas');
    staticCanvas.id = 'draw-canvas-static';
    container.appendChild(staticCanvas);
    staticCtx = createCtx(staticCanvas);

    // Create active canvas (current stroke + events, top layer)
    canvas = document.createElement('canvas');
    canvas.id = 'draw-canvas';
    container.appendChild(canvas);
    ctx = createCtx(canvas);

    resizeCanvas();

    // ResizeObserver to track content height changes (debounced)
    resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        invalidateCellCache();
        resizeCanvas();
        redrawAll();
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    // Scroll listeners for viewport canvas repositioning
    window.addEventListener('scroll', onContainerScroll, { passive: true });
    container.addEventListener('scroll', onContainerScroll, { passive: true });

    // Toolbar setup — tools panel on right side, toggle in footer
    toolsPanel = document.getElementById('draw-tools-panel');

    if (isTeacher) {
      // Show draw toggle button in footer
      const toggle = document.getElementById('draw-toggle');
      if (toggle) toggle.style.display = '';
      setupToolbar();
      setupPointerEvents();
    }
  }

  function resizeCanvas() {
    if (!canvas || !staticCanvas || !container) return;
    if (!staticCtx || !ctx) return;
    const dpr = isTeacher ? 1 : (window.devicePixelRatio || 1);
    const w = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const h = window.innerHeight; // viewport height instead of scrollHeight
    const leftOffset = cellsDiv ? cellsDiv.offsetLeft : 0;
    cachedScrollOffset = getScrollOffset();

    // Both canvases: viewport-sized, positioned at scroll offset
    for (const cvs of [staticCanvas, canvas]) {
      cvs.style.left = leftOffset + 'px';
      cvs.style.top = cachedScrollOffset + 'px';
      cvs.style.width = w + 'px';
      cvs.style.height = h + 'px';
      cvs.width = w * dpr;
      cvs.height = h * dpr;
    }
    applyScrollTransform(staticCtx);
    applyScrollTransform(ctx);
  }

  // --- Scroll Handling ---

  function onContainerScroll() {
    if (scrollRAFPending) return;
    scrollRAFPending = true;
    requestAnimationFrame(() => {
      scrollRAFPending = false;
      repositionCanvases();
    });
  }

  function repositionCanvases() {
    if (!canvas || !staticCanvas || !container) return;
    const scrollOffset = getScrollOffset();
    if (Math.abs(scrollOffset - cachedScrollOffset) < 1) return;
    cachedScrollOffset = scrollOffset;

    // 1. Update CSS position
    staticCanvas.style.top = scrollOffset + 'px';
    canvas.style.top = scrollOffset + 'px';

    // 2. Redraw static canvas
    clearCanvas(staticCtx, staticCanvas);
    applyScrollTransform(staticCtx);
    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const positions = getCellPositions();
    for (const stroke of strokes) {
      drawSmoothStroke(staticCtx, stroke, cw, positions);
    }

    // 3. Redraw active canvas if needed
    clearCanvas(ctx, canvas);
    applyScrollTransform(ctx);
    if (currentStroke && currentStroke.points.length > 0) {
      lastDrawnIndex = 0;
      redrawActiveStrokeFull();
    } else if (intermediateStrokes.size > 0) {
      redrawIntermediateCanvasInner(cw, positions);
    }
  }

  // Full redraw of active stroke (used during scroll — incremental is invalidated)
  function redrawActiveStrokeFull() {
    if (!currentStroke || !ctx) return;
    const pts = currentStroke.points;
    if (pts.length === 0) return;

    ctx.globalAlpha = currentStroke.alpha;
    if (pts.length === 1) {
      ctx.fillStyle = currentStroke.color;
      ctx.beginPath();
      ctx.arc(pts[0]._x, pts[0]._y, currentStroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = currentStroke.color;
      ctx.lineWidth = currentStroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0]._x, pts[0]._y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i]._x, pts[i]._y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    lastDrawnIndex = pts.length;
  }

  // --- Toolbar ---

  function setupToolbar() {
    const toggle = document.getElementById('draw-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        drawingMode = !drawingMode;
        toggle.classList.toggle('active', drawingMode);
        if (toolsPanel) toolsPanel.style.display = drawingMode ? 'flex' : 'none';
        canvas.style.pointerEvents = drawingMode ? 'auto' : 'none';
        if (drawingMode) {
          canvas.style.touchAction = 'none';
          updateCanvasCursor();
        } else {
          canvas.style.touchAction = '';
          canvas.classList.remove('cursor-pen', 'cursor-eraser');
          canvas.style.cursor = '';
        }
      });
    }

    if (!toolsPanel) return;

    toolsPanel.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toolsPanel.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTool = btn.dataset.tool;
        updateCanvasCursor();
      });
    });

    toolsPanel.querySelectorAll('.color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toolsPanel.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = btn.dataset.color;
        updateCanvasCursor();
      });
    });

    toolsPanel.querySelectorAll('.width-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toolsPanel.querySelectorAll('.width-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentWidth = parseInt(btn.dataset.width, 10);
      });
    });

    const undoBtn = document.getElementById('draw-undo');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        if (strokes.length === 0) return;
        strokes.pop();
        redrawAll(true); // skip cache invalidation — cell positions unchanged
        WsClient.send('draw:undo', {});
      });
    }

    const clearBtn = document.getElementById('draw-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        strokes = [];
        redrawAll();
        WsClient.send('draw:clear', {});
      });
    }
  }

  // --- Pointer Events ---

  function setupPointerEvents() {
    if (!canvas) return;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);
  }

  function buildHighlighterCursorSVG(color) {
    const enc = color.replace('#', '%23');
    return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Ccircle cx='14' cy='14' r='12' fill='${enc}' fill-opacity='0.35' stroke='${enc}' stroke-width='1.5'/%3E%3C/svg%3E") 14 14, crosshair`;
  }

  function updateCanvasCursor() {
    if (!canvas) return;
    canvas.style.cursor = '';
    canvas.classList.remove('cursor-pen', 'cursor-eraser');
    if (currentTool === 'eraser') {
      canvas.classList.add('cursor-eraser');
    } else if (currentTool === 'highlighter') {
      canvas.style.cursor = buildHighlighterCursorSVG(currentColor);
    } else {
      canvas.classList.add('cursor-pen');
    }
  }

  function onPointerDown(e) {
    if (!drawingMode) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    // Rebuild cell cache at stroke start
    invalidateCellCache();

    // Cache DOM reads for the entire stroke duration
    cachedCellsRect = cellsDiv ? cellsDiv.getBoundingClientRect() : container.getBoundingClientRect();
    cachedContainerTop = container.getBoundingClientRect().top;
    cachedCW = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;

    const pt = toCoords(e);

    if (currentTool === 'eraser') {
      isErasing = true;
      eraseAtPoint(pt);
      return;
    }

    const alpha = currentTool === 'highlighter' ? 0.3 : 1.0;
    const width = currentTool === 'highlighter' ? 20 : currentWidth;

    currentStroke = {
      strokeId: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      tool: currentTool,
      color: currentColor,
      width: width,
      alpha: alpha,
      points: [pt],
    };
    currentPoints = [pt];

    // Draw initial dot on active canvas
    lastDrawnIndex = 0;
    if (ctx) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = currentColor;
      ctx.beginPath();
      ctx.arc(pt._x, pt._y, width / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      lastDrawnIndex = 1;
    }

    // Per-stroke flag: only send full metadata in first batch
    let sentStrokeMetadata = false;

    // Start batch timer for WS sending
    batchTimer = setInterval(() => {
      if (currentPoints.length > 0 && currentStroke) {
        const pts = stripInternalCoords(currentPoints);
        if (!sentStrokeMetadata) {
          WsClient.send('draw:stroking', {
            strokeId: currentStroke.strokeId,
            tool: currentStroke.tool,
            color: currentStroke.color,
            width: currentStroke.width,
            alpha: currentStroke.alpha,
            points: pts,
          });
          sentStrokeMetadata = true;
        } else {
          WsClient.send('draw:stroking', {
            strokeId: currentStroke.strokeId,
            points: pts,
          });
        }
        currentPoints = [];
      }
    }, BATCH_INTERVAL);
  }

  function onPointerMove(e) {
    if (!drawingMode) return;

    if (isErasing) {
      e.preventDefault();
      eraseAtPoint(toCoords(e));
      return;
    }

    if (!currentStroke) return;
    e.preventDefault();

    // Use per-stroke cached DOM reads; only scrollTop is read live (can change during stroke)
    const cellsRect = cachedCellsRect;
    const cw = cachedCW;
    const containerTop = cachedContainerTop;
    const st = container.scrollTop;
    const positions = getCellPositions();

    const events = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
    for (let j = 0; j < events.length; j++) {
      const ce = events[j];
      const x = ce.clientX - cellsRect.left;
      const absY = ce.clientY - containerTop + st;
      const xRatio = cw > 0 ? x / cw : 0;

      // Find cell using binary search on cached positions
      let cellIndex = -1;
      let yOffset = absY;
      if (positions.length > 0) {
        cellIndex = findCellIndex(absY, positions);
        yOffset = absY - positions[cellIndex].top;
      }

      const pt = { cellIndex, xRatio, yOffset, _x: x, _y: absY };
      currentStroke.points.push(pt);
      currentPoints.push(pt);
    }

    // Draw directly — getCoalescedEvents already batches per frame
    drawActiveStroke();
  }

  function drawActiveStroke() {
    if (!currentStroke || !ctx) return;
    const pts = currentStroke.points;
    // Nothing new to draw
    if (lastDrawnIndex >= pts.length || pts.length < 2) return;

    // Incremental: only draw NEW segments since last frame.
    // Avoids clearRect on full-height canvas (scrollHeight can be 5000-10000+ px)
    // which was the main performance bottleneck in Electron Webview.
    const startIdx = Math.max(1, lastDrawnIndex);

    ctx.globalAlpha = currentStroke.alpha;
    ctx.strokeStyle = currentStroke.color;
    ctx.lineWidth = currentStroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[startIdx - 1]._x, pts[startIdx - 1]._y);
    for (let i = startIdx; i < pts.length; i++) {
      ctx.lineTo(pts[i]._x, pts[i]._y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    lastDrawnIndex = pts.length;
  }

  function onPointerUp(e) {
    if (isErasing) {
      isErasing = false;
      return;
    }

    if (!currentStroke) return;
    e.preventDefault();

    if (batchTimer) {
      clearInterval(batchTimer);
      batchTimer = null;
    }

    // Clear per-stroke DOM cache
    cachedCellsRect = null;
    cachedContainerTop = 0;
    cachedCW = 0;

    // Flush remaining unsent points
    if (currentPoints.length > 0) {
      WsClient.send('draw:stroking', {
        strokeId: currentStroke.strokeId,
        points: stripInternalCoords(currentPoints),
      });
    }

    // Move completed stroke to static canvas
    strokes.push(currentStroke);

    invalidateCellCache();
    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const positions = getCellPositions();
    applyScrollTransform(staticCtx);
    drawSmoothStroke(staticCtx, currentStroke, cw, positions);

    // Clear active canvas
    if (ctx) {
      clearCanvas(ctx, canvas);
      applyScrollTransform(ctx);
    }

    WsClient.send('draw:stroke', {
      strokeId: currentStroke.strokeId,
      tool: currentStroke.tool,
      color: currentStroke.color,
      width: currentStroke.width,
      alpha: currentStroke.alpha,
      points: simplifyPoints(stripInternalCoords(currentStroke.points)),
    });

    currentStroke = null;
    currentPoints = [];
  }

  // --- Eraser ---

  function eraseAtPoint(pt) {
    const threshold = 15;
    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const px = pt._x !== undefined ? pt._x : pt.xRatio * cw;
    const py = pt._y !== undefined ? pt._y : pt.yOffset;
    const positions = getCellPositions();

    let erased = false;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      for (const sp of stroke.points) {
        const { x: sx, y: sy } = ptToPixelXY(sp, cw, positions);
        const dx = px - sx, dy = py - sy;
        if (dx * dx + dy * dy < threshold * threshold) {
          strokes.splice(i, 1);
          erased = true;
          WsClient.send('draw:erase', { strokeId: stroke.strokeId });
          break;
        }
      }
      if (erased) break;
    }
    // Batch redraw via rAF — at most 1 redraw per frame even with rapid erasing
    if (erased && !eraseRedrawPending) {
      eraseRedrawPending = true;
      requestAnimationFrame(() => {
        redrawAll(true);
        eraseRedrawPending = false;
      });
    }
  }

  // --- Smooth Drawing (Quadratic Bezier Curves) ---

  function drawSmoothStroke(targetCtx, stroke, cw, positions) {
    if (!targetCtx || !stroke.points || stroke.points.length === 0) return;

    const pts = stroke.points;

    targetCtx.globalAlpha = stroke.alpha;
    targetCtx.strokeStyle = stroke.color;
    targetCtx.lineWidth = stroke.width;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';

    if (pts.length === 1) {
      const { x, y } = ptToPixelXY(pts[0], cw, positions);
      targetCtx.beginPath();
      targetCtx.arc(x, y, stroke.width / 2, 0, Math.PI * 2);
      targetCtx.fillStyle = stroke.color;
      targetCtx.fill();
    } else if (pts.length === 2) {
      const p0 = ptToPixelXY(pts[0], cw, positions);
      const p1 = ptToPixelXY(pts[1], cw, positions);
      targetCtx.beginPath();
      targetCtx.moveTo(p0.x, p0.y);
      targetCtx.lineTo(p1.x, p1.y);
      targetCtx.stroke();
    } else {
      const p0 = ptToPixelXY(pts[0], cw, positions);
      targetCtx.beginPath();
      targetCtx.moveTo(p0.x, p0.y);

      for (let i = 1; i < pts.length - 1; i++) {
        const cp = ptToPixelXY(pts[i], cw, positions);
        const next = ptToPixelXY(pts[i + 1], cw, positions);
        targetCtx.quadraticCurveTo(cp.x, cp.y, (cp.x + next.x) / 2, (cp.y + next.y) / 2);
      }

      const last = ptToPixelXY(pts[pts.length - 1], cw, positions);
      targetCtx.lineTo(last.x, last.y);
      targetCtx.stroke();
    }

    targetCtx.globalAlpha = 1;
  }

  function redrawAll(skipCacheInvalidation) {
    if (!staticCtx || !staticCanvas || !container) return;
    if (!skipCacheInvalidation) invalidateCellCache();
    cachedScrollOffset = getScrollOffset();

    // Update canvas positions
    staticCanvas.style.top = cachedScrollOffset + 'px';
    canvas.style.top = cachedScrollOffset + 'px';

    // Clear and re-apply transform
    clearCanvas(staticCtx, staticCanvas);
    applyScrollTransform(staticCtx);
    if (ctx) {
      clearCanvas(ctx, canvas);
      applyScrollTransform(ctx);
    }

    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const positions = getCellPositions();
    for (const stroke of strokes) {
      drawSmoothStroke(staticCtx, stroke, cw, positions);
    }
  }

  // --- Receive handlers (student side) ---

  function receiveStroke(stroke) {
    strokes.push(stroke);
    intermediateStrokes.delete(stroke.strokeId);
    // Draw completed stroke on static canvas (incremental, no redrawAll)
    if (!cellPosCache) buildCellCache();
    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const positions = getCellPositions();
    applyScrollTransform(staticCtx);
    drawSmoothStroke(staticCtx, stroke, cw, positions);
    // Redraw active canvas with remaining intermediates only
    redrawIntermediateCanvas();
  }

  function receiveStroking(data) {
    if (!ctx || !data.points || data.points.length === 0) return;

    // Accumulate points in intermediateStrokes Map
    let entry = intermediateStrokes.get(data.strokeId);
    if (!entry) {
      entry = {
        tool: data.tool || 'pen',
        color: data.color || '#000',
        width: data.width || 4,
        alpha: data.alpha || 1,
        points: [],
      };
      intermediateStrokes.set(data.strokeId, entry);
    } else if (data.tool) {
      // Update metadata if provided (first batch has full metadata)
      entry.tool = data.tool;
      entry.color = data.color || entry.color;
      entry.width = data.width || entry.width;
      entry.alpha = data.alpha !== undefined ? data.alpha : entry.alpha;
    }
    for (let i = 0; i < data.points.length; i++) {
      entry.points.push(data.points[i]);
    }

    // Redraw all intermediates on active canvas
    redrawIntermediateCanvas();
  }

  function redrawIntermediateCanvas() {
    if (!ctx || !container) return;
    clearCanvas(ctx, canvas);
    applyScrollTransform(ctx);
    if (intermediateStrokes.size === 0) return;

    if (!cellPosCache) buildCellCache();
    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const positions = getCellPositions();
    redrawIntermediateCanvasInner(cw, positions);
  }

  function redrawIntermediateCanvasInner(cw, positions) {
    intermediateStrokes.forEach((entry) => {
      const pts = entry.points;
      if (pts.length === 0) return;
      ctx.globalAlpha = entry.alpha;
      ctx.strokeStyle = entry.color;
      ctx.lineWidth = entry.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (pts.length === 1) {
        const { x, y } = ptToPixelXY(pts[0], cw, positions);
        ctx.beginPath();
        ctx.arc(x, y, entry.width / 2, 0, Math.PI * 2);
        ctx.fillStyle = entry.color;
        ctx.fill();
      } else {
        const p0 = ptToPixelXY(pts[0], cw, positions);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) {
          const p = ptToPixelXY(pts[i], cw, positions);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  function receiveUndo(data) {
    if (data && data.strokeId) {
      const idx = strokes.findIndex(s => s.strokeId === data.strokeId);
      if (idx !== -1) strokes.splice(idx, 1);
    } else {
      strokes.pop();
    }
    redrawAll(true); // skip cache invalidation — cell positions unchanged
  }

  function receiveErase(data) {
    if (data && data.strokeId) {
      const idx = strokes.findIndex(s => s.strokeId === data.strokeId);
      if (idx !== -1) strokes.splice(idx, 1);
      redrawAll(true); // skip cache invalidation — cell positions unchanged
    }
  }

  function receiveClear() {
    strokes = [];
    intermediateStrokes.clear();
    invalidateCellCache();
    redrawAll();
  }

  function receiveFull(data) {
    strokes = data.strokes || [];
    intermediateStrokes.clear();
    invalidateCellCache();
    redrawAll();
  }

  function clearAll() {
    strokes = [];
    intermediateStrokes.clear();
    invalidateCellCache();
    if (staticCtx && staticCanvas && container) {
      clearCanvas(staticCtx, staticCanvas);
      applyScrollTransform(staticCtx);
    }
    if (ctx && canvas && container) {
      clearCanvas(ctx, canvas);
      applyScrollTransform(ctx);
    }
  }

  function destroy() {
    // Cancel any pending operations
    if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    scrollRAFPending = false;

    // Remove scroll listeners
    window.removeEventListener('scroll', onContainerScroll);
    if (container) container.removeEventListener('scroll', onContainerScroll);

    // Clear state
    strokes = [];
    currentStroke = null;
    currentPoints = [];
    isErasing = false;
    eraseRedrawPending = false;
    intermediateStrokes.clear();
    invalidateCellCache();
    cachedCellsRect = null;
    cachedContainerTop = 0;
    cachedCW = 0;
    cachedScrollOffset = 0;

    // Reset drawing mode
    drawingMode = false;
    const toggle = document.getElementById('draw-toggle');
    if (toggle) {
      toggle.classList.remove('active');
      toggle.style.display = 'none';
    }

    // Hide tools panel
    if (toolsPanel) toolsPanel.style.display = 'none';

    // Remove canvases from DOM
    if (staticCanvas && staticCanvas.parentNode) {
      staticCanvas.parentNode.removeChild(staticCanvas);
    }
    if (canvas && canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
    staticCanvas = null; staticCtx = null;
    canvas = null; ctx = null;
    container = null;
    cellsDiv = null;
  }

  return {
    init,
    receiveStroke,
    receiveStroking,
    receiveUndo,
    receiveErase,
    receiveClear,
    receiveFull,
    clearAll,
    destroy,
  };
})();
