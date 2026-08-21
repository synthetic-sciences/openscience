---
name: generate-image
description: Generate or edit images using AI models (FLUX, Gemini). Use for general-purpose image generation including photos, illustrations, artwork, visual assets, concept art, and any image that isn't a technical diagram or schematic. For flowcharts, circuits, pathways, and technical diagrams, use the scientific-schematics skill instead.
category: llm-tools
allowed-tools: [Read, generate_image]
---

# Generate Image

Generate or edit a high-quality image with OpenScience's native `generate_image` tool. The tool keeps credentials in the trusted host and saves the returned image directly into the connected workspace.

## Required route

Inside OpenScience, always call the native `generate_image` tool. Do not invoke `scripts/generate_image.py` through Bash: that standalone helper can use a shell-provided BYOK key, but arbitrary subprocesses intentionally cannot receive the managed wallet token.

Credential routing is automatic:

1. A connected user-owned OpenRouter key is used when BYOK routing is active.
2. Otherwise, when managed LLM spend is enabled, a signed-in user's funded OpenScience wallet is used.
3. Only stop when neither route is available or the selected route reports insufficient credit.

Never ask the user to paste a secret into chat. Do not claim that wallet Credits are unavailable until the native tool has attempted the resolved route.

## Tool contract

Call `generate_image` with:

- `prompt` (required): detailed generation or editing instructions.
- `output_path`: destination in the connected workspace; default `generated-image.png`.
- `input_path`: existing image for an edit.
- `model`: OpenRouter image model; default `google/gemini-3-pro-image` (Nano Banana Pro).
- `aspect_ratio`: optional `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, or `9:16`.

Example generation:

```json
{
  "prompt": "Editorial scientific illustration of a DNA double helix with one mutation site highlighted, restrained blue and amber palette, no decorative text",
  "output_path": "figures/dna-mutation.png",
  "aspect_ratio": "3:2"
}
```

Example edit:

```json
{
  "prompt": "Preserve every plotted value and label; improve spacing and contrast for a two-column conference paper",
  "input_path": "figures/ablation-draft.png",
  "output_path": "figures/ablation-refined.png",
  "aspect_ratio": "4:3"
}
```

## Model selection

- `google/gemini-3-pro-image`: Nano Banana Pro; recommended for generation and editing.
- `black-forest-labs/flux.2-pro`: fast, high-quality generation and editing.
- `black-forest-labs/flux.2-flex`: cheaper generation-only alternative.

Use Nano Banana Pro unless the user requests another model or a measured iteration shows a reason to switch.

## Quality workflow

1. Inspect the destination document or visual context first.
2. State the communication goal, content constraints, aspect ratio, and typography constraints in the prompt.
3. Generate one purposeful candidate; never create filler images merely because an output slot exists.
4. Open and inspect the saved image.
5. Check factual content, legibility at final size, cropping, color accessibility, and unwanted invented text.
6. Refine only when a concrete defect remains. Preserve requested content during edits.

For a technical architecture, method flow, pathway, or experimental diagram, load `scientific-schematics` and apply its publication checks while still using the native `generate_image` tool for the Nano Banana call.

## Standalone script

`scripts/generate_image.py` remains a BYOK-only helper for use outside OpenScience. It reads `--api-key`, `OPENROUTER_API_KEY`, or `.env` and calls public OpenRouter. It is not the in-product wallet route.
