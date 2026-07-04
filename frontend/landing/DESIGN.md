# Design

## Theme

Warm near-black, terminal-native editorial. A research-paper aesthetic rendered
in a dark room: slab-serif display over a warm charcoal ground, JetBrains Mono
for anything a machine would print, a single coral accent, paper grain and a
faint graticule over everything. The lane is committed identity, not a greenfield
choice — keep it.

## Color (OKLCH-equivalent, authored in HSL)

- `--bg` hsl(30 14% 7%) — warm near-black ground (the whole page)
- `--bg-2` hsl(30 11% 10%), `--bg-3` hsl(30 10% 13%), `--panel` hsl(30 12% 9%)
- `--fg` hsl(42 30% 90%) — warm cream ink (body)
- `--fg-soft` 68%, `--fg-faint` 50%, `--fg-dim` 38% — the muted ramp
- `--border` hsl(32 10% 17%), `--border-2` hsl(34 11% 24%) — hairlines
- `--coral` hsl(14 66% 66%) + `--coral-deep` — the one accent, ≤10% of surface
- `--gold` hsl(36 55% 70%), `--blue`, `--purple`, `--ok` — reserved for the
  product-shot mocks (terminal syntax, graph nodes), not for chrome.
- Strategy: **Committed-dark.** The charcoal ground carries the brand; coral is
  the single spark. No second accent competes.

## Typography

- Display + body: **CMU Concrete** (the Computer Modern Concrete slab serif from
  TeX). Roman + Bold only, no italic — the family has none. Carries every human
  sentence: headings and prose.
- Machine text: **JetBrains Mono** (400/500/700) — labels, code, terminal, meta,
  nav, chips. Never for prose.
- Scale (tokens in `:root`): `--fs-display` clamp(44–84px) · `--fs-h1` (hero) ·
  `--fs-h2` (sections) · `--fs-h3` (card headlines) · `--fs-lede` 17–20px ·
  `--fs-prose` 17px. Mono locked to four steps: 14 code / 13 meta / 12 label /
  11 micro. Shared prose measure `--measure: 48ch`.
- Rules: serif for all prose; mono only for machine text; one 18px header→lede
  gap everywhere; `text-wrap: balance` on headings.

## Components

- **Statement card** (`.card.g-red/.g-purple/.g-blue`): radial grainy gradient,
  mono kicker + serif headline + serif body, 10px radius. Paired with a product
  shot in a showcase row.
- **Product shot** (`.shot`, `.term-svg`): browser/terminal chrome around a real
  mock — the animated-once terminal SVG, the web workspace, the Atlas graph, the
  connectors orbit. These are the page's imagery.
- **Quickstart stepper** (`.qs-step`): full-width numbered rows (a real 3-step
  sequence, so numbers are earned), roomy command chips.
- **Copy chip** (`.chip`): the `curl | bash` install line, click-to-copy.
- **Footer**: mono link columns + giant clipped `openscience` wordmark, fully
  visible above the bottom edge.

## Layout

- Max width 1180px, fluid `clamp()` section padding for rhythm.
- Alternating two-column showcase rows (card ⇄ shot), then lower-density
  typographic sections. Vary spacing; avoid uniform box grids (an identical card
  grid is the slop tell).
- Full-bleed grainy engraving hero (a Doré-style two-angels woodcut, B&W) with a
  veil for headline contrast.

## Motion

Reveal-on-scroll (IntersectionObserver, staggered) over an always-safe default;
the terminal types once then rests. Nothing blinks or loops in the chrome.
`prefers-reduced-motion` shows everything statically. Ease-out only.
