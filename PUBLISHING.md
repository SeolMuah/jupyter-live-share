# Extension 배포 방법 가이드

Azure Marketplace 외에 VS Code Extension을 배포하는 방법들을 정리합니다.

---

## 1. VSIX 직접 배포 (가장 간단, 권장)

Azure 계정이 필요 없고, 가장 간단한 배포 방법입니다.

### 1.1 VSIX 파일 생성

```bash
# 빌드 + 패키징
npm run build
npx @vscode/vsce package
```

`jupyter-live-share-0.1.0.vsix` 파일이 생성됩니다.

### 1.2 배포 방법

| 방법 | 설명 |
|------|------|
| USB / 공유 폴더 | `.vsix` 파일을 USB나 네트워크 드라이브로 전달 |
| 이메일 / 메신저 | `.vsix` 파일을 직접 전송 |
| GitHub Releases | GitHub 저장소의 Release에 첨부 (아래 참고) |
| 학교 LMS | 학습관리시스템에 파일 업로드 |

### 1.3 학생 설치 방법

**방법 A: VS Code UI**

1. VS Code 열기
2. `Ctrl+Shift+X` (Extensions 패널)
3. 상단 `...` → **"Install from VSIX..."**
4. 다운로드받은 `.vsix` 파일 선택
5. VS Code 재시작

**방법 B: 명령줄**

```bash
code --install-extension jupyter-live-share-0.1.0.vsix
```

### 1.4 교실 대량 설치 스크립트

`install.bat` 파일을 `.vsix`와 함께 배포:

```bat
@echo off
echo Jupyter Live Share Extension 설치 중...
code --install-extension "%~dp0jupyter-live-share-0.1.0.vsix" --force
if %errorlevel% equ 0 (
    echo 설치 완료! VS Code를 재시작하세요.
) else (
    echo 설치 실패. VS Code가 설치되어 있는지 확인하세요.
)
pause
```

> `%~dp0`은 배치 파일이 위치한 디렉토리를 가리킵니다. `.vsix`와 `.bat`를 같은 폴더에 두면 됩니다.

---

## 2. GitHub Releases 배포

GitHub 저장소의 Releases 기능을 활용하여 버전별로 `.vsix` 파일을 배포합니다.

### 2.1 Release 생성 (웹)

1. GitHub 저장소 → **Releases** → **"Create a new release"**
2. Tag: `v0.1.0`
3. Title: `v0.1.0 - 초기 릴리스`
4. Description: 변경사항 작성
5. **Attach binaries**: `jupyter-live-share-0.1.0.vsix` 파일 첨부
6. **Publish release**

### 2.2 Release 생성 (CLI)

```bash
# GitHub CLI 설치 필요 (https://cli.github.com/)
gh release create v0.1.0 jupyter-live-share-0.1.0.vsix \
  --title "v0.1.0 - 초기 릴리스" \
  --notes "Jupyter Notebook 실시간 공유 Extension"
```

### 2.3 학생 다운로드

학생에게 Release 페이지 URL을 공유:

```
https://github.com/SeolMuah/jupyter-live-share/releases/latest
```

학생은 `.vsix` 파일을 다운로드하여 위 1.3의 방법으로 설치합니다.

---

## 3. Open VSX Registry 배포

