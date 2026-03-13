# Jupyter Live Share

선생님이 VS Code에서 열고 있는 파일을 학생들에게 브라우저로 실시간 공유하는 교육용 VS Code Extension입니다.

> **설치 및 사용법 가이드:** [Notion 문서 바로가기](https://www.notion.so/Jupyter-Live-Share-2fdfceb573c381e78170c6808dad708a)

## 주요 기능

- **Jupyter Notebook 실시간 공유** (`.ipynb`): 셀 편집, 실행 결과, 셀 추가/삭제가 실시간 반영
- **텍스트 파일 공유** (`.py`, `.txt`, `.md` 등): 구문 하이라이팅 및 Markdown 렌더링 지원
- **선생님 커서 실시간 공유**: 노트북 및 텍스트 파일 모두에서 선생님의 커서 위치, 라인 하이라이트, 텍스트 선택 영역을 학생 화면에 실시간 표시
- **실시간 채팅**: 선생님은 VS Code 사이드바에서, 학생은 브라우저 또는 VS Code Viewer Chat 패널에서 메시지 교환 (스팸 방지 Rate Limiting)
- **선생님 메시지 강조**: 선생님 채팅 메시지는 초록색 배경으로 구분 표시 (사이드바, Viewer Chat, 브라우저 모두 적용)
- **실시간 설문조사 (Poll)**: 숫자 모드(1, 2, 3...) 및 텍스트 모드(사용자 정의 선택지) 지원, 실시간 막대 그래프 결과 표시 (1인 1표, 재투표 불가)
- **선생님 이름 설정**: 세션 시작 전 사이드바에서 표시 이름 변경 가능 (기본값: "Teacher")
- **실시간 판서 (Drawing/Annotation)**: Teacher Preview 패널에서 펜/형광펜/지우개로 노트북 위에 판서, 학생 화면에 실시간 공유
- **Teacher Preview 패널**: VS Code 내에서 학생이 보는 화면을 미리보기 (판서 도구 포함)
- **스크롤 동기화**: 선생님의 스크롤 위치를 Cell-relative Anchor 방식으로 학생 화면에 정확히 동기화
- **로컬 이미지 공유**: 마크다운/HTML 내 로컬 이미지를 자동으로 base64 변환하여 학생에게 전송
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

VS Code Extensions (`Ctrl+Shift+X`)에서 **Jupyter Live Share** 검색 후 설치

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

## Cloudflare Tunnel 안내

이 익스텐션은 외부 접속을 위해 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`)을 사용합니다. 첫 세션 시작 시 Cloudflare의 공식 GitHub 릴리스에서 바이너리를 자동 다운로드하며, 이후에는 재다운로드 없이 사용됩니다.

## 라이선스

MIT
