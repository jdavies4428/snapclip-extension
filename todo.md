# LLM Clip Execution Plan

## Product Position

LLM Clip is not a screenshot utility.

LLM Clip is a local-first incident drafting tool for:
- frontend engineers
- design engineers
- product designers
- agentic coders working with Claude, Codex, and similar tools

Core loop:
1. Capture a broken browser state quickly.
2. Mark what matters.
3. Write the prompt once while the context is fresh.
4. Attach trustworthy technical evidence.
5. Copy or send a deterministic packet into an LLM workflow.

If the product is working, the user should feel:
- fast
- precise
- in control
- able to trust the packet

## Product Wedge

The wedge is:

> Turn one browser state into one clean LLM-ready incident packet faster than the user can lose the thread.

That means the roadmap should optimize for:
- capture reliability
- editor clarity
- prompt quality
- evidence trust
- handoff trust

It should not optimize first for:
- deep debugger capture
- broad collaboration
- cloud sync
- replay/session video
- generic annotation parity

## How We Beat Jam

Jam is strong at:
- collecting broad evidence
- showing replay and debugging surfaces
- helping humans inspect an incident

LLM Clip should win somewhere sharper.

LLM Clip should be better at:
- turning visual evidence into a clean task for an LLM
- making prompt quality first-class instead of secondary metadata
- keeping packet contents local-first, inspectable, and deterministic
- shaping evidence into signal instead of dumping telemetry walls
- moving faster from "I saw something broken" to "Claude/Codex can act on this"

Product rule:
- do not build "Jam but with AI"
- build "the fastest path from browser state to agent-ready task"

That means:
- the prompt is as important as the screenshot
- evidence tabs matter more than raw debug panels
- packet preview matters more than generic replay parity
- send trust matters more than data exhaust

## Product Differentiators

### 1. Prompt-first incident authoring

The user should be able to:
- capture the state
- explain the task once
- trust that the explanation stays attached to the clip

This should feel native in the modal, not bolted on in the side panel.

### 2. Evidence shaping instead of evidence dumping

The product should prefer:
- failed requests
- warnings and errors
- actions near the capture moment
- backend evidence relevant to the same incident

The product should avoid:
- showing normal `200 ok` noise by default
- forcing users to sift through DevTools-style walls

### 3. Deterministic agent handoff

Every clip should be able to become:
- one image
- one prompt
- one inspectable packet

The user should always be able to answer:
- what will be sent
- why it was included
- what failed if delivery did not work

### 4. IDE-adjacent workbench feel

The UI should feel more like:
- a compact incident workbench
- a precision tool for engineers and designers

It should feel less like:
- a consumer screenshot app
- a generic SaaS dashboard
- a replay-heavy support tool

## Jam-Inspired But Not Jam-Copied

There are ideas worth borrowing:
- one evidence surface with multiple lenses
- timeline-oriented debugging
- console / network / backend tabs
- clear incident context on the right

But the correct LLM Clip interpretation is:
- left: visual state
- right: prompt, packet actions, and evidence tabs
- timeline: optional context spine, not the whole product

Recommended future evidence tabs:
- `Prompt`
- `Info`
- `Console`
- `Network`
- `Actions`
- `Backend`
- later `Deep Debug`

The important difference:
- Jam optimizes for debugging a session
- LLM Clip should optimize for packaging one moment into one actionable task

## Current Repo Reality

Already present:
- popup, shortcut, and side-panel launch surfaces
- visible-tab and region capture
- modal-first clip editing
- clip title + per-clip prompt entry
- text, box, and arrow annotations
- local clip session persistence
- blob-backed image storage
- copy image / copy instructions / copy packet summary
- deterministic bundle assembly
- bridge-backed handoff scaffolding
- bounded runtime context collection

Not yet locked down:
- editor hierarchy and visual polish
- side-panel information density
- send-current-clip workflow from the modal
- repeatable QA gates for the capture/editor/handoff loop
- storage lifecycle and session management beyond the happy path
- explicit deep-debug product decision

## Planning Conclusions

From frontend, backend, CEO, and engineering review, the implementation plan should be stage-based.

