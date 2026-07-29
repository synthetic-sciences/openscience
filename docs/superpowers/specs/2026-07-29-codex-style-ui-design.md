# Codex-style OpenScience UI design

## Intent

OpenScience should feel like a focused research workspace, not a collection of
dashboards. The conversation or active scientific artifact is the primary
surface. Sessions, files, compute, evidence, skills, and settings remain fully
available, but they should not compete for attention before the researcher asks
for them.

The visual reference is the Codex desktop app: quiet neutral surfaces, strong
typographic hierarchy, generous space around the active work, restrained
controls, and progressive disclosure. OpenScience keeps its research identity
through scientific file previews, notebooks, compute, evidence, and local
project context rather than through extra chrome.

## Product principles

1. **The work is the interface.** Chat, notebooks, data, manuscripts, and
   visualizations receive the largest uninterrupted area.
2. **Reveal tools in context.** The research inspector is closed by default and
   opens when a file, artifact, compute job, terminal, or evidence view needs it.
3. **One clear action per region.** Header, session rail, start screen, and
   composer each have a single dominant action.
4. **Quiet by default.** Status, readiness, provider, and setup information is
   collapsed into compact, actionable states instead of permanent cards.
5. **Research-specific, not dashboard-like.** Scientific starters and workflows
   are concise prompts or rows. They do not become a grid of competing cards.
6. **No functionality regression.** Sessions, files, skills, command palette,
   settings, theme selection, artifacts, Atlas, evidence, compute, and terminal
   remain reachable by mouse and keyboard.

## Information architecture

### Session rail

The left rail is a calm, full-height navigation surface. It contains:

- OpenScience identity and a compact collapse control.
- One prominent “New research” action.
- Recent sessions with a quiet active state.
- Search behind an explicit control or keyboard shortcut instead of a permanent
  input.
- Project navigation and low-frequency settings at the bottom.

The rail is resizable only if the existing behavior already supports it. It
becomes an overlay on small screens and can be dismissed without changing the
active work.

### Workspace header

The header belongs to the active workspace, not the whole product. It shows:

- A session-rail toggle when needed.
- The project or session title, with the path available as secondary text or a
  tooltip.
- A compact “Open” or workspace-tools menu.
- Search/command palette and one overflow menu for help, settings, and theme.

The header does not repeat the wordmark, project breadcrumb, path, and multiple
equal-weight icon buttons.

### Center workspace

Chat is the default center tab. Files and Skills remain available, but the tab
strip reads like a lightweight document bar. It appears only when useful and
does not look like a second global navigation bar.

Conversation content uses a readable central measure, generous turn spacing,
subtle separators, and a composer that visually belongs to the document. The
composer keeps attachments, model selection, research mode, and submission, but
secondary switches collapse into menus.

### New research screen

The start screen contains:

- A simple research question heading.
- One sentence of guidance.
- The composer in the primary visual position.
- A short list of high-value starting actions.
- Compact setup feedback only when action is required.

Detailed workspace readiness, artifact counts, starter packs, workflow
categories, worktree controls, and local/reproducible metadata use progressive
disclosure below the fold or a single “Browse workflows” surface.

### Research inspector

The inspector is closed by default. Its collapsed rail is visually quiet and
has one clear “Tools” affordance rather than four equally prominent icons. When
open, its tabs remain Atlas, Evidence, Compute, and Terminal, plus contextual
artifact inspection. Closing it restores the center workspace without losing
state.

## Visual system

- Use the existing theme tokens and stack. Do not migrate frameworks or add a
  design library.
- Prefer Avenir Next / SF Pro / native app typography for UI and the configured
  mono font for code and measurements.
- Use warm or neutral monochrome surfaces, off-black text, and hairline borders.
- Avoid gradients, large shadows, glow, glass cards, colored ambient
  backgrounds, excessive all-caps labels, and rounded pills.
- Use `4px` to `8px` radii for controls and containers. Reserve full pills for
  tiny statuses.
- Motion is limited to `transform` and `opacity`, respects reduced motion, and
  should be felt more than noticed.
- Every interactive control keeps a visible keyboard focus state and a minimum
  practical hit target.

## Responsive behavior

- At desktop widths, the session rail is stable and the inspector is contextual.
- Below the current tablet breakpoint, both side surfaces become independent
  overlays with backdrops; opening one closes or visually dominates the other.
- At narrow mobile widths, the header keeps only rail toggle, title, and
  overflow. The composer remains fully usable above the virtual keyboard.
- No horizontal page scrolling is introduced at any supported width.

## Verification

Each batch must include a failing automated contract or browser test before its
implementation. Verification includes:

- Focused Solid/Bun tests for state and source contracts.
- Existing workspace typecheck and formatting.
- Hosted or local Playwright flows for session creation, navigation, files,
  skills, inspector tools, and composer interaction.
- Visual inspection at desktop and mobile widths in light and dark themes.
- Console error inspection after each major browser pass.

## Branch and release contract

- All redesign work stays on `openscience/ui-changes`.
- The branch has one permanent pull request into `main`.
- New UI commits are pushed to that PR continuously.
- The UI pull request is never merged without a new explicit user instruction.
- Unrelated functional bug fixes use separate branches and pull requests and may
  be merged to `main` after their own tests pass.
- No npm production workflow is triggered from this work.
