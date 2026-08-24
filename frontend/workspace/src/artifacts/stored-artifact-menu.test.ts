import { afterEach, describe, expect, test } from "bun:test"
import { moveStoredArtifactMenuFocus } from "./stored-artifact-menu"

afterEach(() => document.body.replaceChildren())

function menu() {
  const scope = document.createElement("section")
  scope.setAttribute("role", "menu")
  const items = ["Rename", "Move to trash"].map((label, index) => {
    const item = document.createElement("button")
    item.type = "button"
    item.setAttribute("role", "menuitem")
    item.tabIndex = index === 0 ? 0 : -1
    item.textContent = label
    scope.append(item)
    return item
  })
  document.body.append(scope)
  return { scope, items }
}

describe("stored Result action menu keyboard navigation", () => {
  test("moves and wraps with ArrowUp and ArrowDown", () => {
    const { scope, items } = menu()
    items[0]!.focus()

    expect(moveStoredArtifactMenuFocus(scope, items[0]!, "ArrowDown")).toBe(true)
    expect(document.activeElement).toBe(items[1])
    expect(items.map((item) => item.tabIndex)).toEqual([-1, 0])

    expect(moveStoredArtifactMenuFocus(scope, items[1]!, "ArrowDown")).toBe(true)
    expect(document.activeElement).toBe(items[0])

    expect(moveStoredArtifactMenuFocus(scope, items[0]!, "ArrowUp")).toBe(true)
    expect(document.activeElement).toBe(items[1])
  })

  test("moves directly with Home and End and ignores unrelated keys", () => {
    const { scope, items } = menu()
    items[0]!.focus()

    expect(moveStoredArtifactMenuFocus(scope, items[0]!, "End")).toBe(true)
    expect(document.activeElement).toBe(items[1])
    expect(moveStoredArtifactMenuFocus(scope, items[1]!, "Home")).toBe(true)
    expect(document.activeElement).toBe(items[0])
    expect(moveStoredArtifactMenuFocus(scope, items[0]!, "Enter")).toBe(false)
    expect(document.activeElement).toBe(items[0])
  })
})
