# Network Inspector TDO

## Goal

Add a Jam-like per-request network inspector to LLM Clip that helps users inspect the most relevant request evidence for a clip and hand it off to Claude, Codex, or another AI assistant without opening a full DevTools workflow.

This feature should feel:

- clip-first
- evidence-first
- local-first
- technically sharp
- dense but calm

This feature should not become:

- a mini DevTools clone
- an always-on recorder
- a generic debugging dashboard

## Problem statement

The current extension already captures several layers of debugging context:

- runtime errors and warnings
- page-level failed and slow `fetch` / `XMLHttpRequest`
- a bounded Chrome debugger snapshot with logs, layout, frames, and network entries

The current side panel only exposes debugger network data as a flat list. That gives users a hint that something went wrong, but it does not give them a fast way to inspect one request deeply enough to explain the issue to an agent.

The gap is not browser capability. The gap is product shape:

- no request detail pane
- no request and response header inspection
- weak hierarchy between suspicious and routine requests
- no strong UI explanation of bounded capture timing
- no visible trust messaging near the deep evidence surface

## Product intent

The job of this feature is not "show all network activity."

The job is:

1. keep the clip as the hero
2. surface the most useful request evidence for the incident
3. make the evidence understandable at a glance
4. make the evidence easy to hand off to an AI assistant

Core product framing:

```text
capture exact state -> inspect key requests -> hand off to AI
```

Not:

```text
record a browser session -> recreate DevTools -> manage a debugging workspace
```

## Users

Primary users:

- frontend engineers
- design engineers
- solo builders
- indie developers
- technically fluent designers working with AI agents

These users usually already know how to use DevTools. The value here is not replacing DevTools for every task. The value is compressing the path from "I see the problem" to "I have a clean, local, bounded evidence packet."

## Goals

- Let the user inspect one request deeply inside the side panel.
- Preserve the clip and incident summary as the primary experience.
- Make suspicious requests easy to spot quickly.
- Improve the quality of exported and AI-ready evidence packets.
- Keep deep inspection bounded to the current clip.
- Make privacy boundaries explicit in both code and UI.

## Non-goals

- full DevTools parity
- HAR export in v1
- request body capture by default
- response body capture by default
- timeline or waterfall visualization
- always-on background recording
- replay-style capture
- websocket parity
- backend or collaboration tabs

## Existing implementation to build on

The repo already contains the core seams needed for this work:

- [src/service-worker/runtime.ts](/Users/jeffdai/snapclip-extension/src/service-worker/runtime.ts)
  - lightweight runtime monitor for page-level `fetch`, `XMLHttpRequest`, console, route, and error signals
- [src/service-worker/debugger.ts](/Users/jeffdai/snapclip-extension/src/service-worker/debugger.ts)
  - bounded `chrome.debugger` snapshot with network, log, and performance metadata
- [src/shared/types/session.ts](/Users/jeffdai/snapclip-extension/src/shared/types/session.ts)
  - shared schema boundary for persisted clip evidence
- [src/shared/export/evidence.ts](/Users/jeffdai/snapclip-extension/src/shared/export/evidence.ts)
  - evidence normalization and truncation boundary
- [src/side-panel/App.tsx](/Users/jeffdai/snapclip-extension/src/side-panel/App.tsx)
  - current side-panel evidence rendering
- [src/manifest/manifest.ts](/Users/jeffdai/snapclip-extension/src/manifest/manifest.ts)
  - already declares `debugger`

## Product decision

Use `chrome.debugger` as the canonical source for deep per-request inspection.

Keep the runtime monitor as:

- a lightweight incident summary
- a fallback when debugger attach fails
- a simpler signal source for the "what went wrong?" summary layer

Do not merge runtime-monitor requests and debugger requests into one synthetic inspector list. That would introduce:

- duplicate request rows
- ambiguous field completeness
- weak request identity
- unnecessary abstraction

## Scope for v1

### In scope

- richer debugger network entries with request and response header detail
- compact request list in the side panel
- selected request detail pane
- three tabs:
  - `Headers`
  - `Request`
  - `Response`
