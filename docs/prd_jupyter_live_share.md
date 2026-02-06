# PRD: Jupyter Live Share Extension for VS Code

## 제품 요약

**제품명:** Jupyter Live Share (가칭)

**한 줄 요약:** VS Code에서 Jupyter Notebook(.ipynb), Python(.py), Markdown(.md), 텍스트(.txt) 등 파일을 실시간으로 학생들에게 공유하는 교육용 Extension

**목표 사용자:** 통계/데이터 분석을 가르치는 교육자 및 50명 규모의 학생

**기술적 타당성:** 구현 가능 (아래 타당성 분석 참조)

---

## 기술적 타당성 분석

### 결론: 구현 가능

| 핵심 요소 | 타당성 | 근거 |
|-----------|--------|------|
| VS Code Notebook API | **가능** | `onDidChangeNotebookDocument` API로 셀 변경/출력 감지 지원 |
| WebSocket 50명 동시접속 | **가능** | Socket.io는 단일 Node.js 프로세스에서 수천 연결 처리 가능 |
| Cloudflare Quick Tunnel | **가능** | `cloudflared tunnel --url`로 무료 HTTPS 터널 생성, 제한 없음 |
| 브라우저 노트북 렌더링 | **가능** | marked.js + highlight.js + KaTeX 조합으로 구현 가능 |
| 셀 출력 동기화 | **가능** | NotebookCellOutput의 MIME type별 직렬화로 처리 |

### 주요 기술적 제약사항

1. **VS Code Notebook API는 `onDidChangeTextDocument`가 아님**
   - `.ipynb`를 네이티브 노트북 에디터로 열면 TextDocument 이벤트가 발생하지 않음
   - 반드시 `vscode.workspace.onDidChangeNotebookDocument` 사용 필요

2. **Output 직렬화 복잡성**
   - `NotebookCellOutput`에는 여러 MIME type이 포함됨 (`text/plain`, `text/html`, `image/png`, `application/json` 등)
   - `image/png`는 base64 인코딩되어 있어 대용량 가능 (matplotlib 그래프 ~100KB-1MB)
   - DataFrame의 HTML 출력도 수천 행이면 수 MB 가능

3. **Cloudflare Quick Tunnel 특성**
   - `trycloudflare.com` URL은 매 세션마다 변경됨 (고정 불가)
   - SLA 없음 (무료 서비스)
   - 대역폭 제한 명시 없으나, 교육용 트래픽 수준에서 문제없음

4. **LaTeX/수식 렌더링**
   - 통계 수업이므로 수식 포함 가능성 높음
   - 브라우저 뷰어에 KaTeX 또는 MathJax 필수

---

## 배경 및 문제 정의

### 현재 문제점

1. **기존 솔루션의 한계**
   - VS Code Live Share: .ipynb 지원 불완전 (셀 실행 결과 동기화 안 됨, 노트북 네이티브 에디터 비호환)
   - CodeTogether: .ipynb 미지원
   - JupyterHub: 서버 설치/운영 복잡, 비용 발생, IT 인프라 필요
   - Google Colab: 실시간 셀 실행 공유 불가, 각자 별도 실행 필요

2. **교육 현장의 니즈**
   - 선생님이 코드 작성하는 과정을 학생들이 실시간으로 봐야 함
   - 셀 실행 결과(표, 그래프, 통계 출력)도 즉시 공유되어야 함
   - 학생들은 별도 설치 없이 브라우저로 접근 가능해야 함
   - 클라우드 서버 없이 선생님 PC에서 직접 호스팅 가능해야 함
   - 수업 중 네트워크 불안정에도 안정적으로 동작해야 함

---

## 솔루션 개요

### 아키텍처

```
┌───────────────────────────────────────────────────────────────────┐
│                      선생님 PC (Windows)                          │
│                                                                   │
│  ┌─────────────────┐    ┌──────────────────────────────────┐     │
│  │   VS Code       │    │  Extension 내장 서버              │     │
│  │  + Extension    │───▶│  ┌────────────┐ ┌─────────────┐  │     │
│  │  (.ipynb 편집)  │    │  │ Express.js │ │ Socket.io   │  │     │
│  └─────────────────┘    │  │ (HTTP)     │ │ (WebSocket) │  │     │
│                          │  └────────────┘ └─────────────┘  │     │
│                          └──────────┬───────────────────────┘     │
│                                     │ localhost:3000              │
│                          ┌──────────▼───────────┐                │
│                          │  cloudflared          │                │
│                          │  (Quick Tunnel)       │                │
│                          └──────────┬───────────┘                │
└─────────────────────────────────────┼────────────────────────────┘
                                      │
                             https://xxxx.trycloudflare.com
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
   [학생 A 브라우저]           [학생 B 브라우저]           [학생 N 브라우저]
   - Read-Only 뷰어           - Read-Only 뷰어           - Read-Only 뷰어
   - 실시간 셀 업데이트       - 실시간 셀 업데이트       - 실시간 셀 업데이트
   - 출력 결과 렌더링         - 출력 결과 렌더링         - 출력 결과 렌더링
   - 선생님 포커스 추적       - 선생님 포커스 추적       - 선생님 포커스 추적
```

