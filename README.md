# Jupyter Live Share

선생님이 VS Code에서 열고 있는 파일을 학생들에게 브라우저로 실시간 공유하는 교육용 VS Code Extension입니다.

## 주요 기능

- **Jupyter Notebook 실시간 공유** (`.ipynb`): 셀 편집, 실행 결과, 셀 추가/삭제가 실시간 반영
- **텍스트 파일 공유** (`.py`, `.txt`, `.md` 등): 구문 하이라이팅 및 Markdown 렌더링 지원
- **선생님 커서 실시간 공유**: 노트북 및 텍스트 파일 모두에서 선생님의 커서 위치, 라인 하이라이트, 텍스트 선택 영역을 학생 화면에 실시간 표시
- **실시간 채팅**: 선생님은 VS Code 사이드바에서, 학생은 브라우저 또는 VS Code Viewer Chat 패널에서 메시지 교환 (스팸 방지 Rate Limiting)
- **선생님 메시지 강조**: 선생님 채팅 메시지는 초록색 배경으로 구분 표시 (사이드바, Viewer Chat, 브라우저 모두 적용)
- **실시간 설문조사 (Poll)**: 숫자 모드(1, 2, 3...) 및 텍스트 모드(사용자 정의 선택지) 지원, 실시간 막대 그래프 결과 표시 (1인 1표, 재투표 불가)
- **선생님 이름 설정**: 세션 시작 전 사이드바에서 표시 이름 변경 가능 (기본값: "Teacher")
- **Cloudflare Tunnel**: 별도 서버 없이 외부 HTTPS URL로 접속 가능
- **100명 동시 접속**: 교실 규모의 동시 접속자 지원 (설정으로 변경 가능)
- **다크/라이트 모드**: 뷰어에서 테마 전환 지원

## 동작 방식

```
[선생님 VS Code] → Extension → HTTP/WebSocket 서버 → Cloudflare Tunnel
                                                         ↓
                                        [학생 브라우저] ← HTTPS URL
```

1. 선생님이 VS Code에서 `Start Session` 실행
2. 로컬 서버(기본 포트 48632)가 시작되고 Cloudflare Tunnel로 외부 URL 생성
3. 학생들이 브라우저에서 해당 URL로 접속하고 이름을 입력
4. 선생님이 파일을 편집하면 WebSocket을 통해 실시간 전송
5. 채팅과 설문조사로 양방향 소통

## 설치

### VSIX 파일로 설치 (권장)

```bash
code --install-extension jupyter-live-share-2.0.0.vsix
```

또는 VS Code → Extensions → `...` → "Install from VSIX..." 에서 `.vsix` 파일 선택

### 마켓플레이스에서 설치

> 마켓플레이스 게시 후 사용 가능

VS Code Extensions에서 "Jupyter Live Share" 검색 후 설치

## 사용 방법

### 세션 시작

1. VS Code에서 `.ipynb`, `.py`, `.md`, `.txt` 등 파일 열기
2. 왼쪽 사이드바의 **Jupyter Live Share** 패널에서 표시 이름 입력 (기본값: "Teacher")
3. **Start Session** 클릭
   - 또는 `Ctrl+Shift+P` → `Jupyter Live Share: Start Session`
4. 상태바에 표시되는 URL을 학생들에게 공유 (자동으로 클립보드에 복사됨)
5. 사이드바에 세션 정보(URL, 파일명, 접속자 수) + 채팅 패널이 표시됨
6. 파일을 아직 열지 않은 상태에서도 세션 시작 가능 (학생에게 빈 화면 표시, 이후 파일 열면 자동 공유)

### 세션 종료

- 사이드바의 **Stop Session** 버튼 클릭
- 또는 `Ctrl+Shift+P` → `Jupyter Live Share: Stop Session`

### 실시간 채팅

**선생님 (VS Code):**
- 세션 시작 시 사이드바 하단에 채팅 영역이 자동으로 표시됨
- 사이드바에서 메시지 입력 및 전송
- 세션 시작 전 설정한 표시 이름(기본: "Teacher")으로 자동 설정 (접속자 수에 포함되지 않음)
- 선생님 닉네임은 초록색, 학생 닉네임은 파란색으로 구분 표시
- 선생님 메시지는 초록색 배경으로 강조 표시

