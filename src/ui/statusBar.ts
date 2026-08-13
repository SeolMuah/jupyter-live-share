import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  // 터미널 공유 전용 항목. 기존 item은 터널 URL이 있으면 command를 URL 복사로 덮어쓰므로
  // 거기에 클릭 액션을 더하면 경합한다. 그래서 항목을 따로 둔다.
  private terminalItem: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codeClassLive.startSession';
    this.terminalItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.terminalItem.command = 'codeClassLive.stopShareTerminal';
    this.hide();
  }

  /** 터미널 공유 중일 때만 보이는 표시. 클릭하면 공유를 중지한다. */
  showTerminalSharing(terminalName?: string) {
    const name = terminalName ? `: ${terminalName}` : '';
    this.terminalItem.text = `$(terminal) Terminal 공유 중${name}`;
    this.terminalItem.tooltip = terminalName
      ? `학생에게 공유 중인 터미널: ${terminalName}\n클릭하면 공유를 중지합니다`
      : '학생에게 터미널을 공유 중입니다. 클릭하면 중지합니다';
    this.terminalItem.show();
  }

  hideTerminalSharing() {
    this.terminalItem.hide();
  }

  show(viewerCount: number, tunnelUrl?: string) {
    this.item.text = `$(broadcast) Live Share: ${viewerCount}명 접속`;
    this.item.tooltip = tunnelUrl
      ? `${tunnelUrl}\nClick to copy URL`
      : 'Code Class Live Sharing';
    this.item.command = tunnelUrl ? undefined : 'codeClassLive.startSession';

    if (tunnelUrl) {
      // URL 복사 명령으로 변경
      this.item.command = {
        title: 'Copy URL',
        command: 'codeClassLive.copyUrl',
      } as unknown as string;
    }

    this.item.show();
  }

  updateCount(count: number) {
    this.item.text = `$(broadcast) Live Share: ${count}명 접속`;
  }

  hide() {
    this.item.text = '$(broadcast) Live Share';
    this.item.tooltip = 'Start Code Class Live Sharing session';
    this.item.command = 'codeClassLive.startSession';
    this.item.hide();
    this.terminalItem.hide();
  }

  dispose() {
    this.item.dispose();
    this.terminalItem.dispose();
  }
}
