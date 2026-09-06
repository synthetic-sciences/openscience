# Classic chat presentation

The reference is OpenScience 2.0.61–2.0.63. The turn, reasoning and tool
presentation in these tags is identical; 2.0.64 uses the same tool components.
This restoration is based on that implementation, not a rollback of the runtime.

## One disclosure per turn

The turn's **Show reasoning and activity** control expands inline reasoning and
individual tool rows in their original order. It does not rewrite a global
preference. Completed history starts collapsed unless the reader previously
expanded it. A live turn opens once and stays open after completion; an explicit
collapse is not overridden by the next stream update.

`session-trace.ts` reads the historical `openscience-trace-expansion-v1` storage
key, retaining explicit false values and bounding saved choices to 200 turns.
The obsolete global `showReasoning` field is ignored, not deleted, and no other
settings are reset.

Answers and scientific results remain available when steps are collapsed.
Pending approvals/questions and failed operations remain at the same keyed
location, so toggling does not destroy an unsent answer or conceal a failure.

## Streaming and scrolling

Readable reasoning remains inline prose, without per-part clocks, repeated
phase headings or Detailed/Compact modes. Tool rows use their original icon,
title and description, with one accessible lifecycle indicator. Full command
output and error details remain inspectable.

The new global toggle changed the heights of earlier turns. In a long-chat
Chromium reproduction this displaced the clicked control by 4,400 pixels.
The restored per-turn control avoids that global mutation. The scroll hook also
captures a disclosure's viewport position before layout changes and corrects
only its residual displacement after native scroll anchoring. Corrections are
immediate, not animated; manual scrolling and Jump to latest release the anchor.

The 2.0.61–2.0.64 runtime used the same streaming SDK versions as 2.0.75 and
appended reasoning deltas as they arrived. Keep that path, the readable-reasoning
SDK fixes, model-specific controls, title single-flight, Stop, partial-output
preservation and protections against retrying unknown paid outcomes. Stored
reasoning/signatures are not changed by presentation. This UI restoration does
not claim to eliminate provider latency or reveal reasoning a provider withholds.

## Regression checks

- `frontend/ui/src/components/session-turn-trajectory.test.ts`: incremental prose,
  stable pending question drafts, failed tools, terminal errors and disclosure.
- `frontend/ui/src/components/basic-tool.test.ts`: compact lifecycle rows and
  complete error/cancellation details.
- `frontend/ui/src/hooks/create-auto-scroll.test.ts`: disclosure anchoring,
  native compensation, manual scrolling and viewport resize.
- `frontend/workspace/src/pages/session-trace.test.ts`: per-turn persistence,
  malformed storage and active-turn expansion.
- `frontend/workspace/src/context/settings-reasoning.test.tsx`: legacy global
  preference compatibility without resetting unrelated settings.
- `frontend/workspace/e2e/science-artifact.spec.ts`: real workspace reloads,
  reasoning prose and scientific results with obsolete preferences present.
- `frontend/workspace/e2e/classic-chat.spec.ts`: twelve long turns with independent
  disclosures, stable mouse/keyboard viewport positions, and persisted choices.

Use the isolated fake-model browser harness; these checks do not require paid
inference or interacting with a running user's session.
