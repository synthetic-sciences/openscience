import { expect, test } from "bun:test"
import path from "node:path"
import { logsDirectory } from "../../../../frontend/desktop/src/log-path.mjs"

const userData = path.join(path.sep, "scratch", "os-dev")

test("an installed app started normally keeps the platform's logs directory", () => {
  expect(logsDirectory({ packaged: true, relocated: false, userData })).toBeUndefined()
})

test("a shell run from source keeps its logs with its own data", () => {
  expect(logsDirectory({ packaged: false, relocated: false, userData })).toBe(path.join(userData, "logs"))
  expect(logsDirectory({ packaged: false, relocated: true, userData })).toBe(path.join(userData, "logs"))
})

test("a launch given its own user data directory does not write beside the installed app's log", () => {
  expect(logsDirectory({ packaged: true, relocated: true, userData })).toBe(path.join(userData, "logs"))
})
