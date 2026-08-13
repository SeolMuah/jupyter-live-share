/* terminal.js - 강사 터미널 공유 뷰 (명령 카드 + SGR 렌더) */

/**
 * 서버(terminalShare.ts)가 OSC와 SGR 이외 CSI, `\r` 접기를 이미 처리해서 보낸다.
 * 여기서는 남은 SGR(`CSI ... m`)만 해석해 span으로 바꾸고, 그 밖의 이스케이프는
 * 방어적으로 제거한다. 텍스트는 항상 createTextNode로만 넣는다(innerHTML 금지).
 */
const TerminalView = (() => {
  // 접기 기준 줄 수. 이보다 길면 '더 보기' 버튼을 붙인다.
  const COLLAPSE_LINES = 10;
  // 접었을 때 본문 최대 높이. `.collapsed` 클래스는 공유 CSS 계약에 없어서
  // 인라인 스타일로 직접 제한한다(스타일 담당이 손대지 않아도 동작하도록).
  const COLLAPSE_MAX_HEIGHT = '14.5em';
  // 바닥 판정 오차(px)
  const BOTTOM_EPSILON = 4;
  // 이 시간이 지나도 안 끝나면 '입력 대기 가능'으로 배지 문구를 바꾼다.
  const WAIT_HINT_MS = 15000;
  // 미완성 이스케이프 시퀀스를 들고 있을 최대 길이.
  // 종결자 없는 쓰레기 한 조각이 이후 출력을 통째로 삼키는 것을 막는다.
  const MAX_PENDING = 64;

  // xterm 기본 16색(256색 인덱스 0~15 표기용). 16색 SGR 코드는 클래스로 처리하고
  // 이 표는 `38;5;n`(n<16)처럼 256색 경로로 들어온 경우에만 쓴다.
  const BASE16 = [
    '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
    '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
  ];

  let bodyEl = null;
  let jumpBtnEl = null;
  // execId → { root, outputEl, moreBtn, badgeEl, parser, lineCount, collapsed,
  //            expanded, commandLine, waitTimer, finished }
  const cards = new Map();
  let cardCount = 0;
  // 바닥 추종 여부. 학생이 위로 올리면 false가 되고 '맨 아래로'가 뜬다.
  let stickToBottom = true;

  /* ------------------------------------------------------------------ */
  /* SGR 파서 (순수 함수, DOM 없음)                                       */
  /* ------------------------------------------------------------------ */

  /** 빈 스타일 상태 */
  function emptyState() {
    return {
      bold: false, dim: false, underline: false, reverse: false,
      fgClass: null, fgColor: null, bgClass: null, bgColor: null,
    };
  }

  /** 256색 인덱스를 CSS 색 문자열로 바꾼다 */
  function color256(n) {
    if (n < 16) return BASE16[n];
    if (n < 232) {
      const i = n - 16;
      const steps = [0, 95, 135, 175, 215, 255];
      const r = steps[Math.floor(i / 36) % 6];
      const g = steps[Math.floor(i / 6) % 6];
      const b = steps[i % 6];
      return 'rgb(' + r + ', ' + g + ', ' + b + ')';
    }
    const v = 8 + (n - 232) * 10;
    return 'rgb(' + v + ', ' + v + ', ' + v + ')';
  }

  function clamp255(n) {
    if (!isFinite(n) || n < 0) return 0;
    return n > 255 ? 255 : Math.floor(n);
  }

  /** SGR 파라미터 배열을 상태에 적용한다 */
  function applySgr(state, params) {
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) {
        const fresh = emptyState();
        state.bold = fresh.bold; state.dim = fresh.dim;
        state.underline = fresh.underline; state.reverse = fresh.reverse;
        state.fgClass = null; state.fgColor = null;
        state.bgClass = null; state.bgColor = null;
      } else if (p === 1) state.bold = true;
      else if (p === 2) state.dim = true;
      else if (p === 4) state.underline = true;
      else if (p === 7) state.reverse = true;
      else if (p === 22) { state.bold = false; state.dim = false; }
      else if (p === 24) state.underline = false;
      else if (p === 27) state.reverse = false;
      else if (p >= 30 && p <= 37) { state.fgClass = 'ansi-fg-' + (p - 30); state.fgColor = null; }
      else if (p === 39) { state.fgClass = null; state.fgColor = null; }
      else if (p >= 40 && p <= 47) { state.bgClass = 'ansi-bg-' + (p - 40); state.bgColor = null; }
      else if (p === 49) { state.bgClass = null; state.bgColor = null; }
      else if (p >= 90 && p <= 97) { state.fgClass = 'ansi-fg-b' + (p - 90); state.fgColor = null; }
      else if (p >= 100 && p <= 107) { state.bgClass = 'ansi-bg-b' + (p - 100); state.bgColor = null; }
      else if (p === 38 || p === 48) {
        // 확장 색: 38;5;n(256색) 또는 38;2;r;g;b(truecolor). 둘 다 인라인 스타일로 준다.
        const mode = params[i + 1];
        let css = null;
        if (mode === 5 && params.length > i + 2) {
          css = color256(clamp255(params[i + 2]));
          i += 2;
        } else if (mode === 2 && params.length > i + 4) {
          css = 'rgb(' + clamp255(params[i + 2]) + ', ' + clamp255(params[i + 3]) + ', ' + clamp255(params[i + 4]) + ')';
          i += 4;
        } else {
          // 인자가 모자라면 남은 것을 버린다(방어)
          i = params.length;
        }
        if (css) {
          if (p === 38) { state.fgColor = css; state.fgClass = null; }
          else { state.bgColor = css; state.bgClass = null; }
        }
      }
      // 그 밖의 코드는 무시한다
    }
  }

  /** 현재 상태를 세그먼트용 classes/style로 굳힌다 */
  function snapshot(state) {
    const classes = [];
    if (state.bold) classes.push('ansi-bold');
    if (state.dim) classes.push('ansi-dim');
    if (state.underline) classes.push('ansi-underline');
    if (state.reverse) classes.push('ansi-reverse');
    if (state.fgClass) classes.push(state.fgClass);
    if (state.bgClass) classes.push(state.bgClass);
    const style = {};
    if (state.fgColor) style.color = state.fgColor;
    if (state.bgColor) style.backgroundColor = state.bgColor;
    return { classes: classes, style: style };
  }

  /**
   * 스트리밍 파서를 만든다. 청크 경계에서 잘린 이스케이프는 다음 청크와 이어붙인다.
   * write(text) → [{ text, classes, style }] 세그먼트 배열(순수 데이터).
   */
  function createParser() {
    const state = emptyState();
    let pending = '';

    function write(input) {
      let s = pending + String(input == null ? '' : input);
      pending = '';
      const out = [];
      let buf = '';

      function flush() {
        if (!buf) return;
        const snap = snapshot(state);
        out.push({ text: buf, classes: snap.classes, style: snap.style });
        buf = '';
      }

      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch !== '\x1b') {
          buf += ch;
          i++;
          continue;
        }
        // ESC 이후를 해석한다
        const rest = s.length - i;
        if (rest < 2) {
          // 다음 청크에서 이어 본다
          if (rest <= MAX_PENDING) { pending = s.slice(i); i = s.length; break; }
          buf += ch; i++; continue;
        }
        const next = s[i + 1];
        if (next === '[') {
          // CSI: 파라미터 바이트를 지나 종결자(0x40~0x7e)를 찾는다
          let j = i + 2;
          while (j < s.length) {
            const c = s.charCodeAt(j);
            if (c >= 0x40 && c <= 0x7e) break;
            j++;
          }
          if (j >= s.length) {
            if (s.length - i <= MAX_PENDING) { pending = s.slice(i); i = s.length; break; }
            // 너무 길면 이스케이프만 버리고 나머지는 평문으로 살린다
            i += 2;
            continue;
          }
          const final = s[j];
          if (final === 'm') {
            flush();
            const body = s.slice(i + 2, j);
            const params = body.split(';').map((t) => (t === '' ? 0 : parseInt(t, 10) || 0));
            applySgr(state, params);
          }
          // SGR가 아닌 CSI는 버린다(서버가 이미 걸렀지만 방어)
          i = j + 1;
          continue;
        }
        if (next === ']') {
          // OSC: BEL 또는 ST(ESC \)까지 버린다
          let k = i + 2;
          let endLen = 0;
          while (k < s.length) {
            if (s[k] === '\x07') { endLen = 1; break; }
            if (s[k] === '\x1b' && s[k + 1] === '\\') { endLen = 2; break; }
            k++;
          }
          if (k >= s.length) {
            if (s.length - i <= MAX_PENDING) { pending = s.slice(i); i = s.length; break; }
            i += 2;
            continue;
          }
          i = k + endLen;
          continue;
        }
        // 두 글자짜리 나머지 이스케이프는 통째로 버린다
        i += 2;
      }

      flush();
      return out;
    }

    return { write: write };
  }

  /**
   * 세그먼트 배열을 DOM 조각으로 만든다.
   * 텍스트는 createTextNode로만 넣으므로 마크업이 실행될 여지가 없다.
   */
  function segmentsToFragment(segments) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const hasClass = seg.classes && seg.classes.length > 0;
      const styleKeys = Object.keys(seg.style || {});
      if (!hasClass && styleKeys.length === 0) {
        frag.appendChild(document.createTextNode(seg.text));
        continue;
      }
      const span = document.createElement('span');
      if (hasClass) span.className = seg.classes.join(' ');
      for (let k = 0; k < styleKeys.length; k++) {
        span.style[styleKeys[k]] = seg.style[styleKeys[k]];
      }
      span.appendChild(document.createTextNode(seg.text));
      frag.appendChild(span);
    }
    return frag;
  }

  /* ------------------------------------------------------------------ */
  /* 스크롤 추종                                                          */
  /* ------------------------------------------------------------------ */

  function isAtBottom() {
    if (!bodyEl) return true;
    return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight <= BOTTOM_EPSILON;
  }

  function updateJumpBtn() {
    if (!jumpBtnEl) return;
    jumpBtnEl.style.display = stickToBottom ? 'none' : '';
  }

  function scrollToBottom() {
    if (!bodyEl) return;
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  /** 새 내용이 붙은 뒤 호출. 추종 중이면 바닥으로 내린다. */
  function followIfNeeded() {
    if (!bodyEl) return;
    if (stickToBottom) scrollToBottom();
    updateJumpBtn();
  }

  function onBodyScroll() {
    const atBottom = isAtBottom();
    if (atBottom !== stickToBottom) {
      stickToBottom = atBottom;
      updateJumpBtn();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 카드 렌더                                                            */
  /* ------------------------------------------------------------------ */

  function copyText(text, btn) {
    if (typeof Renderer !== 'undefined' && Renderer && typeof Renderer.copyToClipboard === 'function') {
      Renderer.copyToClipboard(text, btn);
      return;
    }
    // Renderer가 없을 때의 방어적 폴백
    const done = () => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { btn.textContent = 'Failed'; });
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Failed'; }
    document.body.removeChild(ta);
  }

  /** 배지 문구/클래스를 상태에 맞게 갱신한다 */
  function setBadge(card, kind, text) {
    if (!card.badgeEl) return;
    card.badgeEl.className = 'term-badge ' + kind;
    card.badgeEl.textContent = text;
  }

  function clearWaitTimer(card) {
    if (card.waitTimer) {
      clearTimeout(card.waitTimer);
      card.waitTimer = null;
    }
  }

  /** 실행 중 배지를 걸고, 오래 걸리면 입력 대기 가능성을 알린다 */
  function markRunning(card) {
    setBadge(card, 'running', '실행 중');
    clearWaitTimer(card);
    card.waitTimer = setTimeout(() => {
      card.waitTimer = null;
      if (!card.finished) setBadge(card, 'running', '실행 중(입력 대기 가능)');
    }, WAIT_HINT_MS);
  }

  /** 접기 상태를 줄 수에 맞춰 다시 계산한다 */
  function refreshCollapse(card) {
    if (!card.outputEl || !card.moreBtn) return;
    const needs = card.lineCount > COLLAPSE_LINES;
    if (!needs) {
      card.moreBtn.style.display = 'none';
      card.outputEl.classList.remove('collapsed');
      card.outputEl.style.maxHeight = '';
      card.outputEl.style.overflowY = '';
      return;
    }
    card.moreBtn.style.display = '';
    if (card.expanded) {
      if (card.moreBtn.textContent !== '접기') card.moreBtn.textContent = '접기';
      card.outputEl.classList.remove('collapsed');
      card.outputEl.style.maxHeight = '';
      card.outputEl.style.overflowY = '';
    } else {
      if (card.moreBtn.textContent !== '더 보기') card.moreBtn.textContent = '더 보기';
      card.outputEl.classList.add('collapsed');
      card.outputEl.style.maxHeight = COLLAPSE_MAX_HEIGHT;
      card.outputEl.style.overflowY = 'hidden';
    }
  }

  // 서버 링버퍼와 같은 수만 화면에 유지한다. 3시간 수업이면 명령이 수백 개가 되는데,
  // 카드를 무한히 쌓으면 저사양 학생 단말에서 메모리와 레이아웃 비용이 커진다.
  const MAX_CARDS = 50;

  /** 오래된 카드를 상한까지 제거한다 */
  function trimCards() {
    while (cards.size > MAX_CARDS) {
      const oldestKey = cards.keys().next().value;
      const oldest = cards.get(oldestKey);
      if (!oldest) break;
      clearWaitTimer(oldest);
      if (oldest.root && oldest.root.parentNode) oldest.root.parentNode.removeChild(oldest.root);
      cards.delete(oldestKey);
    }
  }

  /** 카드 DOM을 만들고 맵에 등록한다 */
  function createCard(data) {
    const execId = String(data.execId == null ? '' : data.execId);
    const root = document.createElement('div');
    root.className = 'term-card';
    root.dataset.execId = execId;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    root.appendChild(copyBtn);

    const header = document.createElement('div');
    header.className = 'term-card-header';

    const prompt = document.createElement('span');
    prompt.className = 'term-prompt';
    prompt.textContent = '$';
    header.appendChild(prompt);

    const cmd = document.createElement('span');
    cmd.className = 'term-cmd';
    cmd.textContent = data.commandLine || '';
    header.appendChild(cmd);

    // cwd는 나중에 채워질 수 있으므로(이벤트 순서 역전 방어) 항상 만들어 두고 비면 숨긴다
    const cwd = document.createElement('span');
    cwd.className = 'term-cwd';
    cwd.textContent = data.cwd || '';
    if (!data.cwd) cwd.style.display = 'none';
    header.appendChild(cwd);

    const badge = document.createElement('span');
    badge.className = 'term-badge running';
    badge.textContent = '실행 중';
    header.appendChild(badge);

    root.appendChild(header);

    const output = document.createElement('pre');
    output.className = 'term-output';
    root.appendChild(output);

    const moreBtn = document.createElement('button');
    moreBtn.className = 'term-more';
    moreBtn.textContent = '더 보기';
    moreBtn.style.display = 'none';
    root.appendChild(moreBtn);

    const card = {
      execId: execId,
      root: root,
      outputEl: output,
      moreBtn: moreBtn,
      badgeEl: badge,
      cmdEl: cmd,
      cwdEl: cwd,
      parser: createParser(),
      lineCount: 0,
      expanded: false,
      commandLine: data.commandLine || '',
      waitTimer: null,
      finished: false,
    };

    copyBtn.addEventListener('click', () => {
      const cmdLine = card.commandLine ? '$ ' + card.commandLine + '\n' : '';
      copyText(cmdLine + (card.outputEl ? card.outputEl.textContent : ''), copyBtn);
    });

    moreBtn.addEventListener('click', () => {
      card.expanded = !card.expanded;
      refreshCollapse(card);
    });

    cards.set(execId, card);
    cardCount++;
    if (bodyEl) bodyEl.appendChild(root);
    trimCards();
    return card;
  }

  /** execId에 해당하는 카드를 찾고, 없으면 만든다(순서가 뒤바뀐 이벤트 방어) */
  function ensureCard(data) {
    const execId = String(data.execId == null ? '' : data.execId);
    const existing = cards.get(execId);
    if (existing) return existing;
    return createCard({ execId: execId, commandLine: data.commandLine || '', cwd: data.cwd || '' });
  }

  /** 출력 청크를 카드 본문 끝에 이어붙인다 */
  function appendChunk(card, chunk) {
    const text = String(chunk == null ? '' : chunk);
    if (!text) return;
    const segments = card.parser.write(text);
    if (segments.length === 0) return;
    let added = 0;
    for (let i = 0; i < segments.length; i++) {
      const t = segments[i].text;
      for (let j = 0; j < t.length; j++) if (t[j] === '\n') added++;
    }
    card.lineCount += added;
    card.outputEl.appendChild(segmentsToFragment(segments));
    refreshCollapse(card);
  }

  /** 안내 문구를 본문에 채운다(출력이 없는 경우) */
  function setNote(card, message) {
    card.outputEl.textContent = message;
    card.outputEl.classList.add('term-note');
    card.lineCount = 1;
    card.expanded = false;
    refreshCollapse(card);
  }

  /** 종료 정보를 카드에 반영한다 */
  function finishCard(card, data) {
    card.finished = true;
    clearWaitTimer(card);

    if (data.blocked) {
      setNote(card, '출력은 공유되지 않았습니다');
      setBadge(card, 'blocked', '출력 미공유');
      return;
    }
    if (data.unsupported) {
      setNote(card, '이 명령의 화면은 공유되지 않습니다');
      setBadge(card, 'unsupported', '화면 공유 안 됨');
      return;
    }

    if (data.truncated) {
      appendChunk(card, '\n[출력이 잘렸습니다]\n');
    }

    const code = data.exitCode;
    if (code === null || code === undefined) {
      setBadge(card, 'unknown', '종료 코드 알 수 없음');
    } else if (code === 0) {
      setBadge(card, 'ok', 'exit 0');
    } else {
      setBadge(card, 'fail', 'exit ' + code);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 공개 API                                                             */
  /* ------------------------------------------------------------------ */

  function mount(opts) {
    const o = opts || {};
    bodyEl = o.bodyEl || null;
    jumpBtnEl = o.jumpBtnEl || null;
    if (bodyEl) {
      bodyEl.addEventListener('scroll', onBodyScroll);
    }
    if (jumpBtnEl) {
      jumpBtnEl.addEventListener('click', () => {
        stickToBottom = true;
        scrollToBottom();
        updateJumpBtn();
      });
    }
    stickToBottom = true;
    updateJumpBtn();
  }

  function clear() {
    cards.forEach((card) => { clearWaitTimer(card); });
    cards.clear();
    cardCount = 0;
    if (bodyEl) bodyEl.textContent = '';
    stickToBottom = true;
    updateJumpBtn();
  }

  function applyFull(data) {
    const d = data || {};
    clear();
    if (!bodyEl) return;

    const omitted = Number(d.omitted || 0);
    if (omitted > 0) {
      const note = document.createElement('div');
      note.className = 'term-card term-omitted';
      note.textContent = '이전 출력 ' + omitted + '개는 생략되었습니다';
      bodyEl.appendChild(note);
    }

    const entries = Array.isArray(d.entries) ? d.entries : [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] || {};
      // 카드를 실제로 등록해 둔다. 마지막 명령이 아직 실행 중이면 곧 도착할
      // terminal:data가 같은 카드에 이어붙어야 하기 때문이다.
      const card = createCard(e);
      if (e.blocked || e.unsupported) {
        finishCard(card, e);
      } else {
        if (e.output) appendChunk(card, e.output);
        const running = (e.endedAt === undefined || e.endedAt === null);
        if (running) markRunning(card);
        else finishCard(card, e);
      }
    }

    stickToBottom = true;
    scrollToBottom();
    updateJumpBtn();
  }

  function onStart(data) {
    if (!data) return;
    const d = data;
    const execId = String(d.execId == null ? '' : d.execId);
    let card = cards.get(execId);
    if (card) {
      // 이미 만들어져 있으면(data/end가 먼저 온 경우) 헤더 정보를 채워 넣는다
      card.commandLine = d.commandLine || card.commandLine;
      if (card.cmdEl) card.cmdEl.textContent = card.commandLine;
      if (card.cwdEl && d.cwd) {
        card.cwdEl.textContent = d.cwd;
        card.cwdEl.style.display = '';
      }
    } else {
      card = createCard(d);
    }
    markRunning(card);
    followIfNeeded();
  }

  function onData(data) {
    if (!data) return;
    const card = ensureCard(data);
    appendChunk(card, data.chunk);
    followIfNeeded();
  }

  function onEnd(data) {
    if (!data) return;
    const card = ensureCard(data);
    finishCard(card, data);
    followIfNeeded();
  }

  function count() {
    // 오래된 카드를 잘라내므로 생성 누계가 아니라 현재 보유 수를 돌려준다
    return cards.size;
  }

  return {
    mount: mount,
    applyFull: applyFull,
    onStart: onStart,
    onData: onData,
    onEnd: onEnd,
    clear: clear,
    count: count,
    // 검증용 순수 파서. DOM 없이 세그먼트 배열을 만든다.
    __parseAnsi(text) { return createParser().write(text); },
  };
})();

// viewer.js는 terminal.js가 없는 빌드에서도 안전하도록 `window.TerminalView?.`로 접근한다.
// 최상위 const는 window 프로퍼티가 되지 않으므로 여기서 명시적으로 붙여 준다.
window.TerminalView = TerminalView;
