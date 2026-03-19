# SnapClip Implementation Todo

## Product Vision

SnapClip should be the fastest way to turn one broken browser state into a clean, trustworthy, Claude-ready incident packet.

Core loop:

1. User snaps the current browser state quickly.
2. User annotates only what matters.
3. SnapClip attaches the right technical evidence:
   - page metadata
   - DOM summary
   - optional runtime errors and network failures
   - optional deeper debug evidence
4. SnapClip writes a deterministic local bundle.
5. SnapClip sends that bundle into Claude or Codex through local hooks.

This is not a generic screenshot extension and not a Jam.dev clone.

SnapClip should win on:
- speed
- local-first privacy
- trustworthy evidence packaging
- Claude/Codex handoff quality
- low operating cost

## Product Wedge

The wedge is not "annotation parity."

The wedge is:

> Capture one broken browser state and route a clean AI-ready incident packet directly into Claude.

That means the order of operations matters:

1. reliable snap
2. useful evidence packet
3. deterministic Claude handoff
4. richer annotation polish
5. deeper optional debug capture

## Target Users

Primary:
- frontend engineers
- design engineers
- solo builders
- small teams already working heavily with Claude/Codex

Secondary:
- designers and QA collaborators handing clean bug context to engineers

## Non-Goals For V1

- replay/session video
- cloud clip storage
- accounts
- team collaboration
- Jira/Linear integrations
- browser-wide capture
- full-page stitching
- always-on deep debugger capture
- AI-generated diagnosis that hides raw evidence

## Current Repo Reality

Already present:
- MV3 extension shell
- popup, shortcut, and side-panel surfaces
- visible-tab and region capture flows
- local clip session model
- IndexedDB-backed image asset storage
- basic box annotation
- lightweight runtime context capture:
  - `console.warn`
  - `console.error`
  - `window.onerror`
  - `unhandledrejection`
  - route changes
  - failed/slow `fetch`
  - failed/slow XHR
- JSON/Markdown export
- "Copy all for Claude" style packaging

Not yet complete:
- capture reliability has not been fully QA-gated
- annotation workspace is still thin
- Claude/Codex hook delivery does not exist yet
- bounded debug UX is not productized
- deep debugger mode does not exist yet

## Planning Decision

The work should stay staged.

Do not collapse everything into one implementation push.

Reasons:
- capture reliability still needs hardening
- the handoff contract is not finalized
- storage and delivery semantics need to stabilize before hook integration
- debugger capture adds permission and trust complexity that should be gated deliberately

Rule:
- do not advance a stage until it is functionally delightful and technically sound
- every stage ends with review and QA gates
- deep debugger work must not become a hidden dependency for Stages 1 through 5

## Target Architecture

```text
Launcher
  -> popup / shortcut / side panel
  -> service worker orchestrator
  -> tab validation + permission resolution
  -> page extraction + screenshot
  -> optional runtime context
  -> clip session persistence
  -> side-panel review workspace
  -> bundle writer
  -> Claude/Codex hook delivery
```

Architecture principles:
- service worker is the orchestration boundary
- side panel is the main workspace, not the source of business logic
- bundle generation is its own module, not mixed into persistence logic
- runtime capture has two layers:
  - bounded page-level monitor
  - optional deep debugger mode

## Permission Strategy

Fast paths:
- popup uses `activeTab`
- keyboard shortcuts use `activeTab`

Side-panel path:
- side panel can request current-site access
- do not regress to blanket all-site host access requests as the normal flow

Deep debug path:
- if `chrome.debugger` is added, treat it as an explicit opt-in feature
- feature remains off by default
- user must always know when deep debug is attached
- Chrome does not allow `"debugger"` to be requested as an optional runtime permission
- therefore deep debug is also a packaging and trust decision, not only an implementation task

## Deep Debug Product Decision

Debugger-grade capture is not the product wedge.

It is an optional evidence amplifier for power users after the core handoff loop is already strong.

Product rule:

- do not reposition the product around "capture everything"
- do not let deep debug displace:
  - reliable snap
  - evidence trust
  - deterministic bundle writing
  - Claude/Codex handoff quality

Current recommendation:

- finish Stages 1 through 5 first
- evaluate whether real users still hit "bounded evidence was not enough"
- only then decide whether debugger-grade capture is worth the install-time trust cost

## Deep Debug Implementation Options

If Stage 6 is approved, one of these paths must be chosen explicitly:

### Option A: Single extension with `debugger`

