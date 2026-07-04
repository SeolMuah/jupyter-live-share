# Code Class Live Sharing

A VS Code extension that lets teachers share files (.ipynb, .py, .txt, .md, etc.) with students in real-time via browser. Works great with Jupyter notebooks.

> **한국어 설명은 Notion 문서를 참고해주세요:** [Notion 문서 바로가기](https://www.notion.so/Jupyter-Live-Share-2fdfceb573c381e78170c6808dad708a)

## ⚠️ How sharing works — please read

- Starting a session runs a **local server on your machine** (bound to `127.0.0.1` by default).
- To let students connect from outside, the extension runs Cloudflare's **`cloudflared`** tool to create a **temporary public URL** (`https://<random>.trycloudflare.com`). **Anyone with the URL can view the shared file while the session is running** — share it only with your class.
- If `cloudflared` is not installed, it is **downloaded once** from Cloudflare's official GitHub release — **version-pinned and SHA-256 verified** — and only **after you approve a consent dialog**. If you already have `cloudflared` on your PATH, that installation is used instead and nothing is downloaded. Declining the dialog (or setting `codeClassLive.tunnelProvider` to `none`) keeps the session on localhost only.
- **No data is sent to the developer. No telemetry.** See the full **[Privacy Policy](./PRIVACY.md)**.

## Key Features

- **Real-time Jupyter Notebook Sharing** (`.ipynb`): Cell edits, execution outputs, and cell add/delete are synced instantly
- **Text File Sharing** (`.py`, `.txt`, `.md`, etc.): Syntax highlighting, Markdown rendering, and Mermaid diagram rendering (```mermaid code blocks display as diagrams)
- **Live Cursor Tracking**: Teacher's cursor position, line highlight, and text selection are displayed on students' screens in real-time
- **Live Chat**: Teachers chat from the VS Code sidebar, students from the browser or VS Code Viewer Chat panel (with spam rate limiting)
- **Teacher Message Highlighting**: Teacher messages are displayed with a green background for easy identification
- **Live Polls**: Number mode (1, 2, 3...) and text mode (custom labels) with real-time bar chart results (one vote per student, no re-voting) — plus a one-click **Quick Check Poll** for instant understanding checks
- **Teacher Display Name**: Set a custom name before starting a session (default: "Teacher")
- **Drawing/Annotation**: Draw on notebooks with pen/highlighter/eraser in the Teacher Preview panel, shared live with students
- **Teacher Preview Panel**: Preview exactly what students see, with drawing tools included
- **Scroll Sync**: The teacher's own editor drives student scroll — scrolling or clicking in VS Code keeps students in lockstep for both notebooks (cell anchor) and text files (line/block anchor), accurately regardless of font size or window size (no separate preview required)
- **Local Image Sharing**: Local images in Markdown/HTML are auto-converted to base64 for transmission
- **Cloudflare Tunnel**: External HTTPS access without a dedicated server
- **100 Concurrent Viewers**: Supports classroom-scale connections (configurable)
- **Dark/Light Mode**: Theme toggle in the viewer

## How It Works

```
[Teacher VS Code] → Extension → HTTP/WebSocket Server → Cloudflare Tunnel
                                                              ↓
                                           [Student Browser] ← HTTPS URL
```

1. Teacher runs `Start Session` in VS Code
2. A local server (default port 48632, loopback-bound) starts and — with your consent — generates an external URL via Cloudflare Tunnel
3. Students open the URL in a browser and enter their name
4. File edits are transmitted in real-time via WebSocket
5. Two-way communication through chat and polls

## Installation

Search for **Code Class Live Sharing** in VS Code Extensions (`Ctrl+Shift+X`) and install.

## Usage

### Starting a Session

1. Open a `.ipynb`, `.py`, `.md`, `.txt`, or other file in VS Code
2. Enter a display name in the **Code Class Live Sharing** sidebar panel (default: "Teacher")
3. Click **Start Session**
   - Or `Ctrl+Shift+P` → `Code Class Live Sharing: Start Session`
4. Share the URL shown in the status bar with students (auto-copied to clipboard)
5. The sidebar shows session info (URL, filename, viewer count) + chat panel
6. You can start a session without opening a file first (students see an empty screen until you open one)

### Stopping a Session

- Click **Stop Session** in the sidebar
- Or `Ctrl+Shift+P` → `Code Class Live Sharing: Stop Session`

### Live Chat

**Teacher (VS Code):**

- Chat area appears in the sidebar when a session starts
- Send messages from the sidebar
- Uses the display name set before session start (default: "Teacher"), not counted as a viewer
- Teacher name shown in green, student names in blue
- Teacher messages highlighted with green background

**Student (Browser Viewer):**

- Click the **Chat** button at the bottom to open the chat panel on the right
- Must enter a name to chat (saved to localStorage for auto-fill on reconnect)

**Student (VS Code Open Viewer):**

- Chat via the **Viewer Chat** panel in the terminal area
- When using Open Viewer, the in-viewer chat is hidden and separated into its own panel
- Connects via a dedicated chatOnly WebSocket (not counted as a viewer)

**Common:**

- Poll start/end events are shown as system messages in chat (with results)
- Spam protection: Students limited to 5 messages per 10 seconds, 500ms minimum interval (no limit for teachers)
- Max 500 characters per message

### Live Polls

Teachers can run real-time polls with students.

**Poll Modes:**

- **Number Mode**: Options displayed as numbers (1, 2, 3...) — default, 2–5 options
- **Text Mode**: Custom labels (e.g., "Agree", "Disagree", "Not sure")
- **Quick Check Poll**: One click starts a preset understanding check (👍 got it / 🤔 not yet)

**From VS Code Sidebar (Recommended):**

1. Click **Create Poll** in the Code Class Live Sharing sidebar
2. Enter a question → select mode (Number/Text) → configure options
   - Number mode: choose count (2–5)
   - Text mode: enter labels, one per line
3. A poll banner appears on students' browsers, and a system message is posted in chat

**From VS Code Command Palette:**

1. `Ctrl+Shift+P` → `Code Class Live Sharing: Create Poll`
2. Enter a question → choose option count (2–5, number mode only)

**From Browser (Teacher, localhost access):**

1. Click the **Poll** button at the bottom of the viewer
2. Enter a question → select mode → configure options → Start Poll

**Ending a Poll:**

- VS Code sidebar: Click **End Poll**
- Command Palette: `Ctrl+Shift+P` → `Code Class Live Sharing: End Poll`
- Browser: Click the **End Poll** button
- Final results are posted as a system message in chat

**Student Voting:**

- A poll banner appears at the top when a poll is active
- Number mode: click a number button (1–5) to vote
- Text mode: click a label button to vote
- One vote per student — no re-voting (buttons are disabled after voting)
- Results update as a live bar chart (with labels in text mode)

## Settings

| Setting                        | Default       | Description                                  |
| ------------------------------ | ------------- | -------------------------------------------- |
| `codeClassLive.port`           | `48632`       | Local server port                            |
| `codeClassLive.maxViewers`     | `100`         | Max concurrent viewers                       |
| `codeClassLive.tunnelProvider` | `cloudflare`  | Tunnel provider (`cloudflare` or `none`)     |
| `codeClassLive.bindAddress`    | `127.0.0.1`   | Server bind interface. Keep the default unless you need direct LAN access without the tunnel — `0.0.0.0` exposes the session to everyone on your local network |

## Supported File Types

| File Type              | Share Mode | Rendering                                                            |
| ---------------------- | ---------- | -------------------------------------------------------------------- |
| `.ipynb`             | notebook   | Cell-based (Markdown + Code + Output)                                |
| `.py`                | plaintext  | Python syntax highlighting                                           |
| `.md`                | plaintext  | Markdown rendering (raw text when cursor active, rendered when idle) |
| `.txt`               | plaintext  | Plain text                                                           |
| `.js`, `.ts`, etc. | plaintext  | Syntax highlighting                                                  |

## Cloudflare Tunnel

This extension uses [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`) for external access:

- **Your consent is asked once** before the tunnel is first used (declining keeps the session on localhost).
- If `cloudflared` is already installed on your PATH, that installation is used.
- Otherwise it is downloaded **once** from [Cloudflare's official GitHub release](https://github.com/cloudflare/cloudflared/releases), **pinned to a specific version and verified against a hard-coded SHA-256 checksum** before execution. On checksum mismatch the file is discarded and never run.
- The binary is stored in the extension's storage directory and reused for subsequent sessions.

## Privacy

No telemetry, no analytics, no data sent to the developer. Session data (shared files, chat, polls, drawings) travels directly from your machine to students' browsers and is never stored on a server. Full details: **[Privacy Policy](./PRIVACY.md)**.

## Support / 문의

- 버그 제보·기능 제안: [GitHub Issues](https://github.com/paircodingofficial-cloud/code-class-live-sharing/issues)
- 이메일: seolmuah@gmail.com

## License

MIT