### 핵심 설계 원칙

1. **단방향 공유 (선생님 → 학생)**: 학생은 Read-Only 뷰어만 사용
2. **제로 설치 (학생 측)**: 브라우저만으로 접근
3. **제로 설정 (선생님 측)**: Extension 설치 후 원클릭 시작
4. **로컬 우선**: 선생님 PC에서 모든 것을 처리, 외부 서버 의존 없음

---

## 기능 요구사항

### Phase 1: MVP (핵심 기능)

| 기능 | 설명 | 우선순위 | 구현 난이도 |
|------|------|----------|-------------|
| 노트북 전체 동기화 | 세션 시작 시 / 학생 접속 시 전체 노트북 상태 전송 | P0 | 낮음 |
| 셀 소스 실시간 공유 | 셀 내용 변경 시 변경된 셀만 전송 (diff 방식) | P0 | 중간 |
| 셀 실행 결과 공유 | output(텍스트, 표, 이미지, 에러) 동기화 | P0 | 중간 |
| 브라우저 기반 뷰어 | Markdown/코드/출력 렌더링 (수식 포함) | P0 | 높음 |
| Cloudflare Tunnel 통합 | 명령어 한 번으로 외부 공유 URL 생성 | P0 | 낮음 |
| 자동 재연결 | 네트워크 끊김 시 자동 재연결 + 전체 상태 복구 | P0 | 낮음 |
| 일반 파일 공유 | .py, .txt, .md 등 텍스트 파일 실시간 공유 (구문 하이라이팅 지원) | P0 | 중간 |

### Phase 2: 교육 기능 강화

| 기능 | 설명 | 우선순위 | 구현 난이도 |
|------|------|----------|-------------|
| 활성 셀 하이라이트 | 선생님이 현재 편집/선택 중인 셀 강조 표시 | P1 | 낮음 |
| 접속자 수 표시 | 현재 연결된 학생 수 실시간 표시 | P1 | 낮음 |
| 세션 PIN 보호 | 4자리 PIN으로 세션 접근 제어 | P1 | 낮음 |
| 셀 추가/삭제 동기화 | 셀 구조 변경 시 동기화 | P1 | 중간 |
| 노트북 파일 전환 | 수업 중 다른 .ipynb 파일로 전환 시 자동 반영 | P1 | 중간 |

### Phase 3: 편의 기능

| 기능 | 설명 | 우선순위 | 구현 난이도 |
|------|------|----------|-------------|
| 다크/라이트 모드 | 학생 뷰어 테마 선택 | P2 | 낮음 |
| 코드 복사 버튼 | 학생이 셀 코드를 클립보드로 복사 | P2 | 낮음 |
| QR 코드 표시 | URL을 QR 코드로 표시하여 공유 편의성 향상 | P2 | 낮음 |
| 스크롤 자동 추적 | 선생님이 보는 셀로 학생 화면 자동 스크롤 | P2 | 중간 |
| .ipynb 다운로드 | 학생이 현재 노트북 파일을 다운로드 | P2 | 낮음 |

---

## 기술 스택

### Extension (VS Code)

```
언어: TypeScript
최소 VS Code 버전: 1.82.0 (Notebook API 안정화 버전)

VS Code Notebook API (핵심):
  - vscode.workspace.onDidChangeNotebookDocument  → 셀 내용/출력/메타데이터 변경 감지
  - vscode.window.onDidChangeActiveNotebookEditor → 활성 노트북 에디터 변경 감지
  - vscode.window.onDidChangeNotebookEditorSelection → 선택된 셀 변경 감지

※ 주의: vscode.workspace.onDidChangeTextDocument는 .ipynb에 사용 불가
         (네이티브 노트북 에디터에서는 TextDocument 이벤트가 발생하지 않음)
```

### 서버 (Extension 내장)