- add `"debugger"` to the main manifest
- keep deep capture off by default in product UX
- accept that install/update shows the debugger permission warning to every user

### Option B: Separate power-user build or companion extension

- keep the main extension trust posture lighter
- move debugger-grade capture into a separate opt-in build
- pay the extra packaging and distribution complexity

Default recommendation:

- do not decide this until Stage 6
- if debugger capture becomes necessary, compare Option A vs Option B based on real adoption friction rather than assumption

## Bundle Contract

The handoff bundle is a first-class product artifact.

Required contents:
- `screenshot.png`
- `annotated.png`
- `context.json`
- `annotations.json`
- `prompt-claude.md`
- `prompt-codex.md`

Required properties:
- deterministic
- human-readable
- locally inspectable
- safe to preserve if hook delivery fails

Required delivery states:
- bundle written
- hook delivered
- hook failed but bundle preserved

## Stage 1: Capture Reliability

### Goal

Make capture boringly reliable across popup, shortcut, and side-panel entrypoints.

### Why this stage exists

If users cannot trust capture, nothing else matters.

### Scope

- make `ClipSession` the only active runtime model
- remove remaining legacy `SnapshotRecord` runtime assumptions
- keep visible-tab clip as the primary path
- keep region clip as the secondary path
- make popup, shortcut, and side-panel launch behavior consistent
- harden current-site side-panel permission flow
- harden supported-page validation:
  - reject `chrome://`
  - reject extension pages
  - reject Chrome Web Store pages
  - reject PDFs
  - reject discarded/unavailable tabs
- ensure the correct target window is always captured
- ensure region overlay mounts reliably
- ensure session survives reload
- ensure capture failures surface in UI, not only the console

### Files likely touched

- `/Users/jeffdai/snapclip-extension/src/service-worker/clipping.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/index.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/permissions.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/router.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/storage.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/snapshot/storage.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/types/session.ts`
- `/Users/jeffdai/snapclip-extension/src/side-panel/App.tsx`
- `/Users/jeffdai/snapclip-extension/src/popup/App.tsx`

### Acceptance gates

- no active runtime path depends on `SnapshotRecord`
- unsupported pages fail with clear user-facing messaging from every entrypoint
- popup visible clip works reliably
- popup region clip works reliably
- shortcut visible clip works reliably on supported pages
- shortcut region clip works reliably on supported pages
- side-panel current-site permission flow works
- side-panel visible clip works after permission grant
- side-panel region clip works after permission grant
- session survives reload without losing the active clip
- 20 consecutive visible clips on a normal page succeed without workflow breakage
- 10 consecutive region clips on a normal page succeed without workflow breakage

## Stage 2: Claude Handoff Core

### Goal

Make SnapClip genuinely useful for Claude/Codex workflows, not merely exportable.

### Stage split

Stage 2 should stay split internally:

- `2A Bundle Artifact`
  - deterministic incident packet assembly inside the extension
  - explicit workspace / target / scope selection in the side panel
  - visible delivery states in product UX
- `2B Bridge Delivery`
  - local bridge transport to a selected workspace
  - Claude session delivery through the existing localhost bridge
  - bundle-preserved failure states when delivery cannot complete

Implementation decision:

- use the existing localhost bridge pattern at `http://127.0.0.1:4311`
- do not invent a second transport before this path is working end to end
- Codex can start as bundle-first even if direct session delivery remains Claude-only

### Scope

- finalize the handoff bundle schema
- generate:
  - `screenshot.png`
  - `annotated.png`
  - `context.json`
  - `annotations.json`
  - `prompt-claude.md`
  - `prompt-codex.md`
- add workspace selection
- add handoff target selection:
  - Claude
  - Codex
  - export only
- write the bundle locally
- trigger the local hook path
- show delivery status
- make delivery failures retryable
- preserve bundle output if hook delivery fails

### Bundle pipeline

```text
Clip session
  -> select active clip or whole session
  -> load screenshot blob
  -> render annotated image
  -> serialize evidence files
  -> build Claude/Codex prompts
  -> write local bundle
  -> invoke local hook
  -> persist delivery result
```

### Failure cases that must be explicit

- screenshot blob missing
- annotated render fails
- bundle write partially succeeds
- hook target unavailable
- hook invocation fails
- user changes active clip during delivery

### Files likely touched

- `/Users/jeffdai/snapclip-extension/src/service-worker/session.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/router.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/storage.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/export/file.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/export/session-markdown.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/types/session.ts`
- `/Users/jeffdai/snapclip-extension/src/side-panel/App.tsx`
- new handoff/bundle modules under `/Users/jeffdai/snapclip-extension/src/service-worker/` and `/Users/jeffdai/snapclip-extension/src/shared/`

