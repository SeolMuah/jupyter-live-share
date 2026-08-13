/**
 * 터미널 출력 정규화, 비밀정보 마스킹, 차단 명령 판정.
 *
 * 이 파일은 vscode 모듈에 의존하지 않는 순수 함수만 담는다. 그래야 노드에서 직접
 * 호출해 검증할 수 있고, 확장 활성화와 무관하게 동작을 단정할 수 있다.
 *
 * 처리 순서는 설계안 §4.4를 그대로 따른다.
 *   1) OSC 제거(VS Code shell integration의 633 마커 포함)
 *   2) SGR 이외의 CSI 제거(커서 이동, 화면 지우기). 줄 지우기는 센티널로 남긴다
 *   3) `\r` 접기와 줄 지우기 처리로 진행바를 한 줄로 축약
 *   4) 마스킹
 *   5) 바이트 상한 계산
 * 순서를 바꾸면 마스킹이 뚫리고(ANSI가 토큰을 쪼갬) 상한이 진행바에 낭비된다.
 */

const ESC = '\x1b';
const BEL = '\x07';

/** 줄 전체 지우기(CSI 2K 등)를 접기 단계까지 실어 나르는 내부 센티널. */
const CLEAR_LINE = '\x00';

/** 마스킹 치환 문자열. */
export const MASK = '••••';

export interface NormalizeResult {
  /** SGR는 보존하고 나머지 제어 시퀀스는 제거한 텍스트. `\r`과 지우기 센티널은 남는다. */
  text: string;
  /** 제거한 화면 제어 시퀀스 개수(커서 이동, 화면 지우기 등). TUI 판정에 쓴다. */
  controlCount: number;
}

/**
 * OSC와 SGR 이외의 제어 시퀀스를 제거한다. SGR(`CSI ... m`)은 색 렌더를 위해 보존한다.
 * 줄 지우기(`CSI ?K`)는 접기 단계가 알아야 하므로 센티널로 바꾼다.
 */
export function stripEscapes(input: string): NormalizeResult {
  // 입력에 이미 들어 있는 NUL은 센티널과 충돌하므로 먼저 없앤다.
  const src = input.split(CLEAR_LINE).join('');
  let out = '';
  let controlCount = 0;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch !== ESC) {
      // 백스페이스도 화면 제어라 그대로 두면 학생 화면에 이상하게 보인다.
      if (ch === '\b') { i++; continue; }
      out += ch;
      i++;
      continue;
    }

    const next = src[i + 1];

    // OSC: ESC ] ... (BEL | ESC \). VS Code의 633 마커가 여기에 해당한다.
    // DCS/PM/APC(ESC P | ESC ^ | ESC _)도 같은 종결 규칙을 쓴다.
    if (next === ']' || next === 'P' || next === '^' || next === '_') {
      let j = i + 2;
      while (j < src.length) {
        if (src[j] === BEL) { j++; break; }
        if (src[j] === ESC && src[j + 1] === '\\') { j += 2; break; }
        j++;
      }
      controlCount++;
      i = j;
      continue;
    }

    // CSI: ESC [ 파라미터 중간바이트 최종바이트
    if (next === '[') {
      let j = i + 2;
      while (j < src.length && src[j] >= '\x30' && src[j] <= '\x3f') j++;
      while (j < src.length && src[j] >= '\x20' && src[j] <= '\x2f') j++;
      const finalByte = src[j];
      const seq = src.slice(i, j + 1);
      i = j + 1;
      if (finalByte === undefined) {
        // 청크 경계에서 잘린 시퀀스. 버린다(짝이 안 맞는 잔여물이라 복원할 수 없다).
        controlCount++;
        continue;
      }
      if (finalByte === 'm') {
        out += seq;
        continue;
      }
      controlCount++;
      if (finalByte === 'K' || finalByte === 'J') {
        // 0K/1K/2K(줄 지우기)와 J(화면 지우기)는 줄 단위로 현재 줄 초기화로 근사한다.
        out += CLEAR_LINE;
        continue;
      }
      continue;
    }

    // 그 밖의 두 글자 이스케이프(ESC ( B, ESC = 등).
    controlCount++;
    i += next === undefined ? 1 : 2;
  }

  return { text: out, controlCount };
}

/**
 * 한 줄 안의 `\r`과 줄 지우기를 실제 터미널처럼 덮어쓰기로 접는다.
 * SGR는 폭이 0이므로 열을 소모하지 않고 다음 글자에 붙여 둔다.
 */
