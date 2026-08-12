import type { JSX } from "solid-js"

export const FONT_SANS =
  'var(--font-family-sans, "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)'
/** Code font — resolves through the theme/Settings-owned mono variable so the
 *  user's mono-font choice applies everywhere code renders. */
export const FONT_CODE =
  'var(--font-family-mono, "Söhne Mono", "Sohne Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace)'
/** Historical alias: this is UI text, not a monospace face. Use FONT_CODE for code. */
export const FONT_MONO = FONT_SANS
/** Alias kept for call sites that reference the UI sans token. */
export const FONT_UI_SANS = FONT_SANS

/** Semantic UI weight scale — mirrors the variables in @synsci/ui/theme.css. */
export const FONT_WEIGHT = {
  regular: 380,
  medium: 480,
  emphasis: 500,
} as const

/** Control radius in px — keep in lockstep with --radius in atlas.css. */
export const RADIUS = 12
/** Primary panel radius — keep in lockstep with --atlas-radius-lg in atlas.css. */
export const SURFACE_RADIUS = 20

export const Z = {
  header: 20,
  sticky: 50,
  fab: 100,
  overlay: 200,
  modal: 300,
  toast: 400,
} as const

export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
} as const

/** Quiet section-label spec — mirror of .atlas-section-label. */
export const sectionTitle: JSX.CSSProperties = {
  "font-family": FONT_SANS,
  "font-size": "12px",
  "font-weight": FONT_WEIGHT.medium,
  "letter-spacing": "0.02em",
  color: "var(--color-text-faint)",
}

export const cardStyle: JSX.CSSProperties = {
  background: "var(--color-surface-solid)",
  border: "1px solid var(--color-border)",
  "border-radius": `${SURFACE_RADIUS}px`,
  padding: "16px 18px",
}

export const monoText = (size: number, color: string = "var(--color-text)"): JSX.CSSProperties => ({
  "font-family": FONT_MONO,
  "font-size": `${size}px`,
  color,
})

export const sansText = (size: number, color: string = "var(--color-text)"): JSX.CSSProperties => ({
  "font-family": FONT_SANS,
  "font-size": `${size}px`,
  color,
})
