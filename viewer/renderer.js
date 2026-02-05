/* renderer.js - Notebook cell rendering */

const Renderer = (() => {
  const HIGHLIGHT_DEBOUNCE_MS = 300;
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
   * Render entire notebook
   */
  function renderNotebook(notebook, container) {
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
   * Render markdown cell
   */
  function renderMarkupCell(cell, container) {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'cell-markup-wrapper';

    const content = document.createElement('div');
    content.className = 'cell-markup';

    // marked.js로 Markdown 렌더링
    content.innerHTML = DOMPurify.sanitize(marked.parse(cell.source || ''));

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
   * Render cell outputs
   */
  function renderOutputs(outputs) {
    const container = document.createElement('div');
    container.className = 'cell-outputs';

    for (const output of outputs) {
      if (!output.items) continue;

      for (const item of output.items) {
        const el = renderOutputItem(item);
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

    // Markup cell - Markdown 렌더링은 디바운스
    const markupWrapper = cellEl.querySelector('.cell-markup-wrapper');
    const markupEl = cellEl.querySelector('.cell-markup');
    if (markupEl) {
      // Update data-source for copy button
      if (markupWrapper) {
        markupWrapper.dataset.source = source || '';
      }

      const key = `markup-${index}`;
      if (highlightTimers[key]) clearTimeout(highlightTimers[key]);
      highlightTimers[key] = setTimeout(() => {
        markupEl.innerHTML = DOMPurify.sanitize(marked.parse(source || ''));
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
   * Set the active (focused) cell
   * Note: Scroll is now handled by viewport:sync for better precision
   */
  function setActiveCell(index) {
    // Remove existing active
    document.querySelectorAll('.cell.active').forEach((el) => {
      el.classList.remove('active');
    });

    const cellEl = document.getElementById(`cell-${index}`);
    if (cellEl) {
      cellEl.classList.add('active');
      // Scroll is handled by viewport:sync event for better synchronization
    }
  }

  /**
   * Scroll to a specific line number in plaintext document
   * @deprecated Use scrollToRatio instead for better accuracy with rendered content
   */
  function scrollToLine(lineNumber) {
    const contentEl = document.getElementById('document-content');
    if (!contentEl) return;

    const codeEl = contentEl.querySelector('pre code') || contentEl.querySelector('.cell-markup');
    if (!codeEl) return;

    // Calculate approximate line height (1.5em = ~24px typically)
    const lineHeight = parseFloat(getComputedStyle(codeEl).lineHeight) || 24;
    const scrollTarget = lineNumber * lineHeight;

    // Scroll the main container
    const container = document.getElementById('notebook-cells');
    if (container) {
      container.scrollTo({
        top: scrollTarget,
        behavior: 'smooth'
      });
    }
  }

  /**
   * Scroll to a specific ratio (0-1) of the document
   * Works better for rendered content like markdown
   */
  function scrollToRatio(ratio) {
    const container = document.getElementById('notebook-cells');
    if (!container) return;

    // 전체 스크롤 가능한 높이 계산
    const maxScroll = container.scrollHeight - container.clientHeight;
    const scrollTarget = maxScroll * ratio;

    container.scrollTo({
      top: scrollTarget,
      behavior: 'smooth'
    });
  }

  /**
   * Update teacher viewport indicator (which cells teacher is viewing)
   */
  let viewportIndicatorTimeout = null;

  function updateTeacherViewport(firstCell, lastCell) {
    // Clear previous viewport indicators
    document.querySelectorAll('.cell.teacher-viewport, .cell.teacher-viewport-start').forEach(el => {
      el.classList.remove('teacher-viewport', 'teacher-viewport-start');
    });

    // Clear timeout
    if (viewportIndicatorTimeout) {
      clearTimeout(viewportIndicatorTimeout);
    }

    // Add viewport indicator to cells within teacher's view
    for (let i = firstCell; i <= lastCell; i++) {
      const cellEl = document.getElementById(`cell-${i}`);
      if (cellEl) {
        cellEl.classList.add('teacher-viewport');
        if (i === firstCell) {
          cellEl.classList.add('teacher-viewport-start');
        }
      }
    }

    // Auto-hide after 5 seconds of inactivity
    viewportIndicatorTimeout = setTimeout(() => {
      document.querySelectorAll('.cell.teacher-viewport, .cell.teacher-viewport-start').forEach(el => {
        el.classList.remove('teacher-viewport', 'teacher-viewport-start');
      });
    }, 5000);
  }

  /**
   * Handle structure changes (add/remove cells)
   */
  function handleStructureChange(change, cells) {
    // Re-render entire notebook for simplicity
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
      // Markdown 렌더링
      const mdEl = document.createElement('div');
      mdEl.className = 'cell-markup';
      mdEl.innerHTML = DOMPurify.sanitize(marked.parse(content || ''));

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

  function showTeacherCursor(data) {
    const { cellIndex, line, character, selectionStart, selectionEnd, hasSelection } = data;

    // Find the cell element
    const container = document.getElementById('notebook-cells');
    const cellElement = container?.children[cellIndex];
    if (!cellElement) return;

    // Find the code or markdown source element
    const sourceEl = cellElement.querySelector('.cell-source pre code') ||
                     cellElement.querySelector('.cell-markup');
    if (!sourceEl) return;

    // Remove previous cursor/selection
    removeCursor();

    // Get the text content and calculate position
    const sourceText = sourceEl.textContent || '';
    const lines = sourceText.split('\n');

    if (line >= lines.length) return;

    // Create line highlight (full line background)
    const lineHighlight = document.createElement('div');
    lineHighlight.className = 'teacher-line-highlight';
    lineHighlight.style.top = `${line * 1.5}em`;
    sourceEl.style.position = 'relative';
    sourceEl.appendChild(lineHighlight);

    // Create cursor element (blinking vertical bar)
    cursorElement = document.createElement('div');
    cursorElement.className = 'teacher-cursor';

    // Calculate character offset
    const charOffset = Math.min(character, lines[line].length);
    cursorElement.style.top = `${line * 1.5}em`;
    cursorElement.style.left = `${charOffset}ch`;

    sourceEl.appendChild(cursorElement);

    // Handle selection highlight
    if (hasSelection && (selectionStart.line !== selectionEnd.line || selectionStart.character !== selectionEnd.character)) {
      selectionElement = document.createElement('div');
      selectionElement.className = 'teacher-selection';

      // Simple single-line selection
      if (selectionStart.line === selectionEnd.line) {
        selectionElement.style.top = `${selectionStart.line * 1.5}em`;
        selectionElement.style.left = `${selectionStart.character}ch`;
        selectionElement.style.width = `${selectionEnd.character - selectionStart.character}ch`;
      } else {
        // Multi-line: highlight from start to end of first line for simplicity
        selectionElement.style.top = `${selectionStart.line * 1.5}em`;
        selectionElement.style.left = `${selectionStart.character}ch`;
        selectionElement.style.width = `${Math.max(10, lines[selectionStart.line].length - selectionStart.character)}ch`;
        selectionElement.style.height = `${(selectionEnd.line - selectionStart.line + 1) * 1.5}em`;
      }

      sourceEl.appendChild(selectionElement);
    }

    // Auto-remove cursor after 3 seconds of inactivity
    cursorTimeout = setTimeout(() => {
      removeCursor();
    }, 3000);

    // Scroll the cell into view if needed
    cellElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function removeCursor() {
    if (cursorTimeout) {
      clearTimeout(cursorTimeout);
      cursorTimeout = null;
    }

    // Remove all cursor elements
    document.querySelectorAll('.teacher-cursor, .teacher-line-highlight, .teacher-selection').forEach(el => el.remove());
    cursorElement = null;
    selectionElement = null;
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
    updateTeacherViewport,
  };
})();
