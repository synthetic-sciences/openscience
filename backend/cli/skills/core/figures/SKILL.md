---
name: figures
description: Makes publication-quality plots from data with matplotlib or TikZ, learning curves, scaling laws, benchmark and ablation comparisons, Pareto trade-offs, heatmaps and confusion matrices, sized for the page, vector, with uncertainty shown. Use whenever results are plotted, charted or visualized for a paper, report or answer, or an existing plot looks unpolished. Not for conceptual diagrams or schematics (use schematics) and never for drawing numbers that did not come from a run.
summary: "Publication plots from real data: sized for the page, vector, uncertainty shown."
category: core
role: workflow
allowed-tools: [Read, Write, Edit, Bash, python, experiments]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
  adapted-from: alphaXiv OpenResearch orx-figures (MIT)
---

# Figures

A figure in a paper is an argument, not a screenshot of an array. It makes one claim, and a
reader who skips the prose should still get that claim right. Default plotting output does
not clear that bar: it is sized for a screen, titled where a caption belongs, colored from
a cycle that collapses in greyscale, and rasterized where the document wants vector.

## Non-negotiables

1. **Build at the final printed size.** Pick the width from the document (`COLUMN` 3.25 in,
   `TEXT` 5.5 in, `WIDE` 6.75 in in the style module) and include it with
   `width=\linewidth`. Never build big and rescale: a 15-inch canvas dropped into a
   5.5-inch column turns 11 pt tick labels into 4 pt.
2. **Vector out.** PDF for `\includegraphics`, SVG beside it for preview. A rasterized plot
   blurs under the zoom every reviewer uses. PNG is only for genuinely raster content: a
   photograph, a sample grid, an attention map at pixel resolution.
3. **Every number comes from a run.** Read tracked metrics with the experiments tool
   (`experiments series`, `experiments compare`) or from the run's own output files. Never
   plot a remembered, rounded or plausible number, and never leave demo data in a script
   that ships.
4. **The caption is the title.** No axes title on a paper figure; panel letters (**a**,
   **b**) name the parts of a multi-panel figure.
5. **Show the uncertainty, or say there is none.** One seed is an anecdote. Plot the
   interval across seeds and state the seed count in the caption; with one run, write
   "single seed".
6. **Label axes with units.** "Loss" is a label; "step" without saying whether it counts
   optimizer steps or tokens is not.
7. **Colorblind-safe, greyscale-safe.** Use the module's Okabe-Ito palette. Never `jet`,
   `rainbow` or `hsv`; they invent structure the data does not have. Baselines and chance
   levels are grey: color belongs to the things being compared.
8. **One sans-serif face across every figure**, diagrams included. `use_style()` sets it.
   Pass `use_style(family="serif")` only for a figure carrying heavy math on a serif page.

## Set up once per project

Copy the style module beside the figure scripts so a figure stays reproducible after this
session ends. The module lives in this skill's directory at `assets/figstyle.py`; read it
and write it to `figs/figstyle.py` in the working folder (do not import it from the skill
path, which is not part of the project).

```python
from figstyle import COLUMN, PALETTE, figure, save, use_style

use_style()
fig, ax = figure(width=COLUMN)
ax.plot(x, y, color=PALETTE["blue"])
save(fig, "figs/loss_curve")  # writes .pdf and .svg, prints an audit line
```

Plots that only need matplotlib and numpy run in the session's Python; plots that import
project code run in the project environment. Keep the script beside its output
(`figs/loss_curve.py` next to `figs/loss_curve.pdf`); a figure whose script is gone cannot
be corrected when a reviewer asks for one more seed.

## Where the figure goes

Write the figure and its script into the working folder, under `figs/` beside the `.tex`
for a paper, or under the report's own folder otherwise. Never write a figure you intend to
show into a temporary directory; link the saved path in the answer.

```latex
\begin{figure}[t]          % figure* for a WIDE figure in a two-column paper
  \centering
  \includegraphics[width=\linewidth]{figs/loss_curve.pdf}
  \caption{\textbf{LPO reaches the reward plateau in a third of the compute.}
  Held-out reward against training compute for LPO and two baselines; mean of 5 seeds,
  bands are 95\% intervals. The dotted line is the pretrained model.}
  \label{fig:loss}
\end{figure}
```

## Write the caption with the figure

Captions in current papers run about 28 words, often three sentences: a short bold phrase
naming the claim, then the detail a reader needs to trust it.

- Lead with the finding, not the setup. "Training curves for LPO and baselines" names the
  axes, which the axes already do.
- The figure must stand alone; a reader who skipped the section should still get the claim.
- Put the method facts here: seed count, what the band or bar means, smoothing,
  normalization, which points were fitted and which excluded, whether a frontier line is
  measured or a guide.
- Say what is not shown when it matters: a single seed, a truncated axis, a run cut short.
- Do not restate axis labels in prose.

## Multi-panel figures

- Label every panel `(a)`, `(b)`, ... at the top-left with `panel_labels()`.
- Share the axis when panels share a quantity (`sharey=True`); two panels of one metric on
  silently different ranges is the multi-panel version of a truncated bar axis.
- One legend for the figure, not one per panel.
- Panels read in argument order, left to right, top to bottom.
- If the panels do not support one claim, they are separate figures.

Build them with `figure_grid(nrows, ncols, width=TEXT, sharey=True)`.

## Read exactly one reference

Pick by the question the figure answers, not by the shape in mind.

| The figure answers | Read |
| --- | --- |
| How does a metric move over training, and is the gap bigger than seed noise? | `references/curves.md` |
| How does performance change with scale, and what does the trend predict? | `references/scaling.md` |
| Which method wins across benchmarks, or which ablated component mattered? | `references/comparison.md` |
| What is traded off against what: reward vs KL, quality vs cost or latency? | `references/pareto.md` |
| What does this 2D grid, confusion matrix or sweep look like? | `references/matrix.md` |

For a method, architecture or pipeline diagram, load the schematics skill instead; a TikZ
scaffold that matches this palette is in `assets/tikz-preamble.tex` for the cases where an
editable vector diagram is the right medium.

## Before you hand it over

- Read the audit line `save()` prints. It checks the printed width, font embedding, stray
  axes titles, missing axis labels, text under 5 pt, overlapping text and text off the
  canvas. `clean` is the bar; anything else is a defect to fix, not a warning to note.
- If the audit reports no publication font on the machine, say so rather than installing
  fonts; that changes the environment and needs the user's say.
- A label placed at a reference line or data point is the usual overlap; move it or give
  it `backgroundcolor="white"`.
- Open the PDF and read it at printed size. A tick label unreadable on screen at 100% is
  unreadable on paper.
- Every axis labelled with units; no stray title; uncertainty shown with n stated; no legend
  entry for a series that was cut; the script reruns from scratch and reproduces the file.
