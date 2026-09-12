# Microfluidic chips, molds, and flow cells

Channel networks, soft-lithography molds, printed chips, gaskets, and manifolds.

## First: decide what you are actually modelling

This is the error that wastes the most time in microfluidic CAD. Three different objects get
called "the chip":

| Object | Channels are | Made by |
| --- | --- | --- |
| **Mold / master** | **Raised ridges** (positive relief) | Photolithography on a wafer, SLA print, or micromilling |
| **Cast chip** | **Recessed grooves** (negative of the mold) | PDMS cast against the mold, then bonded to a substrate |
| **Directly-fabricated chip** | **Recessed grooves or enclosed lumens** | Printed, milled, or laser-cut directly |

A model that is correct as a chip is exactly wrong as a mold. Put the polarity in the module
docstring and in a named parameter, and **verify it numerically, not by eye**: inverted polarity
is invisible in the bounding box, the volume, and the validity check — and at typical channel
scale (a 0.3 mm ridge on a 40+ mm part) it is invisible in an outline render too, because raised
and recessed features draw the same edges. Declare it as geometry checks instead
(`references/build123d-patterns.md`): a `material` region where the ridge must stand above the
casting surface, and a `clear` region over the rest of that layer — a groove fails the first,
an inverted full-area layer fails the second. For a one-off question,
`check.py probe <step> --box ... --expect material` answers it without editing the model. State
the measured relief height in the report. Use the snapshot for layout and connectivity, which
it does show well.

```python
polarity = "mold"   # "mold" = raised ridges; "chip" = recessed grooves
```

If casting PDMS, the mold also needs a **surrounding wall or a casting frame** to contain the
uncured polymer, and enough flat land around the features for the cast part to release.

## Channel cross-section and aspect ratio

Channels are usually rectangular because that is what planar fabrication produces. Two failure
modes bound the aspect ratio, and both are geometric:

- **Roof sag / collapse** — a channel much wider than it is tall has an unsupported ceiling. In
  PDMS the roof bows down and can stick to the floor. Commonly cited guidance keeps
  **width : height below roughly 10 : 1**; wide channels need support pillars.
- **Sidewall collapse** — a mold ridge much taller than it is wide falls over or fails to release.
  Keep **height : width below roughly 10 : 1** on the mold.

Treat both as rules of thumb, not guarantees: the real limits depend on PDMS mixing ratio, cure
schedule, and applied pressure. For anything load-bearing or high-pressure, prototype.

Also keep **channel-to-channel spacing at least the channel height**, so the wall between two
channels does not deflect or leak, and leave a flat **bonding land** — typically 1 mm or more of
uninterrupted flat surface around the network perimeter — for plasma or adhesive bonding.

## Minimum features by process

Achievable feature size drives the entire design, and the range across processes is three orders
of magnitude. Confirm against your specific tool before committing.

| Process | Practical minimum channel | Notes |
| --- | --- | --- |
| SU-8 photolithography | ~1-10 µm wide, 1-200+ µm tall | The reference process for soft lithography. Feature height is set by spin speed and resist grade. |
| Two-photon / µSLA | ~10-50 µm | Small build volume, slow, expensive. |
| Desktop SLA / DLP | ~200-500 µm | Uncured resin is very hard to clear from smaller lumens. Enclosed channels below ~0.5 mm frequently print blocked. |
| Micromilling | ~100 µm | Set by end-mill diameter; depth limited by tool aspect ratio. Leaves tool marks that scatter light. |
| FDM | Not suitable for sealed channels | Layer porosity leaks. Use only for holders and manifolds. |
| Laser-cut film / gasket | ~200 µm | Excellent for stacked-layer devices and gaskets. |

**Design enclosed printed channels for drainage.** Every lumen needs a path for uncured resin to
escape, and orientation on the build plate determines whether it drains. If the user is printing,
say which way up.

## Ports and tubing

The port is where most chips leak. Options, roughly in order of how common they are in a research
lab:

- **Direct tubing insertion** — a bore slightly *under* the tubing OD so the tubing seals by
  interference. For 1/16 inch OD tubing (1.5875 mm), a bore around 1.5 mm in PDMS is typical. This
  works in elastomer and fails in rigid printed parts, which crack instead of gripping.
- **Luer taper** — the standard syringe interface, a **6% taper** (ISO 80369-7 supersedes the
  legacy ISO 594 series for medical use). Convenient, low pressure only. If you model a Luer taper,
  get the profile from the standard, not from memory.
- **Threaded fittings** — flat-bottom **1/4-28 UNF** is the common lab standard for low-pressure
  fluidics; **10-32 coned** is used at higher pressures. These need a tapped or heat-set-insert
  port and a matching flat sealing face.
- **Barbs** — reliable with soft tubing and a clamp, bulky.

Whichever you choose, the sealing surface must be **flat and normal to the port axis**. A port
face left at a printed layer angle will not seal.

## Dead volume

Dead volume dominates the response time of any perfusion or gradient device, and it is trivially
computable, so compute it rather than estimating:

```
V = pi * r^2 * L                # round tubing / bore
V = w * h * L                   # rectangular channel
```

Report the volume of every connecting bore alongside the channel network volume. A 20 mm long
1 mm bore holds ~15.7 µL, which is often larger than the entire channel network it feeds.

## Flow regime sanity check

Microfluidic flow is almost always laminar, but state it rather than assuming:

```
Re = rho * v * D_h / mu
D_h = 2 * w * h / (w + h)       # hydraulic diameter, rectangular channel
```

For water in a 100 µm channel at 1 mm/s, Re is of order 0.1 — deeply laminar, so mixing is
diffusive only. If the design depends on mixing, it needs a mixer geometry (serpentine,
herringbone, or split-and-recombine); relying on turbulence will not work at these scales.

Pressure drop for a rectangular channel scales steeply with the smaller dimension. **Halving
channel height raises pressure drop by roughly an order of magnitude.** Check that the intended
pump or syringe can actually deliver it before finalising the cross-section.

## Material and optical constraints

- **PDMS** absorbs small hydrophobic molecules and is gas-permeable. Both are sometimes features
  (oxygenation in organ-on-chip) and sometimes fatal to an assay (drug studies).
- **SLA resins** are frequently cytotoxic uncured and often still after a nominal cure. For cell
  work, require post-cure plus a documented biocompatibility check, or use a different process.
  See `references/fabrication-limits.md`.
- **Autofluorescence** matters for any fluorescence readout. Most printed resins autofluoresce
  strongly. Image through glass or a thin COC/COP film, not through printed material.
- **Optical path**: printed and milled surfaces scatter. Any imaging window should be a bonded
  coverslip or film, and the model must specify its thickness so the objective working distance
  works out.

## Checks to run

```bash
python scripts/gen.py chip_model.py --outdir out/
python scripts/check.py facts out/chip.step
python scripts/snapshot.py out/chip.step --out out/chip.png
```

`facts` gives the volume; compare it against your hand-computed channel volume as an independent
check that the network is actually open and connected. A network modelled as a solid rather than a
cavity shows up immediately as a volume far larger than expected.

Then read the snapshot and confirm, explicitly:

1. **Polarity** — ridges for a mold, grooves for a chip.
2. Every port lands on the channel it should, and passes fully through to the surface.
3. The bonding land is continuous around the network.
4. No channel has been closed off or consumed by a fillet.

## Sources

- ISO 80369-7 (Luer connectors for intravascular applications) supersedes the ISO 594 series.
  Obtain the taper profile from the standard itself.
- Aspect-ratio and spacing guidance here is standard soft-lithography practice; the numerical
  limits are rules of thumb and depend on material and process. Prototype before committing.
