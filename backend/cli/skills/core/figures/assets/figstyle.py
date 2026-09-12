"""Publication figure style for matplotlib.

Adapted from alphaXiv OpenResearch (orx_figstyle.py, MIT) for OpenScience.

Vendor this file next to the figure scripts that import it, so a figure stays
reproducible after the session that made it ends.

    from figstyle import COLUMN, PALETTE, figure, save, use_style

    use_style()
    fig, ax = figure(width=COLUMN)
    ax.plot(x, y, color=PALETTE["blue"])
    save(fig, "figs/loss_curve")
"""

from __future__ import annotations

import math
import os
import sys
import warnings

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np

# Final printed widths in inches. Build every figure at the size it will be
# printed at: rescaling in LaTeX rescales the text with it.
COLUMN = 3.25  # one column of a two-column paper (ICML, CVPR, IEEE)
TEXT = 5.5  # \textwidth of a single-column paper (NeurIPS, article)
WIDE = 6.75  # both columns of a two-column paper (figure*)

# Okabe-Ito: distinguishable under every common form of color blindness and in
# greyscale print. Use in this order so the first two series stay the furthest
# apart.
PALETTE = {
    "blue": "#0072B2",
    "orange": "#E69F00",
    "green": "#009E73",
    "red": "#D55E00",
    "purple": "#CC79A7",
    "cyan": "#56B4E9",
    "yellow": "#F0E442",
    "black": "#000000",
}
CYCLE = [PALETTE[k] for k in ("blue", "orange", "green", "red", "purple", "cyan")]

# Reference elements (baselines, chance level, targets) are grey, never a
# palette color: the colors belong to the things being compared. BASELINE is
# the line weight of grey; MUTED is the fill weight, light enough that a dark
# edge still reads as the outline.
BASELINE = "#7F7F7F"
MUTED = "#CFCFCF"

SEQUENTIAL = "viridis"
DIVERGING = "RdBu_r"

# Two-sided 95% t critical values by degrees of freedom. Seed counts are small
# enough that the normal approximation understates the interval.
_T95 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
    8: 2.306, 9: 2.262, 10: 2.228, 12: 2.179, 15: 2.131, 20: 2.086, 30: 2.042,
    40: 2.021, 60: 2.000, 120: 1.980,
}


# Figure text is sans by default. It is what Nature and Science require in
# figures, it holds its strokes at the 5-8pt sizes tick labels actually print
# at, and a figure is scanned rather than read linearly. Each stack runs from
# best to always-present: Helvetica metrics where the machine has them, the
# TeX/Linux clones next, and matplotlib's bundled fonts last so a script still
# renders on a bare box.
SANS = [
    "Helvetica Neue", "Helvetica", "Arial",
    "TeX Gyre Heros", "Nimbus Sans", "Liberation Sans",
    "DejaVu Sans",
]
# STIXGeneral leads the serif stack over Times New Roman deliberately: it has
# the same metrics, ships with matplotlib, and so renders identically on every
# machine instead of silently depending on what is installed.
SERIF = ["STIXGeneral", "TeX Gyre Termes", "Nimbus Roman", "Times New Roman", "DejaVu Serif"]

_resolved_font: str | None = None


def _available_font(stack) -> str | None:
    """The first font in `stack` this machine actually has."""
    import matplotlib.font_manager as fm

    installed = {f.name for f in fm.fontManager.ttflist}
    return next((name for name in stack if name in installed), None)


