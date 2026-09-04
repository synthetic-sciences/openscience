import { afterEach, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Startup } from "../../src/util/startup"

afterEach(() => Startup.reset())

test("records listening, first instance, first project and interactive once each, in order", () => {
  Startup.reset()
  Startup.listening()
  const listening = Startup.snapshot().listening
  Startup.listening()
  expect(Startup.snapshot().listening).toBe(listening)

  // The server-cwd instance the global routes mint is not a project.
  Startup.instance("cwd")
  const instance = Startup.snapshot().instance
  expect(instance).toBeGreaterThanOrEqual(listening!)
  expect(Startup.snapshot().project).toBeUndefined()

  Startup.instance("project")
  expect(Startup.snapshot().instance).toBe(instance)
  expect(Startup.snapshot().project).toBeGreaterThanOrEqual(instance!)

  Startup.interactive({ page: 5 })
  const marks = Startup.snapshot()
  expect(marks.interactive).toBeGreaterThanOrEqual(marks.project!)

  Startup.instance("project")
  Startup.interactive({ page: 9 })
  expect(Startup.snapshot()).toEqual(marks)
})

test("the workspace closes the timing line through the log route", async () => {
  Startup.reset()
  const fetch = Server.internalFetch()
  const response = await fetch("http://openscience.internal/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "startup", level: "info", message: "interactive", extra: { page: 12 } }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toBe(true)
  expect(Startup.snapshot().interactive).toBeDefined()
})

test("ordinary log entries never close the timing line", async () => {
  Startup.reset()
  const fetch = Server.internalFetch()
  const response = await fetch("http://openscience.internal/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "startup", level: "info", message: "something else" }),
  })
  expect(response.status).toBe(200)
  expect(Startup.snapshot().interactive).toBeUndefined()
})
