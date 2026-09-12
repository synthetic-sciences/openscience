# Style guide for methodology diagrams

What separates a diagram that looks like it belongs in a current NeurIPS or Nature paper
from one that looks generated. Use these as constraints in the prompt, and as the checklist
when reading the result.

## Contents

- Composition
- Color
- Typography
- Shape vocabulary
- Arrows and connectivity
- Emphasis
- Common failures

## Composition

- One reading direction: left to right for pipelines, top to bottom for hierarchies. The
  input enters at one edge and the result leaves at the opposite edge.
- Generous whitespace between groups; tight spacing within a group. Grouping does the
  explaining that prose would otherwise do.
- Panels only when they isolate different things (training vs inference, model vs data).
  Label them (a), (b) in the top-left, and give each its own claim.
- Fill the aspect ratio requested; do not leave a wide canvas half empty or crowd a column
  slot with a landscape layout.
- No frames around the whole figure, no drop shadows, no 3D, no gradients.

## Color

- White background, always.
- A restrained palette: neutral greys for context, one accent for the contribution, and at
  most two more hues for categories that recur across the paper's figures (the same hue for
  "ours" in every figure). The Okabe-Ito set (blue #0072B2, orange #E69F00, green #009E73,
  red #D55E00, purple #CC79A7) is colorblind-safe and prints in greyscale.
- Fills are light tints; outlines and text are dark. A saturated fill behind black text is
  a legibility failure.
- Never a rainbow, never a dark theme, never a "tech" blue-purple gradient.

## Typography

- One sans-serif face throughout, matching the paper's plots.
- Labels are nouns from the text: "Frozen encoder", "Sparse features", not "Module A".
- Minimum size: the paper's caption size when the figure is placed at its printed width. If
  a label needs to be smaller to fit, the diagram has too many elements.
- Sentence case. No all-caps blocks, no bold everywhere; bold only the contribution's label.
- Mathematical symbols only where the text uses them, set the same way.

## Shape vocabulary

Keep one vocabulary and state it in the prompt:

| Meaning | Shape |
| --- | --- |
| Learned module or model | rounded rectangle, light fill |
| Data, tensor, file | plain rectangle or a stacked-sheets glyph |
| Frozen or fixed component | dashed border, grey fill |
| Optional or ablated path | dashed arrow |
| Loss, objective | small rounded box at the end of the path it scores |
| Repetition, N layers | a stack with "× N" beside it, not N drawn copies |

## Arrows and connectivity

- Every arrow means one thing: data flow, gradient, or dependency. Use one arrow style per
  meaning and put the legend in the caption if two are needed.
- One arrowhead style, one line weight, orthogonal or gently curved routing, no crossings
  where a re-layout avoids them.
- Label an arrow only when the transformation is the point ("sample", "quantize").
- Connectivity is what image models get wrong most: duplicated arrows, arrows into the
  wrong block, reversed direction. Check every planned edge in the output, and count them.

## Emphasis

- The contribution is visibly the subject: accent color, slightly heavier outline, or the
  center of the composition. Everything standard is greyer and lighter.
- Do not emphasize more than one thing. A figure with three highlights has none.

## Common failures

- Boxes labelled with generic words ("Processing", "Model", "Output").
- Icons that decorate rather than denote (brains, lightbulbs, robots, clouds).
- Components or steps that the text does not describe.
- Numbers, tables or bar charts inside the diagram: those are plots, made from data.
- Text baked in at a size that only survives on screen.
- A legend that explains colors the figure did not need.
- Slight misspellings of labels; read every label in the output.
