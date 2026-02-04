# Jupyter Live Share Extension - 테스트 가이드

## 목차

1. [테스트 개요](#테스트-개요)
2. [뷰어 단독 테스트 (test-viewer.js)](#뷰어-단독-테스트)
3. [Extension 통합 테스트 (F5 실행)](#extension-통합-테스트)
4. [부하 테스트 (50명 동시 접속)](#부하-테스트)
5. [Cloudflare Tunnel 테스트](#cloudflare-tunnel-테스트)
6. [테스트 체크리스트](#테스트-체크리스트)

---

## 테스트 개요

### 테스트 종류

| 종류 | 도구 | 용도 | VS Code 필요 |
|------|------|------|:------------:|
| 뷰어 단독 테스트 | `test-viewer.js` | 브라우저 렌더링 검증 | X |
| Extension 통합 테스트 | F5 (Extension Dev Host) | 전체 기능 검증 | O |
| 부하 테스트 | `load-test.js` | 50명 동시 접속 | X |
| Tunnel 테스트 | cloudflared | 외부 접속 검증 | O |

### 지원 파일 형식

| 파일 형식 | WebSocket 이벤트 | 렌더링 방식 |
|-----------|-----------------|------------|
| `.ipynb` | `notebook:full`, `cell:update`, `cell:output` | 셀 기반 (Markdown + 코드 + 출력) |
| `.py` | `document:full`, `document:update` | Python 구문 하이라이팅 |
| `.md` | `document:full`, `document:update` | Markdown 렌더링 + KaTeX 수식 |
| `.txt` | `document:full`, `document:update` | 일반 텍스트 (`<pre>`) |
| 기타 코드 | `document:full`, `document:update` | 언어별 구문 하이라이팅 |

---

## 뷰어 단독 테스트

VS Code 없이 브라우저 뷰어만 독립적으로 테스트합니다. 4가지 파일 형식의 렌더링을 빠르게 확인할 수 있습니다.

### 사전 준비

```bash
cd jupyter-live-share
npm install
```

### 실행 방법

```bash
node test/manual/test-viewer.js
```

서버가 시작되면 다음 메시지가 표시됩니다:

```
========================================
  Test Server Running on port 3456
  Open: http://localhost:3456
========================================

Test scenarios (auto-rotate every 8s):
  1. notebook:full  - test_statistics.ipynb
  2. document:full  - example.py (Python)
  3. document:full  - README.md (Markdown)
  4. document:full  - notes.txt (Plain text)
```

### 테스트 절차

1. **브라우저에서 `http://localhost:3456` 접속**
2. 자동으로 WebSocket 연결 및 `join` 메시지 전송
3. 첫 번째 시나리오 (notebook) 표시

#### 시나리오 1: 노트북 (.ipynb) - 0~8초

확인 항목:
- [ ] 파일명 `test_statistics.ipynb` 헤더에 표시
- [ ] Markdown 셀: 제목, 수식 ($\bar{x} = \frac{1}{n}\sum x_i$) 렌더링
- [ ] 코드 셀: Python 구문 하이라이팅
- [ ] 출력: `평균: 46.57` 텍스트 표시
- [ ] 활성 셀 하이라이트 (파란색 왼쪽 테두리)
- [ ] 실행 순서 번호 [1], [2] 표시
- [ ] 4초 후 `cell:update` 시뮬레이션 → 셀 내용 자동 갱신

#### 시나리오 2: Python (.py) - 8~16초

확인 항목:
- [ ] 파일명 `example.py` 헤더에 표시
- [ ] "PYTHON" 파일 타입 뱃지 표시
- [ ] `import numpy as np` 등 구문 하이라이팅
- [ ] 주석, 문자열, 키워드 색상 구분
- [ ] 12초 후 `document:update` 시뮬레이션 → 코드 추가 반영

#### 시나리오 3: Markdown (.md) - 16~24초

확인 항목:
- [ ] 파일명 `README.md` 헤더에 표시
- [ ] 제목 (`#`, `##`) 렌더링
- [ ] **굵은 글씨** 렌더링
- [ ] 인라인 수식: $E = mc^2$ 렌더링
- [ ] 블록 수식: 가우스 적분 렌더링
- [ ] 코드 블록 구문 하이라이팅
- [ ] 목록 (중첩 포함) 렌더링
- [ ] 표 렌더링 (이름/점수/등급)

#### 시나리오 4: 일반 텍스트 (.txt) - 24~32초

확인 항목:
- [ ] 파일명 `notes.txt` 헤더에 표시
- [ ] "TEXT" 파일 타입 뱃지 표시
- [ ] 고정폭 폰트로 텍스트 표시
- [ ] 줄바꿈, 들여쓰기 유지
- [ ] 한국어 텍스트 정상 표시

#### 공통 확인 항목

- [ ] 다크/라이트 모드 토글 버튼 동작
- [ ] 접속자 수 표시 (viewers:count)
- [ ] 다운로드 버튼 존재
- [ ] 시나리오 자동 전환 시 화면 정상 갱신
- [ ] WebSocket 연결 끊김 시 재연결 시도

### 종료

`Ctrl+C`로 테스트 서버 종료.

---

## Extension 통합 테스트

VS Code에서 Extension을 직접 실행하여 전체 기능을 테스트합니다.

### 사전 준비

```bash
cd jupyter-live-share
npm install
npm run compile
```

### 실행 방법

1. VS Code에서 `jupyter-live-share` 폴더 열기
2. `F5` 키 → "Extension Development Host" 창 실행
3. 새 VS Code 창에서 테스트할 파일 열기

### 테스트 절차

#### 테스트 A: 노트북 파일 공유

1. `.ipynb` 파일 열기 (예: `test.ipynb`)
2. `Ctrl+Shift+P` → "Jupyter Live Share: Start Session"
3. 표시된 URL을 브라우저에서 열기

확인 항목:
- [ ] 세션 시작 성공 메시지
- [ ] StatusBar에 세션 상태 표시
- [ ] 브라우저에서 노트북 셀 표시
- [ ] VS Code에서 셀 편집 → 브라우저 실시간 반영
- [ ] VS Code에서 셀 실행 → 출력 브라우저에 표시
- [ ] 셀 추가/삭제 → 브라우저 구조 업데이트
- [ ] 활성 셀 변경 → 브라우저 하이라이트 이동

#### 테스트 B: Python 파일 공유

1. `.py` 파일 열기
2. `Ctrl+Shift+P` → "Jupyter Live Share: Start Session"
3. 표시된 URL을 브라우저에서 열기

확인 항목:
- [ ] 브라우저에서 Python 코드 구문 하이라이팅
- [ ] VS Code에서 코드 편집 → 브라우저 실시간 반영
- [ ] "PYTHON" 파일 타입 뱃지 표시

#### 테스트 C: Markdown 파일 공유

1. `.md` 파일 열기
2. `Ctrl+Shift+P` → "Jupyter Live Share: Start Session"

확인 항목:
- [ ] Markdown 렌더링 (제목, 목록, 표, 링크)
- [ ] KaTeX 수식 렌더링
- [ ] 코드 블록 구문 하이라이팅
- [ ] VS Code에서 편집 → 브라우저 실시간 반영

#### 테스트 D: 텍스트 파일 공유

1. `.txt` 파일 열기
2. `Ctrl+Shift+P` → "Jupyter Live Share: Start Session"

확인 항목:
- [ ] 일반 텍스트 고정폭 폰트 표시
- [ ] VS Code에서 편집 → 브라우저 실시간 반영

#### 테스트 E: 파일 전환

세션 실행 중 다른 파일로 전환:

1. `.ipynb` 파일로 세션 시작
2. VS Code에서 `.py` 파일 탭 클릭
3. 브라우저에서 자동으로 Python 코드 표시 확인
4. `.md` 파일 탭 클릭 → Markdown 렌더링 확인
5. 다시 `.ipynb` 탭 클릭 → 노트북 셀 표시 확인

확인 항목:
- [ ] notebook → plaintext 전환 정상
- [ ] plaintext → notebook 전환 정상
- [ ] plaintext → plaintext (다른 파일) 전환 정상
- [ ] 전환 시 이전 파일 내용 잔존하지 않음

#### 테스트 F: 세션 종료

1. `Ctrl+Shift+P` → "Jupyter Live Share: Stop Session"

확인 항목:
- [ ] 세션 종료 메시지
- [ ] StatusBar 상태 초기화
- [ ] 브라우저에서 `session:end` 수신 → 종료 안내 표시
- [ ] WebSocket 연결 해제

#### 테스트 G: PIN 보안

1. VS Code 설정 → Jupyter Live Share → PIN 활성화
2. 세션 시작
3. 브라우저 접속 시 PIN 입력 화면 표시 확인

확인 항목:
- [ ] 올바른 PIN 입력 → 접속 성공
- [ ] 잘못된 PIN 입력 → 접속 거부
- [ ] PIN 비활성화 → PIN 입력 없이 접속

#### 테스트 H: 다운로드

1. 세션 실행 중 브라우저에서 다운로드 버튼 클릭

확인 항목:
- [ ] `.ipynb` 파일 다운로드 정상
- [ ] `.py` 파일 다운로드 정상
- [ ] `.md` 파일 다운로드 정상
- [ ] 다운로드된 파일 내용 일치

---

## 부하 테스트

50명 동시 접속 시뮬레이션으로 서버 안정성을 검증합니다.

### 실행 방법

```bash
# 먼저 Extension 세션을 시작하거나 test-viewer.js를 실행한 후
node test/load/load-test.js --url ws://localhost:3456 --clients 50
```

### 확인 항목

- [ ] 50개 WebSocket 연결 모두 성공
- [ ] 모든 클라이언트에 `notebook:full` 또는 `document:full` 수신
- [ ] `viewers:count`가 정확한 접속자 수 표시
- [ ] 셀 업데이트 시 모든 클라이언트에 broadcast
- [ ] 메모리 사용량 안정적 (급격한 증가 없음)
- [ ] 연결 해제 후 `viewers:count` 감소

---

## Cloudflare Tunnel 테스트

외부 네트워크에서 접속 가능한지 확인합니다.

### 사전 준비

```bash
# cloudflared 설치 확인
cloudflared --version
```

### 수동 터널 테스트

```bash
# 1. Extension 세션 또는 test-viewer.js 실행
# 2. 별도 터미널에서 터널 생성
cloudflared tunnel --url http://localhost:3456
```

출력되는 `https://xxx.trycloudflare.com` URL을 확인합니다.

### 확인 항목

- [ ] 터널 URL 생성 성공
- [ ] 외부 네트워크 (모바일 데이터 등)에서 URL 접속 가능
- [ ] WebSocket 연결 정상 (`wss://` 프로토콜)
- [ ] 노트북/텍스트 파일 렌더링 정상
- [ ] 실시간 업데이트 정상
- [ ] 50명 동시 접속 시 터널 안정성

### Extension 내장 터널 테스트

1. VS Code 설정 → Jupyter Live Share → Tunnel Provider → "cloudflared"
2. 세션 시작 → 자동 터널 생성 확인
3. 표시된 HTTPS URL로 접속 확인

---

## 테스트 체크리스트

### 필수 테스트 (배포 전 반드시 통과)

#### 렌더링

- [ ] `.ipynb`: 셀 기반 렌더링 (Markdown + 코드 + 출력)
- [ ] `.py`: Python 구문 하이라이팅
- [ ] `.md`: Markdown 렌더링 + KaTeX 수식
- [ ] `.txt`: 일반 텍스트 고정폭 표시
- [ ] 다크/라이트 모드 전환

#### 실시간 동기화

- [ ] 셀 편집 → `cell:update` 반영
- [ ] 셀 실행 → `cell:output` 반영
- [ ] 텍스트 편집 → `document:update` 반영
- [ ] 파일 전환 → 자동 모드 전환

#### 서버/연결

- [ ] HTTP 서버 시작/종료
- [ ] WebSocket 연결/해제
- [ ] PIN 인증
- [ ] 파일 다운로드
- [ ] 접속자 수 표시

#### 브라우저 호환성

- [ ] Chrome (최신)
- [ ] Firefox (최신)
- [ ] Edge (최신)
- [ ] 모바일 Chrome

### 선택 테스트

- [ ] 50명 부하 테스트
- [ ] Cloudflare Tunnel 외부 접속
- [ ] 장시간 연결 안정성 (1시간+)
- [ ] 대용량 파일 (1000+ 줄)

---

## 테스트 결과 기록

### 최근 테스트 결과 (Playwright 자동 테스트)

**테스트 일자**: 2026-02-04
**테스트 도구**: Playwright (브라우저 자동화)
**테스트 서버**: `test-viewer.js` (port 3456)

| 시나리오 | 결과 | 비고 |
|----------|:----:|------|
| 노트북 렌더링 (.ipynb) | PASS | KaTeX 수식, 코드 하이라이팅, 출력, 활성 셀 하이라이트 |
| Python 렌더링 (.py) | PASS | "PYTHON" 뱃지, 구문 하이라이팅 |
| Markdown 렌더링 (.md) | PASS | 제목, 굵은 글씨, 수식, 코드 블록, 목록, 표 |
| 일반 텍스트 렌더링 (.txt) | PASS | "TEXT" 뱃지, 고정폭 텍스트 |
| 다크 모드 | PASS | 어두운 배경, 밝은 텍스트 |
| 라이트 모드 | PASS | 밝은 배경, 어두운 텍스트 |
| 파일 전환 (자동 회전) | PASS | 8초 간격 자동 전환 정상 |
| cell:update 시뮬레이션 | PASS | 4초 후 셀 내용 자동 갱신 |
| document:update 시뮬레이션 | PASS | 12초 후 코드 추가 반영 |

### 테스트 결과 템플릿

```
테스트 일자: YYYY-MM-DD
테스터:
환경: Windows XX / Chrome XX / VS Code XX
Extension 버전:

| 항목 | 결과 | 비고 |
|------|:----:|------|
| 노트북 렌더링 |  |  |
| Python 렌더링 |  |  |
| Markdown 렌더링 |  |  |
| 텍스트 렌더링 |  |  |
| 실시간 편집 반영 |  |  |
| 파일 전환 |  |  |
| PIN 인증 |  |  |
| 다운로드 |  |  |
| 다크/라이트 모드 |  |  |
| 50명 부하 테스트 |  |  |
| Tunnel 외부 접속 |  |  |
```
