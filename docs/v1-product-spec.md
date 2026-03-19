# LLM Clip V1 Product Spec

## Product Thesis

LLM Clip is a super lightweight clipping tool for developers and designers.

It should feel faster and less invasive than a full bug-reporting platform:

- clip the current tab instantly
- annotate in seconds
- attach useful technical context
- copy or send a clean bundle to Claude or Codex

The product should be local-first by default.

## Core Promise

Capture one browser state and turn it into a clean AI-ready debug bundle.

## Target Users

### Primary

- frontend engineers
- design engineers
- solo builders
- indie developers working directly with Claude or Codex

### Secondary

- designers who need to hand off UI bugs cleanly
- QA collaborators who want a lighter alternative to full replay tools

## Positioning

LLM Clip should not try to beat Jam.dev on replay, team workflows, or managed SaaS reporting.

LLM Clip should win on:

- speed
- low friction
- local-first privacy
- AI handoff quality
- cost

Framing:

> One shortcut. One clip. One clean bundle for Claude or Codex.

## Pricing Direction

### Free

- current-tab clipping
- region clipping
- annotation
- local copy/export

### Pro

Target price:

- `$12/year` billed annually

Pro value:

- debugging mode
- better runtime context
- local workspace bundle writing
- Claude/Codex handoff polish
- saved local session history controls
- prompt packaging improvements

## Non-Goals For V1

- full session replay
- cloud clip storage
- team dashboards
- Jira/Linear integrations
- multi-user collaboration
- mandatory accounts

## Product Modes

### 1. Instant Full-Tab Clip

Shortcut-driven.

Flow:

1. User presses the full-tab shortcut.
2. LLM Clip captures the visible current tab immediately.
3. The annotation workspace opens.
4. User can annotate, copy, save, or clip more.

### 2. Region Clip

Shortcut-driven.

Flow:

1. User presses the region shortcut.
2. LLM Clip opens the region picker on the current tab.
3. User drags an area.
4. The annotation workspace opens for that crop.

### 3. Clip Session

Session behavior:

- user can save multiple clips into one local session
- user can annotate each clip
- user can copy one clip or copy/export the whole session
- session stays local unless the user explicitly exports or sends

## UX Principles

### Fast by default

- full-tab clip should be one keystroke
- region clip should be two motions: shortcut, drag
- no screen picker
- no extra confirmation step for the common path

### Local-first

- clips are stored locally
- bundles are created locally
- no cloud dependency required for core value

### Evidence first

- screenshot and annotations stay primary
- AI summary should never hide raw evidence
- runtime data should be attached in clearly labeled cards

### Permission-light

- start with minimal permissions
- offer richer debugging as an explicit opt-in

## V1 Feature Set

### Must have

- full-tab clip shortcut
- region clip shortcut
- annotation workspace
- box, arrow, and text annotations
- save clip
- save and clip more
- copy current clip image
- copy/export session bundle
- page metadata
- visible page summary

### Debugging mode

Opt-in, but likely accepted by many technical users if clearly explained.

Initial debugging signals:

- console errors
- console warnings
- unhandled promise rejections
- route changes
- failed `fetch` / `XMLHttpRequest`
- slow `fetch` / `XMLHttpRequest`

Deferred debugging signals:

- browser-level network not exposed through page JS
- full DevTools protocol capture via `debugger`

### AI handoff

V1 AI handoff should focus on packaging, not hosted inference.

Outputs:

- `context.json`
- `prompt.md`
- `annotated.png`
- `annotations.json`

Targets:

- Claude
- Codex
- manual copy/paste into other LLMs

## Local Storage Model

No cloud clip storage by default.

### In-extension storage

Used for:

- current session state
- recent clips
- active annotations
- lightweight preferences

### Optional file output

Recommended local bundle shape:

```text
snapclip-local/
  sessions/
    2026-03-18/
      clip-001/
        screenshot.png
        annotated.png
        context.json
        annotations.json
        prompt.md
```

Principles:

- human-readable
- easy to inspect
- easy to attach to local coding workflows
- easy to delete

## Data Attached To A Clip

### Always-on lightweight context

- title
- URL
- viewport
- browser user agent
- platform
- language
- time zone
- selected text
- visible headings
- visible buttons
- visible fields

### Debugging mode context

- console errors
- console warnings
- unhandled rejections
- route changes
- failed requests
- slow requests

### Local app monitor context

For local workflows only:

- recent local app runtime events from the SnapTool-style bridge
- local app DOM summary
- local app identity and last-seen metadata

## Permission Model

### Baseline install permissions

- `activeTab`
- `scripting`
- `storage`
- `downloads`
- `sidePanel`

### Optional richer capture later

- `debugger`
- broader host permissions only if clearly necessary

## Technical Strategy

### Baseline architecture

- Manifest V3
- service worker
- popup
- side panel
- page-level injected capture and monitor logic

### Runtime monitoring strategy

Start lightweight:

- inject monitor into page main world
- patch `console.error`, `console.warn`
- listen for `window.onerror` and `unhandledrejection`
- patch `history.pushState` and `history.replaceState`
- patch `fetch` and `XMLHttpRequest`

Defer:

- `debugger`
- browser-wide request capture

## Why This Business Can Be Cheap

The core loop is local-first:

- no mandatory backend
- no required clip hosting
- no replay pipeline
- no video infrastructure
- no heavy ingestion costs

That makes a low-cost subscription plausible if the workflow quality is strong.

## V1 Success Criteria

- one-keystroke full-tab clipping feels instant
- developers trust the runtime context enough to use it in real debugging
- exported prompt/bundle feels immediately useful to Claude or Codex
- local-first behavior is obvious and reassuring
- users feel the tool saves time every week

## Build Order

### Phase A: Clip workflow polish

- make the annotator match SnapTool quality
- improve side panel layout
- finish save/copy/save-and-clip-more flow

### Phase B: Debugging mode

- stabilize runtime events
- stabilize failed/slow request capture
- expose debugging mode clearly in UI

### Phase C: Local bundle output

- write clip bundles to disk
- improve prompt packaging
- add one-click copy for Claude/Codex

### Phase D: Local monitor bridge

- detect active local app monitors
- let users attach local runtime context
- include bridge context in bundles

## Open Decisions

- whether debugging mode is on by default for technical users or explicitly toggled
- whether Pro starts at runtime diagnostics or at local bundle writing
- whether the first paid feature is Claude/Codex bundle polish or saved local history controls

## Recommendation

Build LLM Clip as a privacy-friendly, local-first, AI-ready clip tool for developers and designers.

Do not optimize for cloud storage or team collaboration first.

Optimize for:

- instant use
- excellent annotation
- useful technical context
- frictionless Claude/Codex handoff