Reasons:
- the product already has enough surface area that design drift is now a real risk
- the code has working seams, but orchestration is spreading across popup, side panel, modal, storage, and bridge layers
- debugger-grade capture is strategically useful, but it is not the wedge and carries trust cost
- QA needs to move from ad hoc manual checks to explicit stage gates

Rule:
- do not advance a stage until review and QA gates are met
- every stage must end with functional QA and design QA
- no stage is complete if it only compiles

## Architectural Direction

### Runtime surfaces

- popup: lightweight launcher
- side panel: session gallery, selected-clip summary, dispatch surface
- in-page modal: primary authoring surface
- service worker: orchestration boundary
- offscreen document: clipboard support
- bridge client: delivery boundary

### Ownership boundaries

#### Popup
- launch only
- no business logic beyond target-tab resolution and launch requests

#### In-page clip editor
- owns transient capture authoring state:
  - title draft
  - prompt draft
  - unsaved annotations
  - copy actions
- should not own session-level logic

#### Side panel
- owns:
  - saved clip browsing
  - saved clip metadata editing
  - session-level export and handoff
- should not become a second full editor

#### Service worker
- owns:
  - supported-tab validation
  - permission flow coordination
  - capture orchestration
  - runtime monitor orchestration
  - commit/save flows
  - export orchestration
- all critical flows should pass through here

#### Shared export / bundle modules
- own packet shaping
- own prompt generation
- own evidence profile logic
- must stay separate from UI state

#### Bridge client
- own transport only
- no UI assumptions
- no packet assembly

### Critical data flows

#### Capture flow

```text
popup / shortcut / side panel
  -> service worker router
  -> permission + target-tab resolution
  -> screenshot + page context + runtime context
  -> in-page modal authoring state
  -> explicit save
  -> commit clip payload
  -> session index + blob persistence
```

#### Saved-clip flow

```text
session index
  -> side-panel gallery
  -> select clip
  -> view summary
  -> optional reopen in modal
  -> update saved fields
```

#### Handoff flow

```text
saved clip or active session
  -> blob load
  -> annotated render
  -> evidence shaping
  -> prompt generation
  -> bundle assembly
  -> bridge transport
  -> delivery status persisted
```

### Non-negotiable boundaries

- UI surfaces must not each invent their own packet summary logic
- offscreen clipboard is the only fallback copy boundary
- bundle generation must remain shared and deterministic
- service worker owns orchestration of capture, save, export, and send
- runtime evidence must remain bounded by schema before it reaches prompts or bridge delivery

## Cross-Cutting Risks

### Product risks
- too much information competing in the side rail
- screenshot area losing priority to chrome
- prompt entry feeling secondary when it should be first-class
- too many copy/send concepts without one obvious primary path

### Engineering risks
- modal/editor behavior living in a very large `clipping.ts`
- side panel and modal drifting into duplicate editing experiences
- clipboard logic duplicated across modal and side panel
- runtime evidence growing without a clear bounded schema contract
- bridge integration staying panel-only and never becoming clip-centric

### Trust risks
- debugger capture warning could shrink adoption if introduced too early
- packet contents can become noisy if runtime evidence is not aggressively shaped
- copy appearing successful but not landing in target apps erodes trust quickly

## Stage Model

The work should proceed in six stages.

Stage order is deliberate:
1. Editor-first capture loop
2. Session workspace and saved-clip ergonomics
3. Evidence quality and bounded debug UX
4. Direct handoff and deterministic delivery
5. Storage/session hardening and QA automation
6. Deep debugger decision gate

Implication for Stage 3 and Stage 4:
- Stage 3 should evolve toward a tabbed evidence inspector, not bigger raw cards
- Stage 4 should make `Send current clip` feel like the natural end of the authoring flow

## Stage 1: Editor-First Capture Loop

### Goal

Make capture and immediate authoring feel obvious, fast, and trustworthy.

### Scope

- maximize screenshot area in the clip modal
- make the right rail compact and hierarchical
- keep the modal as the only primary annotation surface
- ensure prompt entry is first-class in the modal
- make annotation tools predictable:
  - one-shot placement
  - select/edit after placement
  - clear resize handles
  - clear active-tool state
