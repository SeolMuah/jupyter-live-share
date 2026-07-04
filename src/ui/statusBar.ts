import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codeClassLive.startSession';
    this.hide();
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
  }

  dispose() {
    this.item.dispose();
  }
}