- suspicious-first sorting
- bounded request retention
- redaction before persistence and export
- explicit local-first and bounded-capture copy in the UI
- keyboard navigation and focus states

### Out of scope

- request and response bodies by default
- HAR export
- waterfall charts
- persistent debugger attach
- socket inspection
- replay or recording timelines
- hosted or collaborative debugging workflow

## Design principles

### Shortcut-first immediacy

The network inspector should feel faster to use than opening DevTools and reconstructing context manually.

### Evidence first

The network inspector exists to support the clip, not to overshadow it.

### Local-first trust

The UI should repeatedly reinforce that deep request details are bounded to the current clip and remain local unless the user explicitly exports or sends them.

### Hierarchy over sameness

Not every request should have equal visual weight. Failures, blocked requests, and suspicious slow requests should stand out immediately.

### Technical polish without bloat

The inspector should feel premium, compact, and deliberate. It should not look like a bloated enterprise network console.

### Permission clarity

The inspector should explain what it captured, what may be missing, and why some values are redacted.

## UX requirements

The user should be able to:

- glance at the clip and understand whether deep network evidence exists
- identify the most suspicious requests quickly
- select one request and inspect it deeply
- understand what was captured and what may be missing
- trust that sensitive values are handled carefully
- hand the evidence to an AI assistant without cleanup work

## Information architecture

Recommended side-panel order:

1. clip preview
2. note and incident summary
3. runtime evidence summary
4. deep network inspector
5. export / send actions

The deep network inspector should sit below the fast incident summary and above export actions so it feels like enriched evidence, not the whole product.

```text
[Clip preview]

[Incident summary]
- runtime errors
- failed requests
- debugger snapshot status

[Deep network inspector]
- bounded snapshot label
- capture timing
- refresh action
- request list
- selected request details

[Export / send]
```

## Interaction design

The deep inspector should use a two-pane layout.

```text
+--------------------------------------------------+
| Deep Network Inspector                           |
| Bounded local snapshot • captured 2:14:03 PM     |
| [Refresh snapshot]                               |
+---------------------------+----------------------+
| Request list              | Selected request     |
|                           | [Headers][Request]   |
| POST /api/save     500    | [Response]           |
| GET  /main.js      404    |                      |
| GET  /settings     200    | General              |
| ...                       | Request headers      |
|                           | Response headers     |
+---------------------------+----------------------+
```

### Request list behavior

- sort suspicious requests first:
  - blocked
  - failed
  - 4xx and 5xx
  - slow or suspicious
  - everything else
- preserve selection while switching tabs
- preserve selection after refresh when possible
- support keyboard navigation through rows
- truncate long URLs in the list while preserving full values in the details pane

### Request list row contents

Each row should show:

- HTTP method
- compact route-first URL label
- status
- resource type or source hint
- optional flags for:
  - `cache`
  - `sw`
  - `blocked`
  - `failed`

### Detail tabs

#### `Headers`

- full URL
- method
- status
- request headers
- response headers
- visible `[redacted]` markers where applicable

#### `Request`

- request line
- resource type
- priority if available
- cache and service-worker hints
- request-body availability status only in v1

#### `Response`

- status
- mime type
- encoded data length
- blocked and failed reason
- response-body availability status only in v1

## UI and visual design

The feature should align with the current extension design direction in [AGENTS.md](/Users/jeffdai/snapclip-extension/AGENTS.md):

- dark-first workspace
- cool electric-blue guidance and active accents
- warm emphasis color for warnings and evidence trouble spots
- compact, technical, premium surfaces

### Visual requirements

- the clip remains visually primary
- the inspector should look denser and sharper than the current flat event-card treatment
- the selected request state should be unmistakable
- status should never rely on color alone
- long values should wrap safely in the detail pane
- the layout should hold up in narrow extension widths

### Important design constraint

Do not visually mimic DevTools one-to-one.

This should feel like LLM Clip:

- more compact
- more intentional
- more evidence-oriented
- more AI-handoff-friendly

## Required UI states

### No deep snapshot

Show:

- deep snapshot unavailable
- debugger attach failure message when available
- runtime summary still visible

### Snapshot captured but no relevant requests

Show:

- bounded snapshot captured
- no matching or recent network activity observed
- refresh action

### Partial snapshot

Show:

- some requests may be missing
- page navigated or capture ended early

### Redacted snapshot

Show:

- sensitive values redacted before storage and export
- visible `[redacted]` markers in the details view

### Truncated snapshot

Show:

- count retained
- hint such as "showing 32 most recent requests"

## Trust copy

This copy is part of the feature and must appear near the inspector:

- `Bounded local snapshot`
- `Captured during this clip only`
- `Sensitive values may be redacted before storage and export`
- `Some requests may be missing if they happened before deep capture started`

If debugger attach fails:

- explain that Chrome did not allow the extra deep snapshot for this page
- keep wording technical, calm, and direct

## Accessibility requirements

- full keyboard navigation for request rows and tabs
- visible focus states
- screen-reader-legible labels for selection and status
- non-color status signaling
- resilient text wrapping
- usable at browser zoom
- respect `prefers-reduced-motion`

## Technical architecture

### High-level model

```text
[User triggers clip]
      |
      v
[Capture pipeline]
      |
      +--> screenshot + page context
      |
      +--> runtime monitor summary
      |
      +--> debugger deep snapshot
              |
              v
      [requestId aggregation]
              |
              v
      [redaction + truncation]
              |
              v
      [clip record persisted]
              |
      +-------+--------+
      |                |
      v                v
[side panel UI]   [export / AI prompt]
```

### Responsibility split

`src/service-worker/runtime.ts`

- lightweight runtime telemetry only
- summary signals for the incident digest
- fallback evidence when debugger capture fails

`src/service-worker/debugger.ts`

- attach and detach lifecycle
- event subscription
- request aggregation by `requestId`
- schema-safe normalization
- bounded capture and truncation

`src/side-panel/App.tsx`

- request list rendering
- selection state
- tab state
- empty and partial states

`src/shared/export/evidence.ts`

- redaction and truncation boundary for persisted and exported evidence

## Debugger event expansion

The current debugger path already listens to:

- `Network.requestWillBeSent`
- `Network.responseReceived`
- `Network.loadingFinished`
- `Network.loadingFailed`

For this feature, add:

- `Network.requestWillBeSentExtraInfo`
- `Network.responseReceivedExtraInfo`

Defer body capture for v1.

## Canonical data model

Extend `ChromeDebuggerContext.network` in [src/shared/types/session.ts](/Users/jeffdai/snapclip-extension/src/shared/types/session.ts).

Recommended per-request shape:

- `id`
- `method`
- `url`
- `resourceType`
- `status`
- `mimeType`
- `priority`
- `encodedDataLength`
- `failedReason`
- `blockedReason`
- `fromDiskCache`
- `fromServiceWorker`
- `timestamp`
- `requestHeaders`
- `responseHeaders`
- `requestHeaderRedactions`
- `responseHeaderRedactions`
- `hasRequestHeaders`
- `hasResponseHeaders`
- `hasRequestBody`
- `hasResponseBody`
- `isTruncated`

Headers should be stored as ordered arrays of `{ name, value }`, not maps, so duplicate headers and order are preserved.

## Request assembly model

```text
Network.requestWillBeSent ----------+
                                    |
Network.requestWillBeSentExtraInfo -+--> [requestId map] --> [normalized entry]
                                    |
Network.responseReceived -----------+
                                    |
Network.responseReceivedExtraInfo --+
                                    |
Network.loadingFinished / Failed ---+
```

## Redaction and privacy boundary

Redaction must happen before persistence and export, not only at render time.

Sensitive fields likely include:

- `authorization`
- `cookie`
- `set-cookie`
- CSRF and session-related headers
- bearer-token-like custom headers

Policy:

- preserve the header name
- replace the value with `[redacted]`
- preserve a redaction marker so the user understands the omission

```text
[raw debugger events]
        |
        v
[aggregate by requestId]
        |
        v
[redact sensitive fields]
        |
        v
[truncate bounded snapshot]
        |
        +--> [persist]
        +--> [render]
        +--> [export]
```

## Failure modes

### Attach fails

Expected behavior:

- mark deep snapshot unavailable
- keep runtime summary usable
- explain that Chrome blocked or did not allow the extra capture

### Interesting request happened before attach

Expected behavior:

- show that the snapshot is bounded
- show capture timing
- offer refresh and repro guidance

### Tab navigates during capture

Expected behavior:

- persist a partial but valid snapshot
- mark it as partial

### Noisy page exceeds limits

Expected behavior:

- keep only bounded recent requests
- mark the snapshot as truncated

## Implementation plan

### Phase 1: schema and capture

- extend debugger event handling
- extend shared schema types
- add completeness and truncation metadata

### Phase 2: redaction and evidence shaping

- add request and response header redaction rules
- enforce bounded limits
- update export and prompt shaping

### Phase 3: side-panel inspector UI

- build request list
- build selected request detail pane
- add tab state and empty states

### Phase 4: polish and accessibility

- strengthen visual hierarchy
- keyboard navigation and focus states
- narrow-width and zoom resilience
- reduced-motion-safe transitions

### Phase 5: docs and QA

- update permissions and trust documentation
- manual QA against noisy, cached, failed, and auth-heavy scenarios

## Candidate files

Likely touched files:

- [src/service-worker/debugger.ts](/Users/jeffdai/snapclip-extension/src/service-worker/debugger.ts)
- [src/shared/types/session.ts](/Users/jeffdai/snapclip-extension/src/shared/types/session.ts)
- [src/shared/export/evidence.ts](/Users/jeffdai/snapclip-extension/src/shared/export/evidence.ts)
- [src/shared/export/session-markdown.ts](/Users/jeffdai/snapclip-extension/src/shared/export/session-markdown.ts)
- [src/shared/ai/prompts.ts](/Users/jeffdai/snapclip-extension/src/shared/ai/prompts.ts)
- [src/side-panel/App.tsx](/Users/jeffdai/snapclip-extension/src/side-panel/App.tsx)
- [src/side-panel/styles.css](/Users/jeffdai/snapclip-extension/src/side-panel/styles.css)
- [docs/permissions.md](/Users/jeffdai/snapclip-extension/docs/permissions.md)

## Acceptance criteria

### Product

- the user can inspect request and response headers for a captured request
- the user can identify likely failing requests quickly
- the user understands what was captured and what may be missing
- the feature feels clip-attached rather than dashboard-like

### Design

- the clip remains visually primary
- suspicious requests stand out clearly
- selected request state is obvious
- empty and partial states are understandable
- the inspector feels dense, calm, and intentional

### Engineering

- no new extension permission required
- runtime summary still works when deep capture fails
- sensitive headers are redacted before persistence and export
- bounded limits prevent unbounded payload growth

### Accessibility

- keyboard navigation works across rows and tabs
- focus states are clear
- status is not color-only
- the layout remains usable at extension widths and zoom

## Testing

### Unit tests

- out-of-order event assembly
- duplicate header preservation
- redirect handling
- failed requests without response
- truncation behavior
- redaction behavior
- partial snapshot normalization

### Integration tests

- clip persistence includes expanded debugger snapshot
- side panel renders the request list and detail pane
- attach failure falls back cleanly
- exports and prompts do not leak stripped secrets

### Manual QA matrix

- normal GET 200
- POST JSON
- 404 asset
- CORS or network failure
- cached response
- service-worker response
- noisy page over limit
- auth-heavy requests
- no request activity during observation window

## Final recommendation

Proceed with a bounded, design-aware v1 that adds request and response header inspection, strong hierarchy, explicit trust copy, and compact two-pane request inspection.

Do not pursue body capture, HAR export, or DevTools parity in the first pass.