```
런타임: VS Code Extension Host의 Node.js (별도 Node.js 설치 불필요)
WebSocket: ws (경량, Socket.io 대비 의존성 최소)
  - 대안: Socket.io (자동 재연결, room 기능 내장 - 편의성 우선시 선택)
HTTP 서버: VS Code 내장 http 모듈 또는 Express.js
정적 파일: 브라우저 뷰어 HTML/JS/CSS (Extension에 번들)
터널링: cloudflared 바이너리 (Extension이 OS별 자동 다운로드)
```

### 클라이언트 (브라우저 뷰어)

```
프레임워크: Vanilla JS (번들 크기 최소화, 의존성 제거)
  - React 불필요: Read-Only 뷰어이므로 복잡한 상태 관리 없음
노트북 렌더링:
  - Markdown: marked.js (~40KB)
  - 코드 하이라이팅: highlight.js (~30KB, Python 언어팩만)
  - 수식 렌더링: KaTeX (~300KB) - 통계 수업 필수
  - HTML 출력: innerHTML (pandas DataFrame 등)
  - 이미지 출력: base64 → <img> 태그
실시간 통신: WebSocket 네이티브 API 또는 Socket.io-client
스타일링: 단일 CSS 파일 (외부 프레임워크 불필요)
```

### 의존성 최소화 원칙

```
Extension 번들 크기 목표: < 5MB (cloudflared 제외)
브라우저 뷰어 크기 목표: < 500KB (gzip 후)
외부 CDN 의존: 없음 (모든 리소스 로컬 서빙)
```

---

## 데이터 흐름

### 1. 세션 시작 시

```
Command Palette → "Start Session"
       ↓
Express HTTP 서버 시작 (localhost:3000)
+ WebSocket 서버 시작
       ↓
cloudflared 프로세스 실행
       ↓
터널 URL 감지 (stderr에서 파싱)
       ↓
Extension UI에 URL 표시 (Sidebar WebviewView + StatusBar)
+ 사이드바가 ws://localhost:{port}에 teacherPanel 모드로 WebSocket 연결
```

### 2. 학생 접속 시

```
브라우저에서 URL 접속
       ↓
HTTP로 뷰어 HTML/JS/CSS 다운로드
       ↓
WebSocket 연결 수립
       ↓
(PIN 설정 시) PIN 검증
       ↓
서버가 현재 노트북 전체 상태 전송 (notebook:full)
       ↓
뷰어에서 전체 노트북 렌더링
```

### 3. 셀 내용 변경 시 (실시간 타이핑)

```
VS Code에서 셀 편집
       ↓
onDidChangeNotebookDocument 이벤트 발생
  → event.cellChanges[].document (셀 소스 변경)
       ↓
변경된 셀만 추출 (인덱스 + 새 소스)
       ↓
debounce (300ms) 적용 - 타이핑 중 과도한 전송 방지
       ↓
WebSocket broadcast (cell:update)
       ↓
클라이언트에서 해당 셀만 재렌더링
```

### 4. 셀 실행 시

```
VS Code에서 셀 실행 (Shift+Enter)
       ↓
Jupyter Kernel이 실행
       ↓
onDidChangeNotebookDocument 이벤트 발생
  → event.cellChanges[].outputs (출력 변경)
       ↓
Output MIME type별 직렬화:
  - text/plain → 문자열 그대로
  - text/html → HTML 문자열 그대로 (DataFrame 등)
  - image/png → base64 문자열 그대로
  - application/vnd.plotly.v1+json → JSON 그대로
  - traceback → ANSI 컬러 코드 포함 에러 메시지
       ↓
대용량 체크 (> 1MB인 경우 청크 분할)
       ↓
WebSocket broadcast (cell:output)
       ↓
클라이언트에서 MIME type에 따라 렌더링
```

### 5. 텍스트 파일 공유 시

```
VS Code에서 .py / .md / .txt 파일 열기
       ↓
"Start Session" 실행
       ↓
watcher가 plaintext 모드로 시작
       ↓
학생 접속 → document:full 전송 (fileName, content, languageId)
       ↓
뷰어에서 파일 타입에 따라 렌더링:
  - .py → highlight.js (Python 구문 하이라이팅)
  - .md → marked.js + KaTeX (Markdown 렌더링)
  - .txt → <pre> 일반 텍스트
       ↓
파일 편집 시 → onDidChangeTextDocument 이벤트
       ↓
debounce (300ms) 적용
       ↓
WebSocket broadcast (document:update)
       ↓
클라이언트에서 콘텐츠 재렌더링
```

### 6. 활성 셀 변경 시