def use_style(family: str = "sans") -> None:
    """Apply the house rcParams. Call once, before creating any figure.

    Sans is the default. Pass `family="serif"` to match a serif-set document
    when the figure carries heavy math and you want it to read as part of the
    body text; for a plain `article` in Computer Modern, set
    `mathtext.fontset` to `"cm"` afterwards.
    """
    # Figure scripts only ever write files, and often run where no display
    # exists; picking Agg up front avoids a backend failure at import.
    mpl.use("Agg")
    global _resolved_font
    _resolved_font = _available_font(SERIF if family == "serif" else SANS)
    mpl.rcParams.update({
        "font.family": "serif" if family == "serif" else "sans-serif",
        "font.serif": SERIF,
        "font.sans-serif": SANS,
        # stixsans pairs with a Helvetica-metric text face and is bundled, so
        # math in a figure does not fall back to a different-looking family.
        "mathtext.fontset": "stix" if family == "serif" else "stixsans",
        # arXiv rejects Type 3 fonts; 42 embeds TrueType outlines instead.
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "svg.fonttype": "none",
        "font.size": 8,
        "axes.labelsize": 8,
        "axes.titlesize": 8,
        "legend.fontsize": 7,
        "xtick.labelsize": 7,
        "ytick.labelsize": 7,
        "figure.dpi": 200,
        "savefig.dpi": 600,
        "savefig.transparent": False,
        "axes.prop_cycle": mpl.cycler(color=CYCLE),
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.linewidth": 0.6,
        "axes.grid": True,
        "axes.grid.axis": "y",
        "axes.axisbelow": True,
        "grid.color": "#D9D9D9",
        "grid.linewidth": 0.4,
        "lines.linewidth": 1.2,
        "lines.markersize": 3.5,
        "xtick.direction": "out",
        "ytick.direction": "out",
        "xtick.major.width": 0.6,
        "ytick.major.width": 0.6,
        "xtick.major.size": 2.5,
        "ytick.major.size": 2.5,
        "legend.frameon": False,
        "legend.handlelength": 1.4,
        "legend.columnspacing": 1.0,
        "legend.borderaxespad": 0.3,
    })


def figure(width: float = COLUMN, ratio: float = 0.68, **kwargs):
    """One axes at a final printed size. `ratio` is height/width."""
    fig, ax = plt.subplots(figsize=(width, width * ratio), layout="constrained", **kwargs)
    return fig, ax


def figure_grid(nrows: int = 1, ncols: int = 2, width: float = TEXT, ratio: float = 0.4, **kwargs):
    """A panel grid at a final printed size, sharing one constrained layout."""
    fig, axes = plt.subplots(
        nrows, ncols, figsize=(width, width * ratio), layout="constrained", **kwargs
    )
    return fig, axes


def panel_labels(axes, labels=None, weight: str = "bold", pad: float = 2.0):
    """Label panels (a), (b), ... above each axes' top-left corner.

    Panel letters are how prose names a part of a figure ("as Fig. 2b shows").
    Without them a multi-panel figure can only be referred to by position,
    which breaks the moment a panel moves.
    """
    flat = np.ravel(np.asarray(axes, dtype=object)).tolist()
    labels = labels or [f"({chr(ord('a') + i)})" for i in range(len(flat))]
    for ax, text in zip(flat, labels):
        ax.annotate(
            text,
            xy=(0, 1), xycoords="axes fraction",
            xytext=(0, pad), textcoords="offset points",
            ha="left", va="bottom", fontweight=weight,
            fontsize=mpl.rcParams["axes.labelsize"],
        )


def _looks_numeric(label: str) -> bool:
    try:
        float(label.replace("\u2212", "-").replace("%", "").rstrip("kMBT"))
        return True
    except ValueError:
        return False


def _audit(fig) -> list[str]:
    """Check a figure against the rules the references make non-negotiable."""
    problems = []
    if mpl.rcParams["pdf.fonttype"] != 42:
        problems.append("use_style() was never called: fonts will embed as Type 3, which arXiv rejects")
    if _resolved_font is None or _resolved_font.startswith("DejaVu"):
        problems.append(
            "no publication font on this machine, so the figure carries matplotlib's "
            "default DejaVu look — install Helvetica/Arial, or a Liberation or TeX Gyre package"
        )

    width = fig.get_size_inches()[0]
    if not any(abs(width - known) < 0.02 for known in (COLUMN, TEXT, WIDE)):
        problems.append(
            f"width {width:.2f}in is not a known column width "
            f"({COLUMN}/{TEXT}/{WIDE}); it will be rescaled on import and the text with it"
        )

    for ax in fig.axes:
        if not ax.axison:
            continue
        if ax.get_title():
            problems.append(f"axes title {ax.get_title()!r} duplicates the caption — delete it")
        # A colorbar carries its own label. Two signals because the first is a
        # private attribute: a rename would otherwise fail every heatmap.
        if getattr(ax, "_colorbar", None) is not None or ax.get_label() == "<colorbar>":
            continue
        for axis, name, shared in (
            (ax.xaxis, "x", ax.get_shared_x_axes()),
            (ax.yaxis, "y", ax.get_shared_y_axes()),
        ):
            if axis.get_label().get_text() or not ax.get_visible():
                continue
            # A shared axis is labelled once, on whichever panel shows the ticks.
            if any(
                getattr(sib, f"get_{name}label")() for sib in shared.get_siblings(ax) if sib is not ax
            ):
                continue
            # Categorical ticks (benchmark or variant names) label themselves;
            # an axis title over them just repeats the tick text. Only a linear
            # axis can be categorical — a log axis is quantitative by
            # construction, and its formatter emits mathtext that no numeric
            # test would accept.
            ticks = [t.get_text() for t in axis.get_ticklabels() if t.get_text().strip()]
            if (
                axis.get_scale() == "linear"
                and ticks
                and not all(_looks_numeric(t) for t in ticks)
            ):
                continue
            problems.append(f"an axes has no {name} label")

    # Anything below 5pt is unreadable in print. Bar value labels sit at 5.
    tiny = {
        round(t.get_fontsize(), 1)
        for t in fig.findobj(mpl.text.Text)
        if t.get_text().strip() and t.get_fontsize() < 5
    }
    if tiny:
        problems.append(f"text below the 5pt floor: sizes {sorted(tiny)}")

    problems.extend(_text_collisions(fig))
    return problems