export function foldLine(line: string): string {
  const cells: string[] = [];
  let col = 0;
  let pendingSgr = '';
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (ch === ESC && line[i + 1] === '[') {
      // 정규화를 거치면 SGR만 남지만, 단독으로 불릴 때도 안전하도록 CSI를 제대로 끊는다.
      let j = i + 2;
      while (j < line.length && line[j] >= '\x30' && line[j] <= '\x3f') j++;
      while (j < line.length && line[j] >= '\x20' && line[j] <= '\x2f') j++;
      const finalByte = line[j];
      if (finalByte === 'm') pendingSgr += line.slice(i, j + 1);
      else if (finalByte === 'K' || finalByte === 'J') { cells.length = 0; col = 0; }
      i = j + 1;
      continue;
    }
    if (ch === '\r') { col = 0; i++; continue; }
    if (ch === CLEAR_LINE) { cells.length = 0; col = 0; i++; continue; }
    if (ch === '\t') {
      const stop = col + (4 - (col % 4));
      while (col < stop) { if (cells[col] === undefined) cells[col] = ' '; col++; }
      i++;
      continue;
    }

    cells[col] = pendingSgr + ch;
    pendingSgr = '';
    col++;
    i++;
  }

  let out = '';
  for (let k = 0; k < cells.length; k++) out += cells[k] === undefined ? ' ' : cells[k];
  return out + pendingSgr;
}

/**
 * 줄 접기 스트림. 청크 경계를 넘어 이어지는 진행바를 올바로 접기 위해
 * 완결되지 않은 마지막 줄은 내보내지 않고 들고 있는다. 그 줄은 flush()에서 나간다.
 */
export function createLineFolder() {
  let pending = '';
  return {
    /** 완결된 줄만 반환한다. 반환값은 항상 `\n`으로 끝나거나 빈 문자열이다. */
    push(text: string): string {
      pending += text;
      let out = '';
      let idx = pending.indexOf('\n');
      while (idx >= 0) {
        out += foldLine(pending.slice(0, idx)) + '\n';
        pending = pending.slice(idx + 1);
        idx = pending.indexOf('\n');
      }
      // 진행바가 한 줄에 수천 번 갱신되면 pending이 계속 자란다. 접기는 멱등이므로
      // 중간에 한 번 접어 메모리를 상수로 묶는다.
      if (pending.length > 8192) pending = foldLine(pending);
      return out;
    },
    /** 남아 있는 미완결 줄을 접어 내보낸다. */
    flush(): string {
      if (!pending) return '';
      const out = foldLine(pending);
      pending = '';
      return out;
    },
    hasPending(): boolean { return pending.length > 0; },
  };
}

// 마스킹 ---------------------------------------------------------------

/** 접두사가 뚜렷한 자격증명 패턴. */
const SECRET_PATTERNS: RegExp[] = [
  /A[KS]IA[0-9A-Z]{12,24}/g,                                       // AWS 액세스 키, 임시 키
  /sk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{16,}/g,                   // OpenAI 계열
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                                   // GitHub 토큰
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,                                 // Slack 토큰
  /[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g,                          // Bearer 토큰
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
];

/** 접두사 없는 고엔트로피 문자열(길이 32 이상 base64/hex). */
const HIGH_ENTROPY = /(?<![A-Za-z0-9+/_:-])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g;

const PEM_BEGIN = /-----BEGIN [^-]*-----/;
const PEM_END = /-----END [^-]*-----/;

/** 영문만 이어진 긴 단어(문장, 경로)를 오탐하지 않도록 문자 구성을 본다. */
function looksHighEntropy(s: string): boolean {
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s);
}

/** SGR를 걷어낸 평문과 원문 인덱스 매핑을 만든다. 토큰 중간에 낀 SGR를 뚫기 위함이다. */
function stripSgrWithMap(text: string): { plain: string; map: number[] } {
  let plain = '';
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC && text[i + 1] === '[') {
      let j = i + 2;
      while (j < text.length && text[j] !== 'm') j++;
      i = j + 1;
      continue;
    }
    map.push(i);
    plain += text[i];
    i++;
  }
  return { plain, map };
}

/**
 * 정규화된 텍스트에서 자격증명으로 보이는 부분을 마스킹 문자열로 바꾼다.
 * SGR가 토큰 중간에 끼어 있어도 잡히도록 평문 사본에서 찾아 원문 범위를 치환한다.
 */