### Acceptance gates

- bundle contents are deterministic and human-readable
- Claude-ready prompt is useful without heavy editing
- Codex-ready prompt is useful without heavy editing
- local handoff failures are visible and retryable
- bundle creation still works when no hook target is available
- hook delivery never destroys the locally written bundle
- UI clearly distinguishes:
  - bundle created
  - delivered
  - failed after bundle creation

## Stage 3: Evidence Quality

### Goal

Improve packet usefulness and trustworthiness before investing in richer annotation polish.

### Stage split

- `3A Evidence Canonicalization`
  - normalize page, DOM, and runtime evidence into one compact export shape
- `3B Packet Profiles + Privacy`
  - ship `lean / balanced / full`
  - redact query params by default
  - keep prompts compact and auditable

### Scope

- strengthen evidence quality:
  - DOM summary cleanup
  - selected-text reliability
  - page metadata consistency
- add packet profiles:
  - lean
  - balanced
  - full
- add privacy controls:
  - redact query params by default
  - mask obvious secrets and PII candidates where practical
- keep raw evidence visible and auditable
- ensure prompt generation stays compact and deterministic

### Files likely touched

- `/Users/jeffdai/snapclip-extension/src/service-worker/runtime.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/session.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/types/session.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/export/`
- `/Users/jeffdai/snapclip-extension/src/side-panel/App.tsx`

### Acceptance gates

- evidence profiles produce meaningfully different packet sizes
- query params are redacted by default in exported evidence
- prompts remain auditable and compact
- packet quality is materially better than the current markdown export

## Stage 4: Workspace Delight

### Goal

Make the side panel feel like a real annotation workbench, not just a screenshot viewer.

### Stage split

- `4A Annotation Model + Renderer`
- `4B Workflow Controls`
- `4C Layout + Narrow-Width Polish`

### Scope

- keep screenshot + annotation stage primary
- keep runtime/debug cards secondary while annotating
- add annotation parity needed for v1:
  - box
  - arrow
  - text
- add core workflow controls:
  - remove last
  - clear all
  - save shot
  - save and clip more
  - save as is
- show note count and capture dimensions clearly
- improve active-clip clarity
- improve narrow-width panel layout
- ensure high-DPR annotation alignment

### UX rules

- the active workspace should own the panel surface
- session list should support the flow, not dominate it
- annotation actions should be obvious without being noisy

### Files likely touched

- `/Users/jeffdai/snapclip-extension/src/side-panel/App.tsx`
- `/Users/jeffdai/snapclip-extension/src/side-panel/components/AnnotationCanvas.tsx`
- `/Users/jeffdai/snapclip-extension/src/side-panel/styles.css`
- `/Users/jeffdai/snapclip-extension/src/shared/types/session.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/storage.ts`

### Acceptance gates

- box, arrow, and text annotations all work correctly
- annotation state survives reload
- remove-last and clear-all work correctly
- save-and-clip-more works without confusing state transitions
- no visible collision remains between capture controls and workspace
- narrow-width panel remains usable
- high-DPR annotation alignment remains correct
- the active clip is always obvious

## Stage 5: Bounded Debug Mode

### Goal

Ship a polished, explicit, privacy-legible runtime context mode using the existing lightweight monitor.

### Stage split

- `5A Runtime State Model`
- `5B Privacy + Noise Controls`
- `5C Debug UX`

### Scope

- keep debug mode off by default
- add a user-facing debug toggle
- add explanatory disclosure copy
- make the UI summary-first and raw-second
- add runtime status states:
  - off
  - installed
  - collecting
  - unsupported
- keep current-page runtime monitor approach
- capture and present:
  - console warnings
  - console errors
  - unhandled rejections
  - route changes
  - failed requests
  - slow requests
- add noise and privacy controls:
  - query-param redaction by default
  - truncate oversized console payloads
  - cap event counts
  - cap network counts
  - dedupe noisy repeats
- make the "first clip after enabling debug" limitation explicit
- keep bounded debug subordinate to the incident-packet flow, not as a mini DevTools surface

### Files likely touched

- `/Users/jeffdai/snapclip-extension/src/service-worker/runtime.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/session.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/storage.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/types/session.ts`
- `/Users/jeffdai/snapclip-extension/src/side-panel/App.tsx`

### Acceptance gates