def _text_collisions(fig) -> list[str]:
    """Report text that overlaps other text or runs off the canvas.

    A label sitting on the axis or through a tick label is the most common way
    a figure that satisfies every other rule is still unusable, and it is
    invisible until the figure is drawn.
    """
    fig.canvas.draw()
    try:
        renderer = fig.canvas.get_renderer()
    except AttributeError:
        return ["text could not be inspected: no Agg-family canvas — call use_style() first"]

    # A locator can emit ticks just past the view limits; their label artists
    # exist and carry a position but are never drawn. Exclude them by tick
    # location rather than by geometry, which cannot tell them apart.
    offscreen = set()
    for ax in fig.axes:
        for axis in (ax.xaxis, ax.yaxis):
            lo, hi = sorted(axis.get_view_interval())
            span = hi - lo
            for tick in list(axis.get_major_ticks()) + list(axis.get_minor_ticks()):
                if not lo - span * 1e-6 <= tick.get_loc() <= hi + span * 1e-6:
                    offscreen.update({id(tick.label1), id(tick.label2)})

    boxes = []
    hidden = set()
    for ax in fig.axes:
        if ax.axison:
            continue
        # Its axis artists still carry positions but are never drawn; the
        # axes' own text is the figure and must stay in the comparison.
        for part in (ax.xaxis, ax.yaxis):
            hidden.update(id(t) for t in part.findobj(mpl.text.Text))
    for text in fig.findobj(mpl.text.Text):
        if id(text) in offscreen or id(text) in hidden:
            continue
        if not text.get_visible() or not text.get_text().strip():
            continue
        try:
            box = text.get_window_extent(renderer)
        except (RuntimeError, ValueError):
            continue
        if box.width > 0 and box.height > 0:
            boxes.append((text, box))

    problems, tolerance = [], 1.5
    clipped = [
        text.get_text()
        for text, box in boxes
        if box.x0 < fig.bbox.x0 - tolerance
        or box.x1 > fig.bbox.x1 + tolerance
        or box.y0 < fig.bbox.y0 - tolerance
        or box.y1 > fig.bbox.y1 + tolerance
    ]
    if clipped:
        problems.append(
            f"text runs off the canvas and will be clipped: {sorted(set(clipped))[:3]}"
        )

    hits = []
    for i, (text_a, box_a) in enumerate(boxes):
        for text_b, box_b in boxes[i + 1 :]:
            overlap = mpl.transforms.Bbox.intersection(box_a, box_b)
            if overlap is None:
                continue
            if overlap.width > tolerance and overlap.height > tolerance:
                hits.append(f"{text_a.get_text()[:22]!r} over {text_b.get_text()[:22]!r}")
    if hits:
        shown = "; ".join(hits[:3]) + (f" (+{len(hits) - 3} more)" if len(hits) > 3 else "")
        problems.append(f"overlapping text: {shown}")
    return problems


