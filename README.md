# Jupyter Live Share

선생님이 VS Code에서 열고 있는 파일을 학생들에게 브라우저로 실시간 공유하는 교육용 VS Code Extension입니다.

## 주요 기능

- **Jupyter Notebook 실시간 공유** (`.ipynb`): 셀 편집, 실행 결과, 셀 추가/삭제가 실시간 반영
- **텍스트 파일 공유** (`.py`, `.txt`, `.md` 등): 구문 하이라이팅 및 Markdown 렌더링 지원
- **실시간 채팅**: 선생님과 학생 간 메시지 교환 (스팸 방지 Rate Limiting)
- **실시간 설문조사 (Poll)**: 질문 + 2~5개 선택지, 실시간 막대 그래프 결과 표시
- **Cloudflare Tunnel**: 별도 서버 없이 외부 HTTPS URL로 접속 가능
- **50명 동시 접속**: 교실 규모의 동시 접속자 지원
- **다크/라이트 모드**: 뷰어에서 테마 전환 지원

## 동작 방식

```
[선생님 VS Code] → Extension → HTTP/WebSocket 서버 → Cloudflare Tunnel
                                                         ↓
                                        [학생 브라우저] ← HTTPS URL
```

1. 선생님이 VS Code에서 `Start Session` 실행
2. 로컬 서버(기본 포트 3000)가 시작되고 Cloudflare Tunnel로 외부 URL 생성
3. 학생들이 브라우저에서 해당 URL로 접속하고 이름을 입력
4. 선생님이 파일을 편집하면 WebSocket을 통해 실시간 전송
5. 채팅과 설문조사로 양방향 소통

## 설치

### VSIX 파일로 설치 (권장)

```bash
code --install-extension jupyter-live-share-0.1.0.vsix
```

또는 VS Code → Extensions → `...` → "Install from VSIX..." 에서 `.vsix` 파일 선택

### 마켓플레이스에서 설치

> 마켓플레이스 게시 후 사용 가능

VS Code Extensions에서 "Jupyter Live Share" 검색 후 설치

## 사용 방법

### 세션 시작

1. VS Code에서 `.ipynb`, `.py`, `.md`, `.txt` 등 파일 열기
2. `Ctrl+Shift+P` → `Jupyter Live Share: Start Session`
3. 상태바에 표시되는 URL을 학생들에게 공유 (자동으로 클립보드에 복사됨)

### 세션 종료

- `Ctrl+Shift+P` → `Jupyter Live Share: Stop Session`
- 또는 상태바의 Jupyter Live Share 아이콘 클릭

### 실시간 채팅

학생과 선생님 모두 브라우저 뷰어에서 채팅을 사용할 수 있습니다.

- 뷰어 하단의 **Chat** 버튼을 클릭하면 오른쪽에 채팅 패널이 열림
- 학생은 접속 시 이름을 입력해야 채팅 가능 (localStorage에 저장되어 재접속 시 자동 입력)
- 선생님(localhost 접속)은 자동으로 "Teacher"로 표시
- 설문 시작/종료 시 채팅에 시스템 메시지가 자동 표시 (결과 포함)
- 스팸 방지: 학생은 10초당 5개, 최소 500ms 간격으로 메시지 전송 제한
- 메시지 최대 500자

### 실시간 설문조사 (Poll)

선생님이 학생들에게 실시간으로 설문을 진행할 수 있습니다.

**VS Code 사이드바에서 설문 시작 (권장):**
1. 왼쪽 사이드바의 Jupyter Live Share 패널에서 **Create Poll** 클릭
2. 질문 입력 → 선택지 수(2~5) 선택
3. 학생 브라우저에 설문 배너가 나타나고, 채팅에 시스템 메시지 표시

**VS Code Command Palette에서 설문 시작:**
1. `Ctrl+Shift+P` → `Jupyter Live Share: Create Poll`
2. 질문 입력 → 선택지 수(2~5) 선택

