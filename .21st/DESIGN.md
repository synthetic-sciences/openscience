# OpenScience design context

OpenScience is a local scientific research workspace built with SolidJS, TypeScript, Vite, and semantic CSS custom properties.

## Visual direction

The product carries the public OpenScience identity into a focused desktop application: warm paper in light appearance, espresso in dark appearance, cream typography, and one restrained coral accent. The interface should feel quiet, precise, and native without copying macOS chrome.

Inter is the interface typeface. Computer Modern is reserved for scientific writing and research artifacts. Controls use 8–10px radii, grouped surfaces use 12–14px, and modal shells use 20–24px. Shadows are low-contrast and warm.

## Source of truth

- Theme tokens: `frontend/ui/src/theme/themes/openscience.json`
- Pre-JavaScript fallback: `frontend/ui/src/styles/theme.css`
- Workspace aliases and geometry: `frontend/workspace/src/styles/atlas.css`
- Existing product components: `frontend/ui/src/components` and `frontend/workspace/src/components`

## Product rules

- Use semantic tokens for every product surface and support light and dark appearance.
- Keep keyboard focus, reduced motion, reduced transparency, and coarse-pointer behavior intact.
- Use coral for interaction, selection, and brand recognition—not decoration.
- Preserve semantic status colors.
- Prefer stable sidebars, inset grouped lists, quiet toolbars, and progressive disclosure.
- Avoid decorative gradients, excessive glass, low-contrast text, and unnecessary card grids.
