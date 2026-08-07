import { expect, test } from "bun:test"
import { SIDEBAR_WIDTH, clampSidebarWidth } from "./session-sidebar-size"

test("session sidebar width stays within a readable desktop range", () => {
  expect(clampSidebarWidth(120)).toBe(SIDEBAR_WIDTH.min)
  expect(clampSidebarWidth(257.6)).toBe(258)
  expect(clampSidebarWidth(640)).toBe(SIDEBAR_WIDTH.max)
})