export function maskSecrets(text: string): string {
  if (!text) return text;
  const { plain, map } = stripSgrWithMap(text);
  const ranges: Array<[number, number]> = [];

  const collect = (re: RegExp, guard?: (s: string) => boolean) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(plain)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (guard && !guard(m[0])) continue;
      ranges.push([m.index, m.index + m[0].length]);
    }
  };

  for (const re of SECRET_PATTERNS) collect(re);
  collect(HIGH_ENTROPY, looksHighEntropy);

  // PEM 블록은 통째로 지운다. END가 아직 안 왔으면 끝까지 지운다.
  const b = plain.search(PEM_BEGIN);
  if (b >= 0) {
    const rest = plain.slice(b);
    const em = PEM_END.exec(rest);
    ranges.push([b, em ? b + em.index + em[0].length : plain.length]);
  }

  if (ranges.length === 0) return text;

  ranges.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) { last[1] = Math.max(last[1], r[1]); continue; }
    merged.push([r[0], r[1]]);
  }

  let out = '';
  let cursor = 0;
  for (const [s, e] of merged) {
    const os = map[s] !== undefined ? map[s] : text.length;
    const oe = map[e - 1] !== undefined ? map[e - 1] + 1 : text.length;
    if (os > cursor) out += text.slice(cursor, os);
    out += MASK;
    cursor = Math.max(cursor, oe);
  }
  out += text.slice(cursor);
  return out;
}

export interface SecretMasker {
  push(chunk: string): string;
  flush(): string;
}

/** 토큰이 청크 경계에서 쪼개져도 마스킹되도록 꼬리를 들고 다니는 스트리밍 마스커. */
export function createSecretMasker(enabled: boolean): SecretMasker {
  let carry = '';
  let inPem = false;
  const MAX_CARRY = 4096;

  const run = (s: string): string => {
    if (!s) return s;
    if (inPem) {
      const em = PEM_END.exec(s);
      if (!em) return MASK;
      inPem = false;
      return MASK + maskSecrets(s.slice(em.index + em[0].length));
    }
    const b = s.search(PEM_BEGIN);
    if (b >= 0 && !PEM_END.test(s.slice(b))) inPem = true;
    return maskSecrets(s);
  };

  return {
    /** 안전한 경계까지만 마스킹해 내보내고, 마지막 미완결 토큰은 다음 청크로 넘긴다. */
    push(chunk: string): string {
      if (!enabled) return chunk;
      const combined = carry + chunk;
      // 마지막 공백 뒤는 아직 자라는 중인 토큰일 수 있으므로 들고 있는다.
      let lastWs = -1;
      for (let i = combined.length - 1; i >= 0; i--) {
        const c = combined[i];
        if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { lastWs = i; break; }
      }
      let split = lastWs + 1;
      // 거대한 단일 토큰(줄바꿈 없는 대용량 출력)은 무한정 들고 있지 않는다.
      if (combined.length - split > MAX_CARRY) split = combined.length;
      carry = combined.slice(split);
      return run(combined.slice(0, split));
    },
    /** 남은 꼬리를 마스킹해 내보낸다. */
    flush(): string {
      if (!enabled) return '';
      if (!carry) return '';
      const out = run(carry);
      carry = '';
      return out;
    },
  };
}

// 차단 명령 ------------------------------------------------------------

/** 설계안 §7.3의 기본 차단 목록. 정규식 문자열이며 명령 세그먼트와 토큰 양쪽에 적용된다. */
export const DEFAULT_BLOCKED_PATTERNS: string[] = [
  '^env$',
  '^printenv\\b',
  '^export\\b',
  '^set$',
  '^history\\b',
  '^(cat|head|tail|less|more|bat|type)\\b.*(token|\\.env|\\.pem|credential|secret|password|id_rsa|\\.npmrc|\\.aws)',
  '^sed\\b.*(token|\\.env|\\.pem|credential)',
  '^aws\\s+configure\\b',
  '^git\\s+remote\\s+-v\\b',
  '^gh\\s+auth\\s+token\\b',
  '^security\\s+find-generic-password\\b',
];

/**
 * 명령줄용 민감 파일명 규칙. 명령줄은 강사가 방금 친 한 줄이라 넓게 잡아도 부작용이 적다.
 */
const SENSITIVE_FILE_COMMAND = /(token\.txt|\.env\b|\.pem\b|credentials?\b|id_rsa\b|\.npmrc\b|\.aws\/)/i;

/**
 * 출력용 민감 파일명 규칙. 출력에는 "credentials" 같은 영어 단어가 흔히 섞이는데
 * (git push 실패 메시지, gcloud/aws 안내 등) 그걸로 카드를 통째로 막으면 정상 수업이 깨진다.
 * 그래서 출력에는 파일명 모양일 때만 반응한다. `.env.example` 처럼 예시 파일은 제외한다.
 */
const SENSITIVE_FILE_OUTPUT = new RegExp(
  '(^|[\\s\'"=:(/\\\\])(' +
    'token\\.txt' +
    '|id_rsa(\\.pub)?' +
    '|\\.npmrc' +
    '|credentials\\.(json|ini|ya?ml|csv)' +
    '|[\\w.-]*\\.pem' +
    '|[\\w.-]*\\.env(\\.(local|production|prod|development|dev))?(?![\\w.])' +
    '|\\.aws/' +
  ')',
  'i',
);

