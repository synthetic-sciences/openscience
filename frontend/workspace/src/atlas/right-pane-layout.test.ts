import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PANE_WIDTH,
  INLINE_PANE_BREAKPOINT,
  MIN_CONVERSATION_WIDTH,
  MIN_PANE_WIDTH,
  clampPaneWidth,
  equalPaneWidth,
  legacyPaneWidthKey,
  maxPaneWidthForWorkspace,
  paneWidthForViewport,
  paneWidthForWorkspace,
  paneWidthKey,
  presetPaneWidth,
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
    expect(clampPaneWidth(9999)).toBe(9999)
    expect(clampPaneWidth(9999, 960)).toBe(960)
    expect(clampPaneWidth(Number.NaN)).toBe(DEFAULT_PANE_WIDTH)
    expect(clampPaneWidth(512)).toBe(512)
  })

  test("can divide the available workspace evenly without crushing conversation", () => {
    expect(MIN_CONVERSATION_WIDTH).toBe(420)
    expect(equalPaneWidth(1200)).toBe(600)
    expect(equalPaneWidth(1600)).toBe(800)
    expect(equalPaneWidth(620)).toBe(MIN_PANE_WIDTH)
    expect(maxPaneWidthForWorkspace(1200)).toBe(780)
    expect(paneWidthForWorkspace(900, 1200)).toBe(780)
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

    expect(maxPaneWidthForWorkspace(workspace, collapsedSidebar)).toBe(724)
    expect(
      workspace - collapsedSidebar - paneWidthForWorkspace(900, workspace, collapsedSidebar),
    ).toBeGreaterThanOrEqual(MIN_CONVERSATION_WIDTH)
  })

  test("keeps a true side pane at the reference desktop viewport without crushing the conversation", () => {
    expect(INLINE_PANE_BREAKPOINT).toBe(1100)
    expect(paneWidthForViewport(DEFAULT_PANE_WIDTH, 1100)).toBe(DEFAULT_PANE_WIDTH)
    expect(paneWidthForViewport(DEFAULT_PANE_WIDTH, 1012)).toBe(DEFAULT_PANE_WIDTH)
    expect(paneWidthForViewport(720, 900)).toBe(332)
  })

  test("uses the actual large display instead of an arbitrary inspector cap", () => {
    expect(maxPaneWidthForWorkspace(2560, 232)).toBe(1908)
    expect(paneWidthForWorkspace(1800, 2560, 232)).toBe(1800)
    expect(paneWidthForWorkspace(1800, 1200, 232)).toBe(548)
    expect(paneWidthForWorkspace(1800, 2560, 232)).toBe(1800)
    expect(maxPaneWidthForWorkspace(Number.NaN)).toBe(DEFAULT_PANE_WIDTH)
  })

  test("offers useful presets while protecting both panes", () => {
    expect(presetPaneWidth("equal", 1600, 200)).toBe(700)
    expect(presetPaneWidth("conversation", 1600, 200)).toBe(420)
    expect(presetPaneWidth("inspector", 1600, 200)).toBeCloseTo(980)
    expect(presetPaneWidth("default", 1600, 200)).toBe(DEFAULT_PANE_WIDTH)
    expect(presetPaneWidth("inspector", 1100, 232)).toBe(448)
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
    savePaneWidth(first, 1400, storage)
    expect(readPaneWidth(first, storage)).toBe(1400)
    // A temporary narrow window never rewrites the preferred wide-window size.
    expect(paneWidthForWorkspace(readPaneWidth(first, storage), 1100, 232)).toBe(448)
    expect(readPaneWidth(first, storage)).toBe(1400)
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