- user can understand what debug mode collects
- duplicate/noisy events are bounded
- failed and slow requests display clearly
- exported debug context stays compact and deterministic
- unsupported pages explain why debug mode is unavailable
- UI never suggests that debug mode is active when it is not
- the side panel remains readable and annotation-first while bounded debug is enabled

## Stage 6: Deep Debugger Decision Gate

### Goal

Decide whether bounded debug mode is sufficient or whether SnapClip needs opt-in DevTools-protocol-grade capture.

Rule:

- treat this as a decision gate, not an automatic build stage
- if approved, open a separate implementation stage after Stages 1 through 5 are complete
- do not silently fold this into Stage 5

### Default recommendation

Do not build this until Stages 1 through 5 are complete and real handoff quality has been evaluated.

### If approved

Stage 6 should stay split internally:

- `6A Packaging + Permission Decision`
- `6B Debugger Orchestrator`
- `6C Deep Evidence Model + Storage`
- `6D Deep Capture UX`
- `6E Bundle + Bridge Integration`

#### `6A Packaging + Permission Decision`

Scope:

- explicitly choose:
  - single extension with `"debugger"` in the main manifest
  - or separate power-user build / companion extension
- write the trust rationale into docs before implementation
- document install/update warning implications clearly

Acceptance gates:

- chosen packaging path is explicit
- permission trust tradeoff is documented
- no implementation starts without this decision

#### `6B Debugger Orchestrator`

Scope:

- add `"debugger"` permission deliberately if Option A is chosen
- keep deep debug off by default
- require explicit attach consent
- attach only while deep debug mode is active
- service worker is the only debugger orchestration boundary
- collect only the first domains needed:
  - `Network`
  - `Runtime`
  - `Log`
  - `Page`
- add reliable detach on:
  - explicit user detach
  - tab close
  - unsupported navigation
  - stale recovery after service-worker restart

Files likely touched:

- `/Users/jeffdai/snapclip-extension/src/manifest/manifest.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/index.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/router.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/permissions.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/debugger.ts`

Acceptance gates:

- attach and detach are reliable
- no silent background debugger attachment exists
- unsupported pages fail with explicit user-facing messaging
- service-worker restart does not leave stale attached state behind

#### `6C Deep Evidence Model + Storage`

Scope:

- do not inflate `ClipRecord.runtimeContext` into a raw debugger dump
- keep `runtimeContext` as the bounded summary layer
- add a separate deep-debug evidence layer keyed to the clip or capture session
- store bounded raw/debugger-derived artifacts outside `chrome.storage.local`
- use IndexedDB/blob-style storage for deep-debug artifacts
- add per-domain caps by count and byte size
- redact and normalize before persistence
- keep:
  - deep debug summary
  - bounded raw artifacts
  - explicit capture metadata

Files likely touched:

- `/Users/jeffdai/snapclip-extension/src/shared/types/session.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/storage.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/storage/blob-store.ts`
- `/Users/jeffdai/snapclip-extension/src/service-worker/debugger-storage.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/export/deep-debug.ts`

Acceptance gates:

- `chrome.storage.local` stays small and stable
- raw debugger volume is bounded
- redaction happens before bundle delivery
- deleting a clip/session cleans up orphaned deep-debug artifacts

#### `6D Deep Capture UX`

Scope:

- deep capture consent must be explicit and visually prominent
- add a persistent attached-state indicator in the side panel
- show:
  - off
  - ready
  - attached
  - collecting
  - failed
  - unsupported
- keep the default view summary-first, raw-second
- add collapsible raw evidence sections with counts and truncation notices
- keep privacy controls near the attach action
- do not let deep capture visually dominate annotation or handoff flows

Files likely touched:

- `/Users/jeffdai/snapclip-extension/src/side-panel/App.tsx`
- `/Users/jeffdai/snapclip-extension/src/side-panel/styles.css`

Acceptance gates:

- user always knows when deep capture is on
- user can detach easily
- the side panel remains readable with deep evidence present
- the UX makes it obvious which deep evidence will be included in the packet

#### `6E Bundle + Bridge Integration`

Scope:

- keep `context.json` compact and human-readable
- add optional deep-debug artifacts instead of dumping everything inline
- likely artifact set:
  - `deep-debug-summary.json`
  - `network-events.json`
  - `runtime-events.json`
  - `page-events.json`
- prompts should summarize deep evidence first and point to raw artifacts second
- keep the bridge dumb about debugger semantics:
  - extension prepares redacted artifacts
  - bridge validates, writes, preserves, and delivers

Files likely touched:

- `/Users/jeffdai/snapclip-extension/src/shared/export/bundle.ts`
- `/Users/jeffdai/snapclip-extension/src/shared/ai/prompts.ts`
- `/Users/jeffdai/SnapTool/bridge/server.mjs`
- `/Users/jeffdai/SnapTool/bridge/server.test.mjs`
- `/Users/jeffdai/SnapTool/bridge/README.md`

Acceptance gates:

- bundle remains inspectable and local-first
- delivery failure still preserves the full bundle
- prompts stay compact enough for Claude/Codex handoff
- raw deep-debug artifacts are optional and bounded

### Acceptance gates

- attach and detach are reliable
- user always knows when deep capture is on
- no silent background debugger attachment exists
- event volume is bounded enough for Claude-ready packaging
- bundle remains inspectable and local-first
- deep capture does not make the product feel like an embedded DevTools clone

## Cross-Cutting Storage Plan

### Desired state

`chrome.storage.local`
- session index
- active clip id
- preferences
- debug settings
- delivery metadata

IndexedDB
- raw clip blob
- cropped blob
- annotated blob
- optional bundle cache

### Required follow-up work

- retention policy
- cleanup on clip delete and session clear
- corruption recovery when index points to a missing blob
- explicit bundle cache lifecycle

## Cross-Cutting Test Strategy

### Unit

- schema validation
- current-site permission-pattern building
- runtime event classification
- redaction and truncation logic
- bundle formatting
- delivery-state transitions

### Integration

- message routing
- session persistence
- asset write/read lifecycle
- side-panel permission request flow
- bundle generation
- hook delivery success/failure handling
- index ↔ blob consistency

### Browser E2E

- popup visible clip flow
- popup region clip flow
- shortcut visible clip flow
- shortcut region clip flow
- side-panel visible clip flow with current-site permission request
- side-panel region clip flow with current-site permission request
- unsupported-page flow from all entrypoints
- debug mode flow on a controlled page with console/network failures
- Claude handoff flow with a local hook stub

### Environment matrix

- normal HTTP page
- SPA page with route changes
- local page with console + network failures
- unsupported pages:
  - `chrome://`
  - extension page
  - Chrome Web Store
  - PDF
- narrow panel width
- high-DPR display

## Failure Matrix

```text
Capture launch
  - permission denied
  - unsupported page
  - active tab changed
  - side panel lacks current-site access

Screenshot
  - wrong window
  - capture fails after grant
  - stale viewport metadata
  - high-DPR mismatch

Region flow
  - overlay not mounted
  - drag too small
  - crop scaling mismatch
  - save fails silently

Session persistence
  - index written but blob missing
  - blob stored but index not updated
  - reload loses active clip
  - delete leaves orphaned assets

Runtime context
  - duplicate noisy events
  - oversized payloads
  - sensitive query params leak
  - debug state unclear to the user

Claude handoff
  - bundle incomplete
  - hook unavailable
  - write succeeded but delivery failed
  - UI claims success on partial failure
```

Zero silent failures is the rule.

## Stage Review + QA Contract

Do not advance a stage until all of the following are true:

1. review pass is clean or findings are fixed
2. QA pass is complete for the stage-specific acceptance gates
3. the product feels coherent, not merely technically complete

For each stage:
- run a review-first pass
- run a QA pass against the stage gates
- fix findings
- rerun the same gate checks

## Test Diagram

```text
Entry points
  -> popup visible
  -> popup region
  -> shortcut visible
  -> shortcut region
  -> side-panel visible
  -> side-panel region

Capture outcomes
  -> supported page success
  -> unsupported page clear error
  -> permission denied
  -> overlay failure

Workspace flows
  -> annotate clip
  -> save note
  -> switch clip
  -> export session
  -> send to Claude/Codex

Debug flows
  -> debug off
  -> debug enabled first clip
  -> debug enabled event capture
  -> unsupported debug page
  -> deep debug attached
  -> deep debug detached
```

## Immediate Execution Order

1. finish Stage 1 fully
2. finish Stage 2 fully
3. finish Stage 3 fully
4. finish Stage 4 fully
5. finish Stage 5 fully
6. decide whether Stage 6 is truly required

## Done Definition

SnapClip v1 is done when:

- a user can clip in one action
- the workspace feels polished and trustworthy
- the evidence packet is compact and useful
- the Claude/Codex handoff bundle is excellent and local-first
- failures are visible and recoverable
- optional diagnostics are understandable and privacy-legible
- the product still feels lightweight rather than enterprise-heavy