```
VS Code에서 다른 셀 클릭/이동
       ↓
onDidChangeNotebookEditorSelection 이벤트 발생
       ↓
throttle (200ms) 적용
       ↓
WebSocket broadcast (focus:cell)
       ↓
클라이언트에서 해당 셀 하이라이트 + 자동 스크롤
```

---

## API 설계

### WebSocket Events

#### Server → Client

```typescript
// 노트북 전체 동기화 (최초 접속 시, 노트북 전환 시)
socket.emit('notebook:full', {
  fileName: string,          // 파일명
  cells: SerializedCell[],   // 모든 셀
  activeCellIndex: number    // 현재 선생님이 선택한 셀
});

interface SerializedCell {
  kind: 'code' | 'markup';           // 셀 타입
  source: string;                     // 셀 소스 코드/마크다운
  languageId: string;                 // 'python', 'markdown' 등
  outputs: SerializedOutput[];        // 실행 결과
  executionOrder?: number;            // 실행 순서 번호 [1], [2], ...
}

interface SerializedOutput {
  items: Array<{
    mime: string;    // 'text/plain', 'text/html', 'image/png' 등
    data: string;    // MIME type에 따른 데이터
  }>;
}

// 셀 소스 업데이트 (편집 시)
socket.emit('cell:update', {
  index: number,
  source: string
});

// 셀 출력 업데이트 (실행 시)
socket.emit('cell:output', {
  index: number,
  outputs: SerializedOutput[],
  executionOrder?: number
});

// 셀 구조 변경 (추가/삭제/이동)
socket.emit('cells:structure', {
  type: 'insert' | 'delete' | 'move',
  index: number,
  cell?: SerializedCell,    // insert 시
  toIndex?: number          // move 시
});

// 선생님 활성 셀 변경
socket.emit('focus:cell', {
  cellIndex: number
});

// 접속자 수 변경
socket.emit('viewers:count', {
  count: number
});

// 세션 종료
socket.emit('session:end', {});

// 텍스트 파일 전체 동기화 (최초 접속 시, 파일 전환 시)
socket.emit('document:full', {
  fileName: string,          // 파일명
  content: string,           // 파일 전체 내용
  languageId: string         // 'python', 'markdown', 'plaintext' 등
});

// 텍스트 파일 내용 변경
socket.emit('document:update', {
  content: string            // 변경된 전체 내용
});
```

#### Client → Server

```typescript
// 세션 참여 (학생 브라우저)
socket.emit('join', {
  pin?: string
});

// 세션 참여 (VS Code 사이드바 Teacher Panel)
socket.emit('join', {
  teacherPanel: true    // localhost에서만 허용, 접속자 수 미포함
});

// 세션 참여 (VS Code Viewer Chat Panel — chatOnly 연결)
socket.emit('join', {
  chatOnly: true,       // 채팅/설문 전용, 접속자 수 미포함, isTeacher=false
  pin?: string
});

// 참여 결과
socket.on('join:result', {
  success: boolean,
  error?: string
});

// 채팅 메시지 전송
socket.emit('chat:message', {
  text: string
});

// 설문 시작 (teacher만)
socket.emit('poll:start', {
  question: string,
  optionCount: number,
  pollId: string
});

// 설문 종료 (teacher만)
socket.emit('poll:end', {});

// 투표
socket.emit('poll:vote', {
  pollId: string,
  option: number
});
```

### HTTP Endpoints

```
GET /                → 브라우저 뷰어 HTML
GET /assets/*        → JS, CSS, 폰트 등 정적 리소스
GET /health          → 서버 상태 확인 (학생 수, 업타임)
GET /download        → 현재 노트북 .ipynb 다운로드 (Phase 3)
```

---

## UI/UX 명세

### VS Code Extension UI

#### StatusBar 아이템 (항상 표시)

```
┌──────────────────────────────────────────────────────────────────┐
│  ... [다른 StatusBar 아이템들] ...  | 📡 Live Share: 47명 접속   │
└──────────────────────────────────────────────────────────────────┘
```

#### Sidebar WebviewView (세션 정보 + 채팅 통합)

