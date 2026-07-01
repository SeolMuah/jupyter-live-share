/* renderer.js - Notebook cell rendering */

const Renderer = (() => {
  const HIGHLIGHT_DEBOUNCE_MS = 150;
  // 커서는 idle 타임아웃 없이 영구 표시 (마지막 위치에서 계속 깜빡임).
  // 정리는 셀 전환 시 removeCursor(), 세션 종료 시 resetCursorState()가 전담.
  let highlightTimers = {};
  let layoutChangeCallback = null;
  let lastRenderedHash = {};

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  // Markup cells revert to rendered mode after this idle duration (ms).
  // Code cells are NOT affected — their cursor persists indefinitely.
  const MARKUP_REVERT_MS = 3000;
  let markupRevertTimer = null;

  /** Current page scroll offset (robust for VS Code Webview iframe) */
  function getScrollY() {
    return window.scrollY || window.pageYOffset
      || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  /**
   * Debounced highlight: 텍스트는 즉시 반영, 하이라이팅은 지연
   */
  function debouncedHighlight(key, element) {
    if (highlightTimers[key]) clearTimeout(highlightTimers[key]);
    highlightTimers[key] = setTimeout(() => {
      // Detach cursor overlays before highlighting (hljs.highlightElement replaces innerHTML)
      const overlays = [];
      element.querySelectorAll('.teacher-cursor, .teacher-line-highlight, .teacher-selection, .teacher-selection-container').forEach(el => {
        overlays.push(el);
        el.remove();
      });

      hljs.highlightElement(element);

      // Re-attach cursor overlays
      for (const el of overlays) {
        element.appendChild(el);
      }
      delete highlightTimers[key];
    }, HIGHLIGHT_DEBOUNCE_MS);
  }

  const LARGE_CELL_LINE_THRESHOLD = 200;

  // 단일 물결표(~text~) 취소선 비활성화 — 이중 물결표(~~text~~)만 허용
  // marked v12 GFM 내장 del 정규식이 단일 물결표도 매칭하므로 2단계 방어 적용

  // 1단계: marked 내장 GFM del 정규식을 이중 물결표 전용으로 직접 교체 (시도)
  if (marked.Lexer && marked.Lexer.rules &&
      marked.Lexer.rules.inline && marked.Lexer.rules.inline.gfm) {
    try {
      marked.Lexer.rules.inline.gfm.del = /^~~([^~][\s\S]*?)~~(?=[^~]|$)/;
    } catch (e) { /* frozen 객체면 2단계 폴백 */ }
  }

  // 2단계: 소스 전처리 — 단일 물결표를 HTML 엔티티로 이스케이프 (확실한 폴백)
  // ~~는 보존 (정상 취소선), 단일 ~만 &#126;로 변환
  // 코드 펜스(```...```) 및 인라인 코드(`...`)는 건너뜀
  function escapeGfmSingleTildes(src) {
    // 코드 펜스, 인라인 코드, 그 외 텍스트를 순서대로 매칭
    return src.replace(/(```[\s\S]*?```|`[^`\n]+`)|(?<![~])~(?![~])/g,
      (match, codeBlock) => codeBlock ? codeBlock : '&#126;');
  }

  // marked.js math extension: $...$ 및 $$...$$ 수식을 emphasis 토크나이저보다 먼저 인식
  // GFM이 underscore(_)를 em/strong으로 처리하기 전에 수식을 보호
  marked.use({
    extensions: [{
      name: 'math',
      level: 'inline',
      start(src) { return src.indexOf('$'); },
      tokenizer(src) {
        // display math $$...$$
        const displayMatch = src.match(/^\$\$([\s\S]+?)\$\$/);
        if (displayMatch) {
          return { type: 'math', raw: displayMatch[0], text: displayMatch[1], displayMode: true };
        }
        // inline math $...$  (no space after opening $, prevents $5 false positive)
        const inlineMatch = src.match(/^\$([^\s$](?:[^$]*?[^\s$])?)\$/);
        if (inlineMatch) {
          return { type: 'math', raw: inlineMatch[0], text: inlineMatch[1], displayMode: false };
        }
        return undefined;
      },
      renderer(token) {
        const escaped = token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const delim = token.displayMode ? '$$' : '$';
        return `<span class="math-tex">${delim}${escaped}${delim}</span>`;
      },
    }],
  });

  /**
   * Atomic highlight update: hljs.highlight() + innerHTML in one shot.
   * Prevents flicker from textContent destroying hljs spans then re-highlighting later.
   * Preserves cursor overlay elements that are children of codeEl.
   */
  function highlightedUpdate(codeEl, source, language) {
    // Detach cursor overlays (they are children of codeEl)
    const overlays = [];
    codeEl.querySelectorAll('.teacher-cursor, .teacher-line-highlight, .teacher-selection, .teacher-selection-container').forEach(el => {
      overlays.push(el);
      el.remove();
    });

    const lineCount = (source || '').split('\n').length;

    if (language && language !== 'plaintext' && lineCount <= LARGE_CELL_LINE_THRESHOLD) {
      try {
        const result = hljs.highlight(source || '', { language });
        codeEl.innerHTML = result.value;
      } catch (e) {
        codeEl.textContent = source || '';
      }
    } else {
      codeEl.textContent = source || '';
      if (language && language !== 'plaintext') {
        const parentId = codeEl.closest('[id]')?.id || 'unknown';
        debouncedHighlight(`fallback-${parentId}-${language}`, codeEl);
      }
    }

    // Re-attach cursor overlays
    for (const el of overlays) {
      codeEl.appendChild(el);
    }
  }

  function detectLanguage(codeEl) {
    for (const cls of codeEl.className.split(/\s+/)) {
      if (cls.startsWith('language-')) return cls.slice(9);
    }
    return null;
  }

  /**
   * Copy text to clipboard with fallback
   */
  function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      showCopySuccess(btn);
    }).catch(() => {
      // Fallback: execCommand
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showCopySuccess(btn);
      } catch (e) {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }
      document.body.removeChild(textarea);
    });
  }

  function showCopySuccess(btn) {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  }

  /**
   * Render markdown tokens with line number data attributes
   * Uses marked tokens to track source line positions
   */
  function renderMarkdownWithLineNumbers(tokens, sourceText) {
    // 소스 텍스트에서 각 토큰의 raw를 순차 매칭하여 정확한 라인 위치 추적
    let searchOffset = 0;
    let html = '';

    // 소스를 줄 단위로 분할하여 offset→line 변환용
    const lineBreaks = [0]; // lineBreaks[i] = i번째 줄의 시작 문자 offset
    for (let i = 0; i < (sourceText || '').length; i++) {
      if (sourceText[i] === '\n') lineBreaks.push(i + 1);
    }
    function offsetToLine(offset) {
      // 이진 탐색: offset이 속한 줄 번호 반환
      let lo = 0, hi = lineBreaks.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineBreaks[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }

    for (const token of tokens) {
      const tokenText = token.raw || '';

      // 소스에서 토큰의 시작 위치를 찾아 정확한 라인 번호 계산
      let startLine;
      if (sourceText && tokenText) {
        const idx = sourceText.indexOf(tokenText, searchOffset);
        if (idx !== -1) {
          startLine = offsetToLine(idx);
          searchOffset = idx + tokenText.length;
        } else {
          startLine = offsetToLine(searchOffset);
        }
      } else {
        startLine = offsetToLine(searchOffset);
      }

      // 블록 레벨 요소에 data-line 속성 추가
      if (token.type !== 'space') {
        try {
          const tokenHtml = marked.parser([token]);
          const modifiedHtml = tokenHtml.replace(/^<(\w+)/, `<$1 data-line="${startLine}"`);
          html += modifiedHtml;
        } catch (e) {
          // malformed token — skip
        }
      }
    }

    return html;
  }
  /**
   * Reset all cursor/highlight state (call before full re-render)
   */
  function resetCursorState() {
    if (markupRevertTimer) { clearTimeout(markupRevertTimer); markupRevertTimer = null; }
    cursorElement = null;
    selectionElement = null;
    currentCursorCellIndex = -1;
    documentCursorActive = false;
    mdDocViewMode = 'rendered';
    // Clear stale highlight timers (DOM elements are about to be destroyed)
    for (const key of Object.keys(highlightTimers)) {
      clearTimeout(highlightTimers[key]);
      delete highlightTimers[key];
    }
    lastRenderedHash = {};
  }

  /**
   * Render entire notebook
   */
  function renderNotebook(notebook, container) {
    resetCursorState();
    container.innerHTML = '';
    notebook.cells.forEach((cell, index) => {
      const el = renderCell(cell, index);
      container.appendChild(el);
    });

    // Highlight active cell
    if (notebook.activeCellIndex >= 0) {
      setActiveCell(notebook.activeCellIndex);
    }
  }

  /**
   * Render a single cell
   */
  function renderCell(cell, index) {
    const cellEl = document.createElement('div');
    cellEl.className = `cell cell-${cell.kind}`;
    cellEl.dataset.index = String(index);
    cellEl.id = `cell-${index}`;

    if (cell.kind === 'markup') {
      renderMarkupCell(cell, cellEl);
    } else {
      renderCodeCell(cell, cellEl, index);
    }

    return cellEl;
  }

  /**
   * Render markdown cell with line number mapping for accurate scroll sync
   */
  function renderMarkupCell(cell, container) {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'cell-markup-wrapper';

    const content = document.createElement('div');
    content.className = 'cell-markup';

    // 라인 번호 매핑을 포함한 마크다운 렌더링 (정확한 스크롤 동기화용)
    const source = cell.source || '';
    if (source.trim()) {
      const tokens = marked.lexer(escapeGfmSingleTildes(source));
      const html = renderMarkdownWithLineNumbers(tokens, source);
      content.innerHTML = DOMPurify.sanitize(html, {
        ADD_ATTR: ['data-line', 'class', 'style'],
      });
    }

    // highlight.js로 코드 블록 하이라이팅
    content.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block);
    });

    // KaTeX로 수식 렌더링
    try {
      renderMathInElement(content, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true },
        ],
        throwOnError: false,
      });
    } catch (e) {
      console.warn('KaTeX rendering error:', e);
    }

    wrapper.appendChild(content);

    // 원본 소스 저장 (커서 표시 + Copy 버튼에서 사용)
    wrapper.dataset.source = cell.source || '';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      const source = wrapper.dataset.source || '';
      copyToClipboard(source, copyBtn);
    });
    wrapper.appendChild(copyBtn);

    container.appendChild(wrapper);
  }

  /**
   * Render code cell
   */
  function renderCodeCell(cell, container, index) {
    container.innerHTML = '';

    // Source area
    const sourceEl = document.createElement('div');
    sourceEl.className = 'cell-source';

    const execLabel = document.createElement('span');
    execLabel.className = 'exec-label';
    execLabel.textContent = cell.executionOrder ? `In [${cell.executionOrder}]:` : 'In [ ]:';
    sourceEl.appendChild(execLabel);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-python';
    code.textContent = cell.source || '';
    hljs.highlightElement(code);
    pre.appendChild(code);
    sourceEl.appendChild(pre);

    container.appendChild(sourceEl);

    // Copy button (read from code element for live updates)
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      const codeEl = container.querySelector('.cell-source code');
      const text = codeEl ? codeEl.textContent : '';
      copyToClipboard(text, copyBtn);
    });
    container.appendChild(copyBtn);

    // Outputs
    if (cell.outputs && cell.outputs.length > 0) {
      const outputEl = renderOutputs(cell.outputs);
      container.appendChild(outputEl);
    }
  }

  /**
   * Pick the richest MIME item from an output's items.
   * display()/execute_result produces multiple MIME types for the same data
   * (e.g., text/html + text/plain for DataFrame). Render only the richest one.
   * Stream (stdout/stderr) and error outputs are typically single-item.
   */
  function pickBestMimeItem(items) {
    if (items.length <= 1) return items[0] || null;

    // Prefer: text/html > image/* > everything else > text/plain
    const htmlItem = items.find(i => i.mime === 'text/html');
    if (htmlItem) return htmlItem;

    const imageItem = items.find(i => i.mime.startsWith('image/'));
    if (imageItem) return imageItem;

    // Avoid text/plain if a richer format exists
    const nonPlain = items.find(i => i.mime !== 'text/plain');
    if (nonPlain) return nonPlain;

    return items[0];
  }

  /**
   * Render cell outputs
   */
  function renderOutputs(outputs) {
    const container = document.createElement('div');
    container.className = 'cell-outputs';

    for (const output of outputs) {
      if (!output.items || output.items.length === 0) continue;

      // 같은 데이터의 여러 MIME 표현 중 가장 풍부한 것 하나만 렌더링
      const bestItem = pickBestMimeItem(output.items);
      if (bestItem) {
        const el = renderOutputItem(bestItem);
        if (el) container.appendChild(el);
      }
    }

    return container;
  }

  /**
   * Render single output item by MIME type
   */
  function renderOutputItem(item) {
    const { mime, data } = item;

    if (mime === 'text/html') {
      const div = document.createElement('div');
      // Sanitize HTML output - allow inline style attribute but NOT <style> tags
      // <style> tags can be exploited for CSS-based attacks (data exfiltration, UI spoofing)
      div.innerHTML = DOMPurify.sanitize(data, {
        ADD_ATTR: ['class', 'style'], // inline style attribute only
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
      });
      return div;
    }

    if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = `data:${mime};base64,${data}`;
      img.alt = 'Cell output';
      return img;
    }

    if (mime === 'text/plain') {
      const pre = document.createElement('pre');
      pre.textContent = data;
      return pre;
    }

    // stdout (print() 출력)
    if (mime === 'application/vnd.code.notebook.stdout') {
      const pre = document.createElement('pre');
      pre.className = 'output-stdout';
      pre.textContent = data;
      return pre;
    }

    // stderr (에러 스트림)
    if (mime === 'application/vnd.code.notebook.stderr') {
      const pre = document.createElement('pre');
      pre.className = 'output-stderr';
      pre.textContent = data;
      return pre;
    }

    if (mime === 'application/vnd.plotly.v1+json') {
      const div = document.createElement('div');
      div.textContent = '[Plotly chart - open in Jupyter to view interactive plot]';
      div.style.color = 'var(--text-muted)';
      div.style.fontStyle = 'italic';
      return div;
    }

    // Error traceback
    if (mime === 'application/vnd.code.notebook.error') {
      const div = document.createElement('div');
      div.className = 'cell-output-error';
      try {
        const errorData = JSON.parse(data);
        div.textContent = `${errorData.ename}: ${errorData.evalue}\n${(errorData.traceback || []).join('\n')}`;
      } catch {
        div.textContent = data;
      }
      return div;
    }

    // 기타 텍스트 계열 MIME 타입 fallback
    if (data && typeof data === 'string') {
      const pre = document.createElement('pre');
      pre.textContent = data;
      return pre;
    }

    return null;
  }

  /**
   * Immediately render markdown content for a cell (no debounce)
   * Used by updateCellSource debounce callback and removeCursor flush
   */
  function renderMarkupImmediate(index) {
    const cellEl = document.getElementById(`cell-${index}`);
    if (!cellEl) return;
    const markupWrapper = cellEl.querySelector('.cell-markup-wrapper');
    const markupEl = cellEl.querySelector('.cell-markup');
    if (!markupEl || !markupWrapper) return;

    const source = markupWrapper.dataset.source || '';
    if (source.trim()) {
      const tokens = marked.lexer(escapeGfmSingleTildes(source));
      const html = renderMarkdownWithLineNumbers(tokens, source);
      markupEl.innerHTML = DOMPurify.sanitize(html, {
        ADD_ATTR: ['data-line', 'class', 'style'],
      });
      markupEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
      });
      try {
        renderMathInElement(markupEl, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
      } catch (e) { /* ignore */ }
      // 렌더링 완료 후 해시 기록 (stale 체크용)
      lastRenderedHash[index] = simpleHash(source);
    } else {
      markupEl.innerHTML = '';
      lastRenderedHash[index] = 0;
    }
  }

  /**
   * Update a single cell's source
   */
  function updateCellSource(index, source) {
    const cellEl = document.getElementById(`cell-${index}`);
    if (!cellEl) {
      console.error('[JLS] updateCellSource FAIL — DOM cell-' + index + ' not found');
      return;
    }

    const codeEl = cellEl.querySelector('.cell-source code');
    if (codeEl) {
      highlightedUpdate(codeEl, source, detectLanguage(codeEl));
    }

    // Markup cell - Markdown 렌더링은 디바운스 (라인 번호 매핑 포함)
    const markupWrapper = cellEl.querySelector('.cell-markup-wrapper');
    const markupEl = cellEl.querySelector('.cell-markup');
    if (markupEl) {
      // Update data-source for copy button
      if (markupWrapper) {
        markupWrapper.dataset.source = source || '';
      }

      // Raw source 모드 활성 시 즉시 텍스트 업데이트 (마지막 글자 누락 방지)
      const rawSourceCode = cellEl.querySelector('.markup-raw-source code');
      if (rawSourceCode) {
        highlightedUpdate(rawSourceCode, source || '', 'markdown');
      }

      const key = `markup-${index}`;
      if (highlightTimers[key]) clearTimeout(highlightTimers[key]);
      highlightTimers[key] = setTimeout(() => {
        renderMarkupImmediate(index);
        delete highlightTimers[key];
      }, HIGHLIGHT_DEBOUNCE_MS);
    }
  }

  /**
   * Update a cell's outputs
   */
  function updateCellOutputs(index, outputs, executionOrder) {
    const cellEl = document.getElementById(`cell-${index}`);
    if (!cellEl) return;

    // Update execution order
    const execLabel = cellEl.querySelector('.exec-label');
    if (execLabel && executionOrder) {
      execLabel.textContent = `In [${executionOrder}]:`;
    }

    // Remove existing outputs
    const existingOutput = cellEl.querySelector('.cell-outputs');
    if (existingOutput) existingOutput.remove();

    // Add new outputs
    if (outputs && outputs.length > 0) {
      const outputEl = renderOutputs(outputs);
      cellEl.appendChild(outputEl);
    }
  }

  /**
   * Set the active (focused) cell — highlight + scroll if needed
   * 선생님이 셀을 클릭하면 학생 화면도 해당 셀이 보이도록 스크롤
   */
  function setActiveCell(index, skipScroll) {
    // Remove existing active
    document.querySelectorAll('.cell.active').forEach((el) => {
      el.classList.remove('active');
    });

    const cellEl = document.getElementById(`cell-${index}`);
    if (cellEl) {
      cellEl.classList.add('active');

      // Auto-scroll (skipScroll for teacher preview — teacher controls their own scroll)
      if (!skipScroll) {
        const autoScroll = document.getElementById('auto-scroll');
        if (autoScroll && autoScroll.checked) {
          const headerHeight = document.getElementById('header')?.offsetHeight || 48;
          // Use getBoundingClientRect for reliable positioning regardless of
          // positioned ancestors (container has position:relative for canvas overlay)
          const rect = cellEl.getBoundingClientRect();
          window.scrollTo({
            top: Math.max(0, rect.top + getScrollY() - headerHeight - 8),
            behavior: 'auto'
          });
        }
      }
    }
  }

  /**
   * Scroll to a specific line number in plaintext document
   * Uses data-line attributes for markdown, line height calculation for code
   */
  function scrollToLine(lineNumber) {
    const contentEl = document.getElementById('document-content');
    if (!contentEl) return;

    const headerHeight = document.getElementById('header')?.offsetHeight || 48;
    const margin = 60;
    const markupEl = contentEl.querySelector('.cell-markup');

    if (markupEl) {
      const elementsWithLine = markupEl.querySelectorAll('[data-line]');
      let targetEl = null;
      let closestLine = -1;

      for (const el of elementsWithLine) {
        const elLine = parseInt(el.getAttribute('data-line'), 10);
        if (elLine <= lineNumber && elLine > closestLine) {
          closestLine = elLine;
          targetEl = el;
        }
      }

      if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        // 이미 뷰포트 안에 보이면 스크롤 불필요
        if (rect.top >= headerHeight + margin && rect.bottom <= window.innerHeight - margin) {
          return;
        }
        const absoluteTop = rect.top + window.scrollY;
        window.scrollTo({
          top: Math.max(0, absoluteTop - headerHeight - (window.innerHeight / 3)),
          behavior: 'auto'
        });
        return;
      }
    }

    const codeEl = contentEl.querySelector('pre code');
    if (codeEl) {
      const lineHeight = parseFloat(getComputedStyle(codeEl).lineHeight) || 24;
      const codeTop = codeEl.getBoundingClientRect().top + window.scrollY;
      const targetAbsoluteTop = codeTop + (lineNumber * lineHeight);

      // 이미 뷰포트 안에 보이면 스크롤 불필요
      const targetViewportTop = targetAbsoluteTop - window.scrollY;
      if (targetViewportTop >= headerHeight + margin && targetViewportTop <= window.innerHeight - margin) {
        return;
      }

      window.scrollTo({
        top: Math.max(0, targetAbsoluteTop - headerHeight - (window.innerHeight / 3)),
        behavior: 'auto'
      });
    }
  }

  /**
   * Scroll to a specific ratio (0-1) of the document
   * Works better for rendered content like markdown
   */
  function scrollToRatio(ratio) {
    if (typeof ratio !== 'number' || isNaN(ratio)) return;

    // 전체 스크롤 가능한 높이 계산 (window 기준)
    const documentHeight = document.documentElement.scrollHeight;
    const windowHeight = window.innerHeight;
    const maxScroll = documentHeight - windowHeight;

    if (maxScroll <= 0) return; // 스크롤할 내용이 없음

    const scrollTarget = maxScroll * Math.min(1, Math.max(0, ratio));

    window.scrollTo({
      top: scrollTarget,
      behavior: 'auto'
    });
  }

  /**
   * 소스 라인 앵커로 plaintext 문서 스크롤 (화면 크기 독립적)
   * line: 첫 번째 가시 소스 라인 번호, offsetRatio: 라인 내 오프셋 비율
   */
  function scrollToDocumentAnchor(line, offsetRatio) {
    if (typeof line !== 'number' || isNaN(line)) return;
    const contentEl = document.getElementById('document-content');
    if (!contentEl) return;
    const headerHeight = document.getElementById('header')?.offsetHeight || 48;
    const MARGIN = 8;
    const off = (typeof offsetRatio === 'number' && !isNaN(offsetRatio))
      ? Math.min(1, Math.max(0, offsetRatio)) : 0;

    // Markdown plaintext: [data-line] 속성으로 가장 가까운 요소 찾기
    const markupEl = contentEl.querySelector('.cell-markup');
    if (markupEl) {
      const els = markupEl.querySelectorAll('[data-line]');
      let targetEl = null, closest = -1;
      for (const el of els) {
        const l = parseInt(el.getAttribute('data-line'), 10);
        if (l <= line && l > closest) { closest = l; targetEl = el; }
      }
      if (!targetEl && els.length) targetEl = els[0];
      if (!targetEl) return;
      const rect = targetEl.getBoundingClientRect();
      const targetAbs = rect.top + getScrollY() + off * (rect.height || 0);
      const dest = Math.max(0, targetAbs - headerHeight - MARGIN);
      if (Math.abs(getScrollY() - dest) < 2) return;
      window.scrollTo({ top: dest, behavior: 'auto' });
      return;
    }

    // 코드 plaintext: 균일 라인 높이 기반 절대 위치 계산
    const code = contentEl.querySelector('pre code');
    if (code) {
      const lineHeight = parseFloat(getComputedStyle(code).lineHeight) || 24;
      const codeTopAbs = code.getBoundingClientRect().top + getScrollY();
      const targetAbs = codeTopAbs + (line + off) * lineHeight;
      const dest = Math.max(0, targetAbs - headerHeight - MARGIN);
      if (Math.abs(getScrollY() - dest) < 2) return;
      window.scrollTo({ top: dest, behavior: 'auto' });
    }
  }

  /**
   * Scroll notebook to match teacher's visible cell range
   * 셀이 이미 화면에 보이면 불필요한 스크롤 방지
   */
  function scrollNotebookToCell(cellIndex) {
    const cellEl = document.getElementById(`cell-${cellIndex}`);
    if (!cellEl) return;

    const headerHeight = document.getElementById('header')?.offsetHeight || 48;
    const rect = cellEl.getBoundingClientRect();

    // 셀 상단이 뷰포트 안에 있으면 스크롤 불필요
    if (rect.top >= headerHeight && rect.top <= window.innerHeight - 100) {
      return;
    }

    window.scrollTo({
      top: Math.max(0, rect.top + getScrollY() - headerHeight - 8),
      behavior: 'auto'
    });
  }

  /**
   * Scroll notebook to a cell-relative anchor position
   * Uses cellIndex + offsetRatio for screen-size-independent positioning
   */
  function scrollToNotebookAnchor(cellIndex, offsetRatio) {
    const cellEl = document.getElementById('cell-' + cellIndex);
    if (!cellEl) return;

    const headerHeight = document.getElementById('header')?.offsetHeight || 48;
    // Use getBoundingClientRect for reliable positioning regardless of
    // positioned ancestors (container has position:relative for canvas overlay)
    const rect = cellEl.getBoundingClientRect();
    const currentScroll = getScrollY();
    const targetScroll = rect.top + currentScroll + (rect.height * offsetRatio) - headerHeight;

    // 이미 5px 이내면 스크롤 생략 (jitter 방지)
    if (Math.abs(currentScroll - targetScroll) < 5) return;

    window.scrollTo({ top: Math.max(0, targetScroll), behavior: 'auto' });
  }

  // Teacher viewport indicator 제거 — 선생님 스크롤이 학생 화면에 영향 없음

  /**
   * Handle structure changes (add/remove cells)
   */
  function handleStructureChange(change, cells) {
    // Re-render entire notebook for simplicity
    // renderNotebook internally calls resetCursorState()
    const container = document.getElementById('notebook-cells');
    if (container && cells) {
      renderNotebook({ cells, activeCellIndex: -1 }, container);
    }
  }

  // === Plaintext Document Rendering ===

  /**
   * Render a plaintext document
   */
  function renderPlaintextDocument(data, container) {
    resetCursorState();
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'plaintext-document';

    // 파일 타입 뱃지
    const header = document.createElement('div');
    header.className = 'document-header';
    const badge = document.createElement('span');
    badge.className = 'document-type-badge';
    badge.textContent = getLanguageLabel(data.languageId);
    header.appendChild(badge);

    // Copy 버튼 (read from content element for live updates)
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn document-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      // Always prefer data-source (raw content) for accurate copy
      const text = wrapper.dataset.source || '';
      copyToClipboard(text, copyBtn);
    });
    header.appendChild(copyBtn);
    wrapper.dataset.source = data.content || '';

    wrapper.appendChild(header);

    // 콘텐츠 렌더링
    const contentEl = document.createElement('div');
    contentEl.className = 'document-content';
    contentEl.id = 'document-content';

    renderDocumentContent(data.content, data.languageId, contentEl);
    wrapper.appendChild(contentEl);
    container.appendChild(wrapper);
  }

  /**
   * Render document content based on language type
   */
  function renderDocumentContent(content, languageId, container) {
    container.innerHTML = '';

    if (languageId === 'markdown') {
      // Markdown 렌더링 with line number mapping
      const mdEl = document.createElement('div');
      mdEl.className = 'cell-markup';

      // 라인 번호 매핑을 위해 토큰 단위로 렌더링
      const tokens = marked.lexer(escapeGfmSingleTildes(content || ''));
      const html = renderMarkdownWithLineNumbers(tokens, content || '');
      mdEl.innerHTML = DOMPurify.sanitize(html, {
        ADD_ATTR: ['data-line', 'class', 'style'],
      });

      // 코드 블록 하이라이팅
      mdEl.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
      });

      // KaTeX 수식 렌더링
      try {
        renderMathInElement(mdEl, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
      } catch (e) {
        console.warn('KaTeX rendering error:', e);
      }

      container.appendChild(mdEl);
    } else {
      // 코드 또는 일반 텍스트
      const pre = document.createElement('pre');
      const code = document.createElement('code');

      const hljsLang = getHljsLanguage(languageId);
      if (hljsLang) {
        code.className = `language-${hljsLang}`;
        code.textContent = content || '';
        hljs.highlightElement(code);
      } else {
        code.textContent = content || '';
      }

      pre.appendChild(code);
      container.appendChild(pre);
    }
  }

  /**
   * Update plaintext document content
   */
  function updateDocumentContent(content) {
    const contentEl = document.getElementById('document-content');
    if (!contentEl) return;

    // Update data-source for copy button
    const wrapper = document.querySelector('.plaintext-document');
    if (wrapper) {
      wrapper.dataset.source = content || '';
    }

    // languageId를 badge 텍스트에서 유추
    const badge = document.querySelector('.document-type-badge');
    const label = badge ? badge.textContent : '';
    const languageId = getLangIdFromLabel(label);

    if (languageId === 'markdown') {
      if (mdDocViewMode === 'raw') {
        // Raw mode: 코드 요소 직접 업데이트 (코드 파일과 동일)
        const codeEl = contentEl.querySelector('code');
        if (codeEl) {
          highlightedUpdate(codeEl, content || '', 'markdown');
        }
      } else {
        // Rendered mode: 전체 렌더링 디바운스
        const key = 'doc-markdown';
        if (highlightTimers[key]) clearTimeout(highlightTimers[key]);
        highlightTimers[key] = setTimeout(() => {
          renderDocumentContent(content, languageId, contentEl);
          delete highlightTimers[key];
        }, HIGHLIGHT_DEBOUNCE_MS);
      }
    } else {
      // 코드/텍스트: atomic highlight update (flicker 방지)
      const codeEl = contentEl.querySelector('code');
      if (codeEl) {
        let hljsLang = getHljsLanguage(languageId);
        // badge label에서 languageId를 유추하지 못한 경우 (getLangIdFromLabel 매핑 누락),
        // code 요소의 className에서 language를 읽는다
        if (!hljsLang) {
          hljsLang = detectLanguage(codeEl);
        }
        if (hljsLang) {
          codeEl.className = `language-${hljsLang}`;
        }
        highlightedUpdate(codeEl, content || '', hljsLang);
      } else {
        // code 요소가 없으면 전체 재렌더
        renderDocumentContent(content, languageId, contentEl);
      }
    }
  }

  /**
   * Map VS Code languageId to highlight.js language name
   */
  function getHljsLanguage(languageId) {
    const map = {
      'python': 'python',
      'javascript': 'javascript',
      'typescript': 'typescript',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'csharp': 'csharp',
      'go': 'go',
      'rust': 'rust',
      'ruby': 'ruby',
      'php': 'php',
      'swift': 'swift',
      'kotlin': 'kotlin',
      'r': 'r',
      'sql': 'sql',
      'html': 'html',
      'css': 'css',
      'json': 'json',
      'xml': 'xml',
      'yaml': 'yaml',
      'shell': 'bash',
      'shellscript': 'bash',
      'bash': 'bash',
      'powershell': 'powershell',
      'bat': 'dos',
      'lua': 'lua',
      'perl': 'perl',
      'scala': 'scala',
      'dart': 'dart',
      'dockerfile': 'dockerfile',
      'makefile': 'makefile',
    };
    return map[languageId] || null;
  }

  /**
   * Get human-readable language label
   */
  function getLanguageLabel(languageId) {
    const map = {
      'python': 'Python',
      'javascript': 'JavaScript',
      'typescript': 'TypeScript',
      'markdown': 'Markdown',
      'plaintext': 'Text',
      'json': 'JSON',
      'html': 'HTML',
      'css': 'CSS',
      'java': 'Java',
      'c': 'C',
      'cpp': 'C++',
      'csharp': 'C#',
      'go': 'Go',
      'rust': 'Rust',
      'ruby': 'Ruby',
      'php': 'PHP',
      'r': 'R',
      'sql': 'SQL',
      'yaml': 'YAML',
      'xml': 'XML',
      'shell': 'Shell',
      'shellscript': 'Shell',
      'bash': 'Bash',
      'powershell': 'PowerShell',
    };
    return map[languageId] || languageId.charAt(0).toUpperCase() + languageId.slice(1);
  }

  /**
   * Reverse label to languageId
   */
  function getLangIdFromLabel(label) {
    const map = {
      'Python': 'python',
      'JavaScript': 'javascript',
      'TypeScript': 'typescript',
      'Markdown': 'markdown',
      'Text': 'plaintext',
      'JSON': 'json',
      'HTML': 'html',
      'CSS': 'css',
      'Shell': 'shell',
      'Bash': 'bash',
      'Java': 'java',
      'C': 'c',
      'C++': 'cpp',
      'C#': 'csharp',
      'Go': 'go',
      'Rust': 'rust',
      'Ruby': 'ruby',
      'PHP': 'php',
      'R': 'r',
      'SQL': 'sql',
      'YAML': 'yaml',
      'XML': 'xml',
      'PowerShell': 'powershell',
    };
    return map[label] || 'plaintext';
  }

  /**
   * Show teacher's cursor position in a cell
   */
  let cursorElement = null;
  let selectionElement = null;
  let currentCursorCellIndex = -1;
  let documentCursorActive = false;
  let mdDocViewMode = 'rendered'; // 'raw' | 'rendered' for markdown document view
  let measureCanvas = null;

  function showTeacherCursor(data) {
    const { cellIndex, line, character, selectionStart, selectionEnd, hasSelection } = data;

    const cellElement = document.getElementById(`cell-${cellIndex}`);
    if (!cellElement) return;

    // Reset markup revert timer on every cursor:position (any cell)
    if (markupRevertTimer) { clearTimeout(markupRevertTimer); markupRevertTimer = null; }

    // NOTE: cursor:position은 source를 포함하지 않는다.
    // 소스 동기화는 cell:update가 전담한다 (onDidChangeNotebookDocument에서 즉시 전송).
    // 이전에 cursor:position에 source를 포함했을 때, stale getText()가 올바른 소스를
    // 덮어쓰는 버그가 있었다.

    // === Fast path: 같은 셀이면 커서 오버레이만 업데이트 (DOM 재생성 없음) ===
    if (cellIndex === currentCursorCellIndex) {
      removeCursorOverlays();

      const rawSourceCode = cellElement.querySelector('.markup-raw-source code');
      const codeSourceEl = cellElement.querySelector('.cell-source pre code');
      const targetEl = rawSourceCode || codeSourceEl;

      if (targetEl) {
        // 마크다운: raw source 텍스트를 최신 소스로 동기화
        if (rawSourceCode) {
          const wrapper = cellElement.querySelector('.cell-markup-wrapper');
          const currentSource = wrapper?.dataset?.source || '';
          if (rawSourceCode.textContent !== currentSource) {
            highlightedUpdate(rawSourceCode, currentSource, 'markdown');
          }
        }
        showCursorInElement(targetEl, line, character, selectionStart, selectionEnd, hasSelection);
      }

      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked) {
        targetEl ? scrollToCursorElement() : scrollToCellElement(cellElement);
      }
      // Markup cells: schedule revert to rendered mode after idle
      if (rawSourceCode) {
        markupRevertTimer = setTimeout(() => { markupRevertTimer = null; removeCursor(); }, MARKUP_REVERT_MS);
      }
      return;
    }

    // === Full path: 다른 셀로 이동 ===
    removeCursor();
    currentCursorCellIndex = cellIndex;

    // 마크다운 셀: raw source 모드 전환
    const markupWrapper = cellElement.querySelector('.cell-markup-wrapper');
    const markupEl = cellElement.querySelector('.cell-markup');

    if (markupEl && markupWrapper) {
      const cellSource = markupWrapper.dataset.source || '';
      cellElement.classList.add('teacher-editing');

      // ★ 핵심: 빈 마크다운 셀이라도 raw source 요소를 반드시 생성한다.
      // 생성하지 않으면 이후 cell:update가 도착해도 텍스트를 렌더할 곳이 없어
      // 첫 글자가 학생 뷰어에 표시되지 않는 버그 발생.
      markupEl.classList.add('raw-source-mode');
      const rawSourceEl = document.createElement('pre');
      rawSourceEl.className = 'markup-raw-source';
      const codeEl = document.createElement('code');
      codeEl.className = 'language-markdown';
      rawSourceEl.appendChild(codeEl);
      markupWrapper.appendChild(rawSourceEl);

      // 빈 마크다운 셀이라도 커서를 표시 (코드 셀과 동일한 동작)
      highlightedUpdate(codeEl, cellSource, 'markdown');
      showCursorInElement(codeEl, line, character, selectionStart, selectionEnd, hasSelection);

      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked) {
        scrollToCursorElement();
      }
      // Markup rendered→raw source changes cell heights — notify drawing layer
      if (layoutChangeCallback) layoutChangeCallback();
      // Schedule revert to rendered mode after idle
      markupRevertTimer = setTimeout(() => { markupRevertTimer = null; removeCursor(); }, MARKUP_REVERT_MS);
      return;
    }

    // 코드 셀
    const sourceEl = cellElement.querySelector('.cell-source pre code');

    cellElement.classList.add('teacher-editing');

    if (!sourceEl) {
      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked) {
        scrollToCellElement(cellElement);
      }
      return;
    }

    // ★ 빈 코드 셀이라도 커서를 표시한다 (이후 cell:update로 텍스트가 들어오면 즉시 보이도록)
    showCursorInElement(sourceEl, line, character, selectionStart, selectionEnd, hasSelection);

    const autoScroll = document.getElementById('auto-scroll');
    if (autoScroll && autoScroll.checked) {
      scrollToCursorElement();
    }
  }

  /**
   * 커서 오버레이만 제거 (raw source, teacher-editing은 유지)
   * 같은 셀 내 커서 이동 시 사용 (fast path)
   */
  function removeCursorOverlays() {
    document.querySelectorAll('.teacher-cursor, .teacher-line-highlight, .teacher-selection, .teacher-selection-container').forEach(el => el.remove());
    cursorElement = null;
    selectionElement = null;
  }

  /**
   * 코드 요소 내에 커서와 라인 하이라이트 표시
   */
  function showCursorInElement(codeEl, line, character, selectionStart, selectionEnd, hasSelection) {
    // 실제 라인 높이 계산
    const computedStyle = window.getComputedStyle(codeEl);
    const lineHeight = parseFloat(computedStyle.lineHeight) ||
                       parseFloat(computedStyle.fontSize) * 1.5 || 24;

    // Get the text content and calculate position
    const sourceText = codeEl.textContent || '';
    const lines = sourceText.split('\n');

    // ★ 커서 위치를 텍스트 길이로 자르지 않는다 (race condition 방지)
    // cursor:position이 cell:update보다 먼저 도착할 수 있어서
    // 뷰어 텍스트가 아직 이전 상태일 때 자르면 한 글자 뒤에 커서가 표시됨
    const targetLine = Math.max(0, line);
    const targetChar = Math.max(0, character);

    codeEl.style.position = 'relative';
    // Ensure block layout for correct selection positioning
    // Without this, inline <code> (e.g. .txt, .md raw) uses text-width containing block
    // instead of full parent width, causing narrow/misaligned selection overlays
    codeEl.style.display = 'block';

    // ★ Range API로 정확한 커서 위치 계산 (Canvas measureText fallback)
    // Canvas measureText는 font hinting/sub-pixel 차이로 한 칸 어긋날 수 있음
    // getCursorPositionByRange 1회 호출로 left/top 동시 획득 (트리 워크 최소화)
    const rangePos = getCursorPositionByRange(codeEl, targetLine, targetChar);
    const cursorTop = rangePos ? rangePos.top : targetLine * lineHeight;
    const lineText = lines[targetLine] || '';
    const cursorLeft = rangePos ? rangePos.left : getCharOffset(codeEl, lineText, targetChar);

    // Create line highlight (full line background)
    const lineHighlight = document.createElement('div');
    lineHighlight.className = 'teacher-line-highlight';
    lineHighlight.style.top = `${cursorTop}px`;
    lineHighlight.style.height = `${lineHeight}px`;
    codeEl.appendChild(lineHighlight);

    // Create cursor element (blinking vertical bar)
    cursorElement = document.createElement('div');
    cursorElement.className = 'teacher-cursor';

    cursorElement.style.top = `${cursorTop}px`;
    cursorElement.style.left = `${cursorLeft}px`;
    cursorElement.style.height = `${lineHeight}px`;

    codeEl.appendChild(cursorElement);

    // Handle selection highlight (노란 배경)
    if (hasSelection && selectionStart && selectionEnd &&
        (selectionStart.line !== selectionEnd.line || selectionStart.character !== selectionEnd.character)) {
      // ★ 라인 범위도 텍스트 길이로 자르지 않는다 (race condition 방지)
      const startLine = Math.max(0, selectionStart.line);
      const endLine = Math.max(0, selectionEnd.line);

      // 선택 영역 컨테이너 (여러 라인 블록을 담음)
      selectionElement = document.createElement('div');
      selectionElement.className = 'teacher-selection-container';
      selectionElement.style.position = 'absolute';
      selectionElement.style.top = '0';
      selectionElement.style.left = '0';
      selectionElement.style.right = '0';
      selectionElement.style.bottom = '0';
      selectionElement.style.pointerEvents = 'none';
      selectionElement.style.zIndex = '40';

      if (startLine === endLine) {
        // 단일 라인 선택 — 1회 Range 호출로 top/startLeft 동시 획득
        const startPos = getCursorPositionByRange(codeEl, startLine, selectionStart.character);
        const startOffset = startPos ? startPos.left : getLeftAt(codeEl, lines, startLine, selectionStart.character);
        const endOffset = getLeftAt(codeEl, lines, endLine, selectionEnd.character);
        const selTop = startPos ? startPos.top : startLine * lineHeight;
        const block = document.createElement('div');
        block.className = 'teacher-selection';
        block.style.top = `${selTop}px`;
        block.style.left = `${startOffset}px`;
        block.style.width = `${Math.max(2, endOffset - startOffset)}px`;
        block.style.height = `${lineHeight}px`;
        selectionElement.appendChild(block);
      } else {
        // 멀티라인: Range 1회 호출로 각 라인의 top/left 동시 획득
        // 첫 번째 라인: startChar → 라인 끝
        const startPos = getCursorPositionByRange(codeEl, startLine, selectionStart.character);
        const startOffset = startPos ? startPos.left : getLeftAt(codeEl, lines, startLine, selectionStart.character);
        const startTop = startPos ? startPos.top : startLine * lineHeight;
        const firstBlock = document.createElement('div');
        firstBlock.className = 'teacher-selection';
        firstBlock.style.top = `${startTop}px`;
        firstBlock.style.left = `${startOffset}px`;
        firstBlock.style.width = `calc(100% - ${startOffset}px)`;
        firstBlock.style.height = `${lineHeight}px`;
        selectionElement.appendChild(firstBlock);

        // 중간 라인: 전체 너비
        if (endLine - startLine > 1) {
          const midTop = getTopAt(codeEl, startLine + 1, lineHeight);
          const midBlock = document.createElement('div');
          midBlock.className = 'teacher-selection';
          midBlock.style.top = `${midTop}px`;
          midBlock.style.left = '0';
          midBlock.style.width = '100%';
          midBlock.style.height = `${(endLine - startLine - 1) * lineHeight}px`;
          selectionElement.appendChild(midBlock);
        }

        // 마지막 라인: 라인 시작 → endChar
        const endPos = getCursorPositionByRange(codeEl, endLine, selectionEnd.character);
        const endOffset = endPos ? endPos.left : getLeftAt(codeEl, lines, endLine, selectionEnd.character);
        if (endOffset > 0) {
          const endTop = endPos ? endPos.top : endLine * lineHeight;
          const lastBlock = document.createElement('div');
          lastBlock.className = 'teacher-selection';
          lastBlock.style.top = `${endTop}px`;
          lastBlock.style.left = '0';
          lastBlock.style.width = `${endOffset}px`;
          lastBlock.style.height = `${lineHeight}px`;
          selectionElement.appendChild(lastBlock);
        }
      }

      codeEl.appendChild(selectionElement);
    }
  }

  /**
   * 커서 요소로 스크롤 (이미 보이면 스크롤 안함)
   */
  function scrollToCursorElement() {
    // cursorElement는 showCursorInElement에서 이미 캐시됨 — DOM 재탐색 불필요
    const targetEl = cursorElement || document.querySelector('.teacher-line-highlight');
    if (!targetEl) return;

    const headerHeight = document.getElementById('header')?.offsetHeight || 48;
    const rect = targetEl.getBoundingClientRect();
    const margin = 60;

    // 커서가 화면 안에 보이면 스크롤 불필요
    if (rect.top >= headerHeight + margin && rect.bottom <= window.innerHeight - margin) {
      return;
    }

    const absoluteTop = rect.top + window.scrollY;
    window.scrollTo({
      top: Math.max(0, absoluteTop - headerHeight - (window.innerHeight / 3)),
      behavior: 'auto'
    });
  }

  /**
   * 셀 요소로 스크롤 (빈 셀용)
   */
  function scrollToCellElement(cellElement) {
    if (!cellElement) return;

    const headerHeight = document.getElementById('header')?.offsetHeight || 48;
    const rect = cellElement.getBoundingClientRect();

    // 셀이 화면 안에 보이면 스크롤 불필요
    if (rect.top >= headerHeight && rect.top <= window.innerHeight - 100) {
      return;
    }

    window.scrollTo({
      top: Math.max(0, cellElement.offsetTop - headerHeight - 8),
      behavior: 'auto'
    });
  }

  /**
   * 문자 오프셋 픽셀 계산 (Canvas API 사용 — DOM 조작/reflow 없음)
   */
  function getCharOffset(sourceEl, lineText, charIndex) {
    if (!measureCanvas) {
      measureCanvas = document.createElement('canvas').getContext('2d');
    }
    measureCanvas.font = window.getComputedStyle(sourceEl).font;
    if (charIndex <= lineText.length) {
      return measureCanvas.measureText(lineText.substring(0, charIndex)).width;
    }
    // cursor:position이 cell:update보다 먼저 도착한 경우 (race condition)
    // 현재 텍스트 끝까지 측정 + 초과분은 평균 문자폭으로 외삽
    const fullWidth = measureCanvas.measureText(lineText).width;
    const avgCharWidth = lineText.length > 0
      ? fullWidth / lineText.length
      : measureCanvas.measureText('m').width; // fallback: 'm' 문자폭
    return fullWidth + (charIndex - lineText.length) * avgCharWidth;
  }

  /**
   * DOM Range 기반 커서 위치 측정 — 브라우저 레이아웃 엔진이 직접 계산한 좌표 반환
   * Canvas measureText는 font hinting, sub-pixel rendering, 합자(ligature) 등에서
   * 실제 DOM 렌더링과 미세하게 달라질 수 있어 한 칸 정도 차이가 발생할 수 있음.
   * Range API는 브라우저가 실제로 렌더링한 위치를 정확히 반환한다.
   */
  function getCursorPositionByRange(codeEl, targetLine, targetChar) {
    try {
      const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      let line = 0;
      let col = 0;
      let node;
      let lastNode = null;
      let lastOffset = 0;

      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        for (let i = 0; i < text.length; i++) {
          if (line === targetLine && col === targetChar) {
            return getRangeRect(codeEl, node, i);
          }
          if (text[i] === '\n') {
            line++;
            col = 0;
          } else {
            col++;
          }
        }
        lastNode = node;
        lastOffset = text.length;
      }
      // 텍스트 끝에 커서가 있는 경우 (마지막 줄 끝, 또는 cursor:position이
      // cell:update보다 먼저 도착하여 텍스트보다 한 칸 앞선 경우)
      // lastNode의 끝 위치에서 Range를 생성하여 정확한 좌표 반환
      if (line === targetLine && col === targetChar && lastNode) {
        return getRangeRect(codeEl, lastNode, lastOffset);
      }
    } catch (e) {
      // DOM 변경 중 walker 오류 — fallback 사용
    }
    return null;
  }

  function getRangeRect(codeEl, node, offset) {
    try {
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      let rects = range.getClientRects();

      // hljs span 경계에서 collapsed range의 getClientRects()가 빈 배열을 반환할 수 있음.
      // 이 경우 1-char range를 만들어 인접 문자의 좌표로 대체한다.
      if (rects.length === 0) {
        const textLen = node.textContent ? node.textContent.length : 0;
        if (offset > 0) {
          // 이전 문자를 포함하는 1-char range → right edge = 커서 위치
          range.setStart(node, offset - 1);
          range.setEnd(node, offset);
          rects = range.getClientRects();
          if (rects.length > 0) {
            const codeRect = codeEl.getBoundingClientRect();
            return {
              left: rects[0].right - codeRect.left + codeEl.scrollLeft,
              top: rects[0].top - codeRect.top + codeEl.scrollTop,
            };
          }
        }
        if (offset < textLen) {
          // 다음 문자를 포함하는 1-char range → left edge = 커서 위치
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          rects = range.getClientRects();
          if (rects.length > 0) {
            const codeRect = codeEl.getBoundingClientRect();
            return {
              left: rects[0].left - codeRect.left + codeEl.scrollLeft,
              top: rects[0].top - codeRect.top + codeEl.scrollTop,
            };
          }
        }
        return null;
      }

      const codeRect = codeEl.getBoundingClientRect();
      return {
        left: rects[0].left - codeRect.left + codeEl.scrollLeft,
        top: rects[0].top - codeRect.top + codeEl.scrollTop,
      };
    } catch (e) {
      return null;
    }
  }

  /** Range 기반 left 오프셋 (Canvas fallback) */
  function getLeftAt(codeEl, lines, targetLine, targetChar) {
    const pos = getCursorPositionByRange(codeEl, targetLine, targetChar);
    if (pos) return pos.left;
    const lineText = lines[targetLine] || '';
    return getCharOffset(codeEl, lineText, targetChar);
  }

  /** Range 기반 top 오프셋 (lineHeight fallback) */
  function getTopAt(codeEl, targetLine, lineHeight) {
    const pos = getCursorPositionByRange(codeEl, targetLine, 0);
    if (pos) return pos.top;
    return targetLine * lineHeight;
  }

  function removeCursor() {
    if (markupRevertTimer) { clearTimeout(markupRevertTimer); markupRevertTimer = null; }
    // Flush pending markup render for cursor cell (마지막 글자 렌더링 보장)
    if (currentCursorCellIndex >= 0) {
      const key = `markup-${currentCursorCellIndex}`;
      if (highlightTimers[key]) {
        clearTimeout(highlightTimers[key]);
        delete highlightTimers[key];
      }
      // raw→rendered 전환 시 항상 최신 소스로 렌더링 보장
      const cellEl = document.getElementById(`cell-${currentCursorCellIndex}`);
      const wrapper = cellEl && cellEl.querySelector('.cell-markup-wrapper');
      if (wrapper) {
        const currentSource = wrapper.dataset.source || '';
        const currentHash = simpleHash(currentSource);
        if (lastRenderedHash[currentCursorCellIndex] !== currentHash) {
          renderMarkupImmediate(currentCursorCellIndex);
        }
      }
    }

    document.querySelectorAll('.teacher-cursor, .teacher-line-highlight, .teacher-selection, .teacher-selection-container').forEach(el => el.remove());
    // Removing raw source restores rendered markup — cell heights change
    const hadRawSource = document.querySelectorAll('.markup-raw-source').length > 0;
    document.querySelectorAll('.markup-raw-source').forEach(el => el.remove());
    document.querySelectorAll('.cell-markup.raw-source-mode').forEach(el => el.classList.remove('raw-source-mode'));
    document.querySelectorAll('.cell.teacher-editing').forEach(el => el.classList.remove('teacher-editing'));

    cursorElement = null;
    selectionElement = null;
    currentCursorCellIndex = -1;

    // Notify drawing layer to redraw strokes at new cell positions
    if (hadRawSource && layoutChangeCallback) layoutChangeCallback();
  }

  // === Plaintext Document Cursor ===

  /**
   * Markdown document: switch from rendered view to raw source view
   * 선생님과 동일하게 순수 마크다운 텍스트를 보여줌
   */
  function switchDocToRawMode(content, contentEl) {
    // 보류 중인 마크다운 렌더 타이머 정리 (raw 모드 덮어쓰기 방지)
    const key = 'doc-markdown';
    if (highlightTimers[key]) {
      clearTimeout(highlightTimers[key]);
      delete highlightTimers[key];
    }

    contentEl.innerHTML = '';

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-markdown';
    highlightedUpdate(code, content || '', 'markdown');
    pre.appendChild(code);
    contentEl.appendChild(pre);

    mdDocViewMode = 'raw';
  }

  /**
   * Markdown document: switch from raw source view back to rendered view
   * 커서가 사라지면 렌더된 마크다운으로 전환 (스크롤 위치 보존)
   */
  function switchDocToRenderedMode() {
    const contentEl = document.getElementById('document-content');
    if (!contentEl) return;
    const wrapper = document.querySelector('.plaintext-document');
    const content = wrapper?.dataset?.source || '';

    // 스크롤 위치 보존
    const docHeight = document.documentElement.scrollHeight;
    const winHeight = window.innerHeight;
    const maxScroll = docHeight - winHeight;
    const scrollRatio = maxScroll > 0 ? window.scrollY / maxScroll : 0;

    // 보류 중인 렌더 타이머 정리
    const key = 'doc-markdown';
    if (highlightTimers[key]) {
      clearTimeout(highlightTimers[key]);
      delete highlightTimers[key];
    }

    renderDocumentContent(content, 'markdown', contentEl);
    mdDocViewMode = 'rendered';

    // 스크롤 위치 복원
    requestAnimationFrame(() => {
      const newDocHeight = document.documentElement.scrollHeight;
      const newMaxScroll = newDocHeight - winHeight;
      if (newMaxScroll > 0) {
        window.scrollTo({ top: newMaxScroll * scrollRatio, behavior: 'auto' });
      }
    });
  }

  /**
   * Show teacher cursor in plaintext document (.py, .txt, .md 등)
   * 마크다운: 렌더 모드 → raw 소스 전환 후 커서 표시
   * 코드/텍스트: 정밀 커서 + 라인 하이라이트 + 선택 영역
   */
  function showDocumentCursor(data) {
    const { line, character, selectionStart, selectionEnd, hasSelection } = data;

    const contentEl = document.getElementById('document-content');
    if (!contentEl) return;

    // Markdown 렌더 모드면 raw 소스 모드로 전환 (선생님과 동일한 뷰)
    if (mdDocViewMode === 'rendered' && contentEl.querySelector('.cell-markup')) {
      const wrapper = document.querySelector('.plaintext-document');
      const content = wrapper?.dataset?.source || '';
      switchDocToRawMode(content, contentEl);
    }

    // 코드/텍스트/raw-markdown — 정밀 커서 표시
    const codeEl = contentEl.querySelector('code');
    if (!codeEl) return;

    removeCursorOverlays();
    documentCursorActive = true;

    showCursorInElement(codeEl, line, character, selectionStart, selectionEnd, hasSelection);

    const autoScroll = document.getElementById('auto-scroll');
    if (autoScroll && autoScroll.checked) {
      scrollToCursorElement();
    }
  }

  function removeDocumentCursor() {
    removeCursorOverlays();
    documentCursorActive = false;

    // Markdown raw mode → 렌더 모드로 전환
    if (mdDocViewMode === 'raw') {
      switchDocToRenderedMode();
    }
  }

  return {
    renderNotebook,
    renderCell,
    updateCellSource,
    updateCellOutputs,
    setActiveCell,
    handleStructureChange,
    renderPlaintextDocument,
    updateDocumentContent,
    showTeacherCursor,
    showDocumentCursor,
    removeDocumentCursor,
    scrollToLine,
    scrollToRatio,
    scrollToDocumentAnchor,
    scrollNotebookToCell,
    scrollToNotebookAnchor,
    /** Register callback for when cursor removal changes cell layout (markup restore) */
    onLayoutChange(cb) { layoutChangeCallback = cb; },
  };
})();