**학생 (브라우저 뷰어):**
- 뷰어 하단의 **Chat** 버튼을 클릭하면 오른쪽에 채팅 패널이 열림
- 접속 시 이름을 입력해야 채팅 가능 (localStorage에 저장되어 재접속 시 자동 입력)

**학생 (VS Code Open Viewer):**
- VS Code 하단 터미널 영역의 **Viewer Chat** 패널에서 채팅
- Open Viewer 사용 시 뷰어 패널의 채팅은 숨겨지고, 별도 패널로 분리됨
- 별도의 chatOnly WebSocket으로 접속자 수에 포함되지 않음

**공통:**
- 설문 시작/종료 시 채팅에 시스템 메시지가 자동 표시 (결과 포함)
- 스팸 방지: 학생은 10초당 5개, 최소 500ms 간격으로 메시지 전송 제한 (선생님은 제한 없음)
- 메시지 최대 500자

### 실시간 설문조사 (Poll)

선생님이 학생들에게 실시간으로 설문을 진행할 수 있습니다.

**설문 모드:**
- **숫자 모드**: 선택지를 숫자(1, 2, 3...)로 표시 (기본값, 2~10개)
- **텍스트 모드**: 사용자가 직접 선택지 레이블을 입력 (예: "찬성", "반대", "모르겠음")

**VS Code 사이드바에서 설문 시작 (권장):**
1. 왼쪽 사이드바의 Jupyter Live Share 패널에서 **Create Poll** 클릭
2. 질문 입력 → 모드 선택(Number/Text) → 선택지 설정
   - Number 모드: 선택지 수(2~10) 선택
   - Text 모드: 한 줄에 하나씩 선택지 입력
3. 학생 브라우저에 설문 배너가 나타나고, 채팅에 시스템 메시지 표시

**VS Code Command Palette에서 설문 시작:**
1. `Ctrl+Shift+P` → `Jupyter Live Share: Create Poll`
2. 질문 입력 → 선택지 수(2~5) 선택 (숫자 모드만 지원)

**브라우저에서 설문 시작 (선생님, localhost 접속 시):**
1. 뷰어 하단의 **Poll** 버튼 클릭
2. 질문 입력 → 모드 선택(Number/Text) → 선택지 설정 → Start Poll

**설문 종료:**
- VS Code 사이드바: **End Poll** 클릭
- VS Code Command Palette: `Ctrl+Shift+P` → `Jupyter Live Share: End Poll`
- 브라우저: 하단의 **End Poll** 버튼 클릭
- 종료 시 채팅에 최종 투표 결과가 시스템 메시지로 표시

**학생 투표:**
- 설문이 시작되면 상단에 설문 배너 표시
- 숫자 모드: 번호 버튼(1~10)을 클릭하여 투표
- 텍스트 모드: 선생님이 입력한 레이블 버튼을 클릭하여 투표
- 1인 1표: 한 번 투표하면 재투표 불가 (버튼 비활성화)
- 투표 결과가 막대 그래프로 실시간 업데이트 (텍스트 모드 시 레이블 표시)

## 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `jupyterLiveShare.port` | `48632` | 로컬 서버 포트 |
| `jupyterLiveShare.maxViewers` | `100` | 최대 동시 접속자 수 |
| `jupyterLiveShare.tunnelProvider` | `cloudflare` | 터널 제공자 (`cloudflare` 또는 `none`) |

## 지원 파일 형식

| 파일 형식 | 공유 모드 | 렌더링 |
|-----------|----------|--------|
| `.ipynb` | notebook | 셀 기반 (Markdown + 코드 + 출력) |
| `.py` | plaintext | Python 구문 하이라이팅 |
| `.md` | plaintext | Markdown 렌더링 (커서 활성 시 원본 텍스트, idle 시 렌더링) |
| `.txt` | plaintext | 일반 텍스트 |
| `.js`, `.ts` 등 | plaintext | 구문 하이라이팅 |

