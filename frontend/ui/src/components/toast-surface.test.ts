import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const css = readFileSync(fileURLToPath(new URL("./toast.css", import.meta.url)), "utf8")
const source = readFileSync(fileURLToPath(new URL("./toast.tsx", import.meta.url)), "utf8")

test("toasts use one compact floating surface without an outlined card", () => {
  expect(css).toContain("width: min(360px, calc(100vw - 32px))")
  expect(css).toContain("border-radius: var(--radius-sm)")
  expect(css).toContain("border: 0")
  expect(css).toContain("overflow-wrap: anywhere")
  expect(css).not.toContain("max-width: 400px")
})

test("toasts stay usable at 320px and when reduced motion is requested", () => {
  expect(css).toContain("@media (max-width: 360px)")
  expect(css).toContain("width: calc(100vw - 16px)")
  expect(css).toContain("min-height: 32px")
  expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none;[\s\S]*transition: none;/)
})

test("toast actions are explicit buttons with a visible keyboard focus treatment", () => {
  expect(source).toContain('type="button"')
  expect(css).toContain('[data-slot="toast-action"]')
  expect(css).toContain("&:focus-visible")
  expect(css).toContain("outline: 2px solid var(--border-focus-base, var(--text-interactive-base))")
})