```
┌─────────────────────────────────────────┐
│ JUPYTER LIVE SHARE - Session            │
├─────────────────────────────────────────┤
│                                         │
│ [세션 미실행 시]                        │
│  No active session                      │
│  [Start Session]                        │
│                                         │
│ [세션 실행 시]                          │
│  URL  https://xxx.trycloudflare.com     │
│  File Statistics_01.ipynb               │
│  Viewers 47                             │
│                                         │
│  [Create Poll]                          │
│  ┌─ 인라인 설문 생성 폼 ────────────┐  │
│  │ Question: [________________]      │  │
│  │ Options:  [2 ▼]                   │  │
│  │ [Cancel] [Start]                  │  │
│  └──────────────────────────────────┘  │
│  [Stop Session]                         │
│                                         │
│ ─── CHAT ─────────────────────────────  │
│ │ Student1          14:23 │             │
│ │ ┌───────────────────┐   │             │
│ │ │ 잘 이해됩니다!     │   │             │
│ │ └───────────────────┘   │             │
│ │ Teacher (빨간색)   14:24 │             │
│ │ ┌───────────────────┐   │             │
│ │ │ 다음 코드 보겠습니다│   │             │
│ │ └───────────────────┘   │             │
│ ├─────────────────────────┤             │
│ │ [메시지 입력...] [Send] │             │
│ └─────────────────────────┘             │
└─────────────────────────────────────────┘
```

**구현 방식:**
- `WebviewViewProvider`로 구현 (TreeDataProvider가 아님)
- 사이드바 채팅은 `ws://localhost:{port}`로 직접 WebSocket 연결
- `join` 메시지에 `teacherPanel: true` 플래그 전송 → 서버가 접속자 수에 미포함
- 설문 생성/종료는 사이드바에서 WebSocket으로 직접 전송 (Command Palette 없이도 가능)

### 학생용 브라우저 뷰어

```
┌─────────────────────────────────────────────────────────────────┐
│  Statistics_Lecture_01.ipynb                      47명 접속 중   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  # 기초 통계학 - 1강                                            │
│  ## 평균과 표준편차                                             │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  [1] import pandas as pd                                        │
│      import numpy as np                                         │
│      from scipy import stats                                    │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  [2] data = [23, 45, 67, 89, 12, 34, 56]          ◀ 현재 셀   │
│      mean = np.mean(data)                                       │
│      std = np.std(data)                                         │
│      print(f"평균: {mean:.2f}, 표준편차: {std:.2f}")            │
│                                                                 │
│      ┌─ Output ────────────────────────────────────────────┐    │
│      │ 평균: 46.57, 표준편차: 24.28                        │    │
│      └─────────────────────────────────────────────────────┘    │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  [3] plt.hist(data, bins=5)                                     │
│      plt.title('데이터 분포')                                   │
│      plt.show()                                                 │
│                                                                 │
│      ┌─ Output ────────────────────────────────────────────┐    │
│      │ [히스토그램 이미지 (base64 → img)]                  │    │
│      └─────────────────────────────────────────────────────┘    │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  수식 예시: $$\bar{x} = \frac{1}{n}\sum_{i=1}^{n}x_i$$        │
│  (KaTeX로 렌더링)                                               │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  [코드 복사]  [.ipynb 다운로드]  [라이트/다크 모드 전환] │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 비기능 요구사항

### 성능

| 항목 | 목표 | 근거 |
|------|------|------|
| 동시 접속자 | 50명 이상 | Socket.io 단일 프로세스 기준 수천 연결 가능 |
| 셀 편집 → 학생 반영 | < 500ms | debounce 300ms + 네트워크 ~100ms + 렌더링 ~50ms |
| 셀 실행 → 출력 반영 | < 1초 | 출력 직렬화 + 전송 + 렌더링 |
| 학생 최초 로딩 | < 3초 | 뷰어 번들 < 500KB + 노트북 데이터 |
| Extension 메모리 | < 100MB | 서버 + WebSocket 연결 관리 |
| 대용량 출력 처리 | < 5MB/셀 | 초과 시 경고 + 축소 전송 |

### 보안

| 항목 | 구현 방안 |
|------|-----------|
| 전송 암호화 | Cloudflare Tunnel 기본 HTTPS 제공 |
| 세션 접근 제어 | 랜덤 URL (UUID 기반) + 선택적 4자리 PIN |
| 코드 주입 방지 | HTML 출력 시 DOMPurify로 새니타이징 |
| Rate Limiting | WebSocket 연결당 이벤트 수 제한 (100/분) |
| 최대 접속자 제한 | 기본 100명 (설정 가능), 초과 시 접속 거부 |

### 호환성

| 항목 | 지원 범위 |
|------|-----------|
| VS Code | 1.82.0 이상 (Notebook API 안정화 기준) |
| OS (선생님) | Windows 10/11, macOS 12+, Linux (Ubuntu 20.04+) |
| 브라우저 (학생) | Chrome 90+, Firefox 90+, Safari 15+, Edge 90+ |
| Python Kernel | Python 3.8+ (Jupyter Extension 기본 지원) |

### 안정성

| 항목 | 구현 방안 |
|------|-----------|
| 학생 자동 재연결 | WebSocket 끊김 시 exponential backoff로 재연결 (1s, 2s, 4s...) |
| 상태 복구 | 재연결 시 notebook:full 재전송으로 전체 상태 복구 |
| Extension 충돌 복구 | Extension 재시작 시 이전 세션 정보 복원 |
| cloudflared 모니터링 | 프로세스 감시, 종료 시 자동 재시작 |

---

## 설치 및 사용 흐름

### 선생님 (최초 설정)

```
1. VS Code에서 "Jupyter Live Share" Extension 설치
2. (자동) Extension이 OS에 맞는 cloudflared 바이너리 다운로드
   - Windows: cloudflared-windows-amd64.exe
   - macOS: cloudflared-darwin-amd64
   - Linux: cloudflared-linux-amd64