**브라우저에서 설문 시작 (선생님, localhost 접속 시):**
1. 뷰어 하단의 **Poll** 버튼 클릭
2. 질문 입력 → 선택지 수 선택 → Start Poll

**설문 종료:**
- VS Code 사이드바: **End Poll** 클릭
- VS Code Command Palette: `Ctrl+Shift+P` → `Jupyter Live Share: End Poll`
- 브라우저: 하단의 **End Poll** 버튼 클릭
- 종료 시 채팅에 최종 투표 결과가 시스템 메시지로 표시

**학생 투표:**
- 설문이 시작되면 상단에 설문 배너 표시
- 번호 버튼(1~5)을 클릭하여 투표 (1인 1표)
- 투표 결과가 막대 그래프로 실시간 업데이트

## 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `jupyterLiveShare.port` | `3000` | 로컬 서버 포트 |
| `jupyterLiveShare.maxViewers` | `100` | 최대 동시 접속자 수 |
| `jupyterLiveShare.tunnelProvider` | `cloudflare` | 터널 제공자 (`cloudflare` 또는 `none`) |

## 지원 파일 형식

| 파일 형식 | 공유 모드 | 렌더링 |
|-----------|----------|--------|
| `.ipynb` | notebook | 셀 기반 (Markdown + 코드 + 출력) |
| `.py` | plaintext | Python 구문 하이라이팅 |
| `.md` | plaintext | Markdown 렌더링 |
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
│   ├── ui/                   # StatusBar, Sidebar, Commands
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
3. 브라우저에서 `http://localhost:3000` 접속
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

1. 브라우저 2개 탭 열기 (탭 1: `http://localhost:3000` = 선생님, 탭 2: 시크릿 창으로 접속 = 학생)
2. 학생 탭에서 이름 입력 후 Join
3. 확인:

| 테스트 | 동작 | 확인 |
|--------|------|------|
| 채팅 패널 | Chat 버튼 클릭 | 오른쪽에 채팅 패널 슬라이드 |
| 메시지 전송 | 메시지 입력 후 Send | 양쪽 탭에서 메시지 표시 |
| 닉네임 표시 | 선생님/학생 메시지 전송 | 닉네임 + 시간 표시 |
| Rate Limit | 학생 탭에서 빠르게 연속 전송 | 에러 메시지 표시 |
| 읽지 않은 알림 | 채팅 패널 닫은 상태에서 메시지 수신 | Chat 버튼에 빨간 뱃지 |

### 설문조사 테스트

1. 위 채팅 테스트와 같은 환경에서 진행
2. 확인:

| 테스트 | 동작 | 확인 |
|--------|------|------|
| 사이드바 설문 | 사이드바에서 "Create Poll" 클릭 | 양쪽 브라우저에 설문 배너 + 채팅 시스템 메시지 |
| VS Code 설문 | Command Palette → "Create Poll" | 양쪽 브라우저에 설문 배너 표시 |
| 브라우저 설문 | 선생님 탭에서 Poll 버튼 → 질문 입력 → Start | 양쪽에 설문 배너 표시 |
| 투표 | 학생 탭에서 번호 버튼 클릭 | 실시간 막대 그래프 업데이트 |
| 중복 투표 방지 | 학생 탭에서 다시 투표 시도 | 버튼 비활성화, 투표 불가 |
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
2. URL 입력: `http://localhost:3000` (로컬) 또는 `https://xxx.trycloudflare.com` (외부)
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
| 채팅 | Chat 버튼 클릭 → 채팅 패널 열림 |
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
node test/load/load-test.js --url ws://localhost:3000 --clients 50
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

- [DEPLOYMENT.md](DEPLOYMENT.md) - 배포 가이드 (VSIX 패키징, Marketplace, 교실 대량 배포)
- [PUBLISHING.md](PUBLISHING.md) - Extension 배포 방법 (VSIX 직접 배포, Open VSX, GitHub Releases)

## 라이선스

MIT