## 시스템 요구사항

- **VS Code**: 1.82.0 이상
- **Node.js**: 18.x 이상 (Extension 내장)
- **OS**: Windows 10/11
- **브라우저** (학생): Chrome, Firefox, Edge, 모바일 Chrome

## 프로젝트 구조

```
jupyter-live-share/
├── src/
│   ├── extension.ts          # Extension 진입점
│   ├── server/               # HTTP + WebSocket 서버
│   ├── notebook/             # 노트북 변경 감지 + 직렬화
│   ├── ui/                   # StatusBar, Sidebar, Viewer Chat, ViewerPanel, Commands
│   └── utils/                # 설정, 로깅
├── viewer/                   # 브라우저 뷰어 (Vanilla JS)
├── bin/                      # cloudflared 바이너리
└── test/                     # 테스트 코드
```

## 테스트 방법

### 사전 준비

```bash
cd jupyter-live-share
npm install
npm run build
```

1. VS Code에서 `jupyter-live-share` 폴더를 열고 `F5`로 **Extension Development Host** 실행
2. 새로 열린 창에서 테스트 진행

### 브라우저 뷰어 테스트

1. Development Host 창에서 `.ipynb` 파일 열기
2. `Ctrl+Shift+P` → **"Jupyter Live Share: Start Session"**
3. 브라우저에서 `http://localhost:48632` 접속
4. 이름 입력 후 Join (localhost 접속 시 자동으로 Teacher로 진입)
5. 확인:

| 테스트 | 호스트 동작 | 뷰어 확인 |
|--------|-----------|----------|
| 셀 편집 | 코드 셀에 타이핑 | 실시간 텍스트 반영 |
| 셀 실행 | `Ctrl+Enter` | 출력 결과 표시 |
| 셀 추가/삭제 | 셀 추가 또는 삭제 | 구조 변경 반영 |
| 포커스 이동 | 다른 셀 클릭 | 활성 셀 하이라이트 이동 |
| 마크다운 | 마크다운 셀 편집 | Markdown 렌더링 |
| 수식 | `$E=mc^2$` 입력 | KaTeX 수식 렌더링 |

### 채팅 테스트

1. 브라우저에서 `http://localhost:48632` 접속 (학생 역할)
2. 이름 입력 후 Join
3. 확인:

| 테스트 | 동작 | 확인 |
|--------|------|------|
| 사이드바 채팅 | VS Code 사이드바에서 메시지 입력 | 브라우저에 선생님 메시지 표시 (초록색 배경) |
| 학생→사이드바 | 브라우저에서 메시지 전송 | VS Code 사이드바에 학생 메시지 표시 (파란색 닉네임) |
| 브라우저 채팅 | Chat 버튼 클릭 | 오른쪽에 채팅 패널 슬라이드 |
| 닉네임 색상 | 선생님/학생 메시지 전송 | 선생님=초록색, 학생=파란색 |
| 메시지 배경 | 선생님 메시지 확인 | 선생님 메시지는 초록색 배경으로 강조 |
| Rate Limit | 학생 탭에서 빠르게 연속 전송 | 에러 메시지 표시 |
| 접속자 수 | 사이드바 Viewers 확인 | Teacher Panel은 접속자 수에 미포함 |

### 설문조사 테스트

1. 위 채팅 테스트와 같은 환경에서 진행
2. 확인:

| 테스트 | 동작 | 확인 |
|--------|------|------|
| 숫자 모드 설문 | 사이드바에서 Number 모드로 설문 생성 | 번호 버튼(1~10) 표시 |
| 텍스트 모드 설문 | 사이드바에서 Text 모드로 설문 생성 | 사용자 정의 레이블 버튼 표시 |
| VS Code 설문 | Command Palette → "Create Poll" | 양쪽 브라우저에 설문 배너 표시 |
| 브라우저 설문 | 선생님 탭에서 Poll 버튼 → 모드 선택 → Start | 양쪽에 설문 배너 표시 |
| 투표 | 학생 탭에서 버튼 클릭 | 실시간 막대 그래프 업데이트 (레이블 포함) |
| 중복 투표 방지 | 학생 탭에서 다시 투표 시도 | 버튼 비활성화, 재투표 불가 |
| 설문 종료 | End Poll 버튼, 사이드바, 또는 Command Palette | 채팅에 최종 결과 표시 |
| 사이드바 상태 | 설문 시작/종료 | Create Poll / End Poll 버튼 토글 |
| 재접속 동기화 | 설문 진행 중 학생 탭 새로고침 | 설문 상태 유지 |

