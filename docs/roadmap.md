# Roadmap

## Shipped

- current-tab and region screenshot capture
- keyboard shortcuts (Option+Shift+T clip, C region, A annotate, S sidebar)
- page metadata, DOM summary, and runtime context extraction
- local snapshot persistence (IndexedDB blobs + chrome.storage)
- side panel with Clips, History, Bridge, Integrations, Export tabs
- annotation canvas (box, arrow, text tools — per-type colors)
- localhost bridge workspace discovery and deterministic bundle writing
- Claude hook installation support and live session discovery
- direct Claude + Codex session delivery with bundle-preserved fallback
- clip-level persisted handoff status (delivered / bundle_created / failed)
- send modes: images+notes (lean) vs images+debug (full evidence packet)
- Slack, Linear, Jira, Teams, Discord integrations (landed — IntegrationsPanel wired in side panel)
- companion .pkg build script (bun --compile + pkgbuild)
- full design system: limestone bg, forest green accent, Geist fonts

---

## Milestone 1: Chrome Web Store Submission

Everything required to pass Google review and go live in the store.

### Blockers

**Extension icons**
`public/icons/` is a placeholder. Manifest has no `icons` field or `action.default_icon`.
CWS rejects without a 128x128 icon. Need 16, 32, 48, 128px branded assets.

**Store assets**
- 5 screenshots at 1280x800 (or 640x400)
- 1 promo tile at 440x280
- Store description (~200 words, Developer Tools category)
- Short description (132 chars max)

**Privacy policy**
Required for CWS, mandatory when `debugger` permission is declared.
GitHub Pages or a static host works. URL must be live before submission.

**`debugger` permission justification**
Google review manually checks `debugger` usage. Need a one-paragraph justification:
bounded opt-in capture of console errors, network requests, and JS runtime state
for the purpose of generating AI-ready incident packets. No persistent background
debugger attachment.

**Chrome Web Store developer registration**
~~One-time $5 fee~~ Done — account registered and verified, approval pending (a few days).

---

## Milestone 2: First Dollar

Free tier gate and Pro unlock. Without this, conversion is zero.

### Free tier cap (50 clips/month)

No enforcement exists anywhere in the codebase. Add a monthly counter to
`chrome.storage.local` with a reset timestamp. Block `startClipWorkflow` when
limit is reached and surface an upgrade prompt. Simple, client-side, honest.

Conversion trigger: the moment a free user tries to clip #51, they see the upgrade
path. Every manual bundle copy before that is friction they tolerate. Past the cap
they feel it directly.

### Pro unlock ($12/year)

Pick a payment processor (Stripe Checkout or Paddle — both support one-time links
with no backend). On successful payment, write a license token to `chrome.storage.local`.
Service worker checks token before enforcing the cap. Token format can be a signed JWT
or a simple server-verified string.

Phase 1: a static Stripe Payment Link is enough. No backend required. Add a
`/verify-license` endpoint later when volume justifies it.

---

## Milestone 3: New User Activation

The gap between "installed" and "first successful send to Claude."

### Companion install UX from Bridge tab

Bridge tab shows connected/disconnected but offers no path to fix it. When companion
is not running, show a prominent download button that points to the .pkg release URL —
same as the popup already does but more visible in context.

### Hook install button in Bridge tab

`installBridgeHooks()` exists in `useBridgeState` but is never surfaced. When
`bridge.bridgeHealth.claude.hookInstalled === false`, show an "Install hooks" button.
One tap, done. Live sessions start appearing automatically after that.

### Companion auto-launch verification

LaunchAgent plist is written by `companion/scripts/postinstall.sh`. Needs a smoke test
on a clean machine: install .pkg → reboot → bridge appears at `http://127.0.0.1:4311/health`
without any manual steps.

---

## Milestone 4: Team Tier

Unlocks the $10/user/month tier. Integrations have landed. Remaining work:

### Integration settings UI

IntegrationsPanel is wired in the side panel but needs working credential entry:
token/webhook URL inputs per integration, test-connection buttons, and persisted state.
`identity` and `alarms` permissions are already declared in the manifest.

### Teams OAuth (chrome.identity)

`chrome.identity` is in the manifest. Teams PKCE flow via `chrome.identity.launchWebAuthFlow`
needs to be wired into the IntegrationsPanel settings. The serverless OAuth relay
(Stage 6 in integration-architecture.md) can be deferred — `chrome.identity` handles
PKCE client-side for now.

### Linear token setup

Linear uses a user-supplied personal API token. Simpler than Slack/Teams.
Credential entry form in IntegrationsPanel handles this — no OAuth flow needed.

---

## Milestone 5: Quality and Competitive Parity

Ship these in parallel with or just after Team tier.

### MCP server on bridge

Jam has MCP. Claude Desktop users who don't use Claude Code hooks need a pull-based
path. Add an MCP endpoint to the bridge that exposes the latest bundle as a resource.
One additional route on the existing bridge server. Makes LLM Clip compatible with
any MCP client, not just hook-enabled Claude Code.

### End-to-end smoke tests

No automated tests cover the bridge + delivery flow. Minimum viable test suite:
- companion absent → clip/editor still work
- companion healthy → active sessions appear
- send success → `delivered` state persisted
- send failure after bundle creation → bundle path recoverable
- free tier cap enforced at clip #51

### Approval UX for pending Claude permission requests

`listBridgeApprovals()` is called in `useBridgeState` but approvals are never
displayed anywhere. When Claude requests a file write or tool permission mid-task,
the user has no signal in SnapClip. Surface a badge on the Bridge tab and a simple
approve/deny card.

### Bounded debug mode UX

Currently the `debugger` permission is always-on (when Chrome permits it). The product
spec calls for opt-in bounded debug mode — a user-visible toggle, a clear scope
description ("captures console errors and network requests for this clip only"), and
a confirmation the session ends when the clip is saved.

---

## Later

- full-page capture (requires off-screen rendering or scroll-stitch)
- deeper Chrome debugger signal shaping (heap snapshots, performance timeline)
- multi-workspace session management polish
- cloud storage option (opt-in, Pro+ tier)
- replay / clip sequence diffing
- team dashboards and shared clip history
- Gemini and other cloud-API-first agent handoff

---

## Shipping Stack Rank

| # | Item | Blocks | Status | Effort (CC) |
|---|------|--------|--------|-------------|
| ~~0~~ | ~~CWS developer registration~~ | ~~CWS submission~~ | **Done** (approval pending) | — |
| 1 | Extension icons | CWS submission | Todo | ~15 min |
| 2 | Privacy policy + store description | CWS submission | Todo | ~20 min |
| 3 | `debugger` justification | CWS review | Todo | ~10 min |
| 4 | Free tier cap (50/mo) | Monetization | Todo | ~20 min |
| 5 | Pro unlock + payment link | First dollar | Todo | ~1 hr |
| 6 | Integration settings UI (credentials, test-connect) | Team tier usable | Todo | ~30 min |
| 7 | Hook install button in Bridge tab | New user activation | Todo | ~10 min |
| 8 | Companion download link in Bridge tab | New user activation | Todo | ~5 min |
| 9 | MCP server on bridge | Competitive parity | Todo | ~2 hrs |
| 10 | E2E smoke tests | Deploy confidence | Todo | ~30 min |
| 11 | Approval UX (pending Claude permissions) | Claude mid-task UX | Todo | ~20 min |
| 12 | Bounded debug mode UX | Polish / trust | Todo | ~30 min |

**Shortest path to CWS submission:** items 1, 2, 3 (dev account already cleared).
**Shortest path to first dollar:** add items 4 + 5.
**Shortest path to Team tier:** item 6 (integrations already landed).