/** 명령줄에 민감 파일이 언급됐는지. 걸리면 그 명령의 출력을 통째로 막는다. */
export function mentionsSensitiveFile(text: string): boolean {
  if (!text) return false;
  return SENSITIVE_FILE_COMMAND.test(text);
}

/** 출력에 민감 파일명이 보이는지. 명령줄보다 좁게 본다(오탐이 곧 수업 방해다). */
export function mentionsSensitiveFileInOutput(text: string): boolean {
  if (!text) return false;
  return SENSITIVE_FILE_OUTPUT.test(text);
}

/**
 * 명령줄을 `&&`, `||`, `;`, `|`, 개행, `$(...)`, 백틱으로 분해한다.
 * 따옴표는 벗겨서 `bash -c 'env'` 같은 형태의 안쪽 명령도 토큰으로 드러나게 한다.
 */
export function splitCommandSegments(commandLine: string): string[] {
  const src = commandLine.replace(/\$\(|`|\)/g, ' ');
  const parts = src.split(/(?:&&|\|\||[;|\n])/);
  const out: string[] = [];
  for (const p of parts) {
    const cleaned = p.replace(/['"]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/** 세그먼트를 공백 기준 토큰으로 쪼갠다. */
export function tokenizeSegment(segment: string): string[] {
  return segment.split(' ').filter((t) => t.length > 0);
}

/**
 * 차단 여부를 판정한다. 세그먼트 전체와 그 안의 모든 토큰(및 토큰 이후 잔여 문자열)에
 * 규칙을 적용하므로 `ls && env`, `bash -c 'env'` 가 모두 걸린다.
 * 명령줄이 비어 있으면 fail-closed로 차단한다.
 */
export function isBlockedCommand(commandLine: string, patterns: string[] = DEFAULT_BLOCKED_PATTERNS): boolean {
  if (!commandLine || !commandLine.trim()) return true;
  const regexes: RegExp[] = [];
  for (const p of patterns) {
    try { regexes.push(new RegExp(p, 'i')); } catch { /* 잘못된 설정값은 무시한다 */ }
  }
  for (const seg of splitCommandSegments(commandLine)) {
    const tokens = tokenizeSegment(seg);
    const candidates = [seg];
    for (let i = 0; i < tokens.length; i++) {
      candidates.push(tokens[i]);
      if (i > 0) candidates.push(tokens.slice(i).join(' '));
    }
    for (const re of regexes) {
      for (const c of candidates) {
        if (re.test(c)) return true;
      }
    }
  }
  return false;
}

/** 정규화 통계로 전체 화면 TUI 여부를 근사한다. */
export function looksLikeFullScreenTui(controlCount: number, visibleChars: number): boolean {
  if (controlCount < 30) return false;
  return controlCount > visibleChars / 20;
}

/**
 * 명령줄 전용 마스킹.
 * 차단된 명령이라도 명령줄 자체는 학생 카드 헤더에 표시되므로, 거기 인라인으로 박힌
 * 자격증명을 지운다. 출력 마스킹(maskSecrets)은 알려진 토큰 접두사와 고엔트로피
 * 문자열만 잡아서 `export DB_PASSWORD=hunter2` 같은 짧은 값은 통과시킨다.
 */
export function maskCommandLine(commandLine: string): string {
  if (!commandLine) return commandLine;
  let out = commandLine;
  // KEY=VALUE 형태의 대입값 (대문자 환경변수 관례)
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|PAT|PWD|AUTH)[A-Za-z0-9_]*)=(\S+)/gi,
    (_m, k) => `${k}=${MASK}`);
  // 비밀번호·토큰을 인자로 받는 흔한 플래그
  out = out.replace(/(\s(?:-p|-u|-P|--password|--pass|--token|--secret|--api-key|--apikey|--auth)[=\s])(\S+)/gi,
    (_m, flag) => `${flag}${MASK}`);
  // mysql -phunter2 처럼 붙여 쓰는 형태
  out = out.replace(/(\s-p)(?=\S)(\S+)/g, (_m, flag) => `${flag}${MASK}`);
  // URL에 박힌 자격증명 (https://user:pw@host)
  out = out.replace(/:\/\/([^\s/@:]+):([^\s/@]+)@/g, (_m, user) => `://${user}:${MASK}@`);
  // 그 밖의 알려진 토큰 패턴은 출력 마스커와 동일하게 처리
  return maskSecrets(out);
}