def save(fig, stem: str, formats=("pdf", "svg"), close: bool = True) -> list[str]:
    """Write `stem.pdf` (for \\includegraphics) and `stem.svg` (for preview).

    No `bbox_inches="tight"`: trimming to content changes the physical width
    and defeats building at the final size.
    """
    # Write first: the audit inspects a live canvas and must never be the
    # reason a finished figure is lost.
    parent = os.path.dirname(stem)
    if parent:
        os.makedirs(parent, exist_ok=True)
    paths = []
    for ext in formats:
        path = f"{stem}.{ext}"
        fig.savefig(path, format=ext)
        paths.append(path)
    try:
        problems = _audit(fig)
    finally:
        if close:
            plt.close(fig)
    # Printed, not raised: a hard failure mid-analysis loses the figure, but a
    # silent pass is how an unpublishable figure reaches the paper.
    if problems:
        print(f"FIGURE AUDIT {stem}: {len(problems)} problem(s) — fix before using", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
    else:
        print(f"figure audit {stem}: clean", file=sys.stderr)
    return paths


def mean_ci(runs, confidence: float = 0.95):
    """Mean and 95% t-interval across seeds. `runs` is (n_seeds, n_points).

    Returns `(mean, lo, hi)`. Report the interval, not the standard deviation:
    a band of +/- 1 SD says how spread the seeds are, not how well the mean is
    resolved.
    """
    if confidence != 0.95:
        raise ValueError("only the 95% interval is tabulated; use scipy for others")
    runs = np.asarray(runs, dtype=float)
    n = runs.shape[0]
    mean = runs.mean(axis=0)
    if n < 2:
        warnings.warn(
            "one seed: the band is a line, not an interval — say 'single seed' in the caption",
            stacklevel=2,
        )
        return mean, mean, mean
    sem = runs.std(axis=0, ddof=1) / math.sqrt(n)
    crit = _t95(n - 1)
    return mean, mean - crit * sem, mean + crit * sem


def family(name: str, n: int, lightest: float = 0.55) -> list[str]:
    """`n` shades of one palette color, lightest first.

    Hue names the method family, shade names the variant within it, so a
    reader separates "prior work" from "ours" before reading the legend.
    """
    base = np.array(mpl.colors.to_rgb(PALETTE[name]))
    if n == 1:
        return [mpl.colors.to_hex(base)]
    steps = np.linspace(lightest, 0.0, n)
    return [mpl.colors.to_hex(base + (1.0 - base) * step) for step in steps]


def pareto_front(x, y, minimize_x: bool = True, maximize_y: bool = True):
    """Indices of the non-dominated points, ordered along the frontier.

    A point is on the frontier when no other point is at least as good on both
    axes and strictly better on one.
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    cost_x = x if minimize_x else -x
    cost_y = -y if maximize_y else y
    best = np.inf
    front = []
    for i in np.lexsort((cost_y, cost_x)):
        if cost_y[i] < best:
            front.append(i)
            best = cost_y[i]
    return np.array(front, dtype=int)


def _t95(df: int) -> float:
    # Round the degrees of freedom down, never to the nearest key: a smaller df
    # gives a larger t, so the interval errs wide rather than overstating how
    # well a handful of seeds resolves the mean.
    covered = [k for k in _T95 if k <= df]
    return _T95[max(covered)] if covered else _T95[1]


def diff_ci(treatment, baseline):
    """Mean difference (treatment - baseline) and its 95% Welch interval.

    An ablation claims a difference, so the figure has to show the interval of
    the difference. Two overlapping per-variant intervals do not mean the
    difference is indistinguishable from zero.
    """
    treatment = np.asarray(treatment, dtype=float)
    baseline = np.asarray(baseline, dtype=float)
    delta = treatment.mean() - baseline.mean()
    n_t, n_b = treatment.size, baseline.size
    if n_t < 2 or n_b < 2:
        warnings.warn(
            "one seed per arm: the difference has no interval — say so in the caption",
            stacklevel=2,
        )
        return delta, delta, delta
    var_t = treatment.var(ddof=1) / n_t
    var_b = baseline.var(ddof=1) / n_b
    sem = math.sqrt(var_t + var_b)
    if sem == 0:
        return delta, delta, delta  # every seed identical: the interval is a point
    df = (var_t + var_b) ** 2 / (var_t**2 / (n_t - 1) + var_b**2 / (n_b - 1))
    half = _t95(int(df)) * sem
    return delta, delta - half, delta + half


def band(ax, x, runs, label=None, color=None, **kwargs):
    """Plot the seed mean as a line with its 95% interval as a matching band."""
    mean, lo, hi = mean_ci(runs)
    (line,) = ax.plot(x, mean, label=label, color=color, **kwargs)
    ax.fill_between(x, lo, hi, color=line.get_color(), alpha=0.18, linewidth=0)
    return line


def label_ends(ax, lines, labels, pad: float = 3.0, min_gap: float = 7.0, **kwargs):
    """Label each line at its right end, in the line's own color.

    Direct labels beat a legend up to ~5 series: the reader never has to match
    a color to a key. Labels whose lines converge are nudged apart by `min_gap`
    points so they stay readable, and the right x-limit is extended by exactly
    the width the labels need.
    """
    ax.figure.canvas.draw()  # constrained layout settles the transform at draw
    renderer = ax.figure.canvas.get_renderer()
    pad_px = pad * ax.figure.dpi / 72

    labels = list(labels)
    if not labels:
        return
    size = kwargs.pop("fontsize", mpl.rcParams["legend.fontsize"])
    widths, heights = [], []
    for text in labels:
        probe = ax.text(0, 0, text, fontsize=size)
        extent = probe.get_window_extent(renderer)
        widths.append(extent.width)
        heights.append(extent.height)
        probe.remove()
    # Separate by the labels' own height, not a fixed point value: the right
    # gap depends on the font, and a constant tuned for one is wrong for another.
    gap_px = max(min_gap * ax.figure.dpi / 72, max(heights) * 1.15)
    # Setting xlim changes the data-to-pixel scale, so the room cannot be
    # measured in the old scale: solve for the limit at which the original span
    # occupies (axes width - label width) pixels.
    x_lo, x_hi = ax.get_xlim()
    need = max(widths) + 2 * pad_px
    axes_px = ax.bbox.width
    if need < axes_px:
        scale = ax.xaxis.get_transform()
        s_lo, s_hi = scale.transform([x_lo, x_hi])
        room = scale.inverted().transform(
            [s_lo + (s_hi - s_lo) * axes_px / (axes_px - need)]
        )[0]
        ax.set_xlim(x_lo, room)

    ends = []
    for line, text in zip(lines, labels):
        xy = (line.get_xdata()[-1], line.get_ydata()[-1])
        ends.append([ax.transData.transform(xy)[1], xy, line, text])
    ends.sort(key=lambda end: end[0])
    for i in range(1, len(ends)):
        ends[i][0] = max(ends[i][0], ends[i - 1][0] + gap_px)
    for y_px, xy, line, text in ends:
        offset = (y_px - ax.transData.transform(xy)[1]) * 72 / ax.figure.dpi
        ax.annotate(
            text,
            xy=xy,
            xytext=(pad, offset),
            textcoords="offset points",
            color=line.get_color(),
            va="center",
            fontsize=size,
            clip_on=False,
            **kwargs,
        )


def si_ticks(ax, which: str = "x") -> None:
    """Format ticks as 1.2k / 340M / 7B instead of 1.2e3 / 3.4e8.

    Call it after the limits are final. On a log axis spanning less than a
    decade the minor ticks carry the labels, so they get the same format —
    otherwise matplotlib prints them as `1.85 x 10^0`.
    """

    def fmt(value, _pos):
        for scale, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "k")):
            if abs(value) >= scale:
                trimmed = f"{value / scale:.1f}".rstrip("0").rstrip(".")
                return f"{trimmed}{suffix}"
        return f"{value:g}"

    axis = ax.xaxis if which == "x" else ax.yaxis
    axis.set_major_formatter(mpl.ticker.FuncFormatter(fmt))
    scale = ax.get_xscale() if which == "x" else ax.get_yscale()
    lo, hi = sorted(ax.get_xlim() if which == "x" else ax.get_ylim())
    if scale == "log" and lo > 0 and hi / lo < 10:
        axis.set_minor_formatter(mpl.ticker.FuncFormatter(fmt))


def annotate_matrix(ax, values, fmt: str = "{:.2f}", image=None, threshold: float = 0.6) -> None:
    """Write each cell's value on a heatmap, in whichever of black or white
    stays legible against that cell."""
    values = np.asarray(values, dtype=float)
    image = ax.images[-1] if image is None else image
    norm, cmap = image.norm, image.cmap
    for (row, col), value in np.ndenumerate(values):
        if not np.isfinite(value):
            continue
        rgba = cmap(norm(value))
        luminance = 0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2]
        ax.text(
            col, row, fmt.format(value),
            ha="center", va="center", fontsize=6,
            color="black" if luminance > threshold else "white",
        )
