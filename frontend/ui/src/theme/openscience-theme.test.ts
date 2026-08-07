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
  "background-base": "#1c1d1c",
  "background-weak": "#202120",
  "background-strong": "#181918",
  "background-stronger": "#141514",
  "surface-raised-strong": "#252625",
  "surface-raised-strong-hover": "#2a2b2a",
  "surface-raised-stronger": "#2a2b2a",
  "surface-raised-stronger-hover": "#30312f",
  "surface-strong": "#2d2e2c",
  "surface-raised-stronger-non-alpha": "#252625",
  "border-weaker-base": "#f0efeb08",
  "border-weak-base": "#f0efeb12",
  "border-weak-hover": "#f0efeb1d",
  "border-base": "#f0efeb27",
  "border-hover": "#f0efeb34",
  "border-strong-base": "#f0efeb43",
  "text-base": "#deddd8",
  "text-weak": "#b0afa9",
  "text-weaker": "#85847f",
  "text-strong": "#f0efeb",
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

describe("OpenScience default theme", () => {
  test("uses canonical warm paper, cool-neutral dark, and rust anchors", () => {
    expect(openscience.light.overrides["background-base"]).toBe("#f7f4ed")
    expect(openscience.light.overrides["text-strong"]).toBe("#241f1a")
    expect(openscience.light.overrides["surface-brand-base"]).toBe("#b85c3b")
    expect(openscience.dark.seeds.neutral).toBe("#292a28")
    expect(openscience.dark.overrides["surface-brand-base"]).toBe("#d48765")

    for (const entry of Object.entries(darkPalette)) {
      expect(darkOverrides[entry[0]]).toBe(entry[1])
      expect(resolved.dark[entry[0]]).toBe(entry[1])
      expect(fallback.dark[entry[0]]).toBe(entry[1])
    }
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
})
