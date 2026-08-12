import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./dialog-select-server.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./dialog-select-server.css", import.meta.url)), "utf8")

describe("server editor contract", () => {
  test("persists add and edit changes only through explicit actions", () => {
    const code = source()

    expect(code).not.toContain("onBlur=")
    expect(code).toContain("onSave={() => void handleAdd(store.addServer.url)}")
    expect(code).toContain("onSave={() => void handleEdit(item, store.editServer.value)}")
    expect(code).toContain("onCancel={resetAdd}")
    expect(code).toContain("onCancel={resetEdit}")
    expect(code).toContain('type="submit"')
  })

  test("keeps Enter to save and Escape to cancel for keyboard users", () => {
    const code = source()

    expect(code).toContain('event.key === "Escape"')
    expect(code).toContain('event.key !== "Enter" || event.isComposing')
    expect(code).toContain('label={language.t("dialog.server.add.url")}')
  })

  test("does not put the edit form inside the list item button", () => {
    const code = source()

    expect(code).toContain("itemWrapper={(item, node) => (")
    expect(code).toContain('data-slot="list-item-editor"')
  })

  test("uses a compact, fit-height connection surface instead of nested dark cards", () => {
    const code = source()
    const css = styles()

    expect(code).toContain('class="server-dialog"')
    expect(code).toContain('description={language.t("dialog.server.description")}')
    expect(code).toMatch(/class="server-dialog"[\s\S]*\bfit\b[\s\S]*\btransition\b/)
    expect(css).toContain("width: min(calc(100vw - 24px), 560px)")
    expect(css).toContain("height: auto")
    expect(css).toMatch(
      /\.server-dialog \[data-slot="dialog-title"\]\s*\{[^}]*font-weight: var\(--font-weight-emphasis\)/s,
    )
    expect(css).toContain("box-shadow: var(--atlas-shadow-float)")
    expect(css).toContain('.server-dialog__list [data-slot="list-items"]')
    expect(css).toContain("background: var(--surface-raised-base)")
    expect(code).not.toContain("bg-surface-raised-base [&_[data-slot=list-items]]:rounded-md")
  })

  test("keeps status metadata sentence-cased and interaction targets accessible", () => {
    const code = source()
    const css = styles()

    expect(code).toContain('return value.trim().toLocaleLowerCase() === "local" ? "Local" : value')
    expect(code).toContain('class="server-dialog__badge server-dialog__badge--current"')
    expect(code).toContain('aria-label={language.t("common.moreOptions")}')
    expect(code).toContain('icon="more-horizontal"')
    expect(css).not.toContain("text-transform")
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 44px/)
    expect(css).toMatch(/\.server-dialog__menu-button\s*\{[^}]*width: 32px;[^}]*height: 32px/s)
  })
})
