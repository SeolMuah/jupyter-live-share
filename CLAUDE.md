# Jupyter Live Share Extension - 작업 지침

## 프로젝트 개요

VS Code Extension: 선생님이 .ipynb, .py, .txt, .md 등 파일을 실시간으로 50명 학생에게 브라우저로 공유하는 교육용 도구.

## 핵심 문서

- `docs/PRD.md` - 제품 요구사항 (기술 스택, API 설계, 아키텍처)
- `TASKS.md` - 단계별 할일 목록 (체크리스트)
- `test.ipynb` - 테스트용 노트북 파일

## 작업 규칙

### 진행 방식

1. **TASKS.md 기반 작업**: 항상 TASKS.md를 먼저 읽고 현재 진행할 단계를 확인한다
2. **순서 준수**: Phase 0 → 1 → 2 → 3 → 4 순서대로 진행. 하위 항목도 번호 순서대로
3. **완료 체크**: 작업 완료 시 TASKS.md에서 `[ ]` → `[x]`로 업데이트
4. **테스트 우선**: 각 기능 구현 후 반드시 `TEST:` 항목을 실행하여 검증
5. **실패 시 기록**: 테스트 실패하면 TASKS.md 해당 항목에 실패 사유를 주석으로 기록

### 코딩 규칙

- **언어**: TypeScript (Extension), JavaScript (브라우저 뷰어)
- **VS Code API**: .ipynb 관련은 반드시 Notebook API 사용. `onDidChangeTextDocument`는 .ipynb에 사용 금지 (일반 텍스트 파일에는 사용 가능)
- **핵심 API**:
  - `vscode.workspace.onDidChangeNotebookDocument` → 셀 내용/출력 변경 감지 (.ipynb)
  - `vscode.window.onDidChangeActiveNotebookEditor` → 활성 노트북 변경
  - `vscode.window.onDidChangeNotebookEditorSelection` → 선택 셀 변경
  - `vscode.workspace.onDidChangeTextDocument` → 텍스트 파일 내용 변경 감지 (.py, .txt, .md 등)
  - `vscode.window.onDidChangeActiveTextEditor` → 활성 텍스트 에디터 변경
- **공유 모드 2가지**:
  - `notebook` 모드: .ipynb 파일 → 셀 기반 렌더링 (기존)
  - `plaintext` 모드: .py, .txt, .md 등 → 단일 문서 렌더링 (구문 하이라이팅/Markdown 지원)
- **의존성 최소화**: 꼭 필요한 패키지만 사용. React 사용 금지 (Vanilla JS로 뷰어 구현)
- **번들 크기**: Extension < 5MB, 뷰어 < 500KB (gzip 후)

### 프로젝트 구조

```
jupyter-live-share/
├── package.json
├── tsconfig.json
├── webpack.config.js
├── src/
│   ├── extension.ts              # 진입점
│   ├── server/
│   │   ├── httpServer.ts         # Express HTTP 서버
│   │   ├── wsServer.ts           # WebSocket 서버
│   │   └── tunnel.ts             # cloudflared 관리
│   ├── notebook/
│   │   ├── watcher.ts            # 노트북 변경 감지
│   │   └── serializer.ts         # 셀/출력 직렬화
│   ├── ui/
│   │   ├── statusBar.ts          # StatusBar
│   │   ├── sidebarView.ts        # Sidebar TreeView
│   │   └── commands.ts           # 명령어 등록
│   └── utils/
│       ├── config.ts             # 설정
│       └── logger.ts             # 로깅
├── viewer/
│   ├── index.html
│   ├── viewer.js
│   ├── renderer.js
│   ├── websocket.js
│   └── style.css
├── bin/                          # cloudflared 바이너리
└── test/
    ├── unit/
    └── load/
        └── load-test.js          # 50명 부하 테스트
```

### 테스트 방법

#### 개발 중 빠른 테스트
```bash
# Extension 컴파일 + 실행
npm run compile
# F5로 Extension Development Host 실행

# 서버 직접 테스트 (개발 중)
# 브라우저에서 http://localhost:3000 접속
# 브라우저 DevTools Console에서 WebSocket 메시지 확인
```

#### WebSocket 수동 테스트 (브라우저 Console)
```javascript
// 연결 테스트
const ws = new WebSocket('ws://localhost:3000');
ws.onmessage = (e) => console.log('수신:', JSON.parse(e.data));
ws.onopen = () => console.log('연결 성공');
ws.onclose = () => console.log('연결 끊김');
```

#### 부하 테스트
```bash
# 50명 동시 접속 시뮬레이션
node test/load/load-test.js --url ws://localhost:3000 --clients 50
```

#### Cloudflare Tunnel 테스트
```bash
# 수동으로 터널 테스트
cloudflared tunnel --url http://localhost:3000
# 출력되는 https://xxx.trycloudflare.com URL로 외부 접속 확인
```

### WebSocket 이벤트 규격

PRD의 API 설계 섹션 참조. 핵심 이벤트:

| 이벤트 | 방향 | 용도 |
|--------|------|------|
| `notebook:full` | Server→Client | 전체 노트북 동기화 (.ipynb) |
| `cell:update` | Server→Client | 셀 소스 변경 (.ipynb) |
| `cell:output` | Server→Client | 셀 실행 결과 (.ipynb) |
| `cells:structure` | Server→Client | 셀 추가/삭제 (.ipynb) |
| `focus:cell` | Server→Client | 활성 셀 변경 (.ipynb) |
| `document:full` | Server→Client | 텍스트 파일 전체 동기화 (.py, .txt, .md 등) |
| `document:update` | Server→Client | 텍스트 파일 내용 변경 |
| `viewers:count` | Server→Client | 접속자 수 |
| `session:end` | Server→Client | 세션 종료 |
| `join` | Client→Server | 세션 참여 (PIN) |

### 빌드 및 배포

#### 빌드 → VSIX 패키지 생성
```bash
npm run compile                # webpack 빌드
npx vsce package               # .vsix 파일 생성 (루트에 jupyter-live-share-x.x.x.vsix)
```

#### 버전 올리기
- `package.json`의 `"version"` 필드를 수동으로 올린다 (예: `0.1.3` → `0.1.4`)

#### 커밋 → 푸시 → 태그
```bash
git add <변경된 파일들>
git commit -m "변경 요약 (vX.X.X)"
git tag -a vX.X.X -m "vX.X.X: 변경 요약"
git push origin main --tags
```

#### GitHub Release 생성 (curl + API)

`gh` CLI가 없으므로 `token.txt`의 GitHub PAT로 GitHub API를 직접 호출한다.

**중요 규칙:**
- **토큰**: 반드시 `sed -n '2p' token.txt`로 가져온다. `git credential fill`은 파이프 환경에서 빈 값을 반환할 수 있어 사용 금지.
- **인증 헤더**: `Authorization: token $TOKEN` (Bearer가 아님)
- **curl 필수 옵션**: 항상 `-s` (silent) 포함. progress 출력이 응답 파싱을 방해함.
- **응답 파싱**: curl 출력을 파이프(`|`)로 바로 python에 넘기지 말고, 반드시 **파일로 저장 후 별도로 파싱**한다. 대용량 업로드 시 curl이 빈 stdout을 반환할 수 있음.
- **파일 경로**: Windows이므로 `$TEMP` 환경변수 사용 (`/tmp` 사용 금지).
- **대용량 업로드**: VSIX가 ~57MB이므로 `--max-time 300` 필수.

```bash
# ★ 토큰 가져오기 (모든 API 호출 전에 실행)
TOKEN=$(sed -n '2p' token.txt)

# ★ 릴리스 생성 → 파일로 저장 → ID 추출
curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/SeolMuah/jupyter-live-share/releases" \
  -d '{
    "tag_name": "vX.X.X",
    "target_commitish": "main",
    "name": "vX.X.X",
    "body": "## 변경사항\n\n- 내용",
    "draft": false,
    "prerelease": false
  }' > "$TEMP/release.json"

# ID 추출
python -c "import json,os; d=json.load(open(os.environ['TEMP']+'/release.json')); print('ID:', d['id']); print('URL:', d['html_url'])"

# ★ VSIX 파일 업로드 (RELEASE_ID를 위에서 추출한 값으로 교체)
curl -s --max-time 300 -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  "https://uploads.github.com/repos/SeolMuah/jupyter-live-share/releases/{RELEASE_ID}/assets?name=jupyter-live-share-X.X.X.vsix" \
  --data-binary "@jupyter-live-share-X.X.X.vsix" > "$TEMP/upload.json"

# 업로드 결과 확인
python -c "import json,os; d=json.load(open(os.environ['TEMP']+'/upload.json')); print('Name:', d.get('name'), 'State:', d.get('state'), 'Size:', d.get('size'))"

# ★ 기존 asset 교체 시: 먼저 기존 asset 삭제 후 재업로드
# asset ID 조회
curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/SeolMuah/jupyter-live-share/releases/{RELEASE_ID}/assets" > "$TEMP/assets.json"
python -c "import json,os; [print(f'ID:{a[\"id\"]} Name:{a[\"name\"]} State:{a[\"state\"]}') for a in json.load(open(os.environ['TEMP']+'/assets.json'))]"

# asset 삭제
curl -s -X DELETE -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/SeolMuah/jupyter-live-share/releases/assets/{ASSET_ID}"

# ★ 릴리스 본문 수정
curl -s -X PATCH \
  -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/SeolMuah/jupyter-live-share/releases/{RELEASE_ID}" \
  -d '{"body": "수정된 내용"}'
```

#### 토큰 파일 (`token.txt`, gitignore 대상)
- 1번째 줄: Open VSX 토큰
- 2번째 줄: GitHub Personal Access Token (repo scope 필요)

### 주의사항

- `vscode.workspace.onDidChangeTextDocument`는 .ipynb에 동작하지 않음. 반드시 `onDidChangeNotebookDocument` 사용
- 셀 출력의 `item.data`는 `Uint8Array`임. 이미지는 `Buffer.from(data).toString('base64')`, 텍스트는 `new TextDecoder().decode(data)`로 변환
- Cloudflare Quick Tunnel URL은 매 세션마다 변경됨 (정상 동작)
- 브라우저 뷰어에서 HTML 출력 렌더링 시 반드시 DOMPurify로 새니타이징
- Windows에서 cloudflared 프로세스 종료 시 `process.kill()` 대신 `taskkill` 사용 필요할 수 있음
