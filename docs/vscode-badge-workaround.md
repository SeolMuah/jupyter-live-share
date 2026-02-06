# VS Code WebviewView.badge 초기화 버그 및 워크어라운드

## 문제

`WebviewView.badge = undefined` 설정 시 Activity Bar 아이콘에서 뱃지가 제거되지 않는 VS Code 버그.

### 증상

- 사이드바에 안읽은 메시지 뱃지(숫자)가 표시됨
- 사이드바를 열거나 클릭해도 뱃지가 사라지지 않음
- `onDidChangeVisibility`, `mousedown`, `focusin` 등 모든 초기화 경로에서 동일하게 실패

### 원인

VS Code 내부에서 `badge = undefined` 할당 시 `Cannot read properties of undefined (reading 'value')` 에러가 발생하여 UI 업데이트가 무시됨.

### 관련 이슈

- [microsoft/vscode#162900](https://github.com/microsoft/vscode/issues/162900) - View badge extension API documentation wrong
- [microsoft/vscode PR #210645](https://github.com/microsoft/vscode/pull/210645) - Clear Activity Bar icon badge correctly

## 워크어라운드

`undefined` 대신 `{ value: 0, tooltip: '' }` 사용:

```typescript
// BAD - 뱃지가 안 사라짐
this._view.badge = undefined;

// GOOD - 뱃지 정상 제거
this._view.badge = { value: 0, tooltip: '' };
```

## 적용 위치

- `src/ui/sidebarView.ts` - `_updateBadge()` 메서드
- `src/ui/viewerChatPanel.ts` - `_updateBadge()` 메서드

## 뱃지 초기화 트리거

1. `onDidChangeVisibility` - 사이드바 visibility 변경 시
2. `mousedown` / `focusin` - 사이드바 내부 클릭/포커스 시
3. `visibilitychange` / `window.focus` - 웹뷰 가시성 변경 시
4. `setInterval` 1초 폴링 - `visible && unreadCount > 0` 조건 충족 시 (안전장치)
5. `ready` 메시지 - 웹뷰 최초 로드 시