### VS Code WebView 뷰어 테스트

학생이 VS Code 내부에서 공유 화면을 보는 기능입니다.

**Step 1: 호스트 시작**

1. Development Host에서 `.ipynb` 파일 열기
2. `Ctrl+Shift+P` → **"Start Session"** → 상태바에 `Live Share: 0명` 확인

**Step 2: WebView 뷰어 열기**

1. `Ctrl+Shift+P` → **"Jupyter Live Share: Open Viewer"**
2. URL 입력: `http://localhost:48632` (로컬) 또는 `https://xxx.trycloudflare.com` (외부)
3. VS Code 옆 탭에 뷰어 패널이 열림

**Step 3: 확인**

| 항목 | 예상 결과 |
|------|----------|
| 패널 | "Live Share Viewer" 탭이 열림 |
| 연결 | "Connecting..." → 이름 입력 (또는 Teacher 자동 진입) |
| 렌더링 | 셀, 코드, 출력이 정상 표시 |
| 접속자 수 | 호스트 상태바가 `1명`으로 증가 |
| 실시간 편집 | 호스트 타이핑 → 뷰어 반영 |
| 셀 실행 | 호스트 실행 → 출력 표시 |
| 테마 | ☀️ 버튼으로 다크/라이트 전환 |
| 채팅 | 하단 Viewer Chat 패널에서 채팅 (뷰어 내 Chat 버튼 숨김) |
| 설문 투표 | Viewer Chat 패널에서 설문 카드 투표 가능 |
| 재연결 | Open Viewer 재실행 → 기존 패널에서 새 URL 연결 |

**Step 4: 파일 전환 테스트**

1. 호스트가 `.ipynb` → `.py` 파일로 전환 → 뷰어에서 코드 문서 전환 확인
2. `.py` 편집 → 실시간 반영 확인
3. 다시 `.ipynb` 탭 → 뷰어 노트북으로 복귀

### 다른 PC에서 테스트 (Cloudflare Tunnel)

1. 호스트: **"Start Session"** → Tunnel URL 생성 (예: `https://xxx.trycloudflare.com`)
2. 학생 PC: 브라우저에서 해당 URL 접속, 또는
3. 학생 PC VS Code: **"Open Viewer"** → URL 입력

> Cloudflare Quick Tunnel URL은 세션마다 변경됩니다.

### 부하 테스트

```bash
node test/load/load-test.js --url ws://localhost:48632 --clients 50
```

### 문제 해결

- **WebView 화면 비어있음**: `Ctrl+Shift+I` → Console에서 CSP 에러 확인, `npm run build` 재실행
- **연결 안 됨**: 호스트 세션 실행 중인지, URL이 올바른지 확인
- **"Connecting..."에서 멈춤**: 세션 재시작 또는 Tunnel URL 만료 확인

## 개발

```bash
npm install        # 의존성 설치
npm run compile    # 개발 빌드
npm run build      # 프로덕션 빌드
npm run watch      # 감시 모드
npm run lint       # 린트
vsce package       # VSIX 패키징
```

## 관련 문서

- [docs/PUBLISHING.md](docs/PUBLISHING.md) - Extension 배포 방법 (VSIX 직접 배포, Open VSX, GitHub Releases)
- [docs/PRD.md](docs/PRD.md) - 제품 요구사항 문서 (PRD)
- [docs/vscode-badge-workaround.md](docs/vscode-badge-workaround.md) - VS Code WebviewView.badge 초기화 버그 워크어라운드

## 변경 이력

### v2.0.0

**파일 전환 안정성 대폭 개선**

