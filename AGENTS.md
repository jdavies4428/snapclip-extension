## Design Context

### Users
LLM Clip is for frontend engineers, design engineers, solo builders, indie developers, and adjacent designers who work directly with Claude, Codex, or similar agents. They are usually in the middle of debugging or explaining a UI issue on a live tab and want to move from "I see the problem" to "here is a clean packet for the agent" with as little friction as possible.

The core job is not "file a bug report." The core job is: capture the exact browser state, isolate the important region, add lightweight annotation when needed, and hand off a clear, local-first evidence bundle to an AI assistant.

### Brand Personality
The product should feel `ai-first`, `easy`, and `fast`.

Tone should be technically confident, calm, and direct. It should feel like a sharp local tool for people who already know what they are doing, not a cheerful onboarding-heavy consumer app or a bloated enterprise dashboard.

Emotionally, the interface should create:
- momentum
- confidence
- control

### Aesthetic Direction
Jam.dev is the closest reference in terms of product adjacency, but LLM Clip should feel lighter, more shortcut-first, more local-first, and more focused on AI handoff than team workflow management.

The current product language already points in a strong direction:
- dark-first workspace
- cool electric-blue guidance and action accents
- warm annotation color for emphasis and evidence markup
- compact, technical, premium surfaces rather than playful or marketing-heavy visuals

This should not look like:
- generic Chrome extension boilerplate
- a SaaS analytics dashboard
- a bug tracker form
- a gimmicky "AI app" with glowing gradients, purple overload, or decorative futurism

The extension should feel dense in a good way: precise, fast, and intentional. Empty states should guide action clearly and never leave large dead zones without purpose.

### Design Principles
- Shortcut-first immediacy: the fastest path should always feel primary. The popup, side panel, and capture controls should reinforce instant action, not ceremony.
- Evidence first: the clip itself is the hero. Screenshots, crops, annotations, and critical runtime evidence should dominate over settings, chrome, and secondary metadata.
- Local-first trust: the UI should continuously signal that clips and bundles stay local unless the user explicitly exports or sends them.
- Hierarchy over sameness: not every card should carry equal weight. The active clip, current task, and next best action must be visually obvious at a glance.
- Technical polish without bloat: interfaces should feel sharp, compact, and fresh, with deliberate spacing and typography, but never drift into management-dashboard clutter.
- Permission clarity: when host access or richer debugging is needed, the UI should explain why in plain language and frame it as an explicit tradeoff, not a surprise tax.

### Accessibility Expectations
- Treat WCAG 2.2 AA as the baseline for popup, side-panel, and annotation workflows.
- Keep the extension keyboard-first: primary actions, clip switching, editing controls, and handoff/export flows should all remain usable without a pointer.
- Respect `prefers-reduced-motion`; motion can reinforce hierarchy and state changes, but it should never be required to understand or complete a task.
- Do not rely on color alone for status, selection, or warning states. Pair color with copy, borders, or shape changes when signaling meaning.
- Dense technical UI is acceptable, but text must stay legible, focus states obvious, and layouts resilient at extension-sized widths and browser zoom.

### Assumptions
These guidelines assume the extension remains dark-first for its primary workflow surfaces and that the broader LLM Clip brand direction from the main product still applies here. If popup and side-panel design should diverge from the main app more aggressively, update this file before a large redesign pass.