- make copy feedback unmistakable
- make close/cancel/escape behavior completely predictable
- tighten popup into a true launcher only

### Frontend work

- reduce modal chrome and dead vertical space
- prioritize screenshot over framing UI
- reorder right rail to:
  1. clip identity
  2. prompt for the LLM
  3. primary actions
  4. annotation tools
  5. technical evidence
- make tool and copy success feedback local to the action
- make empty and loading states intentional rather than generic

### Backend / architecture work

- keep unsaved editor state isolated until explicit save
- ensure commit payload cleanly contains:
  - title
  - prompt
  - annotations
  - clip crop
- runtime context
- do not let prompt/copy logic depend on side-panel state

### Technical implementation items

- split `clipping.ts` mentally into four subdomains even if still in one file temporarily:
  - overlay selection
  - modal layout
  - annotation state machine
  - copy/save actions
- normalize copy helpers so image / instructions / summary all share one success/failure pattern
- ensure `commit-clip` is the only path that mutates saved clip state
- verify offscreen clipboard packaging stays in sync with the in-page direct path

### Acceptance gates

- visible clip and region clip both land in the same editor model
- text, box, and arrow can all be created, moved, and edited predictably
- save, cancel, `Esc`, and `X` all do what the user expects
- prompt text is visibly separate from clip title and system context
- copy actions provide obvious success/error feedback
- no visible scrollbar appears in the editor

### QA gates

- manual:
  - visible clip -> modal -> annotate -> copy -> save
  - region clip -> modal -> annotate -> copy -> cancel
  - text / box / arrow / undo / move / resize
  - `Esc` in selection mode, text mode, and modal mode
- review:
  - no duplicate editor logic introduced into the side panel
  - no new clipboard path bypasses the shared copy boundary

## Stage 2: Session Workspace And Saved-Clip Ergonomics

### Goal

Make the side panel a clean saved-clip gallery and dispatch surface.

### Scope

- keep the side panel out of full editing mode
- make saved clips visually scannable as thumbnails
- make clip intent recoverable after multiple captures
- make the selected clip summary cleaner and denser
- make reopening the modal the obvious editing path

### Frontend work

- compress the active clip card
- make thumbnail cards more visual and less list-like
- collapse low-value metadata behind disclosure sections
- keep prompt text visible and editable for saved clips
- add stronger selected-state hierarchy

### Backend / architecture work

- ensure side-panel edits only update saved clip fields:
  - title
  - prompt
  - selected clip
- do not reintroduce inline saved-clip canvas editing
- keep modal launch from side panel deterministic

### Technical implementation items

- keep side-panel `App.tsx` responsible for selection and dispatch only
- avoid pushing annotation editing back into `AnnotationCanvas` inside the panel
- add a clear saved-clip metadata contract:
  - title
  - prompt
  - mode
  - createdAt
  - preview asset
- ensure selected clip survives reload and extension restart

### Acceptance gates

- single click selects a saved clip
- double click opens the editor modal
- after 3-5 clips, the user can still identify each clip quickly
- selected clip information is obvious without excessive metadata noise
- prompt copy and image copy are available from saved clips

### QA gates

- manual:
  - save 5 clips
  - scan gallery
  - reopen 2 clips in the modal
  - edit title and prompt from side panel
  - verify persistence after reload
- review:
  - side panel remains gallery/dispatch, not parallel editor

## Stage 3: Evidence Quality And Bounded Debug UX

### Goal

Make evidence useful, bounded, trustworthy, and easier to inspect through focused tabs instead of one long metadata wall.

### Scope

- make runtime evidence feel like signal, not DevTools spam
- shape UI around failed/slow/error-first evidence
- keep all packet profiles deterministic
- introduce a tabbed evidence inspector model for saved clips
- refine evidence profile semantics:
  - lean
  - balanced
  - full
- make the user understand what will be sent

### Frontend work

- replace always-open stacked evidence cards with a tabbed inspector
- define initial evidence tabs:
  - `Prompt`
  - `Info`
  - `Console`
  - `Network`
  - `Actions`
  - `Backend` placeholder
- default visible evidence to:
  - failures
  - warnings
  - slow requests