- 노트북↔텍스트 파일 전환 시 발생하던 race condition 완전 해결
- `switchToNotebook()` / `switchToTextDocument()` 함수 도입: 모드 전환 시 이전 핸들러 완전 정리 후 새 핸들러 등록
- `flushAndResetState()`: 파일 전환 시 모든 pending 타이머, 커서 상태, 소스 캐시를 일괄 초기화
- idle 모드에서 파일을 열 때도 기존 뷰어에게 즉시 브로드캐스트

**채팅 선생님 메시지 판별 수정 (Cloudflare Tunnel)**

- `isTeacher` 판별을 `meta.isTeacher` (IP 기반)에서 `meta.isTeacherPanel` (연결 타입 기반)으로 변경
- Cloudflare Tunnel 사용 시에도 선생님 메시지가 정확히 초록색으로 표시됨

**사이드바 뱃지 초기화 버그 수정**

- VS Code API 버그 대응: `badge = undefined` 대신 `{ value: 0, tooltip: '' }` 사용 ([microsoft/vscode#162900](https://github.com/microsoft/vscode/issues/162900))
- `onDidChangeVisibility` + 1초 폴링 + `mousedown`/`focusin`/`visibilitychange`/`focus` 이벤트로 확실한 뱃지 초기화
- 사이드바와 Viewer Chat 패널 모두 적용

**브라우저 선생님 메시지 배경색 수정**

- `color-mix()` CSS 함수에서 명시적 색상값으로 변경 (브라우저 호환성 개선)
- 다크/라이트 모드 모두 안정적인 초록색 배경 표시

**텍스트 파일 선택 영역 렌더링 수정**

- `.txt`, `.md` 파일에서 드래그 선택 시 선택 영역이 좁게 표시되던 문제 수정
- `codeEl.style.display = 'block'`으로 전체 너비 사용 보장

**모드 인식 커서 이벤트 처리**

- `cursor:position` 이벤트에 `mode` 필드 기반 분기 추가 (plaintext vs notebook)
- `cell:update`, `cell:output`, `cells:structure` 이벤트에 `documentType` 가드 추가
- 파일 전환 직후 이전 모드의 잔여 이벤트가 현재 뷰를 깨뜨리지 않도록 방지

**기술 문서**

- `docs/vscode-badge-workaround.md`: VS Code badge API 버그 및 워크어라운드 문서화

### v1.2.0

**VS Code Viewer 채팅 분리**

- Open Viewer 사용 시 채팅이 메인 뷰어 패널에서 분리되어 터미널 영역의 **Viewer Chat** 패널로 이동
- `viewsContainers.panel`을 통해 VS Code 하단 패널(터미널 탭 영역)에 Viewer Chat 탭 등록
- 별도의 `chatOnly` WebSocket 연결로 접속자 수에 포함되지 않음
- PIN 인증, 이름 설정, 설문 투표 등 기존 기능 모두 지원
- 브라우저 뷰어는 기존과 동일하게 동작 (변경 없음)

**Live Chat 패널 제거**

- 터미널 영역의 Live Chat 패널을 제거 — 선생님은 왼쪽 사이드바에서만 채팅
- `ChatPanelProvider` 및 관련 코드 완전 삭제

**선생님 메시지 강조**

- 선생님 채팅 메시지에 초록색 배경 적용 (사이드바, Viewer Chat, 브라우저 뷰어 모두)
- `chatOnly` (VS Code 학생) 연결은 localhost여도 `isTeacher=false`로 정확히 구분
- 다크/라이트 모드 모두 지원

**파일 없이 세션 시작 가능**

- 파일을 열지 않은 상태에서도 세션 시작 가능 (학생에게 빈 화면 표시)
- 이후 파일을 열면 자동으로 공유 시작

**Viewer Chat 안읽은 메시지 뱃지**

- Viewer Chat 패널이 보이지 않을 때 새 메시지가 오면 탭에 숫자 뱃지 표시
- 패널을 열면 뱃지 자동 초기화

**설문 시작 시 Viewer Chat 자동 표시**

- 설문이 시작되면 Viewer Chat 패널이 자동으로 열림 (학생이 즉시 투표 가능)

**설문 카드 UI 개선**

- Viewer Chat 패널의 설문 카드가 메시지와 동일한 너비/위치로 정렬

**사이드바 채팅 뱃지**

- 사이드바가 열려있지 않을 때 학생 채팅 메시지가 오면 왼쪽 아이콘에 숫자 뱃지 표시
- 사이드바를 열면 뱃지 자동 초기화

**Markdown 파일 원본/렌더링 전환**

- `.md` 파일 공유 시, 선생님 커서가 활성화되면 원본 텍스트 + 구문 하이라이팅으로 전환
- 커서가 2초간 비활성화되면 Markdown 렌더링 모드로 자동 복귀 (스크롤 위치 보존)

### v1.1.0

**선생님 표시 이름 설정**

- 세션 시작 전 사이드바에서 "Display Name" 입력 가능 (기본값: "Teacher")
- 설정된 이름이 채팅 닉네임 및 커서 라벨에 적용

**채팅 닉네임 색상 구분**

- 선생님 닉네임: 초록색 (#2ea043 / 다크모드 #3fb950)
- 학생 닉네임: 파란색 (기존 accent 색상)
- VS Code 사이드바, Live Chat 패널, 브라우저 뷰어 모두 동일 적용

**텍스트 모드 설문조사**

- 기존 숫자 모드(1, 2, 3...) 외에 텍스트 모드 추가
- 선생님이 직접 선택지 레이블 입력 (예: "찬성", "반대", "모르겠음")
- 사이드바, 브라우저 뷰어, Live Chat 패널 모두에서 레이블 표시
- 결과 막대 그래프에 레이블 + 퍼센트 표시
- 최대 선택지 수 확장 (5 → 10)

### v1.0.0

**선생님 커서 공유 — 모든 파일 유형 지원**

- 텍스트 파일(.py, .txt, .md 등)에서 선생님 커서 위치, 라인 하이라이트, 텍스트 선택 영역을 학생 뷰어에 실시간 표시
- 커서 기반 스크롤 동기화: 선생님 커서가 이동하면 학생 화면이 자동으로 해당 위치로 스크롤 (이미 보이면 스크롤 생략)
- 커서 스크롤 우선순위: 커서 이동 후 300ms간 viewport 스크롤 무시 (커서 우선, 뷰포트 보조)
- Markdown 파일: 렌더된 HTML에서 `data-line` 기반 가장 가까운 요소로 스크롤

**코드 하이라이팅 플리커 제거**

- `hljs.highlight()` API를 사용한 atomic update로 textContent→highlightElement 2단계 플리커 제거
- 200줄 이상 대형 셀은 debounced fallback (커서 오버레이 보존)
- debouncedHighlight에서 커서 오버레이 detach/reattach 패턴 적용

**마지막 글자 누락 방지**

- 커서 throttle에 trailing edge 패턴 적용: 마지막 이벤트가 반드시 전송됨
- stopWatching() 시 pending debounce 타이머를 flush하여 최종 상태 전송

**커서 점프 방지**

- 활성 셀만 cursor:position 이벤트 처리 (background LSP/formatter 이벤트 무시)

**UI 개선**

- 커서 바: 2px, 발광 효과 제거, 부드러운 on/off 깜빡임 (1.2s)
- "선생님" 라벨: 커서 위쪽 말풍선형 배치
- 라인 하이라이트: 왼쪽 파란 border 제거, 은은한 배경만
- 선택 영역: 파란색 계열로 통일
- 편집 셀 강조: 얇은 테두리, 느린 펄스

### v0.2.0

- 실시간 동기화 응답성 개선 (디바운스 최적화)
- 출력 중복 제거 및 코드 정리

### v0.1.9

- 스크롤 동기화 개선 및 viewport indicator 수정

### v0.1.8

- viewport 동기화 추가, 코드/출력 시각적 구분 개선

### v0.1.7

- 선생님 커서 공유 기능 추가 (노트북 전용), 주요 버그 수정

### v0.1.6

- cloudflared 바이너리 번들링, 주요 버그 수정

## 라이선스

MIT
