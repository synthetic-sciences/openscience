import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PANE_WIDTH,
  INLINE_PANE_BREAKPOINT,
  MAX_PANE_WIDTH,
  MIN_CONVERSATION_WIDTH,
  MIN_PANE_WIDTH,
  clampPaneWidth,
  equalPaneWidth,
  legacyPaneWidthKey,
  maxPaneWidthForWorkspace,
  paneWidthForViewport,
  paneWidthForWorkspace,
  paneWidthKey,
  readPaneWidth,
  savePaneWidth,
} from "./right-pane-layout"

describe("context pane layout", () => {
  test("keys width by project so the inspector does not jump between sessions", () => {
    expect(paneWidthKey("project-a")).not.toBe(paneWidthKey("project-b"))
    expect(paneWidthKey("project-a")).toBe("openscience-context-width-v6:project-a")
    expect(paneWidthKey("project-a")).not.toContain("session-a")
  })

  test("uses a readable default and clamps resize bounds", () => {
    expect(DEFAULT_PANE_WIDTH).toBe(400)
    expect(clampPaneWidth(0)).toBe(MIN_PANE_WIDTH)
    expect(clampPaneWidth(9999)).toBe(MAX_PANE_WIDTH)
    expect(clampPaneWidth(512)).toBe(512)
  })

  test("can divide the available workspace evenly without crushing conversation", () => {
    expect(MIN_CONVERSATION_WIDTH).toBe(420)
    expect(equalPaneWidth(1200)).toBe(600)
    expect(equalPaneWidth(1600)).toBe(MAX_PANE_WIDTH)
    expect(equalPaneWidth(620)).toBe(MIN_PANE_WIDTH)
    expect(maxPaneWidthForWorkspace(1200)).toBe(MAX_PANE_WIDTH)
    expect(paneWidthForWorkspace(900, 1200)).toBe(MAX_PANE_WIDTH)
  })

  test("reserves the actual persistent sidebar at expanded and collapsed widths", () => {
    const workspace = 1200
    const expandedSidebar = 232
    const collapsedSidebar = 56

    expect(maxPaneWidthForWorkspace(workspace, expandedSidebar)).toBe(548)
    expect(paneWidthForWorkspace(900, workspace, expandedSidebar)).toBe(548)
    expect(workspace - expandedSidebar - paneWidthForWorkspace(900, workspace, expandedSidebar)).toBe(
      MIN_CONVERSATION_WIDTH,
    )
    expect(equalPaneWidth(workspace, expandedSidebar)).toBe(484)

    expect(maxPaneWidthForWorkspace(workspace, collapsedSidebar)).toBe(MAX_PANE_WIDTH)
    expect(
      workspace - collapsedSidebar - paneWidthForWorkspace(900, workspace, collapsedSidebar),
    ).toBeGreaterThanOrEqual(MIN_CONVERSATION_WIDTH)
  })

  test("keeps a true side pane at the reference desktop viewport without crushing the conversation", () => {
    expect(INLINE_PANE_BREAKPOINT).toBe(1100)
    expect(paneWidthForViewport(DEFAULT_PANE_WIDTH, 1100)).toBe(DEFAULT_PANE_WIDTH)
    expect(paneWidthForViewport(DEFAULT_PANE_WIDTH, 1012)).toBe(DEFAULT_PANE_WIDTH)
    expect(paneWidthForViewport(MAX_PANE_WIDTH, 900)).toBe(332)
  })

  test("reads and writes one project without leaking into another", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    const first = paneWidthKey("project-a")
    const second = paneWidthKey("project-b")

    expect(readPaneWidth(first, storage)).toBe(DEFAULT_PANE_WIDTH)
    savePaneWidth(first, 540, storage)
    expect(readPaneWidth(first, storage)).toBe(540)
    expect(readPaneWidth(second, storage)).toBe(DEFAULT_PANE_WIDTH)
  })

  test("migrates the combined route key and tolerates blocked storage", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    const current = paneWidthKey("project-a")
    const legacy = legacyPaneWidthKey("project-a", "session-a")
    values.set(legacy, "612")

    expect(readPaneWidth(current, storage, [legacy])).toBe(612)
    expect(values.get(current)).toBe("612")

    const blocked = {
      getItem() {
        throw new Error("blocked")
      },
      setItem() {
        throw new Error("blocked")
      },
    }
    expect(readPaneWidth(current, blocked)).toBe(DEFAULT_PANE_WIDTH)
    expect(() => savePaneWidth(current, 540, blocked)).not.toThrow()
  })
})
