# LLM Clip Extension

LLM Clip is a greenfield Chrome extension for current-tab capture and AI-first context packaging. This repository is intentionally separate from the existing `SnapTool` app and starts with a Manifest V3 architecture from day one.

## Current milestone

This repo is now in the staged v1 buildout. The live implementation currently covers capture, local persistence, and bridge-backed AI handoff:

- installs locally as an unpacked extension
- popup opens and can trigger current-tab clipping
- keyboard shortcuts can start visible-tab and region clipping
- side panel is the main clip workspace
- the side panel capture buttons are the only current-site access launch surface
- the editor modal stays focused on post-capture annotation, copy, export, and send
- side panel can assemble a deterministic incident packet and talk to the local LLM Clip bridge
- the localhost bridge can discover workspaces, track live Claude sessions from Claude Code hooks, and queue/resume Claude delivery
- saved clips persist the latest handoff outcome so bundle-only vs delivered status survives reloads
- active-tab capture reads page title, URL, viewport, user agent, selected text, and compact DOM summary
- image assets are stored outside `chrome.storage.local`
- clips can be copied or exported as JSON/Markdown from the side panel
- Claude/Codex handoff controls exist in both the side panel and the clip editor, backed by the localhost bridge flow
- runtime context capture includes console, route, fetch/XHR diagnostics, plus a bounded Chrome debugger snapshot when Chrome allows it

Not included yet:

- full SnapTool-parity annotation tools
- browser-smoke-tested hook installation UX inside Chrome
- richer approval UI for pending Claude permission requests
- opt-in bounded debug mode UX polish
- full-page capture
- cloud storage, accounts, or collaboration

## Stack

- Manifest V3
- TypeScript
- Vite
- React for popup and side panel
- Zod for shared schema validation

## Local development

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. During development, rebuild on file changes:

```bash
npm run dev
```

`npm run dev` uses Vite in watch mode and writes updated extension assets into `dist/`.

## Local companion / bridge

Start the localhost bridge from the repo root:

```bash
SNAPCLIP_BRIDGE_WORKSPACES=/absolute/path/to/workspace npm run bridge:start
```

If `SNAPCLIP_BRIDGE_WORKSPACES` is omitted, the bridge uses the current repo root as its workspace. The default bridge address is `http://127.0.0.1:4311` and the default token is `snapclip-dev`.

Install Claude Code hooks into your local Claude settings:

```bash
npm run bridge:install-hooks
```

Optional overrides:

```bash
npm run bridge:install-hooks -- --settings /absolute/path/to/settings.local.json --base-url http://127.0.0.1:4311 --token snapclip-dev
```

### macOS companion management

The repo now includes macOS-only helper scripts to run the bridge as a background LaunchAgent:

```bash
npm run bridge:companion:install
npm run bridge:companion:start
npm run bridge:companion:stop
npm run bridge:companion:uninstall
```

What this does:
- installs a LaunchAgent at `~/Library/LaunchAgents/dev.llmclip.bridge.plist`
- writes a run script under `~/Library/Application Support/LLM Clip Companion/`
- keeps the existing localhost API at `http://127.0.0.1:4311`

This is a local developer-grade companion flow, not yet a polished end-user installer.
It uses the current repo path and current Node binary, so if either moves the LaunchAgent should be reinstalled.

## Load unpacked in Chrome

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select `/Users/jeffdai/snapclip-extension/dist`.
5. Pin the extension if you want faster access from the toolbar.

## How the current flow works

1. Open a normal web page.
2. Trigger a clip from the popup, keyboard shortcut, or the side panel after granting current-site access.
3. LLM Clip uses `activeTab` or current-site host access plus `chrome.scripting.executeScript()` to read lightweight page context from the current page.
4. The service worker captures a visible-tab screenshot.
5. The clip is appended to the current local clip session while image assets live in IndexedDB-backed blob storage.
6. The side panel becomes the working surface for annotation, copy, export, and bridge-backed AI handoff.
7. When the local bridge sees a live Claude session, the same bundle can be delivered directly with `claude --resume <sessionId> -p ...`; otherwise it is still preserved locally as a deterministic bundle.

Unsupported pages:
- `chrome://`
- Chrome Web Store
- extension pages
- PDF tabs

## Bridge contract

The localhost bridge now owns:

- companion health
- session-first Claude discovery
- workspace discovery fallback
- live Claude session discovery from Claude Code hooks
- pending approval tracking for Claude permission hooks
- deterministic bundle writing into the selected workspace
- direct Claude session delivery with preserved bundle failures

The extension still owns:

- capture
- annotation
- prompt drafting
- deterministic artifact assembly
- local clip/session persistence
- handoff status visibility in the side panel

## Docs

- [Architecture](./docs/architecture.md)
- [Permissions](./docs/permissions.md)
- [Snapshot schema](./docs/snapshot-schema.md)
- [Roadmap](./docs/roadmap.md)
- [Implementation todo](./todo.md)
