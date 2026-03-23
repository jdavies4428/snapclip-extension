# Architecture

## Current shape

This repository is extension-first and Manifest V3-native.

Primary runtime surfaces:

- service worker for routing, capture orchestration, and storage coordination
- popup for lightweight launch actions
- side panel as the main review workspace
- in-page editor modal for annotation and clip-scoped send/copy actions
- injected active-tab script for page metadata and selection capture
- localhost bridge for workspace/session discovery, deterministic bundle writing, Claude hook integration, and Claude delivery

## Module responsibilities

### `src/manifest`

- defines the MV3 manifest in TypeScript
- keeps permissions minimal
- wires popup, side panel, and service worker entrypoints

### `src/service-worker`

- routes runtime messages
- opens the side panel on demand
- executes the current-tab clip workflow
- captures visible-tab screenshots
- persists the clip session to extension storage
- persists clip-level handoff summaries back into local storage
- handles clip-session export downloads for JSON and Markdown
- validates supported tabs before capture starts

### `src/content-script`

- contains page-context extraction logic
- summarizes headings, buttons, and form fields
- reads selected text without requesting broad host permissions

This bootstrap milestone uses `chrome.scripting.executeScript()` with `activeTab`, so the content-script logic is injected only after an explicit user action.

### `src/popup`

- offers launch actions and fallback help
- starts visible-tab or region clipping
- shows a compact status message

### `src/side-panel`

- renders the local clip session
- becomes the main review surface for annotation, evidence, export, and AI handoff work
- owns bridge settings, workspace/session selection, and task-status visibility

### `bridge`

- exposes `/workspaces`, `/sessions`, `/approvals`, `/tasks`, and Claude hook endpoints over localhost
- tracks live Claude sessions from hook events
- writes deterministic bundles into the selected workspace
- resumes Claude sessions with `claude --resume <sessionId> -p ...`
- keeps delivery status queryable so the extension can poll instead of guessing

### `src/shared`

- shared page-context and clip-session types
- messaging contracts
- storage keys and small utilities

## Data flow

1. User starts a visible-tab or region clip from the popup or keyboard shortcut.
2. The service worker validates that the current tab is supported.
3. The service worker injects the page-context extractor into the active tab.
4. The service worker captures the visible tab screenshot.
5. For visible clips, the screenshot is committed directly into the current `ClipSession`.
6. For region clips, an in-page overlay lets the user draw a region, then the cropped result is committed into the same session.
7. The side panel reads and renders the current clip session from `chrome.storage.local`.
8. When the user sends a handoff, the side panel builds one deterministic packet and posts it to the localhost bridge.
9. The bridge writes the bundle first, optionally resumes a live Claude session, and exposes task state for polling.
10. The side panel stores the final handoff summary back on the clip so delivery state survives reloads.

## Why this structure

- Keeps MV3 responsibilities separate early.
- Avoids broad host permissions by using `activeTab`.
- Keeps the core product current-tab-first and local-first.
- Keeps the extension responsible for evidence and authoring, while the bridge owns live Claude integration.
- Leaves clear seams for later work like storage hardening, approval UX, and optional advanced debugging.
