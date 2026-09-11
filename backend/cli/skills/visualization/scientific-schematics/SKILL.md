---
name: scientific-schematics
description: Create or refine publication-quality technical diagrams, scientific workflows, architectures, and biological schematics using editable drawing tools or native image generation.
category: visualization
allowed-tools: [Read, Write, Edit, Bash, generate_image]
---

# Scientific schematics

Use this skill for technical figures whose scientific structure matters: model
architectures, experimental workflows, study diagrams, biological pathways,
mechanistic illustrations, and conceptual schematics.

## Scope

- Follow the user's requested figure count, subject, and document context.
- When refining an existing paper, inspect the manuscript and current figure
  first. Preserve the paper's claims and unaffected figures.
- Do not expand a figure-editing request into literature review, citation audit,
  peer review, or new experiments unless the user asks for that work.
- For plots derived from numeric data, use the local analysis/plotting tool that
  produced the data. Do not use an image model to invent measurements.

## Figure workflow

1. Read the target manuscript, caption, or source figure when one exists.
2. Identify the figure's scientific claim, required components, labels, reading
   order, and output dimensions.
3. Choose the medium for the figure. Prefer editable vector drawings for exact
   labels, arrows, timelines, matrices, and system diagrams. Use native
   `generate_image` for illustrative figures or when the user requests image
   generation; it uses a connected Gemini or OpenRouter account.
4. Render and visually inspect the figure at its actual manuscript size, then
   inspect the page containing it. Fix collisions between labels, arrows, and
   panel boundaries, clipped legends, tiny type, and low contrast. A successful
   export or a text bounding-box check alone is not visual verification.
5. Save the accepted figure in the active session or project workspace and
   update the manuscript only when requested.

Do not invoke bundled Python or CLI image wrappers inside OpenScience. Do not
ask the user to paste a key into chat. If `generate_image` reports that no route
is connected, explain the limitation once and continue with a deterministic
local diagram when the user's request authorizes making the figure. Do not ask
again for an ordinary drawing-method choice or repeatedly call the unavailable
provider. If AI-generated imagery is an explicit requirement, report that
requirement as unresolved instead of claiming the substitute satisfies it.

## Prompt contract

Include:

- figure purpose and target audience;
- exact components and relationships;
- reading direction and visual hierarchy;
- every required label, symbol, legend, and panel marker;
- restrained, colorblind-safe styling and a clean background;
- aspect ratio and space for the intended caption or page layout;
- instructions to avoid decorative, unsupported, or fabricated scientific
  details.

Example:

```json
{
  "prompt": "Conference-paper schematic of a protein-language-model analysis. Left-to-right flow: aligned protein sequences, frozen encoder, sparse feature extraction, mutation intervention, and held-out functional validation. Label every stage and distinguish observed data from hypotheses. Clean white background, restrained colorblind-safe palette, readable typography, no decorative elements.",
  "output_path": "figures/method_overview.png",
  "model": "google/gemini-3-pro-image",
  "aspect_ratio": "16:9"
}
```

## Acceptance check

Before finishing, confirm that labels are legible, arrows and causal direction
are unambiguous, the caption matches the image, and the figure does not imply
evidence stronger than the underlying study. Report any unresolved visual or
scientific uncertainty plainly.
