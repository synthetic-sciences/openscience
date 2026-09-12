#!/usr/bin/env python3
"""Render a part to a multi-view PNG for mandatory visual review.

    python scripts/snapshot.py out/carrier.step --out out/carrier.png
    python scripts/snapshot.py carrier_model.py --out out/carrier.png --views iso,front,top

Renders offscreen through matplotlib's Agg backend, so it needs no display, no GPU,
and no viewer application. Faces come from OpenCascade's tessellation; the outlines
are the model's real BREP edges, drawn without hidden-line removal, so the render
reads slightly x-ray.

This step exists because ``is_valid`` and a correct bounding box are both fully
consistent with a pocket cut on the wrong face, an inverted mold polarity, or a
feature placed outside the body. Look at the image.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    LabCadError,
    eprint,
    load_shape,
    main_guard,
)

# elevation, azimuth
VIEWS = {
    "iso": (24.0, -58.0),
    "front": (0.0, -90.0),
    "back": (0.0, 90.0),
    "right": (0.0, 0.0),
    "left": (0.0, 180.0),
    "top": (89.9, -90.0),
    "bottom": (-89.9, -90.0),
}
DEFAULT_VIEWS = ["iso", "front", "right", "top", "left", "bottom"]


def _require_matplotlib():
    try:
        import matplotlib  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise LabCadError(
            "matplotlib is not installed in this interpreter.\n"
            '  uv pip install --python .venv-labcad/bin/python "matplotlib>=3.8"'
        ) from exc
    matplotlib.use("Agg")
    return matplotlib


def _to_rgb(color: str):
    from matplotlib.colors import to_rgb  # noqa: PLC0415

    return to_rgb(color)


def _shade(base, normals, elevation: float, azimuth: float):
    """Flat-shade each triangle by its angle to the camera for this view.

    Without this every face renders the same colour, which makes pockets,
    steps, and bosses almost impossible to read - defeating the purpose of a
    review render.
    """
    import numpy as np  # noqa: PLC0415

    elev_rad = np.radians(elevation)
    azim_rad = np.radians(azimuth)
    camera = np.array([
        np.cos(elev_rad) * np.cos(azim_rad),
        np.cos(elev_rad) * np.sin(azim_rad),
        np.sin(elev_rad),
    ])
    # Offset the light from the camera so faces square-on to the viewer still
    # separate from those angled away.
    light = camera + np.array([0.35, 0.25, 0.55])
    light /= np.linalg.norm(light)

    intensity = np.abs(normals @ light)
    scale = 0.55 + 0.45 * intensity
    colors = np.clip(np.asarray(base)[None, :] * scale[:, None], 0.0, 1.0)
    return colors


def _view_label(name: str, bbox) -> str:
    """In-plane extents for this view, in millimetres."""
    size_x, size_y, size_z = float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z)
    plane = {
        "front": (size_x, size_z),
        "back": (size_x, size_z),
        "right": (size_y, size_z),
        "left": (size_y, size_z),
        "top": (size_x, size_y),
        "bottom": (size_x, size_y),
    }.get(name)
    if plane is None:
        return ""
    return f"{plane[0]:.2f} x {plane[1]:.2f} mm"


def _edge_polylines(shape, samples: int = 24) -> list:
    """Sample the shape's real BREP edges as polylines.

    Drawing triangle edges instead puts a diagonal across every flat rectangular
    face -- pure tessellation noise that reads as a crease or a feature in a review
    render. The BREP edges are the ones a machinist would see.
    """
    try:
        edges = shape.edges()
    except (AttributeError, TypeError):  # pragma: no cover - kernel dependent
        return []

    polylines = []
    for edge in edges:
        try:
            straight = "LINE" in str(edge.geom_type)
            count = 2 if straight else samples
            points = [edge @ (index / (count - 1)) for index in range(count)]
            polylines.append([(float(p.X), float(p.Y), float(p.Z)) for p in points])
        except Exception:  # noqa: BLE001 - skip an edge the kernel cannot sample
            continue
    return polylines


def _tessellate(shape, deviation: float):
    """Return (vertices, triangles) as plain nested lists."""
    bbox = shape.bounding_box()
    diagonal = max(float(bbox.diagonal), 1.0)
    tolerance = diagonal * deviation
    vertices, triangles = shape.tessellate(tolerance)
    if not triangles:
        raise LabCadError(
            "tessellation produced no triangles; the shape may be empty or invalid"
        )
    points = [[float(v.X), float(v.Y), float(v.Z)] for v in vertices]
    return points, triangles


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("target", type=Path, help="STEP, STL, or *_model.py")
    parser.add_argument("--out", type=Path, required=True, help="output PNG path")
    parser.add_argument("--views", default=",".join(DEFAULT_VIEWS),
                        help=f"comma-separated views from {', '.join(VIEWS)} "
                             f"(default: {','.join(DEFAULT_VIEWS)})")
    parser.add_argument("--deviation", type=float, default=0.002,
                        help="tessellation deviation as a fraction of the bbox diagonal "
                             "(default: 0.002; lower is finer and slower)")
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--color", default="#7ea9d4", help="base face colour")
    parser.add_argument("--no-edges", action="store_true",
                        help="skip the BREP edge overlay; faster on parts with thousands "
                             "of edges, at the cost of feature outlines")
    parser.add_argument("--show-axes", action="store_true",
                        help="draw mm axes and ticks; off by default because the "
                             "collapsed axis in an orthographic view overlaps its labels")
    args = parser.parse_args()

    requested = [name.strip() for name in args.views.split(",") if name.strip()]
    unknown = [name for name in requested if name not in VIEWS]
    if unknown:
        raise LabCadError(
            f"unknown view(s): {', '.join(unknown)}. Available: {', '.join(VIEWS)}"
        )

    _require_matplotlib()
    import matplotlib.pyplot as plt  # noqa: PLC0415
    from mpl_toolkits.mplot3d.art3d import Line3DCollection, Poly3DCollection  # noqa: PLC0415

    eprint(f"loading {args.target} ...")
    shape = load_shape(args.target)

    eprint("tessellating ...")
    points, triangles = _tessellate(shape, args.deviation)
    outlines = [] if args.no_edges else _edge_polylines(shape)
    eprint(f"{len(points)} vertices, {len(triangles)} triangles, {len(outlines)} edges")

    import numpy as np  # noqa: PLC0415

    vertices = np.asarray(points, dtype=float)
    index = np.asarray(triangles, dtype=int)
    faces = vertices[index]

    # Per-face normals, used to shade each view from its own camera direction.
    normals = np.cross(faces[:, 1] - faces[:, 0], faces[:, 2] - faces[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = normals / np.where(lengths == 0.0, 1.0, lengths)

    base = _to_rgb(args.color)

    bbox = shape.bounding_box()
    centre = [
        (float(bbox.min.X) + float(bbox.max.X)) / 2.0,
        (float(bbox.min.Y) + float(bbox.max.Y)) / 2.0,
        (float(bbox.min.Z) + float(bbox.max.Z)) / 2.0,
    ]
    reach = max(float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z), 1e-6) / 2.0
    reach *= 1.08

    columns = min(3, len(requested))
    rows = (len(requested) + columns - 1) // columns
    figure = plt.figure(figsize=(4.2 * columns, 4.2 * rows))

    for position, name in enumerate(requested, start=1):
        elevation, azimuth = VIEWS[name]
        axes = figure.add_subplot(rows, columns, position, projection="3d")

        shaded = _shade(base, normals, elevation, azimuth)
        collection = Poly3DCollection(
            faces, facecolors=shaded, edgecolors="none", alpha=1.0,
        )
        axes.add_collection3d(collection)
        if outlines:
            # Matplotlib cannot hidden-line-remove across collections, so these
            # include far-side edges. That reads as slightly x-ray, and is called
            # out in the message below rather than hidden.
            axes.add_collection3d(Line3DCollection(
                outlines, colors=[(0.10, 0.16, 0.24, 0.7)], linewidths=0.5,
            ))
        axes.set_xlim(centre[0] - reach, centre[0] + reach)
        axes.set_ylim(centre[1] - reach, centre[1] + reach)
        axes.set_zlim(centre[2] - reach, centre[2] + reach)
        # zoom fills the frame; without it, turning the axes off leaves the shape
        # small in a mostly empty subplot.
        try:
            axes.set_box_aspect((1, 1, 1), zoom=1.0 if args.show_axes else 1.45)
        except TypeError:  # matplotlib < 3.6 has no zoom parameter
            axes.set_box_aspect((1, 1, 1))
        axes.view_init(elev=elevation, azim=azimuth)
        # Matplotlib's 3D default is perspective, which bends a square part into a
        # wedge and makes a straight wall look tapered - the exact kind of thing this
        # render exists to rule out. Every view here is a true orthographic projection.
        axes.set_proj_type("ortho")
        axes.set_title(f"{name}   {_view_label(name, bbox)}", fontsize=10)

        if args.show_axes:
            axes.set_xlabel("x (mm)", fontsize=7)
            axes.set_ylabel("y (mm)", fontsize=7)
            axes.set_zlabel("z (mm)", fontsize=7)
            axes.tick_params(labelsize=6)
        else:
            # Orthographic views collapse one axis, which produces a stack of
            # overlapping tick labels. Legibility of the shape is the point here;
            # use `check.py facts` for numbers.
            axes.set_axis_off()

    figure.suptitle(
        f"{args.target.name}   "
        f"{float(bbox.size.X):.2f} x {float(bbox.size.Y):.2f} x {float(bbox.size.Z):.2f} mm",
        fontsize=12,
    )
    figure.tight_layout()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(args.out, dpi=args.dpi, bbox_inches="tight")
    plt.close(figure)

    eprint(f"wrote {args.out}")
    print(
        f"{args.out}\n"
        "Now READ the image. Confirm: pockets on the intended face, mold polarity "
        "correct, every port and boss present and inside the body, no feature "
        "consumed by a fillet.\n"
        "Reading it: views are true orthographic, and the outlines are the model's real "
        "edges, hidden ones included. So a circle showing 'through' material is a "
        "far-side bore, not a window - the part is not transparent."
    )
    return 0


if __name__ == "__main__":
    main_guard(main)
