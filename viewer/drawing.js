/* drawing.js - Drawing/Annotation overlay module */

const Drawing = (() => {
  'use strict';

  let canvas = null;
  let ctx = null;
  let container = null; // #notebook-container
  let isTeacher = false;
  let drawingMode = false;

  // Stroke state
  let strokes = []; // completed strokes
  let currentStroke = null; // stroke being drawn
  let currentPoints = []; // points for current stroke
  let batchTimer = null;
  let isErasing = false; // eraser drag state (separate from currentStroke)
  const BATCH_INTERVAL = 50; // ms

  // Tool state
  let currentTool = 'pen'; // 'pen' | 'highlighter' | 'eraser'
  let currentColor = '#ef4444'; // red default
  let currentWidth = 4; // medium default

  // Toolbar elements
  let toolbar = null;
  let toolsPanel = null;

  // ResizeObserver debounce
  let resizeTimer = null;
  const RESIZE_DEBOUNCE_MS = 100;

  // Intermediate stroking state (for clearing on final stroke)
  let intermediateStrokeIds = new Set();

  // --- Canvas Setup ---

  function init(isTeacherPreview) {
    isTeacher = isTeacherPreview;
    container = document.getElementById('notebook-container');
    if (!container) return;

    // Create canvas
    canvas = document.createElement('canvas');
    canvas.id = 'draw-canvas';
    container.style.position = 'relative';
    container.appendChild(canvas);

    ctx = canvas.getContext('2d');

    resizeCanvas();

    // ResizeObserver to track content height changes (debounced)
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeCanvas();
        redrawAll();
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(container);

    // Toolbar setup
    toolbar = document.getElementById('draw-toolbar');
    toolsPanel = toolbar ? toolbar.querySelector('.draw-tools') : null;

    if (isTeacher && toolbar) {
      toolbar.style.display = 'flex';
      setupToolbar();
      setupPointerEvents();
    }
  }

  function resizeCanvas() {
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.scrollHeight;

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
        canvas.style.cursor = drawingMode ? 'crosshair' : 'default';
        if (drawingMode) {
          canvas.style.touchAction = 'none';
        } else {
          canvas.style.touchAction = '';
        }
      });
    }

    // Tool buttons
    toolbar.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toolbar.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTool = btn.dataset.tool;
        if (currentTool === 'eraser') {
          canvas.style.cursor = 'pointer';
        } else {
          canvas.style.cursor = 'crosshair';
        }
      });
    });

    // Color buttons
    toolbar.querySelectorAll('.color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toolbar.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = btn.dataset.color;
      });
    });

    // Width buttons
    toolbar.querySelectorAll('.width-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toolbar.querySelectorAll('.width-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentWidth = parseInt(btn.dataset.width, 10);
      });
    });

    // Undo
    const undoBtn = document.getElementById('draw-undo');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        if (strokes.length === 0) return;
        strokes.pop();
        redrawAll();
        WsClient.send('draw:undo', {});
      });
    }

    // Clear
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

  function toCoords(e) {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top + container.scrollTop;
    return {
      xRatio: container.clientWidth > 0 ? x / container.clientWidth : 0,
      yAbsolute: y,
    };
  }

  function onPointerDown(e) {
    if (!drawingMode) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

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

    // Start batch timer
    batchTimer = setInterval(() => {
      if (currentPoints.length > 0) {
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

    // Draw first dot
    drawStrokeSegment(currentStroke, [pt]);
  }

  function onPointerMove(e) {
    if (!drawingMode) return;

    // Eraser drag: tracked separately from currentStroke
    if (isErasing) {
      e.preventDefault();
      eraseAtPoint(toCoords(e));
      return;
    }

    if (!currentStroke) return;
    e.preventDefault();

    const pt = toCoords(e);
    currentStroke.points.push(pt);
    currentPoints.push(pt);

    // Draw incrementally (last 2 points)
    const pts = currentStroke.points;
    if (pts.length >= 2) {
      drawStrokeSegment(currentStroke, [pts[pts.length - 2], pts[pts.length - 1]]);
    }
  }

  function onPointerUp(e) {
    // Reset eraser drag state
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

    // Send final stroke
    strokes.push(currentStroke);
    WsClient.send('draw:stroke', currentStroke);

    currentStroke = null;
    currentPoints = [];
  }

  // --- Eraser ---

  function eraseAtPoint(pt) {
    const threshold = 15; // pixels
    const containerWidth = container.clientWidth;
    const px = pt.xRatio * containerWidth;
    const py = pt.yAbsolute;

    let erased = false;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      for (const sp of stroke.points) {
        const sx = sp.xRatio * containerWidth;
        const sy = sp.yAbsolute;
        const dist = Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
        if (dist < threshold) {
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

  // --- Drawing ---

  function drawStrokeSegment(stroke, points) {
    if (!ctx || points.length === 0) return;
    const w = container.clientWidth;

    ctx.save();
    ctx.globalAlpha = stroke.alpha;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
      // Single dot
      ctx.beginPath();
      ctx.arc(points[0].xRatio * w, points[0].yAbsolute, stroke.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].xRatio * w, points[0].yAbsolute);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].xRatio * w, points[i].yAbsolute);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFullStroke(stroke) {
    if (!ctx || !stroke.points || stroke.points.length === 0) return;
    const w = container.clientWidth;

    ctx.save();
    ctx.globalAlpha = stroke.alpha;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.points.length === 1) {
      ctx.beginPath();
      ctx.arc(stroke.points[0].xRatio * w, stroke.points[0].yAbsolute, stroke.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].xRatio * w, stroke.points[0].yAbsolute);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].xRatio * w, stroke.points[i].yAbsolute);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function redrawAll() {
    if (!ctx || !canvas || !container) return;
    // Use logical CSS dimensions (transform already scales by DPR)
    ctx.clearRect(0, 0, container.clientWidth, container.scrollHeight);
    for (const stroke of strokes) {
      drawFullStroke(stroke);
    }
  }

  // --- Receive handlers (student side) ---

  function receiveStroke(stroke) {
    strokes.push(stroke);
    // Clear intermediate stroking data for this stroke
    intermediateStrokeIds.delete(stroke.strokeId);
    // Redraw all to clear any intermediate stroking artifacts
    if (intermediateStrokeIds.size === 0) {
      redrawAll();
    } else {
      drawFullStroke(stroke);
    }
  }

  function receiveStroking(data) {
    // Track intermediate strokes for cleanup
    intermediateStrokeIds.add(data.strokeId);
    // Real-time streaming — draw points as they arrive
    drawStrokeSegment(data, data.points || []);
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
    redrawAll();
  }

  function receiveFull(data) {
    strokes = data.strokes || [];
    intermediateStrokeIds.clear();
    redrawAll();
  }

  function clearAll() {
    strokes = [];
    intermediateStrokeIds.clear();
    if (ctx && canvas && container) {
      ctx.clearRect(0, 0, container.clientWidth, container.scrollHeight);
    }
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
  };
})();
