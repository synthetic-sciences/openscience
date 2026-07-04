# Molecular Visualization Style Guide

Standards and recommendations for creating publication-quality molecular images in drug discovery, medicinal chemistry, and computational biology.

## Atom Color Scheme (CPK Convention)

The Corey-Pauling-Koltun (CPK) color scheme is the standard for molecular visualization:

| Element | Color | Hex Code |
|---------|-------|----------|
| Carbon (C) | Dark gray | `#333333` |
| Nitrogen (N) | Blue | `#3050F8` |
| Oxygen (O) | Red | `#FF0D0D` |
| Sulfur (S) | Yellow | `#FFFF30` |
| Phosphorus (P) | Orange | `#FF8000` |
| Chlorine (Cl) | Green | `#1FF01F` |
| Bromine (Br) | Dark red | `#A62929` |
| Fluorine (F) | Light green | `#90E050` |
| Iodine (I) | Dark violet | `#940094` |
| Hydrogen (H) | White | `#FFFFFF` |
| Boron (B) | Salmon | `#FFB5B5` |

For 2D drawings, hydrogen atoms are typically implicit (not shown) unless they are stereochemically relevant or the user explicitly requests them.

## Publication Standards

### Resolution

| Medium | Minimum DPI | Recommended DPI |
|--------|-------------|-----------------|
| Journal print | 300 | 600 |
| Journal online | 150 | 300 |
| Poster | 150 | 300 |
| Presentation (screen) | 72 | 150 |

Vector formats (SVG, PDF, EPS) are always preferred for print publications, as they scale to any resolution without quality loss. Use PNG only when vector output is not supported.

### Image Dimensions

| Context | Single Molecule | Grid Cell | Interaction Diagram |
|---------|----------------|-----------|---------------------|
| Manuscript (single column) | 400 x 300 px (3.3 in) | 200 x 150 px | 600 x 600 px |
| Manuscript (double column) | 800 x 600 px (6.6 in) | 300 x 250 px | 800 x 800 px |
| Poster | 600 x 450 px | 400 x 300 px | 1000 x 1000 px |
| Presentation slide | 500 x 375 px | 250 x 200 px | 700 x 700 px |
| Patent figure | 400 x 300 px | 200 x 150 px | N/A |

### Font Sizes

| Element | Minimum Size | Recommended Size |
|---------|-------------|------------------|
| Atom labels | 10 pt | 12 pt |
| Atom index annotations | 7 pt | 8 pt |
| Molecule name (in grid) | 10 pt | 12 pt |
| Property annotations | 8 pt | 10 pt |
| Figure title | 12 pt | 14 pt |
| Interaction residue labels | 8 pt | 10 pt |
| Distance labels | 6 pt | 8 pt |

Use sans-serif fonts (Helvetica, Arial, DejaVu Sans) for labels. Avoid serif fonts in molecular diagrams, as they can interfere with bond line readability.

### Bond Rendering

- Bond line width: 1.5-2.5 px (2.0 recommended)
- Wedge bond width: 2.0-3.0 px for stereochemistry display
- Double bond gap: proportional to bond length (RDKit handles this automatically)
- Aromatic rings: render as alternating single/double bonds (Kekulized) or with inner circle; Kekulized is preferred for publications

## Interaction Diagram Colors

| Interaction Type | Color | Hex Code | Line Style |
|-----------------|-------|----------|------------|
| Hydrogen bond | Green | `#27AE60` | Dashed |
| Hydrophobic | Gray | `#95A5A6` | Dashed |
| Pi-stacking | Orange | `#E67E22` | Dashed |
| Salt bridge | Red | `#E74C3C` | Dashed |
| Water bridge | Cyan | `#00BCD4` | Dotted |
| Halogen bond | Purple | `#9B59B6` | Dashed |
| Metal coordination | Brown | `#795548` | Solid |

### Residue Background Colors (for interaction diagrams)

| Interaction Type | Background | Hex Code |
|-----------------|------------|----------|
| H-bond donor/acceptor | Light green | `#D5F5E3` |
| Hydrophobic contact | Light gray | `#EAECEE` |
| Pi-stacking | Light orange | `#FDEBD0` |
| Salt bridge | Light red | `#FADBD8` |

## Colorblind-Friendly Palettes

Approximately 8% of males and 0.5% of females have some form of color vision deficiency. Follow these guidelines:

### Preferred Substitutions

| Standard Pair | Problem | Colorblind-Safe Alternative |
|--------------|---------|---------------------------|
| Red / Green | Most common confusion | Blue (`#2171B5`) / Orange (`#E6550D`) |
| Red / Blue | Tritanopia confusion | Blue (`#2171B5`) / Yellow (`#FEC44F`) |

### Recommended Palettes

**Two-color scheme** (scaffold / R-group):
- Scaffold: Blue `#4A90D9`
- R-groups: Orange `#E6850D`

**Four-color scheme** (interaction types):
- H-bond: Blue `#2171B5`
- Hydrophobic: Gray `#95A5A6`
- Pi-stacking: Yellow-orange `#FEC44F`
- Salt bridge: Dark purple `#6A3D9A`

**Continuous color scales**:
- Prefer viridis, plasma, or cividis colormaps (all colorblind-safe)
- Avoid jet/rainbow colormaps

### Additional Tips

- Use shape (dashed vs. dotted lines, circles vs. squares) in addition to color to encode information types.
- Add text labels or patterns as a redundant encoding channel.
- Test your figures with a colorblind simulator (e.g., Coblis or Color Oracle).

## When to Use 2D vs 3D

| Scenario | Recommended | Rationale |
|----------|-------------|-----------|
| SAR tables in manuscripts | 2D | Compact, easily comparable, reproducible |
| Patent chemical structures | 2D | Standard legal format, unambiguous |
| Medicinal chemistry presentations | 2D + 3D | 2D for compound comparison, 3D for binding context |
| Binding mode analysis | 3D | Spatial relationships are critical |
| Molecular docking results | 3D | Pose and interaction geometry matter |
| Supplementary material | 3D (interactive HTML) | Allows reader to explore freely |
| Conference posters | 2D primary, 3D inset | 2D for clarity at distance, 3D for detail |
| Teaching materials | Both | 2D for basics, 3D for spatial understanding |
| Virtual screening hit lists | 2D grid | Rapid visual comparison of many compounds |

## 3D Visualization Best Practices

### Protein-Ligand Complexes

- Show protein as cartoon (ribbon) for overall fold context.
- Show ligand as sticks with element coloring for chemical detail.
- Add a transparent surface (opacity 0.2-0.4) around the binding pocket for shape context.
- Color protein chains distinctly (spectrum or by chain ID).
- Always include a scale reference or mention viewing distance.

### Small Molecules

- Use stick representation for bond connectivity.
- Use ball-and-stick for emphasizing atom positions.
- Use sphere (space-filling) for van der Waals surface shape.
- Include hydrogen atoms when they are relevant (H-bonding, tautomerism).

### Background and Lighting

- White background for publications (matches printed page).
- Dark background for presentations (better contrast on projector).
- Ambient occlusion improves depth perception in static renders.

## File Format Reference

| Format | Type | Best For | Notes |
|--------|------|----------|-------|
| SVG | Vector | Print publications | Editable, scales perfectly |
| PNG | Raster | Web, presentations | Use 300 DPI for print |
| PDF | Vector | Print publications | Wide compatibility |
| EPS | Vector | Legacy journal submission | Declining usage |
| HTML | Interactive | Supplementary, web | Self-contained with py3Dmol |
| TIFF | Raster | Journal submission | Lossless, large file size |