3. 완료 (별도 설정 없음)
```

### 선생님 (매 수업)

```
1. VS Code에서 .ipynb 파일 열기
2. 방법 A: StatusBar의 "Live Share" 클릭
   방법 B: Command Palette → "Jupyter Live Share: Start Session"
   방법 C: 에디터 타이틀 바 아이콘 클릭
3. (선택) PIN 설정 팝업
4. Tunnel 생성 대기 (~3-5초)
5. URL이 자동으로 클립보드에 복사됨
6. URL을 학생들에게 공유 (채팅, LMS 등)
7. 수업 진행 (평소대로 .ipynb 편집/실행)
8. 수업 종료 시 "Stop Session" 또는 VS Code 종료
```

### 학생

```
1. 선생님이 공유한 URL 클릭
2. (PIN 설정 시) PIN 입력
3. 브라우저에서 실시간 뷰어 열림
4. 설치/로그인/회원가입 없이 바로 시청
5. 네트워크 끊김 시 자동 재연결
```

---

## 프로젝트 구조 (권장)

```
jupyter-live-share/
├── package.json                    # Extension 매니페스트
├── tsconfig.json
├── webpack.config.js               # Extension + Viewer 번들링
├── src/
│   ├── extension.ts                # Extension 진입점 (activate/deactivate)
│   ├── server/
│   │   ├── httpServer.ts           # Express/HTTP 서버
│   │   ├── wsServer.ts             # WebSocket 서버 (브로드캐스트)
│   │   └── tunnel.ts               # cloudflared 관리 (다운로드/실행/URL 파싱)
│   ├── notebook/
│   │   ├── watcher.ts              # NotebookDocument 변경 감지
│   │   └── serializer.ts           # NotebookCell → SerializedCell 변환
│   ├── ui/
│   │   ├── statusBar.ts            # StatusBar 아이템
│   │   ├── sidebarView.ts          # Sidebar WebviewView (세션 정보 + 채팅)
│   │   └── commands.ts             # Command Palette 명령어
│   └── utils/
│       ├── config.ts               # 설정 관리
│       └── logger.ts               # 로깅
├── viewer/                         # 브라우저 뷰어 (별도 번들)
│   ├── index.html
│   ├── viewer.js                   # 메인 뷰어 로직
│   ├── renderer.js                 # 셀 렌더링 (Markdown/Code/Output)
│   ├── websocket.js                # WebSocket 클라이언트 + 재연결
│   └── style.css                   # 뷰어 스타일 (다크/라이트)
├── bin/                            # cloudflared 바이너리 (자동 다운로드)
└── test/
    ├── unit/
    └── integration/
