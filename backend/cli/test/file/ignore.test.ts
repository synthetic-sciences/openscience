import { test, expect } from "bun:test"
import { FileIgnore } from "../../src/file/ignore"

test("match nested and non-nested", () => {
  expect(FileIgnore.match("node_modules/index.js")).toBe(true)
  expect(FileIgnore.match("node_modules")).toBe(true)
  expect(FileIgnore.match("node_modules/")).toBe(true)
  expect(FileIgnore.match("node_modules/bar")).toBe(true)
  expect(FileIgnore.match("node_modules/bar/")).toBe(true)
})

test("ignores internal OpenScience runtime state", () => {
  expect(FileIgnore.match(".openscience/workspaces/session/message.json")).toBe(true)
})

test("matches ignored folders with either path separator", () => {
  expect(FileIgnore.match("node_modules\\index.js")).toBe(true)
  expect(FileIgnore.match("C:\\repo\\node_modules\\index.js")).toBe(true)
  expect(FileIgnore.match("src\\dist\\bundle.js")).toBe(true)
  expect(FileIgnore.match("node_modules\\pkg/index.js")).toBe(true)
  expect(FileIgnore.match(".openscience\\workspaces\\session\\message.json")).toBe(true)
  expect(FileIgnore.match("src\\normal\\file.ts")).toBe(false)
})
