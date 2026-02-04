import * as vscode from 'vscode';

interface SessionState {
  isRunning: boolean;
  url?: string;
  pin?: string;
  viewerCount: number;
  fileName?: string;
}

export class SessionViewProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private state: SessionState = {
    isRunning: false,
    viewerCount: 0,
  };

  constructor(private readonly _extensionUri: vscode.Uri) {}

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  updateState(update: Partial<SessionState>) {
    Object.assign(this.state, update);
    this.refresh();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionItem[] {
    if (!this.state.isRunning) {
      return [
        new SessionItem(
          'Start Session',
          'Click to start sharing',
          vscode.TreeItemCollapsibleState.None,
          {
            command: 'jupyterLiveShare.startSession',
            title: 'Start Session',
          }
        ),
      ];
    }

    const items: SessionItem[] = [];

    items.push(new SessionItem(
      'Status',
      'Sharing...',
      vscode.TreeItemCollapsibleState.None
    ));

    if (this.state.url) {
      const urlItem = new SessionItem(
        'URL',
        this.state.url,
        vscode.TreeItemCollapsibleState.None
      );
      urlItem.tooltip = 'Click to copy URL';
      items.push(urlItem);
    }

    if (this.state.pin) {
      items.push(new SessionItem(
        'PIN',
        this.state.pin,
        vscode.TreeItemCollapsibleState.None
      ));
    }

    items.push(new SessionItem(
      'Viewers',
      `${this.state.viewerCount}`,
      vscode.TreeItemCollapsibleState.None
    ));

    if (this.state.fileName) {
      items.push(new SessionItem(
        'File',
        this.state.fileName,
        vscode.TreeItemCollapsibleState.None
      ));
    }

    items.push(new SessionItem(
      'Stop Session',
      'Click to stop sharing',
      vscode.TreeItemCollapsibleState.None,
      {
        command: 'jupyterLiveShare.stopSession',
        title: 'Stop Session',
      }
    ));

    return items;
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    private readonly value: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
    this.description = value;
  }
}
