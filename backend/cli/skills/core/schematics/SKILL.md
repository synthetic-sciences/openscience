---
name: schematics
description: Creates or refines publication-quality technical diagrams with Nano Banana Pro through the native generate_image tool, method and architecture overviews, pipelines, experimental workflows, biological pathways and conceptual schematics, planned from the source text, styled from reference figures, rendered at print resolution and checked against the source before it ships. Use for any figure whose content is structure rather than data. Not for plots of measured numbers (use figures) and not for illustrations or artwork (use generate-image).
summary: "Method and pipeline diagrams with Nano Banana Pro: plan, style, render, check."
category: core
role: workflow
allowed-tools: [Read, Write, Edit, generate_image]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
  method: PaperBanana (Zhu et al., 2026), retriever / planner / stylist / visualizer / critic
---

# Schematics

A methodology diagram carries the paper's central idea in one glance, and it is the figure
most often faked: outdated palettes, boxes that say nothing, arrows that go the wrong way,
components the text never mentions. Image models now draw clean diagrams with legible text,
but left to themselves they are verbose and derivative. The method here is
reference-driven: plan the content from the source, borrow the style from good figures,
render, then check the image against the source and regenerate once if it fails.

## The medium

- `generate_image` renders with Nano Banana Pro on the user's connected Gemini or OpenRouter
  account. Use `image_size: "2K"` for anything that will be printed and `"1K"` while
  iterating; pass up to 14 `reference_paths` for style and component fidelity; set
  `aspect_ratio` from the page slot (16:9 or 21:9 for a full-width overview, 4:3 or 1:1 for
  a column). Output is raster: convert downstream if the venue demands PDF, and check it at
  printed size.
- Prefer an editable vector drawing (TikZ scaffold in the figures skill's
  `assets/tikz-preamble.tex`, or the user's drawing tool) when exact labels, matrices,
  timelines or many small text elements matter, or when the figure will be edited by hand
  later. An image model cannot guarantee character-exact text in twenty labels.
- Plots of numbers are never image-generated. PaperBanana measured it: prettier, and wrong
  (hallucinated values, repeated elements). Load the figures skill for data.
- If `generate_image` reports no connected route, say so once and fall back to a vector
  drawing when the request authorizes making the figure. Do not ask the user to paste a
  key into chat.

## Workflow

Copy this checklist and work through it.

- [ ] 1. Read the source: the method section, caption, and any existing figure.
- [ ] 2. Plan the content (the planner's job).
- [ ] 3. Fix the style from references (the stylist's job).
- [ ] 4. Render at 1K; inspect against the plan (the critic's job); regenerate once at most.
- [ ] 5. Render the accepted plan at 2K, save, write the caption, report open issues.

**Step 1. Read the source.** Identify the claim the figure must make, every component the
text names, the relationships and their direction, what is input, what is learned, what is
frozen, what is compared. A figure that shows a component the text never mentions is wrong
even if it is pretty.

**Step 2. Plan the content.** Write the plan down before prompting:

- the one-sentence claim the figure makes;
- the components, each with its exact label as it appears in the text;
- the connections, each as `source -> target: meaning`, and the reading direction;
- what is emphasized (the contribution) versus context (standard parts, drawn plainer);
- panels, if any, and what each panel isolates;
- the aspect ratio and the caption slot.

Keep it concise: a diagram with more than about twelve labelled elements needs a second
figure or a zoomed inset, not smaller text.

**Step 3. Fix the style.** Pick one to three reference figures whose style fits the venue:
the user's own earlier figures, a figure from a paper they cite, or a published diagram in
the working folder. Read `references/style-guide.md` and write two or three sentences of
style constraints from them: palette (restrained, colorblind-safe, one accent for the
contribution), typography (one sans face, no text under the caption's size), shape
vocabulary (rounded blocks for modules, plain rectangles for data, dashed borders for
frozen or optional parts), whitespace, and a white background. Pass the reference files as
`reference_paths`.

**Step 4. Render and critique.** Prompt with the plan, not with adjectives. Use this shape:

```text
Publication methodology diagram for a <venue> paper, <aspect ratio>, white background.
Claim: <one sentence>.
Components, left to right: <label 1> (<role>), <label 2> (<role>), ... Use these exact labels.
Connections: <A> -> <B> (<meaning>); <B> -> <C> (<meaning>); ...
Emphasize <the contribution> with the single accent color; draw <standard parts> in grey.
Style: match the reference images' palette, typography and line weight; flat, no shadows, no
decorative icons, no invented components, no numbers or tables.
```

Then read the produced PNG with the read tool and check it against the plan:

| Check | Fail means |
| --- | --- |
| Every planned component present, labelled exactly | a missing or renamed block |
| No extra components or text | invented parts, filler labels, watermarks |
| Every connection present, in the right direction, none duplicated | the model's usual failure: connectivity |
| Emphasis on the contribution, context plainer | everything the same weight |
| Text legible at printed size, no overlaps or clipping | tiny or colliding labels |
| Palette restrained and colorblind-safe, white background | rainbow, gradients, dark theme |

If it fails, write a delta prompt naming the specific defects ("the arrow from Encoder to
Decoder is reversed; remove the third block labelled 'Model'") and pass the failed image as
`input_path` for an edit, or regenerate from the plan with the defects listed as
constraints. One round. If the second render still fails on connectivity, switch to the
vector scaffold rather than iterating: connectivity errors are the model's blind spot.

**Step 5. Finalize.** Render the accepted plan at `image_size: "2K"` into the working folder
(`figs/<name>.png` beside a paper), write the caption from the claim (bold phrase, then
what the arrows and colors mean), and report anything the image could not do: a label the
model kept misspelling, a component simplified, a panel dropped.

## Refining an existing diagram

For a human-drawn figure that needs polish, keep the content and change only the style:
pass the original as `input_path`, the style references as `reference_paths`, and prompt
for the same components and connections with the new palette, typography and spacing.
Check the result with the same table; a polish that adds or removes a box is a failure.

## Scope

Do the figures the user asked for, at the count asked for. Do not expand a figure request
into a literature review, citation audit or new experiments. When refining a manuscript,
leave its claims and unaffected figures alone. Save into the session or project workspace
and update the manuscript only when asked.