- make each tab answer one clear question:
  - `Prompt`: what do I want the LLM to do?
  - `Info`: what page/state was captured?
  - `Console`: what errors or warnings happened?
  - `Network`: what requests failed or slowed down?
  - `Actions`: what navigation or interaction context happened near capture?
  - `Backend`: what server-side evidence is available for this incident?
- collapse normal `200 ok` noise by default
- add short explanations of evidence profiles
- keep evidence cards readable for designers and engineers

### Backend / architecture work

- treat bounded runtime context as its own stable schema
- define one normalized evidence-view model so tabs do not read raw monitor payloads directly
- add an action/event timeline shape separate from raw console/network arrays
- avoid leaking raw monitor structures directly into UI assumptions
- tighten redaction rules:
  - query params
  - obvious tokens/secrets
  - low-value noisy URLs

### Technical implementation items

- define one evidence shaping boundary in shared export code
- define one shared `IncidentEvidence` or equivalent typed view model for:
  - page info
  - runtime summary
  - console items
  - network items
  - action timeline items
  - backend evidence placeholders
- add explicit redaction helpers instead of scattered string replacements
- store summary counts separately from raw event arrays
- add event and network caps before prompt generation, not only at render time
- create one tab configuration source so modal/side-panel evidence views cannot drift
- keep `Backend` tab scaffolded even if initially empty so the UI model is future-safe

### Acceptance gates

- balanced profile is usable without overwhelming the user
- the evidence inspector is easier to scan than the old card stack
- the most relevant evidence is visible in one click, not buried
- tabs do not expose raw noisy payloads by default
- packet previews explain what will be sent
- profile changes produce materially different outputs
- no raw secret-like values leak in prompt-visible text

### QA gates

- manual:
  - pages with noisy network activity
  - pages with console errors
  - pages with route changes / navigation events
  - compare lean vs balanced vs full
  - switch through every evidence tab on a saved clip
- review:
  - evidence profile logic stays in shared export modules
  - UI does not branch on untyped raw runtime payloads
  - evidence tabs read from one normalized view model rather than bespoke UI mapping logic

## Stage 4: Direct Handoff And Deterministic Delivery

### Goal

Make “send this clip to an LLM” a first-class action, not a side-panel afterthought.

### Scope

- add `Send current clip` from the modal
- keep bridge settings available but secondary
- preserve deterministic bundle creation for every send attempt
- make delivery outcome legible:
  - bundle created
  - delivered
  - failed after bundle creation

### Frontend work

- modal send action for current clip
- cleaner handoff target and intent selection
- outcome UI that clearly distinguishes:
  - copy-only workflow
  - bundle-only workflow
  - delivered-to-session workflow

### Backend / architecture work

- move handoff orchestration closer to the service-worker boundary
- keep side panel as settings/status surface, not the only send surface
- ensure bundle writing remains deterministic even when delivery fails
- unify prompt/image/annotation/context assembly for modal and panel sends

### Technical implementation items

- introduce one send request shape shared by modal and panel
- ensure bridge config resolution is shared and not panel-owned state
- preserve delivery result on the session/clip index without mutating bundle contents
- keep transport retries outside bundle generation

### Acceptance gates

- user can send the current clip directly from the modal
- saved clip and current clip produce the same artifact contract
- failed delivery still preserves bundle state
- bridge config is no longer effectively hidden in one surface

### QA gates

- manual:
  - bundle only
  - bridge unavailable
  - bridge available with valid workspace
  - failed delivery after bundle creation
- review:
  - bundle generation remains separate from transport
  - modal send does not duplicate packet assembly logic

## Stage 5: Storage / Session Hardening And QA Automation

### Goal

Make the product resilient over longer real-world sessions.

### Scope

- session lifecycle rules:
  - new session
  - continue session
  - clear/archive session
- resilience across reload and extension reload
- large-session behavior
- regression-oriented QA harness for the critical flows

### Frontend work

- explicit session controls
- better long-session empty/error/recovery states
- graceful handling when blobs or metadata go missing

### Backend / architecture work

