import { describe, expect, test } from "bun:test"
import ayu from "./themes/ayu.json"
import openscience from "./themes/openscience.json"
import { resolveTheme } from "./resolve"
import type { DesktopTheme } from "./types"

const theme = openscience as DesktopTheme
const resolved = resolveTheme(theme)
const darkOverrides = theme.dark.overrides ?? {}
const css = await Bun.file(new URL("../styles/theme.css", import.meta.url)).text()
const darkStart = css.indexOf("@media (prefers-color-scheme: dark)")
const declarations = (source: string) =>
  Object.fromEntries(
    Array.from(source.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g), (match) => [
      match[1],
      match[2].replace(/\s+/g, " ").trim(),
    ]),
  )
const fallback = {
  light: declarations(css.slice(0, darkStart)),
  dark: declarations(css.slice(darkStart)),
}

const darkPalette = {
  "background-base": "#17191c",
  "background-weak": "#1d2024",
  "background-strong": "#1a1c20",
  "background-stronger": "#202328",
  "surface-inset-base": "#141619",
  "surface-inset-strong": "#111316",
  "surface-float-base": "#25292e",
  "surface-raised-strong": "#23262b",
  "surface-raised-strong-hover": "#292d32",
  "surface-raised-stronger": "#272b30",
  "surface-raised-stronger-hover": "#2f343a",
  "surface-strong": "#2c3137",
  "surface-raised-stronger-non-alpha": "#23262b",
  "input-base": "#202328",
  "input-hover": "#272b30",
  "button-secondary-base": "#23262b",
  "button-secondary-hover": "#2c3137",
  "border-weaker-base": "#edf1f50a",
  "border-weak-base": "#edf1f514",
  "border-weak-hover": "#edf1f522",
  "border-base": "#edf1f52e",
  "border-hover": "#edf1f53d",
  "border-strong-base": "#edf1f54d",
  "text-base": "#d8dde2",
  "text-weak": "#aeb5bd",
  "text-weaker": "#8d959e",
  "text-strong": "#f3f5f7",
} as const

const luminance = (color: string) => {
  const channels = color
    .slice(1)
    .match(/../g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

const contrast = (foreground: string, background: string) => {
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
  return (light + 0.05) / (dark + 0.05)
}

const onBrand = [
  "text-on-brand-base",
  "text-on-brand-weak",
  "text-on-brand-weaker",
  "text-on-brand-strong",
  "icon-on-brand-base",
  "icon-on-brand-hover",
  "icon-on-brand-selected",
] as const

const darkSemantics = [
  "surface-success-base",
  "surface-success-weak",
  "surface-success-strong",
  "surface-warning-base",
  "surface-warning-weak",
  "surface-warning-strong",
  "surface-info-base",
  "surface-info-weak",
  "surface-info-strong",
  "text-on-success-base",
  "text-on-success-weak",
  "text-on-success-strong",
  "text-on-warning-base",
  "text-on-warning-weak",
  "text-on-warning-strong",
  "text-on-info-base",
  "text-on-info-weak",
  "text-on-info-strong",
  "border-success-base",
  "border-success-hover",
  "border-success-selected",
  "border-warning-base",
  "border-warning-hover",
  "border-warning-selected",
  "border-info-base",
  "border-info-hover",
  "border-info-selected",
  "icon-success-base",
  "icon-success-hover",
  "icon-success-active",
  "icon-warning-base",
  "icon-warning-hover",
  "icon-warning-active",
  "icon-info-base",
  "icon-info-hover",
  "icon-info-active",
  "icon-on-success-base",
  "icon-on-success-hover",
  "icon-on-success-selected",
  "icon-on-warning-base",
  "icon-on-warning-hover",
  "icon-on-warning-selected",
  "icon-on-info-base",
  "icon-on-info-hover",
  "icon-on-info-selected",
  "syntax-success",
  "syntax-warning",
  "syntax-info",
] as const

const darkStructuralTokens = [
  "background-base",
  "background-weak",
  "background-strong",
  "background-stronger",
  "surface-inset-base",
  "surface-inset-base-hover",
  "surface-inset-strong",
  "surface-inset-strong-hover",
  "surface-float-base",
  "surface-float-base-hover",
  "surface-raised-strong",
  "surface-raised-strong-hover",
  "surface-raised-stronger",
  "surface-raised-stronger-hover",
  "surface-strong",
  "surface-raised-stronger-non-alpha",
  "input-base",
  "input-hover",
  "input-active",
  "input-selected",
  "input-focus",
  "input-disabled",
  "button-secondary-base",
  "button-secondary-hover",
] as const

describe("OpenScience default theme", () => {
  test("uses canonical paper-gray, slate dark, and teal anchors", () => {
    expect(openscience.light.overrides["background-base"]).toBe("#f5f6f7")
    expect(openscience.light.overrides["text-strong"]).toBe("#20252b")
    expect(openscience.light.overrides["surface-brand-base"]).toBe("#376d70")
    expect(openscience.dark.seeds.neutral).toBe("#626a73")
    expect(openscience.dark.overrides["surface-brand-base"]).toBe("#75a8aa")

    for (const entry of Object.entries(darkPalette)) {
      expect(darkOverrides[entry[0]]).toBe(entry[1])
      expect(resolved.dark[entry[0]]).toBe(entry[1])
      expect(fallback.dark[entry[0]]).toBe(entry[1])
    }
  })

  test("keeps every dark structural surface distinct from pure black", () => {
    for (const token of darkStructuralTokens) {
      const color = resolved.dark[token]
      expect(color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(color.toLowerCase()).not.toBe("#000000")
      expect(luminance(color)).toBeGreaterThanOrEqual(0.006)
      expect(fallback.dark[token]).toBe(color)
    }
  })

  test("keeps dark body, supporting text, and brand labels readable", () => {
    expect(contrast(resolved.dark["text-base"], resolved.dark["background-base"])).toBeGreaterThanOrEqual(7)
    expect(contrast(resolved.dark["text-weak"], resolved.dark["background-base"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(resolved.dark["text-weaker"], resolved.dark["background-base"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(resolved.dark["text-on-brand-base"], resolved.dark["surface-brand-base"])).toBeGreaterThanOrEqual(
      4.5,
    )
  })

  test("does not change alternate themes", () => {
    expect(ayu.light.overrides["background-base"]).toBe("#fdfaf4")
    expect(ayu.dark.overrides["background-base"]).toBe("#0f1419")
  })

  test("resolves explicit readable text and icons on brand surfaces", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const token of onBrand) {
        expect(openscience[mode].overrides[token]).toBe(resolved[mode][token])
        expect(fallback[mode][token]).toBe(resolved[mode][token])
        expect(contrast(resolved[mode][token], resolved[mode]["surface-brand-base"])).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test("keeps the pre-JavaScript dark semantic scales identical to the resolved theme", () => {
    for (const token of darkSemantics) {
      expect(fallback.dark[token]).toBe(resolved.dark[token])
    }
  })

  test("keeps every explicit dark override identical before and after JavaScript loads", () => {
    for (const token of Object.keys(darkOverrides)) {
      expect(fallback.dark[token]).toBe(resolved.dark[token])
    }
  })
})