[Open VSX](https://open-vsx.org/)는 Eclipse Foundation이 운영하는 오픈소스 Extension 마켓플레이스입니다. VS Code 외에도 VSCodium, Gitpod, Eclipse Theia 등에서 사용합니다.

**Azure 계정이 필요 없습니다.** GitHub 계정만 있으면 됩니다.

### 3.1 ovsx CLI 설치

```bash
npm install -g ovsx
```

### 3.2 Access Token 발급

1. [https://open-vsx.org/](https://open-vsx.org/) 접속
2. **GitHub 계정으로 로그인**
3. 우측 상단 프로필 → **Access Tokens** → **Generate New Token**
4. 토큰 복사 후 안전한 곳에 보관

### 3.3 네임스페이스 생성

```bash
# 최초 1회: 퍼블리셔 네임스페이스 생성
ovsx create-namespace jupyter-live-share -p <YOUR_TOKEN>
```

### 3.4 배포

```bash
# VSIX 파일 생성 후
npm run build
npx @vscode/vsce package

# Open VSX에 배포
ovsx publish jupyter-live-share-0.1.0.vsix -p <YOUR_TOKEN>
```

### 3.5 확인

배포 후 확인: `https://open-vsx.org/extension/jupyter-live-share/jupyter-live-share`

### 3.6 장단점

| 장점 | 단점 |
|------|------|
| Azure 계정 불필요 | VS Code 기본 마켓플레이스가 아님 |
| GitHub 계정으로 간편 로그인 | 사용자 기반이 상대적으로 작음 |
| VSCodium/Gitpod 등에서도 사용 가능 | VS Code에서 별도 설정 필요 (아래 참고) |
| 오픈소스 프로젝트에 적합 | |

### 3.7 VS Code에서 Open VSX 사용

VS Code는 기본적으로 Microsoft 마켓플레이스를 사용합니다. Open VSX에서 설치하려면:

- VSIX 파일을 직접 다운로드하여 수동 설치, 또는
- VSCodium을 사용하면 Open VSX가 기본 마켓플레이스

---

## 4. 자체 웹사이트 / 파일 서버 배포

학교나 기관의 웹사이트에 `.vsix` 파일을 호스팅합니다.

### 4.1 정적 파일 호스팅

```
https://your-school-site.com/extensions/jupyter-live-share-0.1.0.vsix
```

학생에게 다운로드 링크를 공유하면 됩니다.

### 4.2 다운로드 페이지 예시

```html
<h2>Jupyter Live Share Extension 설치</h2>
<ol>
  <li><a href="jupyter-live-share-0.1.0.vsix">Extension 다운로드</a></li>
  <li>VS Code 열기 → Ctrl+Shift+X → ... → "Install from VSIX..."</li>
  <li>다운로드받은 파일 선택 → VS Code 재시작</li>
</ol>
```

---

## 5. 배포 방법 비교

| 방법 | 난이도 | 계정 필요 | 자동 업데이트 | 적합한 상황 |
|------|--------|----------|-------------|------------|
| **VSIX 직접 배포** | 쉬움 | 없음 | 없음 | 교실 내부, 소규모 |
| **GitHub Releases** | 쉬움 | GitHub | 없음 | 오픈소스, 버전 관리 |
| **Open VSX** | 보통 | GitHub | 있음 (VSCodium) | 오픈소스, 글로벌 배포 |
| **VS Code Marketplace** | 보통 | Azure | 있음 | 일반 공개 배포 |
| **자체 웹사이트** | 쉬움 | 없음 | 없음 | 기관 내부 배포 |

### 교실 환경 권장

**VSIX 직접 배포 + GitHub Releases** 조합을 추천합니다:

1. `npm run build && npx @vscode/vsce package`로 VSIX 생성
2. GitHub Release에 VSIX 첨부
3. 학생에게 Release 페이지 URL 공유
4. 학생이 VSIX 다운로드 후 VS Code에 설치

이 방식은 Azure 계정이 필요 없고, 버전 관리가 되며, 학생이 쉽게 다운로드할 수 있습니다.

---

## 6. 업데이트 배포

### VSIX 직접 배포 시

```bash
# 1. 버전 올리기
npm version patch  # 0.1.0 → 0.1.1

# 2. 빌드 + 패키징
npm run build
npx @vscode/vsce package

# 3. 새 VSIX 배포 (GitHub Release 또는 직접 전달)

# 4. 학생: 새 VSIX로 재설치 (기존 버전 자동 덮어씀)
code --install-extension jupyter-live-share-0.1.1.vsix --force
```

### Open VSX 배포 시

```bash
npm version patch
npm run build
npx @vscode/vsce package
ovsx publish jupyter-live-share-0.1.1.vsix -p <YOUR_TOKEN>
```
