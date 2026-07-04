# Privacy Policy — Code Class Live Sharing

_Last updated: 2026-07-04_

Code Class Live Sharing is a VS Code extension that lets a teacher share files from their own machine with students in real time. This document describes exactly what data the extension handles and where it goes.

## Summary

- **No data is ever sent to the extension developer.** There is no telemetry, no analytics, and no account system.
- Everything you share travels **directly from the teacher's machine to the students' browsers**, optionally through a Cloudflare Tunnel acting as an encrypted relay.
- **Nothing is stored on any server.** Session data lives only in the memory of the teacher's machine and disappears when the session ends.

## What data is handled during a session

| Data | Source | Where it goes | Stored? |
| --- | --- | --- | --- |
| Shared file contents (code, notebook cells, outputs, images) | The file the teacher chooses to share | Student browsers connected to the session | In memory only, discarded at session end |
| Teacher display name | Entered by the teacher | Student browsers | In memory only |
| Student display names | Entered by each student | Teacher and other students (chat) | In the student's own browser (`localStorage`, for auto-fill); session memory only on the teacher's machine |
| Chat messages | Teacher and students | All session participants | In memory only, discarded at session end |
| Poll questions and votes | Teacher (question), students (votes) | All session participants (aggregated results) | In memory only |
| Drawings / annotations | Teacher | Student browsers | In memory only |

## How the data travels

1. The extension runs a local HTTP/WebSocket server **on the teacher's machine** (bound to `127.0.0.1` by default).
2. With the teacher's explicit consent, the extension runs Cloudflare's [`cloudflared`](https://github.com/cloudflare/cloudflared) tool to create a **temporary public URL** (`https://<random>.trycloudflare.com`). Cloudflare relays the encrypted traffic between the teacher's machine and students' browsers; see [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/) for their handling of relayed traffic.
3. Anyone who has the session URL can view the shared file while the session is running. The URL is random per session and stops working the moment the session ends. Teachers should share the URL only with their class.
4. If consent is declined or `codeClassLive.tunnelProvider` is set to `none`, the session is reachable only from the teacher's own machine (localhost).

## The cloudflared executable

If `cloudflared` is not already installed on the teacher's machine, the extension downloads it **once**, on first tunnel use and only after the teacher confirms a consent dialog:

- Downloaded from Cloudflare's **official GitHub release**, pinned to a specific version.
- The download is verified against a **hard-coded SHA-256 checksum** before it is ever executed; on mismatch the file is discarded.
- Stored in the extension's own storage directory. No other software is installed.

## Third-party components

- **Cloudflare Tunnel** (`trycloudflare.com`) — transit relay for session traffic (only with consent, as above).
- **cdnjs.cloudflare.com** — the student browser viewer loads standard rendering libraries (highlight.js, marked, KaTeX, DOMPurify, Mermaid) from this CDN with subresource integrity (SRI) checks.

## Children / classroom use

The extension is designed for classroom use. It requires no student accounts, collects no student data beyond the self-chosen display name and chat/poll input above, and transmits nothing to the developer. Teachers are responsible for choosing what they share and with whom they share the session URL, in line with their institution's policies.

## Contact

Questions or concerns: **seolmuah@gmail.com** · [GitHub Issues](https://github.com/paircodingofficial-cloud/code-class-live-sharing/issues)