```

---

## 성공 지표

| 지표 | 목표 |
|------|------|
| Extension 설치 → 첫 세션 시작 | < 3분 (cloudflared 다운로드 포함) |
| 세션 시작 → URL 생성 | < 10초 |
| 수업 중 학생 연결 유지율 | > 99% (자동 재연결 포함) |
| 학생 접속 → 노트북 표시 | < 3초 |
| 셀 실행 → 학생 화면 반영 | < 1초 |
| 50명 동시접속 시 CPU 사용률 | < 10% (선생님 PC) |

---

## 경쟁 제품 대비 차별점

| | Jupyter Live Share | VS Code Live Share | Google Colab | JupyterHub | nbviewer |
|---|---|---|---|---|---|
| .ipynb 네이티브 지원 | O | 부분 | O | O | O |
| 셀 출력 실시간 동기화 | O | X | X | O | X |
| 학생 설치 필요 | X | O (VS Code) | X | X | X |
| 별도 서버 필요 | X | X | X | O | X |
| 무료 50명 동시 | O | X (30명) | 해당없음 | O | 해당없음 |
| 실시간 편집 공유 | O | O | X | X | X |
| 오프라인 교실 사용 | O (LAN) | O | X | O | X |

---

## 리스크 및 대응

| 리스크 | 영향도 | 발생 가능성 | 대응 방안 |
|--------|--------|-------------|-----------|
| Cloudflare Quick Tunnel 불안정/정책변경 | 중 | 낮음 | localtunnel, ngrok 무료 Fallback 구현. LAN 내에서는 로컬 IP 직접 접속 지원 |
| VS Code Notebook API 변경 | 중 | 낮음 | API 버전 고정, 래퍼 계층으로 추상화 |
| 대용량 출력 (큰 DataFrame, 고해상도 이미지) | 중 | 높음 | 출력 크기 제한 (기본 5MB/셀), 이미지 리사이징, DataFrame은 상위 100행만 전송 후 "전체 보기" 옵션 |
| 학교 네트워크 방화벽 | 고 | 중간 | HTTPS 443 포트만 사용 (Cloudflare Tunnel), WebSocket fallback to HTTP long-polling |
| cloudflared 바이너리 다운로드 차단 | 중 | 낮음 | 수동 설치 가이드 제공, Extension 설정에서 경로 직접 지정 가능 |
| Windows Defender/방화벽 차단 | 중 | 중간 | 서버 시작 시 방화벽 예외 추가 안내, localhost만 바인딩 |

---

## 향후 확장 가능성

1. **LAN 모드**: cloudflared 없이 같은 네트워크 내 직접 접속 (오프라인 교실용)
2. **양방향 협업**: 학생이 코드를 제출하면 선생님 화면에 표시
3. **실시간 퀴즈**: 셀을 퀴즈로 전환하여 학생이 답변 제출
4. **세션 녹화/재생**: 수업 내용을 타임라인으로 저장 후 재생
5. **LMS 연동**: Canvas, Moodle 등과 URL 자동 공유
6. **다중 노트북**: 여러 .ipynb 파일을 탭으로 동시 공유
7. **VS Code Web Extension**: vscode.dev에서도 사용 가능하도록 확장

---

## 부록: 핵심 코드 스니펫

### A. 노트북 변경 감지 (올바른 API 사용)

```typescript
import * as vscode from 'vscode';

// 셀 내용 및 출력 변경 감지
vscode.workspace.onDidChangeNotebookDocument((event) => {
  // 셀 내용 변경 (타이핑)
  for (const change of event.cellChanges) {
    if (change.document) {
      // 셀 소스 코드가 변경됨
      const cellIndex = change.cell.index;
      const newSource = change.document.getText();
      debouncedBroadcast('cell:update', { index: cellIndex, source: newSource });
    }

    if (change.outputs) {
      // 셀 실행 결과가 변경됨
      const cellIndex = change.cell.index;
      const outputs = serializeOutputs(change.outputs);
      broadcast('cell:output', {
        index: cellIndex,
        outputs,
        executionOrder: change.cell.executionSummary?.executionOrder
      });
    }
  }

  // 셀 구조 변경 (추가/삭제)
  for (const change of event.contentChanges) {
    broadcast('cells:structure', {
      type: change.removedCells.length > 0 ? 'delete' : 'insert',
      index: change.range.start,
      removedCount: change.removedCells.length,
      addedCells: change.addedCells.map(serializeCell)
    });
  }
});
```

### B. 셀 출력 직렬화

```typescript
function serializeOutputs(outputs: readonly vscode.NotebookCellOutput[]): SerializedOutput[] {
  return outputs.map(output => ({
    items: output.items.map(item => {
      const mime = item.mime;
      let data: string;

      if (mime.startsWith('image/')) {
        // 이미지: base64 인코딩된 바이너리
        data = Buffer.from(item.data).toString('base64');
      } else {
        // 텍스트 계열: UTF-8 디코딩
        data = new TextDecoder().decode(item.data);
      }

      return { mime, data };
    })
  }));
}
```

### C. 활성 셀 추적

```typescript
// 선생님이 선택한 셀 변경 감지
vscode.window.onDidChangeNotebookEditorSelection((event) => {
  const editor = event.notebookEditor;
  const selections = event.selections;

  if (selections.length > 0) {
    const activeCellIndex = selections[0].start;
    throttledBroadcast('focus:cell', { cellIndex: activeCellIndex });
  }
});
```

### D. Cloudflare Tunnel 실행 (개선된 버전)

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

class TunnelManager {
  private process: ChildProcess | null = null;

  async start(port: number): Promise<string> {
    const cloudflaredPath = await this.ensureBinary();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Tunnel creation timed out (30s)'));
      }, 30000);

      this.process = spawn(cloudflaredPath, [
        'tunnel', '--url', `http://localhost:${port}`,
        '--no-autoupdate'
      ]);

      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });

      this.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  private async ensureBinary(): Promise<string> {
    // OS별 바이너리 경로 확인 및 자동 다운로드
    const platform = process.platform;
    const binName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const binPath = path.join(__dirname, '..', 'bin', binName);
    // ... 바이너리 존재 확인 및 다운로드 로직
    return binPath;
  }
}
```

### E. 브라우저 뷰어 렌더링 (핵심 부분)

```javascript
// viewer.js - 셀 렌더링
function renderCell(cell, container) {
  const cellEl = document.createElement('div');
  cellEl.className = `cell cell-${cell.kind}`;
  cellEl.dataset.index = cell.index;

  if (cell.kind === 'markup') {
    // Markdown 셀: marked.js + KaTeX
    cellEl.innerHTML = marked.parse(cell.source, {
      highlight: (code, lang) => hljs.highlight(code, { language: lang || 'text' }).value
    });
    // KaTeX로 수식 렌더링
    renderMathInElement(cellEl, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false }
      ]
    });
  } else {
    // 코드 셀
    const execLabel = cell.executionOrder ? `[${cell.executionOrder}]` : '[ ]';
    const sourceEl = document.createElement('div');
    sourceEl.className = 'cell-source';
    sourceEl.innerHTML = `<span class="exec-label">${execLabel}</span>`
      + `<pre><code class="language-python">${hljs.highlight(cell.source, { language: 'python' }).value}</code></pre>`;
    cellEl.appendChild(sourceEl);

    // 출력 렌더링
    if (cell.outputs && cell.outputs.length > 0) {
      const outputEl = renderOutputs(cell.outputs);
      cellEl.appendChild(outputEl);
    }
  }

  container.appendChild(cellEl);
}