- harden session index + blob storage consistency
- define behavior for orphaned blobs and orphaned metadata
- define migration rules for schema changes
- add more deterministic test coverage around:
  - storage
  - router
  - bundle generation
  - bridge client

### Technical implementation items

- add explicit storage repair behavior:
  - missing blob
  - missing index row
  - deleted clip with orphaned assets
- define session clear/archive semantics before adding long-session UX
- add tests around extension reload and service-worker restart behavior
- document blob retention and cleanup rules

### Acceptance gates

- session survives extension reload without corruption
- missing asset failure is user-visible and recoverable
- 10+ clip session remains usable
- clip title, prompt, and annotations persist reliably

### QA gates

- manual:
  - reload browser with existing session
  - extension reload with existing session
  - save/edit/copy across 10 clips
- automated:
  - unit tests for storage/session operations
  - unit tests for bundle generation
  - integration tests for router message outcomes

## Stage 6: Deep Debugger Decision Gate

### Goal

Explicitly decide whether debugger-grade evidence is worth the product and trust cost.

### Decision rule

Do not start implementation just because the API exists.

Only proceed if:
- Stages 1 through 5 are genuinely working
- bounded evidence still leaves repeated important gaps
- install-time trust cost is worth it

### Options

#### Option A: Main extension includes `debugger`
- simpler implementation path
- higher install/update trust cost

#### Option B: Separate power-user build
- cleaner trust posture for main product
- more packaging and distribution complexity

### If approved, implementation scope

- explicit deep-debug enablement UX
- per-tab attach/detach lifecycle
- bounded storage of debugger evidence
- clearly separate deep evidence from bounded runtime evidence
- packet integration without flooding default workflows

### Technical implementation items

- keep deep-debug artifacts out of `ClipRecord.runtimeContext`
- add a separate deep-debug storage/index layer
- define attach lifecycle in the service worker only
- require explicit UX copy for permission and active-state disclosure

### Acceptance gates

- user always knows when debugger capture is attached
- deep debug is off by default
- packet size and evidence scope remain bounded
- uninstall/update trust implications are understood and documented

### QA gates

- manual:
  - attach / detach
  - navigation while attached
  - failure while bridge unavailable
- review:
  - debugger evidence kept behind a separate boundary and schema

## Test Strategy

Every stage requires four layers of validation.

### 1. Build gate
- `npm run build`

### 2. Code review gate
- review findings first
- no silent-failure paths
- no accidental duplication across popup / modal / panel / worker
- no raw runtime/debug payload leaks directly into UI or prompts

### 3. Functional QA gate
- manual flow checks for the changed stage
- screenshots or concrete repro notes for any failure

### 4. Design QA gate
- hierarchy
- spacing
- state clarity
- trust signals
- no visible scrollbar regressions
- no “warning wall” prose

## Sequencing Recommendation

Proceed in this exact order:

1. Finish Stage 1 completely.
2. Do not start Stage 2 until the modal editor is clearly delightful.
3. Do not start Stage 4 handoff polish until Stage 3 evidence shaping is trustworthy.
4. Treat Stage 5 as mandatory before any debugger work.
5. Treat Stage 6 as a product decision, not a background implementation task.

## Review Synthesis

### Founder review summary

- the 10-star version is not “more debugging”; it is “the cleanest path from browser state to agent-ready task”
- editor quality is more important than broader surface area
- prompt quality is a first-class product feature, not metadata

### Engineering review summary

- current architecture is viable if the service worker remains the orchestration boundary
- duplication risk is highest across modal copy logic, side-panel summary logic, and handoff assembly
- Stage 5 is mandatory before any debugger investment

### Frontend/UX review summary

- screenshot should dominate
- side panel should act as gallery + dispatch, not second editor
- local action feedback matters more than global status text

### Backend review summary

- storage/index consistency and packet assembly boundaries are the biggest medium-term technical risks
- deep debug should be modeled as a separate evidence layer if it ever ships

## Immediate Next Step

Execute Stage 1 to completion:
- modal hierarchy cleanup
- annotation interaction polish
- copy/send trust signals
- predictable cancel/escape behavior
- review
- manual QA

Do not move on until the editor-first loop feels boringly reliable.
