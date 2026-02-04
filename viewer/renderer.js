/* renderer.js - Notebook cell rendering */

const Renderer = (() => {
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

    container.appendChild(content);
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
    execLabel.textContent = cell.executionOrder ? `[${cell.executionOrder}]` : '[ ]';
    sourceEl.appendChild(execLabel);

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-python';
    code.textContent = cell.source || '';
    hljs.highlightElement(code);
    pre.appendChild(code);
    sourceEl.appendChild(pre);

    container.appendChild(sourceEl);

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(cell.source || '').then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      });
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
      div.innerHTML = DOMPurify.sanitize(data, {
        ADD_TAGS: ['style'],
        ADD_ATTR: ['class', 'style'],
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
      codeEl.textContent = source;
      hljs.highlightElement(codeEl);
    }

    // Markup cell
    const markupEl = cellEl.querySelector('.cell-markup');
    if (markupEl) {
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
      execLabel.textContent = `[${executionOrder}]`;
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
   */
  function setActiveCell(index) {
    // Remove existing active
    document.querySelectorAll('.cell.active').forEach((el) => {
      el.classList.remove('active');
    });

    const cellEl = document.getElementById(`cell-${index}`);
    if (cellEl) {
      cellEl.classList.add('active');

      // Auto-scroll if enabled
      const autoScroll = document.getElementById('auto-scroll');
      if (autoScroll && autoScroll.checked) {
        cellEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
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

    // Copy 버튼
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn document-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(data.content || '').then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      });
    });
    header.appendChild(copyBtn);

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

    // languageId를 badge 텍스트에서 유추
    const badge = document.querySelector('.document-type-badge');
    const label = badge ? badge.textContent : '';
    const languageId = getLangIdFromLabel(label);

    renderDocumentContent(content, languageId, contentEl);
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

  return {
    renderNotebook,
    renderCell,
    updateCellSource,
    updateCellOutputs,
    setActiveCell,
    handleStructureChange,
    renderPlaintextDocument,
    updateDocumentContent,
  };
})();
