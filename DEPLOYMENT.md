# Jupyter Live Share Extension - 배포 가이드

## 목차

1. [사전 준비](#1-사전-준비)
2. [개발 환경 빌드](#2-개발-환경-빌드)
3. [VSIX 패키징](#3-vsix-패키징)
4. [로컬 설치 (VSIX)](#4-로컬-설치-vsix)
5. [마켓플레이스 배포](#5-마켓플레이스-배포)
6. [교실 환경 대량 배포](#6-교실-환경-대량-배포)
7. [업데이트 및 버전 관리](#7-업데이트-및-버전-관리)
8. [배포 체크리스트](#8-배포-체크리스트)
9. [문제 해결](#9-문제-해결)
10. [배포 롤백](#10-배포-롤백)

---

## 1. 사전 준비

### 1.1 필수 도구 설치

```bash
# Node.js 18+ 설치 확인
node --version   # v18.x.x 이상

# npm 확인
npm --version    # 9.x.x 이상

# vsce (VS Code Extension 패키징/배포 도구) 전역 설치
npm install -g @vscode/vsce

# vsce 설치 확인
vsce --version
```

> **vsce란?** Visual Studio Code Extension Manager의 약자로, Extension을 `.vsix` 파일로 패키징하거나 마켓플레이스에 게시할 때 사용하는 공식 CLI 도구입니다.

### 1.2 프로젝트 의존성 설치

```bash
cd jupyter-live-share
npm install
```

### 1.3 프로젝트 구조 확인

배포 전 주요 파일이 올바르게 존재하는지 확인합니다.

```
jupyter-live-share/
├── package.json          # Extension 메타데이터 + 스크립트
├── tsconfig.json         # TypeScript 설정
├── webpack.config.js     # 번들링 설정
├── .vscodeignore         # VSIX 패키징 시 제외 목록
├── src/                  # TypeScript 소스 코드
│   ├── extension.ts      # 진입점
│   ├── server/           # HTTP + WebSocket 서버
│   ├── notebook/         # 노트북 감시 + 직렬화
│   ├── ui/               # StatusBar, Sidebar, Commands
│   └── utils/            # 설정, 로깅
├── viewer/               # 브라우저 뷰어 (HTML/JS/CSS)
│   ├── index.html
│   ├── viewer.js
│   ├── renderer.js
│   ├── websocket.js
│   └── style.css
├── bin/                  # cloudflared 바이너리 (선택)
└── resources/            # 아이콘 등 리소스
```

---

## 2. 개발 환경 빌드

### 2.1 개발 빌드 (소스맵 포함)

```bash
npm run compile
```

- webpack `--mode development`로 실행
- 소스맵 포함 → 디버깅 가능
- `dist/` 디렉토리에 결과물 생성

### 2.2 프로덕션 빌드 (최적화)

```bash
npm run build
```

- webpack `--mode production`으로 실행
- 코드 난독화 + 최소화 적용
- 번들 크기 최적화
- **배포 전에는 반드시 프로덕션 빌드를 사용**

### 2.3 감시 모드 (개발 중)

```bash
npm run watch
```

- 파일 변경 시 자동 재빌드
- 개발 중 편리하게 사용

### 2.4 빌드 결과물 확인

빌드 후 `dist/` 디렉토리 구조:

```
dist/
├── extension.js          # Extension 메인 번들
├── extension.js.map      # 소스맵 (개발 빌드 시)
└── viewer/               # 브라우저 뷰어 파일 (CopyPlugin으로 복사됨)
    ├── index.html
    ├── viewer.js
    ├── renderer.js
    ├── websocket.js
    └── style.css
```

> **확인 포인트**: `dist/viewer/` 디렉토리가 비어있거나 없다면 `viewer/` 원본 디렉토리 존재 여부를 확인하세요. webpack의 `CopyPlugin`이 `viewer/` → `dist/viewer/`로 복사합니다.

### 2.5 개발 테스트 (F5 실행)

1. VS Code에서 `jupyter-live-share` 폴더 열기
2. `F5` 키 → "Extension Development Host" 창 실행
3. 새 VS Code 창에서 `.ipynb` 또는 `.py` 파일 열기
4. Command Palette (`Ctrl+Shift+P`) → `Jupyter Live Share: Start Session`
5. 브라우저에서 표시된 URL 접속하여 동작 확인
6. Output 패널에서 `Jupyter Live Share` 채널 로그 확인

---

## 3. VSIX 패키징

### 3.1 VSIX란?

VSIX(Visual Studio Integrated Extension)는 VS Code Extension의 배포 형식입니다. 실제로는 ZIP 압축 파일로, Extension 코드와 메타데이터가 포함됩니다.

### 3.2 패키징 전 점검

#### package.json 필수 필드 확인

```jsonc
{
  "name": "jupyter-live-share",
  "displayName": "Jupyter Live Share",
  "description": "Share Jupyter Notebooks in real-time with students via browser",
  "version": "0.1.0",          // semver 형식 필수
  "publisher": "jupyter-live-share",  // 퍼블리셔 이름
  "engines": {
    "vscode": "^1.82.0"        // 최소 VS Code 버전
  },
  "main": "./dist/extension.js"  // 번들 진입점
}
```

#### .vscodeignore 확인

현재 설정된 제외 목록:

```
.vscode/**
.vscode-test/**
src/**              # 소스 코드 (번들에 포함됨)
test/**             # 테스트 코드
node_modules/**     # 의존성 (webpack 번들에 포함됨)
.gitignore
tsconfig.json
webpack.config.js
*.map               # 소스맵
.eslintrc.json
```

> `.vscodeignore`에 나열된 파일/디렉토리는 VSIX에 포함되지 않습니다. webpack이 모든 의존성을 `dist/extension.js`에 번들링하므로 `node_modules/`와 `src/`는 제외해도 됩니다.

### 3.3 프로덕션 빌드 후 패키징

```bash
# 1. 프로덕션 빌드 먼저 실행
npm run build

# 2. VSIX 패키지 생성
vsce package
```

성공 시 프로젝트 루트에 `jupyter-live-share-0.1.0.vsix` 파일이 생성됩니다.

### 3.4 버전 지정 패키징

```bash
# 특정 버전으로 패키징 (package.json의 version도 자동 변경됨)
vsce package 0.2.0

# 또는 package.json의 version 필드를 직접 수정한 후
vsce package
```

### 3.5 패키지 내용 확인

```bash
# VSIX에 포함될 파일 목록 미리 확인
vsce ls
```

출력 예시:

```
extension/package.json
extension/dist/extension.js
extension/dist/viewer/index.html
extension/dist/viewer/viewer.js
extension/dist/viewer/renderer.js
extension/dist/viewer/websocket.js
extension/dist/viewer/style.css
extension/resources/icon.svg
extension/bin/cloudflared.exe    (포함 시)
```

### 3.6 예상 VSIX 크기

| 구성 | 예상 크기 |
|------|----------|
| Extension 코드 + 뷰어만 | ~2MB |
| cloudflared 바이너리 포함 (Windows) | ~30MB |
| cloudflared 제외 (사용자 별도 설치) | ~2MB |

> **권장**: 교실 환경에서는 cloudflared를 VSIX에 포함시키는 것이 편리합니다. 마켓플레이스 배포 시에는 크기 제한(50MB)을 고려하여 플랫폼별 분리를 검토하세요.

---

## 4. 로컬 설치 (VSIX)

교실 환경이나 내부 배포 시 VSIX 파일을 직접 설치하는 방법입니다.

### 4.1 방법 1: VS Code UI에서 설치

1. VS Code 열기
2. 좌측 사이드바 → **Extensions** (확장) 아이콘 클릭 (`Ctrl+Shift+X`)
3. 상단 `...` (더보기) 메뉴 → **"Install from VSIX..."** 클릭
4. 생성된 `.vsix` 파일 선택
5. 설치 완료 알림 확인
6. **VS Code 재시작** (Reload Window)

### 4.2 방법 2: 명령줄에서 설치

```bash
code --install-extension jupyter-live-share-0.1.0.vsix
```

> `code` 명령어가 인식되지 않으면: VS Code → Command Palette → `Shell Command: Install 'code' command in PATH` 실행

### 4.3 설치 확인

1. VS Code 재시작
2. Command Palette (`Ctrl+Shift+P`) → "Jupyter Live Share" 검색
3. "Start Session", "Stop Session" 명령어가 표시되면 설치 성공
4. 좌측 Activity Bar에 Jupyter Live Share 아이콘 표시 확인

### 4.4 Extension 제거

```bash
# 명령줄
code --uninstall-extension jupyter-live-share.jupyter-live-share

# 또는 VS Code UI
# Extensions → Jupyter Live Share → Uninstall
```

---

## 5. 마켓플레이스 배포

VS Code Marketplace에 Extension을 공개 배포하는 절차입니다.

### 5.1 Azure DevOps Personal Access Token (PAT) 발급

1. [https://dev.azure.com](https://dev.azure.com) 접속 (Microsoft 계정 로그인)
2. 우측 상단 프로필 아이콘 → **Personal Access Tokens** 클릭
3. **+ New Token** 클릭
4. 다음과 같이 설정:
   - **Name**: `vsce-publish` (임의)
   - **Organization**: All accessible organizations
   - **Expiration**: 원하는 기간 (최대 1년)
   - **Scopes** → **Custom defined** → **Marketplace** → **Manage** 체크
5. **Create** 클릭
6. **생성된 토큰을 즉시 복사하여 안전한 곳에 저장** (다시 확인 불가)

### 5.2 퍼블리셔 생성

```bash
# 최초 1회만 실행
vsce create-publisher your-publisher-name
# 이메일, PAT 입력

# 또는 https://marketplace.visualstudio.com/manage 에서 웹으로 생성 가능
```

### 5.3 퍼블리셔 로그인

```bash
vsce login your-publisher-name
# PAT 입력 프롬프트 → 위에서 복사한 토큰 붙여넣기
```

### 5.4 package.json 마켓플레이스 필수 필드

```jsonc
{
  "name": "jupyter-live-share",
  "displayName": "Jupyter Live Share",
  "description": "Share Jupyter Notebooks in real-time with students via browser",
  "version": "0.1.0",
  "publisher": "your-publisher-name",     // PAT 발급한 퍼블리셔 이름과 일치
  "license": "MIT",
  "icon": "resources/icon.png",           // 128x128 PNG (필수)
  "repository": {                          // GitHub 저장소 (권장)
    "type": "git",
    "url": "https://github.com/your/repo"
  },
  "categories": ["Education", "Notebooks"],
  "keywords": ["jupyter", "notebook", "live", "share", "education"],
  "engines": {
    "vscode": "^1.82.0"
  }
}
```

> **아이콘 요구사항**: 128x128 또는 256x256 PNG 파일. SVG는 마켓플레이스에서 지원하지 않으므로 PNG로 변환 필요.

### 5.5 README.md 작성

마켓플레이스 페이지에 README.md 내용이 그대로 표시됩니다. 다음 내용을 포함하세요:

- Extension 소개 및 주요 기능
- 스크린샷 또는 GIF 데모
- 설치 방법
- 사용 방법 (Step-by-step)
- 설정 옵션 설명
- 시스템 요구사항
- 라이선스

### 5.6 게시 (Publish)

```bash
# 프로덕션 빌드 확인 후
npm run build

# 마켓플레이스에 게시
vsce publish
```

### 5.7 버전별 게시

```bash
# 현재 package.json 버전으로 게시
vsce publish

# 특정 버전으로 게시 (package.json 자동 업데이트)
vsce publish 0.2.0

# 패치 버전 자동 증가 (0.1.0 → 0.1.1)
vsce publish patch

# 마이너 버전 자동 증가 (0.1.1 → 0.2.0)
vsce publish minor

# 메이저 버전 자동 증가 (0.2.0 → 1.0.0)
vsce publish major
```

### 5.8 게시 확인

- 게시 후 약 5~10분 후 마켓플레이스에 반영
- 확인 URL: `https://marketplace.visualstudio.com/items?itemName=your-publisher-name.jupyter-live-share`
- VS Code에서 Extension 검색으로도 확인 가능

### 5.9 게시 취소 (Unpublish)

```bash
# 특정 버전 취소
vsce unpublish your-publisher-name.jupyter-live-share
```

> 주의: 게시 취소는 되돌릴 수 없습니다. 이미 설치한 사용자에게는 영향 없지만 새 설치가 불가능합니다.

---

## 6. 교실 환경 대량 배포

이 Extension은 교육용이므로 교실의 여러 PC에 한번에 배포하는 시나리오를 설명합니다.

### 6.1 VSIX 파일 배포 (가장 간단)

```bash
# 1. VSIX 파일을 공유 드라이브에 복사
copy jupyter-live-share-0.1.0.vsix \\server\share\

# 2. 각 PC에서 설치 (수동)
code --install-extension "\\server\share\jupyter-live-share-0.1.0.vsix"
```

### 6.2 배치 스크립트로 자동 설치

`install-extension.bat` 파일 생성:

```bat
@echo off
echo Jupyter Live Share Extension 설치 중...

:: VS Code가 설치된 경우
where code >nul 2>nul
if %errorlevel% neq 0 (
    echo [오류] VS Code가 설치되어 있지 않습니다.
    pause
    exit /b 1
)

:: Extension 설치
code --install-extension "\\server\share\jupyter-live-share-0.1.0.vsix" --force

if %errorlevel% equ 0 (
    echo [성공] Extension이 설치되었습니다.
    echo VS Code를 재시작하세요.
) else (
    echo [오류] 설치에 실패했습니다.
)

pause
```

### 6.3 PowerShell로 원격 배포

```powershell
# 대상 PC 목록
$computers = @("PC-01", "PC-02", "PC-03")  # 또는 파일에서 읽기
$vsixPath = "\\server\share\jupyter-live-share-0.1.0.vsix"

foreach ($pc in $computers) {
    Invoke-Command -ComputerName $pc -ScriptBlock {
        param($path)
        & code --install-extension $path --force
    } -ArgumentList $vsixPath
}
```

### 6.4 VS Code 설정 동기화 활용

학생 PC에 동일한 Microsoft/GitHub 계정으로 VS Code 설정 동기화가 활성화되어 있다면, 한 PC에서 설치하면 다른 PC에도 자동 동기화됩니다.

- VS Code → `Ctrl+Shift+P` → `Settings Sync: Turn On`
- Extensions 동기화 항목 활성화

---

## 7. 업데이트 및 버전 관리

### 7.1 Semantic Versioning (SemVer)

```
MAJOR.MINOR.PATCH
  │      │     └── 버그 수정 (하위 호환)
  │      └──────── 새 기능 추가 (하위 호환)
  └─────────────── 호환성 깨지는 변경
```

**예시**:
- `0.1.0` → `0.1.1`: 버그 수정
- `0.1.1` → `0.2.0`: 새 기능 (예: .md 지원 추가)
- `0.2.0` → `1.0.0`: 첫 정식 릴리스 또는 API 변경

### 7.2 버전 업데이트 절차

```bash
# 1. package.json의 version 수정 (또는 npm version 사용)
npm version patch    # 0.1.0 → 0.1.1
# 또는
npm version minor    # 0.1.0 → 0.2.0

# 2. CHANGELOG.md에 변경사항 기록

# 3. 프로덕션 빌드
npm run build

# 4. 테스트 실행 (F5로 Extension 테스트)

# 5. VSIX 패키징
vsce package

# 6-a. VSIX로 배포 시: 파일 공유
# 6-b. 마켓플레이스 배포 시:
vsce publish
```

### 7.3 CHANGELOG.md 작성 형식

```markdown
# Changelog

## [0.2.0] - 2025-01-15

### 추가
- .py, .txt, .md 파일 공유 기능 (plaintext 모드)
- 구문 하이라이팅 지원 (Python, JavaScript 등)
- Markdown 렌더링 지원

### 수정
- WebSocket 재연결 시 화면 깜빡임 해결
- 50명 동시 접속 시 메모리 누수 수정

### 변경
- 최소 VS Code 버전 1.82.0으로 상향

## [0.1.0] - 2025-01-01

### 최초 릴리스
- .ipynb 파일 실시간 공유
- Cloudflare Tunnel 지원
- PIN 접속 제한
```

### 7.4 Pre-release 버전 배포

안정 릴리스 전에 테스트 목적으로 프리릴리스 배포가 가능합니다.

```bash
# Pre-release로 패키징
vsce package --pre-release

# Pre-release로 마켓플레이스 게시
vsce publish --pre-release
```

> Pre-release 버전은 VS Code에서 "Switch to Pre-Release Version" 옵션으로만 설치됩니다. 안정 버전 사용자에게는 자동 업데이트되지 않습니다.

---

## 8. 배포 체크리스트

### 빌드 검증

- [ ] `npm run build` (프로덕션) 에러 없이 완료
- [ ] `dist/extension.js` 파일 존재
- [ ] `dist/viewer/` 디렉토리에 뷰어 파일 5개 존재 (index.html, viewer.js, renderer.js, websocket.js, style.css)
- [ ] `npm run lint` 경고/에러 없음

### 기능 테스트

- [ ] `.ipynb` 파일 공유 → 셀 렌더링 정상
- [ ] `.py` 파일 공유 → Python 구문 하이라이팅 정상
- [ ] `.md` 파일 공유 → Markdown 렌더링 정상
- [ ] `.txt` 파일 공유 → 일반 텍스트 표시 정상
- [ ] 실시간 편집 반영 (타이핑 시 뷰어 즉시 업데이트)
- [ ] 파일 전환 시 뷰어 자동 업데이트
- [ ] PIN 설정/해제 정상 동작
- [ ] 접속자 수 카운트 정확
- [ ] 다크/라이트 모드 전환
- [ ] 다운로드 버튼 동작

### 브라우저 호환성 테스트

- [ ] Chrome 최신 버전
- [ ] Firefox 최신 버전
- [ ] Edge 최신 버전
- [ ] 모바일 Chrome (반응형 레이아웃)

### 환경 테스트

- [ ] Windows 10/11에서 동작 확인
- [ ] Cloudflare Tunnel URL로 외부 접속 확인
- [ ] 50명 동시 접속 부하 테스트 (`node test/load/load-test.js`)

### 패키징 검증

- [ ] `vsce package` 에러 없이 완료
- [ ] `.vsix` 파일 크기 적정 (< 5MB, cloudflared 제외 시)
- [ ] `vsce ls`로 포함 파일 목록 확인
- [ ] 깨끗한 VS Code에 `.vsix` 설치 → 정상 동작

### 마켓플레이스 배포 시 추가 확인

- [ ] `publisher` 필드가 실제 퍼블리셔 이름과 일치
- [ ] `icon` 파일 존재 (128x128 PNG)
- [ ] `repository` URL 유효
- [ ] README.md 작성 완료 (스크린샷 포함)
- [ ] CHANGELOG.md 최신 버전 기록 완료
- [ ] `license` 필드 설정

---

## 9. 문제 해결

### 9.1 vsce package 실패

**증상**: `ERROR: Missing publisher name`

```bash
# 해결: package.json에 publisher 추가
"publisher": "your-publisher-name"
```

**증상**: `WARNING: A '+1' was found in the version`

```bash
# 해결: version이 유효한 semver인지 확인
"version": "0.1.0"    # O
"version": "0.1.0+1"  # X
```

**증상**: `ERROR: Proposed API is not supported`

```bash
# 해결: package.json의 engines.vscode가 사용하는 API를 지원하는 버전인지 확인
"engines": { "vscode": "^1.82.0" }
```

**증상**: `It seems the README.md file is a dummy`

```bash
# 해결: README.md에 실제 내용 작성 (기본 템플릿 그대로 두면 에러)
```

### 9.2 VSIX 설치 후 Extension 동작 안 함

1. **VS Code 재시작**: `Ctrl+Shift+P` → `Developer: Reload Window`
2. **Output 로그 확인**: Output 패널 → 드롭다운에서 "Jupyter Live Share" 선택
3. **Developer Tools 확인**: `Ctrl+Shift+I` → Console 탭에서 에러 메시지 확인
4. **Extension 상태 확인**: Extensions 패널에서 "Jupyter Live Share" 찾아서 Enabled 상태인지 확인
5. **activationEvents 확인**: `.ipynb` 파일을 열거나 명령어를 실행해야 활성화됨

### 9.3 cloudflared 관련 문제

**증상**: 터널 생성 실패

```bash
# 1. cloudflared 바이너리 수동 다운로드
# https://github.com/cloudflare/cloudflared/releases/latest
# Windows: cloudflared-windows-amd64.exe 다운로드
# bin/ 디렉토리에 cloudflared.exe로 저장

# 2. 또는 터널 비활성화 (같은 네트워크 내에서만 사용)
# VS Code Settings → Jupyter Live Share → Tunnel Provider → "none"
```

**증상**: 터널은 생성되지만 외부 접속 불가

```bash
# DNS 전파 대기 (최대 30초)
# 방화벽에서 cloudflared 아웃바운드 연결 허용 필요 (HTTPS 443)
```

### 9.4 포트 충돌

**증상**: `Port 3000 is already in use`

```bash
# Windows에서 포트 사용 프로세스 확인
netstat -ano | findstr :3000

# 해당 프로세스 종료 (PID 확인 후)
taskkill /PID <PID> /F

# 또는 포트 변경
# VS Code Settings → Jupyter Live Share → Port → 3001
```

### 9.5 방화벽 차단

**증상**: 같은 네트워크에서 `http://PC-IP:3000` 접속 불가

```bash
# Windows 방화벽에서 Node.js 인바운드 규칙 추가
# 제어판 → Windows Defender 방화벽 → 고급 설정
# 인바운드 규칙 → 새 규칙 → 포트 → TCP 3000 → 허용

# 또는 Cloudflare Tunnel 사용 (HTTPS 443으로 우회)
```

### 9.6 빌드 에러

**증상**: TypeScript 컴파일 에러

```bash
# 의존성 재설치
rm -rf node_modules
rm -rf dist
npm install
npm run build
```

**증상**: webpack 번들 에러

```bash
# webpack 및 관련 도구 재설치
npm install --save-dev webpack webpack-cli ts-loader copy-webpack-plugin
npm run build
```

### 9.7 뷰어 파일이 dist에 없음

**증상**: `dist/viewer/` 디렉토리가 비어있거나 없음

```bash
# viewer/ 원본 디렉토리 존재 확인
ls viewer/

# webpack.config.js의 CopyPlugin 설정 확인
# from: 'viewer' → to: 'viewer' 경로가 올바른지 확인

# 수동으로 복사 (임시 조치)
cp -r viewer/ dist/viewer/
```

---

## 10. 배포 롤백

문제 발생 시 이전 버전으로 되돌리는 절차입니다.

### 10.1 VSIX 배포 롤백

```bash
# 이전 버전의 .vsix 파일로 재설치
code --install-extension jupyter-live-share-0.1.0.vsix --force
```

> 이전 버전 `.vsix` 파일을 항상 보관해두세요.

### 10.2 마켓플레이스 배포 롤백

```bash
# 방법 1: 이전 버전으로 재게시
# package.json version을 이전 값으로 변경 후
npm run build
vsce publish

# 방법 2: 문제 버전 비게시 (극단적 조치)
# 마켓플레이스 관리 페이지에서 해당 버전 삭제
# https://marketplace.visualstudio.com/manage
```

### 10.3 롤백 후 확인

1. Extension 재시작 (`Developer: Reload Window`)
2. Extension 버전 확인 (Extensions 패널 → Jupyter Live Share → 버전 표시)
3. 핵심 기능 테스트 (세션 시작, 뷰어 접속, 실시간 업데이트)

---

## 부록: 주요 명령어 요약

| 작업 | 명령어 |
|------|--------|
| 의존성 설치 | `npm install` |
| 개발 빌드 | `npm run compile` |
| 프로덕션 빌드 | `npm run build` |
| 감시 모드 | `npm run watch` |
| 린트 검사 | `npm run lint` |
| VSIX 패키징 | `vsce package` |
| 포함 파일 확인 | `vsce ls` |
| 로컬 설치 | `code --install-extension <file>.vsix` |
| 로컬 제거 | `code --uninstall-extension jupyter-live-share.jupyter-live-share` |
| 마켓 로그인 | `vsce login <publisher>` |
| 마켓 게시 | `vsce publish` |
| 마켓 패치 게시 | `vsce publish patch` |
| Pre-release 게시 | `vsce publish --pre-release` |
