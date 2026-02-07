/* drawing.js - Drawing/Annotation overlay module */

const Drawing = (() => {
  'use strict';

  // 2-canvas architecture: staticCanvas (completed strokes) + canvas (active stroke)
  let staticCanvas = null;
  let staticCtx = null;
  let canvas = null; // active stroke canvas
  let ctx = null;    // active stroke context
  let container = null; // #notebook-container
  let isTeacher = false;
  let drawingMode = false;

  // Stroke state
  let strokes = []; // completed strokes
  let currentStroke = null; // stroke being drawn
  let currentPoints = []; // points for WS batch sending
  let batchTimer = null;
  let isErasing = false; // eraser drag state (separate from currentStroke)
  const BATCH_INTERVAL = 50; // ms

  // rAF batching
  let rafId = null;

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

  // Intermediate stroking state (for clearing on final stroke)
  let intermediateStrokeIds = new Set();

  // Cell position cache — built once per resize/stroke-start
  let cellPosCache = null;

  // --- Cell Position Cache ---

  function invalidateCellCache() {
    cellPosCache = null;
  }

  function buildCellCache() {
    const containerRect = container.getBoundingClientRect();
    const cells = container.querySelectorAll('.cell');
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

  // --- Coordinate Conversion ---
  // Cell-relative coordinate system:
  //   { cellIndex, xRatio, yOffset } for WS transmission
  //   + _x, _y (absolute pixel coords) cached for fast local drawing

  // Find cell index from absolute Y using reverse scan (gap-safe)
  function findCellIndex(absY, positions) {
    for (let i = positions.length - 1; i >= 0; i--) {
      if (absY >= positions[i].top) {
        return i;
      }
    }
    return 0; // above first cell
  }

  // Full coordinate conversion — used by onPointerDown and eraser
  function toCoords(e) {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const absY = e.clientY - rect.top + container.scrollTop;
    const cw = container.clientWidth;
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

  // --- Canvas Setup ---

  function init(isTeacherPreview) {
    isTeacher = isTeacherPreview;
    container = document.getElementById('notebook-container');
    if (!container) return;

    // Teacher preview: fix container width to match student view's max-width (960px).
    // Different container widths cause different text wrapping -> different scrollHeight
    // -> coordinate positions drift. Fixed width ensures identical layout.
    if (isTeacher) {
      container.style.minWidth = '960px';
      container.style.boxSizing = 'border-box';
      document.body.style.overflowX = 'auto';
    }

    container.style.position = 'relative';

    // Create static canvas (completed strokes, bottom layer)
    staticCanvas = document.createElement('canvas');
    staticCanvas.id = 'draw-canvas-static';
    container.appendChild(staticCanvas);
    staticCtx = staticCanvas.getContext('2d', { desynchronized: true });

    // Create active canvas (current stroke + events, top layer)
    canvas = document.createElement('canvas');
    canvas.id = 'draw-canvas';
    container.appendChild(canvas);
    ctx = canvas.getContext('2d', { desynchronized: true });

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
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.scrollHeight;

    // Resize both canvases
    staticCanvas.style.width = w + 'px';
    staticCanvas.style.height = h + 'px';
    staticCanvas.width = w * dpr;
    staticCanvas.height = h * dpr;
    staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
        redrawAll();
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

  function updateCanvasCursor() {
    if (!canvas) return;
    canvas.style.cursor = '';
    canvas.classList.remove('cursor-pen', 'cursor-eraser');
    if (currentTool === 'eraser') {
      canvas.classList.add('cursor-eraser');
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
    ctx.globalAlpha = alpha;
    ctx.fillStyle = currentColor;
    ctx.beginPath();
    ctx.arc(pt._x, pt._y, width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Start batch timer for WS sending
    batchTimer = setInterval(() => {
      if (currentPoints.length > 0 && currentStroke) {
        WsClient.send('draw:stroking', {
          strokeId: currentStroke.strokeId,
          tool: currentStroke.tool,
          color: currentStroke.color,
          width: currentStroke.width,
          alpha: currentStroke.alpha,
          points: currentPoints.slice(),
        });
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

    // Cache all DOM reads ONCE for this entire event
    const rect = container.getBoundingClientRect();
    const cw = container.clientWidth;
    const st = container.scrollTop;
    const positions = getCellPositions();

    const events = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
    for (let j = 0; j < events.length; j++) {
      const ce = events[j];
      const x = ce.clientX - rect.left;
      const absY = ce.clientY - rect.top + st;
      const xRatio = cw > 0 ? x / cw : 0;

      // Find cell using cached positions
      let cellIndex = -1;
      let yOffset = absY;
      if (positions.length > 0) {
        for (let i = positions.length - 1; i >= 0; i--) {
          if (absY >= positions[i].top) {
            cellIndex = i;
            yOffset = absY - positions[i].top;
            break;
          }
        }
        if (cellIndex === -1) {
          cellIndex = 0;
          yOffset = absY - positions[0].top;
        }
      }

      const pt = { cellIndex, xRatio, yOffset, _x: x, _y: absY };
      currentStroke.points.push(pt);
      currentPoints.push(pt);
    }

    // Schedule rAF to draw on active canvas (no direct draw here)
    scheduleActiveRedraw();
  }

  function scheduleActiveRedraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      drawActiveStroke();
    });
  }

  function drawActiveStroke() {
    if (!currentStroke || !ctx) return;
    const pts = currentStroke.points;
    if (pts.length < 1) return;

    const w = container.clientWidth;
    const h = container.scrollHeight;

    // Clear active canvas and redraw current stroke fully
    ctx.clearRect(0, 0, w, h);

    ctx.globalAlpha = currentStroke.alpha;
    ctx.strokeStyle = currentStroke.color;
    ctx.lineWidth = currentStroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (pts.length === 1) {
      ctx.fillStyle = currentStroke.color;
      ctx.beginPath();
      ctx.arc(pts[0]._x, pts[0]._y, currentStroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0]._x, pts[0]._y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i]._x, pts[i]._y);
      }
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
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

    // Cancel pending rAF
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    // Flush remaining unsent points
    if (currentPoints.length > 0) {
      WsClient.send('draw:stroking', {
        strokeId: currentStroke.strokeId,
        tool: currentStroke.tool,
        color: currentStroke.color,
        width: currentStroke.width,
        alpha: currentStroke.alpha,
        points: currentPoints.slice(),
      });
    }

    // Move completed stroke to static canvas
    strokes.push(currentStroke);

    invalidateCellCache();
    const cw = container.clientWidth;
    const positions = getCellPositions();
    drawSmoothStroke(staticCtx, currentStroke, cw, positions);

    // Clear active canvas
    ctx.clearRect(0, 0, cw, container.scrollHeight);

    WsClient.send('draw:stroke', currentStroke);

    currentStroke = null;
    currentPoints = [];
  }

  // --- Eraser ---

  function eraseAtPoint(pt) {
    const threshold = 15;
    const px = pt._x !== undefined ? pt._x : pt.xRatio * container.clientWidth;
    const py = pt._y !== undefined ? pt._y : pt.yOffset;
    const cw = container.clientWidth;
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
          redrawAll();
          WsClient.send('draw:erase', { strokeId: stroke.strokeId });
          break;
        }
      }
      if (erased) break;
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

  function redrawAll() {
    if (!staticCtx || !staticCanvas || !container) return;
    invalidateCellCache();
    const cw = container.clientWidth;
    const positions = getCellPositions();
    // Clear both canvases
    staticCtx.clearRect(0, 0, cw, container.scrollHeight);
    if (ctx) ctx.clearRect(0, 0, cw, container.scrollHeight);
    for (const stroke of strokes) {
      drawSmoothStroke(staticCtx, stroke, cw, positions);
    }
  }

  // --- Receive handlers (student side) ---

  function receiveStroke(stroke) {
    strokes.push(stroke);
    intermediateStrokeIds.delete(stroke.strokeId);
    if (intermediateStrokeIds.size === 0) {
      redrawAll();
    } else {
      invalidateCellCache();
      const cw = container.clientWidth;
      const positions = getCellPositions();
      drawSmoothStroke(staticCtx, stroke, cw, positions);
    }
  }

  function receiveStroking(data) {
    intermediateStrokeIds.add(data.strokeId);
    if (!staticCtx || !data.points || data.points.length === 0) return;

    if (!cellPosCache) buildCellCache();
    const cw = container.clientWidth;
    const positions = cellPosCache;

    staticCtx.globalAlpha = data.alpha || 1;
    staticCtx.strokeStyle = data.color || '#000';
    staticCtx.lineWidth = data.width || 4;
    staticCtx.lineCap = 'round';
    staticCtx.lineJoin = 'round';

    const pts = data.points;
    if (pts.length === 1) {
      const { x, y } = ptToPixelXY(pts[0], cw, positions);
      staticCtx.beginPath();
      staticCtx.arc(x, y, (data.width || 4) / 2, 0, Math.PI * 2);
      staticCtx.fillStyle = data.color || '#000';
      staticCtx.fill();
    } else {
      const p0 = ptToPixelXY(pts[0], cw, positions);
      staticCtx.beginPath();
      staticCtx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = ptToPixelXY(pts[i], cw, positions);
        staticCtx.lineTo(p.x, p.y);
      }
      staticCtx.stroke();
    }
    staticCtx.globalAlpha = 1;
  }

  function receiveUndo(data) {
    if (data && data.strokeId) {
      const idx = strokes.findIndex(s => s.strokeId === data.strokeId);
      if (idx !== -1) strokes.splice(idx, 1);
    } else {
      strokes.pop();
    }
    redrawAll();
  }

  function receiveErase(data) {
    if (data && data.strokeId) {
      const idx = strokes.findIndex(s => s.strokeId === data.strokeId);
      if (idx !== -1) strokes.splice(idx, 1);
      redrawAll();
    }
  }

  function receiveClear() {
    strokes = [];
    intermediateStrokeIds.clear();
    invalidateCellCache();
    redrawAll();
  }

  function receiveFull(data) {
    strokes = data.strokes || [];
    intermediateStrokeIds.clear();
    invalidateCellCache();
    redrawAll();
  }

  function clearAll() {
    strokes = [];
    intermediateStrokeIds.clear();
    invalidateCellCache();
    if (staticCtx && staticCanvas && container) {
      staticCtx.clearRect(0, 0, container.clientWidth, container.scrollHeight);
    }
    if (ctx && canvas && container) {
      ctx.clearRect(0, 0, container.clientWidth, container.scrollHeight);
    }
  }

  function destroy() {
    // Cancel any pending operations
    if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }

    // Clear state
    strokes = [];
    currentStroke = null;
    currentPoints = [];
    isErasing = false;
    intermediateStrokeIds.clear();
    invalidateCellCache();

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
