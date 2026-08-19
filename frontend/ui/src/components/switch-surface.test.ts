import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const styles = () => readFileSync(fileURLToPath(new URL("./switch.css", import.meta.url)), "utf8")

describe("shared switch surface", () => {
  test("owns one compact track and thumb geometry", () => {
    const css = styles()

    expect(css).toMatch(
      /\[data-slot="switch-control"\]\s*\{[^}]*box-sizing: border-box;[^}]*width: 34px;[^}]*height: 20px;[^}]*padding: 1px;[^}]*border: 1px solid var\(--border-weak-base\);[^}]*border-radius: 999px;/s,
    )
    expect(css).toMatch(
      /\[data-slot="switch-thumb"\]\s*\{[^}]*box-sizing: border-box;[^}]*width: 16px;[^}]*height: 16px;[^}]*border: 0;[^}]*border-radius: 50%;[^}]*transform: translateX\(0\);/s,
    )
    expect(css).toMatch(/\&\[data-checked\] \[data-slot="switch-thumb"\]\s*\{[^}]*transform: translateX\(14px\);/s)
  })

  test("keeps the state color configurable without changing its border language", () => {
    const css = styles()

    expect(css).toContain("--switch-active-color: var(--surface-brand-base)")
    expect(css).toMatch(
      /\&\[data-checked\] \[data-slot="switch-control"\]\s*\{[^}]*border-color: var\(--switch-active-color\);[^}]*background-color: var\(--switch-active-color\);/s,
    )
    expect(css).not.toMatch(/\[data-slot="switch-thumb"\]\s*\{[^}]*border:\s*1px/s)
  })

  test("uses 32px desktop and 44px coarse-pointer targets", () => {
    const css = styles()

    expect(css).toMatch(/\[data-component="switch"\]\s*\{[^}]*min-width: 32px;[^}]*min-height: 32px;/s)
    expect(css).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\[data-component="switch"\]\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/s,
    )
  })
})