function renderOutputs(outputs) {
  const container = document.createElement('div');
  container.className = 'cell-outputs';

  for (const output of outputs) {
    for (const item of output.items) {
      if (item.mime === 'text/html') {
        // DataFrame 등 HTML 출력
        const div = document.createElement('div');
        div.innerHTML = DOMPurify.sanitize(item.data);
        container.appendChild(div);
      } else if (item.mime.startsWith('image/')) {
        // 이미지 (matplotlib 그래프 등)
        const img = document.createElement('img');
        img.src = `data:${item.mime};base64,${item.data}`;
        container.appendChild(img);
      } else if (item.mime === 'text/plain') {
        // 텍스트 출력
        const pre = document.createElement('pre');
        pre.textContent = item.data;
        container.appendChild(pre);
      }
    }
  }

  return container;
}
```

---

## 부록: package.json 핵심 설정

```jsonc
{
  "name": "jupyter-live-share",
  "displayName": "Jupyter Live Share",
  "description": "Share Jupyter Notebooks in real-time with students via browser",
  "version": "0.1.0",
  "engines": {
    "vscode": "^1.82.0"
  },
  "categories": ["Education", "Notebooks"],
  "activationEvents": [
    "onNotebook:jupyter-notebook"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "jupyterLiveShare.startSession",
        "title": "Start Session",
        "category": "Jupyter Live Share"
      },
      {
        "command": "jupyterLiveShare.stopSession",
        "title": "Stop Session",
        "category": "Jupyter Live Share"
      }
    ],
    "configuration": {
      "title": "Jupyter Live Share",
      "properties": {
        "jupyterLiveShare.port": {
          "type": "number",
          "default": 3000,
          "description": "Local server port"
        },
        "jupyterLiveShare.maxViewers": {
          "type": "number",
          "default": 100,
          "description": "Maximum concurrent viewers"
        },
        "jupyterLiveShare.tunnelProvider": {
          "type": "string",
          "enum": ["cloudflare", "ngrok", "localtunnel", "none"],
          "default": "cloudflare",
          "description": "Tunnel provider for external access"
        }
      }
    },
    "viewsContainers": {
      "activitybar": [
        {
          "id": "jupyterLiveShare",
          "title": "Jupyter Live Share",
          "icon": "resources/icon.svg"
        }
      ]
    }
  },
  "dependencies": {
    "express": "^4.18.0",
    "ws": "^8.14.0"
  }
}
```
