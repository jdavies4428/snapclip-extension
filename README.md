# LLM Clip Extension

LLM Clip is a greenfield Chrome extension for current-tab capture and AI-first context packaging. This repository is intentionally separate from the existing `SnapTool` app and starts with a Manifest V3 architecture from day one.

## Current milestone

This repo is now in the staged v1 buildout. The live implementation currently covers the Stage 1 capture-core foundation plus early runtime collection work:

- installs locally as an unpacked extension
- popup opens and can trigger current-tab clipping
- keyboard shortcuts can start visible-tab and region clipping
- side panel is the main clip workspace
- side panel can request current-site access to launch capture directly
- side panel can assemble a deterministic incident packet and talk to the local LLM Clip bridge
- active-tab capture reads page title, URL, viewport, user agent, selected text, and compact DOM summary
- image assets are stored outside `chrome.storage.local`
- clips can be copied or exported as JSON/Markdown from the side panel
- Claude/Codex handoff controls now exist in the side panel, backed by the localhost bridge flow
- early runtime context capture exists for console, route, and fetch/XHR diagnostics

Not included yet:

- full SnapTool-parity annotation tools
- local bundle writing to a workspace folder
- Claude/Codex hook delivery
- opt-in bounded debug mode UX
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

Unsupported pages:
- `chrome://`
- Chrome Web Store
- extension pages
- PDF tabs

## Docs

- [Architecture](./docs/architecture.md)
- [Permissions](./docs/permissions.md)
- [Snapshot schema](./docs/snapshot-schema.md)
- [Roadmap](./docs/roadmap.md)
- [Implementation todo](./todo.md)
