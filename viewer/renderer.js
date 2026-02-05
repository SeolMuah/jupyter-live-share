/* renderer.js - Notebook cell rendering */

const Renderer = (() => {
  const HIGHLIGHT_DEBOUNCE_MS = 150;
  let highlightTimers = {};

  /**
   * Debounced highlight: 텍스트는 즉시 반영, 하이라이팅은 지연
   */
  function debouncedHighlight(key, element) {
    if (highlightTimers[key]) clearTimeout(highlightTimers[key]);
    highlightTimers[key] = setTimeout(() => {
      hljs.highlightElement(element);
      delete highlightTimers[key];
    }, HIGHLIGHT_DEBOUNCE_MS);
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
    let currentLine = 0;
    let html = '';

    for (const token of tokens) {
      // 토큰의 raw text로 현재 라인 위치 추적
      const tokenText = token.raw || '';
      const startLine = currentLine;

      // 블록 레벨 요소에 data-line 속성 추가
      if (token.type !== 'space') {
        // 토큰을 개별적으로 렌더링하고 첫 번째 요소에 data-line 추가
        const tokenHtml = marked.parser([token]);
        // 첫 번째 태그에 data-line 삽입
        const modifiedHtml = tokenHtml.replace(/^<(\w+)/, `<$1 data-line="${startLine}"`);
        html += modifiedHtml;
      }

      // 토큰이 차지하는 라인 수 계산
      const tokenLines = tokenText.split('\n').length - 1;
      currentLine += Math.max(1, tokenLines);
    }

    return html;
  }
  /**
   * Reset all cursor/highlight state (call before full re-render)
   */
  function resetCursorState() {
    if (cursorTimeout) {
      clearTimeout(cursorTimeout);
      cursorTimeout = null;
    }
    cursorElement = null;
    selectionElement = null;
    currentCursorCellIndex = -1;
    // Clear stale highlight timers (DOM elements are about to be destroyed)
    for (const key of Object.keys(highlightTimers)) {
      clearTimeout(highlightTimers[key]);
      delete highlightTimers[key];
    }
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
    // 원본 소스 저장 (커서 표시 시 사용)
    wrapper.dataset.source = cell.source || '';

    const content = document.createElement('div');
    content.className = 'cell-markup';

    // 라인 번호 매핑을 포함한 마크다운 렌더링 (정확한 스크롤 동기화용)
    const source = cell.source || '';
    if (source.trim()) {
      const tokens = marked.lexer(source);
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

    // Copy button for markdown cell (copies raw markdown source)
    // Store source in data attribute for updates
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    wrapper.dataset.source = cell.source || '';
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
      const tokens = marked.lexer(source);
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
          ],
          throwOnError: false,
        });
      } catch (e) { /* ignore */ }
    } else {
      markupEl.innerHTML = '';
    }
  }

  /**
   * Update a single cell's source
   */
  function updateCellSource(index, source) {
    const cellEl = document.getElementById(`cell-${index}`);
    if (!cellEl) return;

    const codeEl = cellEl.querySelector('.cell-source code');
    if (codeEl) {
      // 텍스트 즉시 반영, 하이라이팅은 디바운스
      codeEl.textContent = source;
      debouncedHighlight(`cell-${index}`, codeEl);
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
        rawSourceCode.textContent = source || '';
        debouncedHighlight(`raw-${index}`, rawSourceCode);
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
  function setActiveCell(index) {
    // Remove existing active
    document.querySelectorAll('.cell.active').forEach((el) => {
      el.classList.remove('active');
    });

    const cellEl = document.getElementById(`cell-${index}`);
    if (cellEl) {
      cellEl.classList.add('active');

      // Auto-scroll이 켜져 있으면 셀이 보이도록 스크롤
      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked) {
        scrollToCellElement(cellEl);
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
        const targetTop = targetEl.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({
          top: Math.max(0, targetTop - headerHeight - 8),
          behavior: 'auto'
        });
        return;
      }
    }

    const codeEl = contentEl.querySelector('pre code');
    if (codeEl) {
      const lineHeight = parseFloat(getComputedStyle(codeEl).lineHeight) || 24;
      const codeTop = codeEl.getBoundingClientRect().top + window.scrollY;
      const scrollTarget = codeTop + (lineNumber * lineHeight) - headerHeight - 8;

      window.scrollTo({
        top: Math.max(0, scrollTarget),
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
      top: Math.max(0, cellEl.offsetTop - headerHeight - 8),
      behavior: 'auto'
    });
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
      const contentEl = document.getElementById('document-content');
      const codeEl = contentEl?.querySelector('code');
      const markupEl = contentEl?.querySelector('.cell-markup');
      // For code: get textContent, for markdown: get from data attribute or raw text
      let text = '';
      if (codeEl) {
        text = codeEl.textContent || '';
      } else if (markupEl) {
        text = wrapper.dataset.source || markupEl.textContent || '';
      }
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
      const tokens = marked.lexer(content || '');
      const html = renderMarkdownWithLineNumbers(tokens, content || '');
      mdEl.innerHTML = DOMPurify.sanitize(html, {
        ADD_ATTR: ['data-line'],
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
      // Markdown: 전체 렌더링 디바운스
      const key = 'doc-markdown';
      if (highlightTimers[key]) clearTimeout(highlightTimers[key]);
      highlightTimers[key] = setTimeout(() => {
        renderDocumentContent(content, languageId, contentEl);
        delete highlightTimers[key];
      }, HIGHLIGHT_DEBOUNCE_MS);
    } else {
      // 코드/텍스트: textContent 즉시 반영, 하이라이팅만 디바운스
      const codeEl = contentEl.querySelector('code');
      if (codeEl) {
        codeEl.textContent = content || '';
        const hljsLang = getHljsLanguage(languageId);
        if (hljsLang) {
          codeEl.className = `language-${hljsLang}`;
          debouncedHighlight('doc-code', codeEl);
        }
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
    };
    return map[label] || 'plaintext';
  }

  /**
   * Show teacher's cursor position in a cell
   */
  let cursorElement = null;
  let cursorTimeout = null;
  let selectionElement = null;
  let currentCursorCellIndex = -1;
  let measureCanvas = null;

  function showTeacherCursor(data) {
    const { cellIndex, line, character, selectionStart, selectionEnd, hasSelection, source } = data;

    const cellElement = document.getElementById(`cell-${cellIndex}`);
    if (!cellElement) return;

    // cursor:position에 source가 포함되면 즉시 반영 (cell:update보다 먼저 도착하므로)
    if (source !== undefined) {
      const markupWrapper = cellElement.querySelector('.cell-markup-wrapper');
      if (markupWrapper) {
        markupWrapper.dataset.source = source;
      }
      const codeEl = cellElement.querySelector('.cell-source code');
      if (codeEl) {
        codeEl.textContent = source;
        debouncedHighlight(`cell-${cellIndex}`, codeEl);
      }
    }

    // Reset timeout
    if (cursorTimeout) clearTimeout(cursorTimeout);
    cursorTimeout = setTimeout(() => removeCursor(), 2000);

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
            rawSourceCode.textContent = currentSource;
            debouncedHighlight(`raw-${cellIndex}`, rawSourceCode);
          }
        }
        showCursorInElement(targetEl, line, character, selectionStart, selectionEnd, hasSelection);
      }

      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked) {
        targetEl ? scrollToCursorElement() : scrollToCellElement(cellElement);
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

      if (!cellSource.trim()) {
        const autoScroll = document.getElementById('auto-scroll');
        if (autoScroll && autoScroll.checked) {
          scrollToCellElement(cellElement);
        }
        return;
      }

      markupEl.classList.add('raw-source-mode');
      const rawSourceEl = document.createElement('pre');
      rawSourceEl.className = 'markup-raw-source';
      const codeEl = document.createElement('code');
      codeEl.className = 'language-markdown';
      codeEl.textContent = cellSource;
      rawSourceEl.appendChild(codeEl);
      markupWrapper.appendChild(rawSourceEl);
      debouncedHighlight(`raw-${cellIndex}`, codeEl);

      showCursorInElement(codeEl, line, character, selectionStart, selectionEnd, hasSelection);

      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked) {
        scrollToCursorElement();
      }
      return;
    }

    // 코드 셀
    const sourceEl = cellElement.querySelector('.cell-source pre code');
    const sourceText = sourceEl ? (sourceEl.textContent || '') : '';

    cellElement.classList.add('teacher-editing');

    if (!sourceEl || !sourceText.trim()) {
      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked) {
        scrollToCellElement(cellElement);
      }
      return;
    }

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

    // 빈 셀이거나 라인 범위를 벗어나면 첫 번째 라인에 커서 표시
    const targetLine = Math.min(Math.max(0, line), Math.max(0, lines.length - 1));
    const targetChar = lines[targetLine] ? Math.min(character, lines[targetLine].length) : 0;

    codeEl.style.position = 'relative';

    // Create line highlight (full line background)
    const lineHighlight = document.createElement('div');
    lineHighlight.className = 'teacher-line-highlight';
    lineHighlight.style.top = `${targetLine * lineHeight}px`;
    lineHighlight.style.height = `${lineHeight}px`;
    codeEl.appendChild(lineHighlight);

    // Create cursor element (blinking vertical bar)
    cursorElement = document.createElement('div');
    cursorElement.className = 'teacher-cursor';

    // Calculate character offset using actual font metrics
    const lineText = lines[targetLine] || '';
    const charWidth = getCharOffset(codeEl, lineText, targetChar);

    cursorElement.style.top = `${targetLine * lineHeight}px`;
    cursorElement.style.left = `${charWidth}px`;
    cursorElement.style.height = `${lineHeight}px`;

    codeEl.appendChild(cursorElement);

    // Handle selection highlight (노란 배경)
    if (hasSelection && selectionStart && selectionEnd &&
        (selectionStart.line !== selectionEnd.line || selectionStart.character !== selectionEnd.character)) {
      // 라인 범위 체크
      const startLine = Math.min(Math.max(0, selectionStart.line), lines.length - 1);
      const endLine = Math.min(Math.max(0, selectionEnd.line), lines.length - 1);

      const startLineText = lines[startLine] || '';
      const endLineText = lines[endLine] || '';

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
        // 단일 라인 선택
        const startOffset = getCharOffset(codeEl, startLineText, Math.min(selectionStart.character, startLineText.length));
        const endOffset = getCharOffset(codeEl, endLineText, Math.min(selectionEnd.character, endLineText.length));
        const block = document.createElement('div');
        block.className = 'teacher-selection';
        block.style.top = `${startLine * lineHeight}px`;
        block.style.left = `${startOffset}px`;
        block.style.width = `${Math.max(2, endOffset - startOffset)}px`;
        block.style.height = `${lineHeight}px`;
        selectionElement.appendChild(block);
      } else {
        // 멀티라인: 각 라인별 블록 생성
        // 첫 번째 라인: startChar → 라인 끝
        const startOffset = getCharOffset(codeEl, startLineText, Math.min(selectionStart.character, startLineText.length));
        const firstBlock = document.createElement('div');
        firstBlock.className = 'teacher-selection';
        firstBlock.style.top = `${startLine * lineHeight}px`;
        firstBlock.style.left = `${startOffset}px`;
        firstBlock.style.width = `calc(100% - ${startOffset}px)`;
        firstBlock.style.height = `${lineHeight}px`;
        selectionElement.appendChild(firstBlock);

        // 중간 라인: 전체 너비
        if (endLine - startLine > 1) {
          const midBlock = document.createElement('div');
          midBlock.className = 'teacher-selection';
          midBlock.style.top = `${(startLine + 1) * lineHeight}px`;
          midBlock.style.left = '0';
          midBlock.style.width = '100%';
          midBlock.style.height = `${(endLine - startLine - 1) * lineHeight}px`;
          selectionElement.appendChild(midBlock);
        }

        // 마지막 라인: 라인 시작 → endChar
        const endOffset = getCharOffset(codeEl, endLineText, Math.min(selectionEnd.character, endLineText.length));
        if (endOffset > 0) {
          const lastBlock = document.createElement('div');
          lastBlock.className = 'teacher-selection';
          lastBlock.style.top = `${endLine * lineHeight}px`;
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
    const cursor = document.querySelector('.teacher-cursor');
    const lineHighlight = document.querySelector('.teacher-line-highlight');
    const targetEl = cursor || lineHighlight;
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
    return measureCanvas.measureText(lineText.substring(0, Math.min(charIndex, lineText.length))).width;
  }

  function removeCursor() {
    if (cursorTimeout) {
      clearTimeout(cursorTimeout);
      cursorTimeout = null;
    }

    // Flush pending markup render for cursor cell (마지막 글자 렌더링 보장)
    if (currentCursorCellIndex >= 0) {
      const key = `markup-${currentCursorCellIndex}`;
      if (highlightTimers[key]) {
        clearTimeout(highlightTimers[key]);
        delete highlightTimers[key];
        renderMarkupImmediate(currentCursorCellIndex);
      }
    }

    document.querySelectorAll('.teacher-cursor, .teacher-line-highlight, .teacher-selection, .teacher-selection-container').forEach(el => el.remove());
    document.querySelectorAll('.markup-raw-source').forEach(el => el.remove());
    document.querySelectorAll('.cell-markup.raw-source-mode').forEach(el => el.classList.remove('raw-source-mode'));
    document.querySelectorAll('.cell.teacher-editing').forEach(el => el.classList.remove('teacher-editing'));

    cursorElement = null;
    selectionElement = null;
    currentCursorCellIndex = -1;
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
    scrollToLine,
    scrollToRatio,
    scrollNotebookToCell,
  };
})();
