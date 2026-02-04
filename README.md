# Jupyter Live Share

선생님이 VS Code에서 열고 있는 파일을 학생들에게 브라우저로 실시간 공유하는 교육용 VS Code Extension입니다.

## 주요 기능

- **Jupyter Notebook 실시간 공유** (`.ipynb`): 셀 편집, 실행 결과, 셀 추가/삭제가 실시간 반영
- **텍스트 파일 공유** (`.py`, `.txt`, `.md` 등): 구문 하이라이팅 및 Markdown 렌더링 지원
- **Cloudflare Tunnel**: 별도 서버 없이 외부 HTTPS URL로 접속 가능
- **PIN 접속 제한**: 4자리 PIN으로 접속 제한 설정 가능
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
3. 학생들이 브라우저에서 해당 URL로 접속
4. 선생님이 파일을 편집하면 WebSocket을 통해 실시간 전송

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
3. 상태바에 표시되는 URL을 학생들에게 공유

### 세션 종료

- `Ctrl+Shift+P` → `Jupyter Live Share: Stop Session`
- 또는 상태바의 Jupyter Live Share 아이콘 클릭

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

## 개발

```bash
# 의존성 설치
npm install

# 개발 빌드
npm run compile

# 프로덕션 빌드
npm run build

# 감시 모드
npm run watch

# 린트
npm run lint

# VSIX 패키징
vsce package
```

## 라이선스

MIT
