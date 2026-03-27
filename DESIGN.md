# Design System — SnapClip

## Product Context
- **What this is:** A Chrome extension that captures screenshots and page context (console logs, network errors, DOM state) and delivers structured evidence packets directly into live Claude or Codex sessions via a localhost bridge.
- **Who it's for:** Developers who code with AI agents all day. Not a DevTools power user — wants to capture what's on screen and hand it to their AI in one click.
- **Space/industry:** Developer tooling, AI-assisted coding workflow
- **Project type:** Chrome extension — popup, side panel (~400px), editor modal

## Aesthetic Direction
- **Direction:** Industrial Minimal — precision instrument, not consumer bug reporter
- **Decoration level:** Minimal. Screenshots are the star. Type and whitespace do the work.
- **Mood:** Warm limestone base, sharp type, forest green accent. Feels like a drafting table. Fast, exact, trustworthy for code/security-sensitive work. Nobody in dev tools owns this combination.
- **Reference products:** Linear (information density), Zed (light theme precision), Raycast (keyboard-first, minimal chrome)
- **Deliberate non-reference:** jam.dev — they own dark + purple. We own light + forest green.

## Typography
- **Display/Hero:** Geist Sans 600 — built by Vercel specifically for developer UIs, free and open source, not overused outside Vercel ecosystem
- **Body/UI:** Geist Sans 400/500 — single family for cohesion, excellent at 11-13px, not Inter
- **Mono/Metadata:** Geist Mono — pairs perfectly with Geist Sans, tabular nums built in, essential for context strips and timestamps
- **Loading:** Google Fonts — `https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap`
- **Scale:**
  - xs: 10px / Geist Mono (metadata, badges, timestamps)
  - sm: 11px / Geist 500 (labels, dock nav, secondary UI)
  - base: 12-13px / Geist 400 (body, list items, prompts)
  - md: 14px / Geist 400 (default body outside extension)
  - lg: 17-18px / Geist 600 (section titles, wordmark)
  - xl: 22-36px / Geist 600 (hero, marketing)

## Color
- **Approach:** Restrained — one accent, warm neutrals, color is rare and meaningful
- **Background:** `#F6F4F0` — limestone, warm off-white. Screenshots pop against this. Not harsh at 2am.
- **Surface:** `#FDFCFB` — chalk white for cards, panels, inputs
- **Surface alt:** `#EEE9E3` — hover states, collapsed items
- **Border:** `#E4DED8` — warm hairline
- **Border strong:** `#D0C9C2` — dividers, stronger separators
- **Text:** `#111110` — near-black with warm tint, not pure #000
- **Muted:** `#867E78` — warm ash for secondary text, placeholders
- **Accent:** `#15783D` — forest green. Nobody in developer tools owns this. Maps to dispatch/go/execute — exactly right for "Send to Agent".
- **Accent hover:** `#0F5F2E`
- **Accent bg:** `#EBF5EF` — tint for active states, badges, focus rings
- **Accent glow:** `rgba(21,120,61,0.18)` — box-shadow on primary buttons
- **Success:** `#1A7A47` — "delivered" state, clip sent confirmation
- **Annotation/Amber:** `#E8960A` — annotation overlays (box, arrow, text), "annotated" clip state
- **Amber bg:** `#FEF3DC`
- **Error:** `#CC2B2B`
- **Error bg:** `#FDEAEA`
- **Dark mode:** Invert surface to `#141412` bg / `#1C1B19` surface, desaturate accent 10%, accent becomes `#22A355`. Warm dark, not cold charcoal.

## Spacing
- **Base unit:** 4px
- **Density:** Compact-to-comfortable. Side panel is 400px — every pixel earns its place.
- **Panel outer padding:** 14px
- **Scale:** 2(2px) 4(4px) 6(6px) 8(8px) 10(10px) 12(12px) 14(14px) 16(16px) 20(20px) 24(24px) 32(32px) 40(40px) 48(48px)
- **Row heights:** dense rows 36px, standard rows 44px, expanded detail variable
- **Card padding:** 10-12px inside the 400px panel, 16px outside

## Layout
- **Approach:** Grid-disciplined inside the extension, camera-roll-first for the clip list
- **Clip list:** 2-column thumbnail grid (camera roll model, not Jira-style text rows). Screenshots are visible immediately.
- **Clip expansion:** Inline — clicking a clip expands it in-place below the grid. No modal. Screenshot full-width, annotation tools, context strip, prompt textarea all appear inline. Each prompt is visually paired to its clip image.
- **Send All pill:** Floating in the panel header at all times. Shows count of ready clips. Primary action is the most prominent element.
- **Navigation:** Bottom dock (Clips / Session / Bridge / Export). Not top tabs. Content first.
- **Border radius:** sm:4px (badges, tags) / base:5-6px (buttons, inputs) / md:8px (cards) / lg:12px (panels, popups) / pill:20px (send all, bridge status)
- **No card borders in clip list:** Left-edge 2px state bar instead (idle=#D0C9C2, annotated=#E8960A amber, ready=#15783D green, sent=#1A7A47, error=#CC2B2B)

## Annotation Tools (Editor)
Available tools in the inline annotation toolbar:
- **Box** — rectangular selection highlight (amber stroke)
- **Arrow** — directional pointer (error red)
- **Text** — label overlay (dark bg, light text)
- **Blur** — redact/privacy blur regions
- **Crop** — trim the screenshot

## Bundle Model
The core product artifact is a multi-clip bundle. Each clip contains:
- Screenshot (full page or region)
- Paired prompt text (written by the user, specific to that clip)
- Context: console errors, network requests, DOM metadata, page URL, viewport
- Annotation overlays

The "Send All" action delivers the complete bundle to the agent session. The bundle preview UI shows numbered clips with thumbnail + URL + prompt + context tags before dispatch.

## Motion
- **Approach:** Minimal-functional + one signature detail
- **Easing:** enter: ease-out / exit: ease-in / move: ease-in-out
- **Duration:** micro:50-80ms / short:100-150ms / medium:200-300ms
- **Transitions:** background color, border-color, box-shadow — all 120ms ease
- **Signature:** Send button has a 150ms left-to-right ink-fill animation on click. The filled state holds 400ms before clearing. Communicates "dispatched" without a spinner.
- **No bounce, no spring physics, no expressive entrance animations** — this is a tool, not a toy

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-26 | Forest green accent #15783D | Zero competition in dev tools; maps to dispatch/go/execute mental model |
| 2026-03-26 | Camera roll clip grid | Screenshots are the star; 2-col thumbnail grid is immediately more useful than text rows |
| 2026-03-26 | Inline expansion (no modal) | Prompt stays paired to its clip visually; less context switching |
| 2026-03-26 | Floating Send All pill | Primary action must be most prominent; product exists for this button |
| 2026-03-26 | Bottom dock nav | Content first; tabs at top push the clip grid down |
| 2026-03-26 | Warm limestone base #F6F4F0 | Screenshots pop; distinct from jam.dev dark; not harsh at 2am |
| 2026-03-26 | Geist Sans + Geist Mono | Purpose-built for developer UIs; free/open source; not Inter |
| 2026-03-26 | Initial design system | Created by /design-consultation based on competitive research (jam.dev, Linear, Zed) + outside voices (Codex + Claude subagent) |
