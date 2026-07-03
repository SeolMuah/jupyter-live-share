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
  let viewportResizeTimer = null;
  const RESIZE_DEBOUNCE_MS = 100;

  // Intermediate stroking state — Map of strokeId → {tool, color, width, alpha, points[]}
  let intermediateStrokes = new Map();

  // Per-stroke DOM read cache (set on pointerdown, cleared on pointerup)
  let cachedCellsRect = null;
  let cachedContainerTop = 0;
  let cachedCW = 0;

  // Viewport canvas scroll tracking
  const BUFFER_MULTIPLIER = 3; // canvas height = 3x viewport (1 above + current + 1 below)
  let canvasTop = 0;           // canvas absolute top position within container
  let cachedScrollOffset = 0;
  let scrollRAFPending = false;

  // Cell position cache — built once per resize/stroke-start
  let cellPosCache = null;

  // Plaintext content-top cache — 콘텐츠 텍스트박스(#document-content)의 document-space top.
  // plaintext 판서 y를 container.scrollHeight 비율로 인코딩하면 분모가 비-콘텐츠 성분
  // (#app-layout flex-stretch(뷰포트 의존)·::after 스페이서·padding·absolute 캔버스 오버플로)을
  // 포함해 교사↔학생 간 달라져 문서 하단으로 갈수록 판서가 어긋난다. 대신 노트북의
  // "셀 top + 절대 yPixel"과 대칭으로 콘텐츠 top 기준 절대 픽셀 앵커를 쓴다 — 콘텐츠는
  // 992/960px 폭·root 16px 폰트가 모든 뷰어에 강제되어 앵커 아래 줄 위치가 결정론적이다.
  let contentTopCache = null;

  // --- Cell Position Cache ---

  function invalidateCellCache() {
    cellPosCache = null;
    contentTopCache = null; // 셀 캐시와 동일 라이프사이클(리사이즈/재렌더/재배치 시 함께 갱신)
  }

  function getContentTop() {
    if (contentTopCache !== null) return contentTopCache;
    const root = cellsDiv || container;
    const el = root.querySelector('#document-content') || root.querySelector('.plaintext-document');
    if (!el) return null; // plaintext 미렌더 상태 — 호출측이 yRatio 폴백
    const cRect = container.getBoundingClientRect();
    contentTopCache = el.getBoundingClientRect().top - cRect.top + container.scrollTop;
    return contentTopCache;
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

  // Apply DPR + canvasTop transform (absolute coords → canvas-local coords)
  function applyScrollTransform(context) {
    const dpr = isTeacher ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    context.setTransform(dpr, 0, 0, dpr, 0, -canvasTop * dpr);
  }

  // --- Coordinate Conversion ---
  // Cell-relative coordinate system:
  //   { cellIndex, xRatio, yRatio, yPixel } for WS transmission
  //   yPixel = absolute pixel offset from cell top (mode-independent accuracy)
  //   yRatio  = proportional offset (fallback for old strokes without yPixel)
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
      const yOff = absY - positions[ci].top;
      const ch = positions[ci].height || 1;
      return { cellIndex: ci, xRatio, yRatio: yOff / ch, yPixel: yOff, _x: x, _y: absY };
    }
    // plaintext: 콘텐츠 top 기준 절대 픽셀 앵커(yPixel). yRatio는 구 뷰어/앵커 실측 실패 시 폴백용으로 유지.
    const contentTop = getContentTop();
    const pt = { cellIndex: -1, xRatio, yRatio: absY / (container.scrollHeight || 1), _x: x, _y: absY };
    if (contentTop !== null) pt.yPixel = absY - contentTop;
    return pt;
  }

  // Convert cell-relative point → absolute pixel (for received/stored strokes)
  function ptToPixelXY(pt, cw, positions) {
    const x = pt.xRatio * cw;
    let y;
    if (pt.cellIndex >= 0 && positions && pt.cellIndex < positions.length) {
      // Prefer absolute pixel offset (mode-independent) over proportional ratio
      if (pt.yPixel !== undefined) {
        y = positions[pt.cellIndex].top + pt.yPixel;
      } else {
        y = positions[pt.cellIndex].top + pt.yRatio * (positions[pt.cellIndex].height || 1);
      }
    } else if (pt.yPixel !== undefined) {
      // plaintext 신규 stroke: 콘텐츠 top 앵커 복원 (scrollHeight 비-콘텐츠 성분에 면역).
      // 앵커 실측 실패(콘텐츠 미렌더) 시에만 구 비율 방식 폴백.
      const contentTop = getContentTop();
      y = (contentTop !== null) ? contentTop + pt.yPixel : pt.yRatio * (container.scrollHeight || 1);
    } else {
      // 구 stroke(yPixel 없음) 하위호환: 기존 비율 방식 그대로.
      y = pt.yRatio * (container.scrollHeight || 1);
    }
    return { x, y };
  }

  // --- Transmission Helpers ---

  // Strip internal pixel coords (_x, _y) before WS send
  function stripInternalCoords(points) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      out[i] = { cellIndex: p.cellIndex, xRatio: p.xRatio, yRatio: p.yRatio, yPixel: p.yPixel };
    }
    return out;
  }

  // Ramer-Douglas-Peucker point simplification (reduces WS payload 50-70%)
  // Both xRatio and yRatio are already in 0-1 normalized range
  function simplifyPoints(points, epsilon) {
    if (points.length <= 2) return points;
    if (epsilon === undefined) epsilon = 0.002;

    let maxDist = 0, maxIdx = 0;
    const first = points[0], last = points[points.length - 1];
    const dx = last.xRatio - first.xRatio;
    const dy = last.yRatio - first.yRatio;
    const lenSq = dx * dx + dy * dy;

    for (let i = 1; i < points.length - 1; i++) {
      let dist;
      if (lenSq === 0) {
        const ex = points[i].xRatio - first.xRatio;
        const ey = points[i].yRatio - first.yRatio;
        dist = Math.sqrt(ex * ex + ey * ey);
      } else {
        const t = Math.max(0, Math.min(1,
          ((points[i].xRatio - first.xRatio) * dx + (points[i].yRatio - first.yRatio) * dy) / lenSq));
        const px = first.xRatio + t * dx - points[i].xRatio;
        const py = first.yRatio + t * dy - points[i].yRatio;
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

  // Track whether the user has manually dragged the tools panel
  let toolsPanelDragged = false;

  function init(isTeacherPreview) {
    isTeacher = isTeacherPreview;
    container = document.getElementById('notebook-container');
    cellsDiv = document.getElementById('notebook-cells');
    if (!container || !cellsDiv) return;

    // ALL viewers must render content at EXACTLY identical dimensions to prevent
    // drawing drift. Using flex:none + width (not flex:1 + min-width) so the
    // container is immune to scrollbar width, viewport size, and flex layout
    // differences between web browser and VS Code webview.
    // Container: 992px = 960px content + 16px padding × 2 (box-sizing: border-box)
    // Cells: 960px (set in CSS as width, not max-width)
    // → cellsDiv.clientWidth = 960px, cellsDiv.offsetLeft = 16px in ALL environments.
    container.style.width = '992px';
    container.style.minWidth = '992px';
    container.style.flex = 'none';
    container.style.margin = '0 auto'; // center within flex container on wide viewports
    document.body.style.overflowX = 'auto';

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
        // Reposition tools panel on content resize (keeps it stuck to content right edge)
        if (!toolsPanelDragged) positionToolsPanelRight();
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    // Scroll listeners for viewport canvas repositioning
    window.addEventListener('scroll', onContainerScroll, { passive: true });
    container.addEventListener('scroll', onContainerScroll, { passive: true });

    // Viewport resize → canvas resize (VS Code panel height change, browser window resize)
    window.addEventListener('resize', onViewportResize);

    // Restore drawing when panel becomes visible again (GPU bitmap loss recovery)
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Toolbar setup — tools panel on right side, toggle in footer
    toolsPanel = document.getElementById('draw-tools-panel');

    if (isTeacher) {
      // Show draw toggle button in footer
      const toggle = document.getElementById('draw-toggle');
      if (toggle) toggle.style.display = '';
      setupToolbar();
      setupPointerEvents();

      // Reposition tools panel on viewport resize (Teacher View width change)
      // Named function for proper cleanup in destroy()
      window.addEventListener('resize', onWindowResizeToolsPanel);

      // Initial positioning (deferred to after layout)
      requestAnimationFrame(() => positionToolsPanelRight());
    }
  }

  /**
   * Position the tools panel at the right edge of the content container.
   * Always sticks to content right, regardless of Teacher View width.
   */
  function positionToolsPanelRight() {
    if (!toolsPanel || !container) return;
    const containerRect = container.getBoundingClientRect();
    const panelWidth = toolsPanel.offsetWidth || 52;
    const gap = 4; // px gap between content and panel
    let leftPos = containerRect.right + gap;

    // Clamp: if panel would overflow viewport right edge, pin to viewport right
    if (leftPos + panelWidth > window.innerWidth) {
      leftPos = window.innerWidth - panelWidth - 2;
    }

    toolsPanel.style.position = 'fixed';
    toolsPanel.style.left = leftPos + 'px';
    toolsPanel.style.right = 'auto';
    toolsPanel.style.top = '50%';
    toolsPanel.style.transform = 'translateY(-50%)';
  }

  function onWindowResizeToolsPanel() {
    if (!toolsPanelDragged) positionToolsPanelRight();
  }

  function onViewportResize() {
    if (viewportResizeTimer) clearTimeout(viewportResizeTimer);
    viewportResizeTimer = setTimeout(() => {
      viewportResizeTimer = null;
      if (window.innerHeight < 1) return; // hidden panel — skip
      invalidateCellCache();
      resizeCanvas();
      redrawAll();
    }, RESIZE_DEBOUNCE_MS);
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && (strokes.length > 0 || intermediateStrokes.size > 0) && window.innerHeight > 0) {
      resizeCanvas();
      redrawAll();
    }
  }

  function resizeCanvas() {
    if (!canvas || !staticCanvas || !container) return;
    if (!staticCtx || !ctx) return;
    const dpr = isTeacher ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const w = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const vh = window.innerHeight;

    // Skip resize when panel is hidden/minimized — prevents 0-height canvas destroying strokes
    if (vh < 1 || w < 1) return;

    const h = vh * BUFFER_MULTIPLIER; // 3x viewport
    const leftOffset = cellsDiv ? cellsDiv.offsetLeft : 0;
    cachedScrollOffset = getScrollOffset();
    canvasTop = Math.max(0, cachedScrollOffset - vh); // 1 viewport above current scroll

    for (const cvs of [staticCanvas, canvas]) {
      cvs.style.left = leftOffset + 'px';
      cvs.style.top = canvasTop + 'px';
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
    cachedScrollOffset = scrollOffset;

    const vh = window.innerHeight;
    const bufferTop = canvasTop;
    const bufferBottom = canvasTop + vh * BUFFER_MULTIPLIER;

    // Only reposition when scroll nears buffer edge (25% margin)
    const margin = vh * 0.25;
    const needsReposition =
      scrollOffset < bufferTop + margin ||
      scrollOffset + vh > bufferBottom - margin;

    if (!needsReposition) return; // still within buffer — no redraw needed

    // Reposition canvas
    canvasTop = Math.max(0, scrollOffset - vh);
    staticCanvas.style.top = canvasTop + 'px';
    canvas.style.top = canvasTop + 'px';

    // Redraw static canvas
    clearCanvas(staticCtx, staticCanvas);
    applyScrollTransform(staticCtx);
    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const positions = getCellPositions();
    for (const stroke of strokes) {
      drawSmoothStroke(staticCtx, stroke, cw, positions);
    }

    // Redraw active canvas if needed
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

    // --- Drag handle for moving the panel ---
    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    toolsPanel.insertBefore(dragHandle, toolsPanel.firstChild);

    let isDragging = false, dragStartX = 0, dragStartY = 0, panelStartX = 0, panelStartY = 0;

    dragHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = toolsPanel.getBoundingClientRect();
      panelStartX = rect.left;
      panelStartY = rect.top;
      toolsPanel.classList.add('dragging');
      dragHandle.setPointerCapture(e.pointerId);
    });

    dragHandle.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      e.preventDefault();
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      let newX = panelStartX + dx;
      let newY = panelStartY + dy;
      // Clamp to viewport
      const pw = toolsPanel.offsetWidth;
      const ph = toolsPanel.offsetHeight;
      newX = Math.max(0, Math.min(window.innerWidth - pw, newX));
      newY = Math.max(0, Math.min(window.innerHeight - ph, newY));
      // Switch from right/top+transform to left/top positioning
      toolsPanel.style.right = 'auto';
      toolsPanel.style.transform = 'none';
      toolsPanel.style.left = newX + 'px';
      toolsPanel.style.top = newY + 'px';
    });

    const endDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      toolsPanel.classList.remove('dragging');
      toolsPanelDragged = true; // user manually positioned — don't auto-reposition
    };
    dragHandle.addEventListener('pointerup', endDrag);
    dragHandle.addEventListener('pointercancel', endDrag);

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

    // plaintext 앵커는 루프 밖에서 1회만 조회 (고빈도 move에서 per-point DOM read 0 유지)
    const contentTop = positions.length > 0 ? null : getContentTop();

    const events = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
    for (let j = 0; j < events.length; j++) {
      const ce = events[j];
      const x = ce.clientX - cellsRect.left;
      const absY = ce.clientY - containerTop + st;
      const xRatio = cw > 0 ? x / cw : 0;

      // Find cell using binary search on cached positions
      let cellIndex = -1;
      let yRatio = absY / (container.scrollHeight || 1);
      if (positions.length > 0) {
        cellIndex = findCellIndex(absY, positions);
        const yOff = absY - positions[cellIndex].top;
        const ch = positions[cellIndex].height || 1;
        yRatio = yOff / ch;
      }

      const pt = { cellIndex, xRatio, yRatio, _x: x, _y: absY };
      // plaintext: down점(toCoords)과 동일하게 move점 전부에 절대 앵커 부여.
      // (누락하면 시작점만 정확하고 이동점은 비율 드리프트가 잔존한다. 노트북 분기는 기존 그대로.)
      if (cellIndex < 0 && contentTop !== null) pt.yPixel = absY - contentTop;
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

    // Strip internal coordinates, keep all original points (no simplification)
    const cleaned = stripInternalCoords(currentStroke.points);
    currentStroke.points = cleaned;

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
      points: cleaned,
    });

    currentStroke = null;
    currentPoints = [];
  }

  // --- Eraser ---

  function eraseAtPoint(pt) {
    const threshold = 15;
    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const positions = getCellPositions();
    const px = pt._x !== undefined ? pt._x : pt.xRatio * cw;
    const py = pt._y !== undefined ? pt._y : ptToPixelXY(pt, cw, positions).y;

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

  // --- Stroke Drawing (Direct lineTo — no smoothing/interpolation) ---

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
    } else {
      const p0 = ptToPixelXY(pts[0], cw, positions);
      targetCtx.beginPath();
      targetCtx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = ptToPixelXY(pts[i], cw, positions);
        targetCtx.lineTo(p.x, p.y);
      }
      targetCtx.stroke();
    }

    targetCtx.globalAlpha = 1;
  }

  function redrawAll(skipCacheInvalidation) {
    if (!staticCtx || !staticCanvas || !container) return;
    if (!skipCacheInvalidation) invalidateCellCache();
    cachedScrollOffset = getScrollOffset();
    canvasTop = Math.max(0, cachedScrollOffset - window.innerHeight);

    // Update canvas positions
    staticCanvas.style.top = canvasTop + 'px';
    canvas.style.top = canvasTop + 'px';

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

    // Restore in-progress intermediate strokes (draw:stroking) on active canvas
    if (intermediateStrokes.size > 0 && ctx) {
      redrawIntermediateCanvasInner(cw, positions);
    }
  }

  // --- Receive handlers (student side) ---

  function receiveStroke(stroke) {
    strokes.push(stroke);
    intermediateStrokes.delete(stroke.strokeId);
    invalidateCellCache();

    // Panel hidden — store stroke but defer rendering until visible
    if (window.innerHeight < 1) return;

    // Refresh scroll offset to prevent stale canvasTop usage
    cachedScrollOffset = getScrollOffset();
    const vh = window.innerHeight;
    if (cachedScrollOffset < canvasTop || cachedScrollOffset + vh > canvasTop + vh * BUFFER_MULTIPLIER) {
      // Stroke area outside buffer — reposition and full redraw
      resizeCanvas();
      redrawAll();
      return;
    }

    const cw = cellsDiv ? cellsDiv.clientWidth : container.clientWidth;
    const positions = getCellPositions();
    applyScrollTransform(staticCtx);
    drawSmoothStroke(staticCtx, stroke, cw, positions);
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

    // Panel hidden — data accumulated but defer rendering
    if (window.innerHeight < 1) return;

    // Redraw all intermediates on active canvas
    redrawIntermediateCanvas();
  }

  function redrawIntermediateCanvas() {
    if (!ctx || !container) return;
    // Refresh scroll offset to prevent stale transform
    cachedScrollOffset = getScrollOffset();
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
    if (window.innerHeight < 1) return; // defer rendering until visible
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
    if (viewportResizeTimer) { clearTimeout(viewportResizeTimer); viewportResizeTimer = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    scrollRAFPending = false;

    // Remove scroll and resize listeners
    window.removeEventListener('scroll', onContainerScroll);
    window.removeEventListener('resize', onViewportResize);
    window.removeEventListener('resize', onWindowResizeToolsPanel);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (container) container.removeEventListener('scroll', onContainerScroll);

    // Reset tools panel state
    toolsPanelDragged = false;

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
    canvasTop = 0;

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
    invalidateCellCache,
    redrawAll,
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
