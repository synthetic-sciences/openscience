import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { SubagentBudget } from "../../src/session/subagent-budget"
import { tmpdir } from "../fixture/fixture"

test("session allowance routes scope reads and apply revisioned increases once", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      await SubagentBudget.open({
        rootSessionID: parent.id,
        parentSessionID: parent.id,
        sessionID: child.id,
        assignmentID: "fixture",
        objective: "review",
        expectedOutput: "findings",
        model: { providerID: "test", modelID: "test" },
        route: "chatgpt",
        unit: "tokens",
        allocation: 100,
        settings: { tokens: 200 },
      })
      const internal = Server.internalFetch()
      const fetch = (url: string, options?: RequestInit) => {
        const headers = new Headers(options?.headers)
        headers.set("x-openscience-project", Instance.project.id)
        headers.set("x-openscience-directory", tmp.path)
        return internal(url, { ...options, headers })
      }
      const base = `http://openscience.internal/session/${parent.id}/subagents/budget`
      const response = await fetch(base)
      expect(response.status).toBe(200)
      const initial = await response.json()
      expect(initial.limits.tokens).toBe(200)
      expect(initial.available.tokens).toBe(100)
      const body = { unit: "tokens", amount: 100, revision: initial.revision, key: crypto.randomUUID() }
      const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      const first = await fetch(base + "/increase", options)
      expect(first.status).toBe(200)
      expect((await first.json()).limits.tokens).toBe(300)
      const replay = await fetch(base + "/increase", options)
      expect(replay.status).toBe(200)
      expect((await replay.json()).limits.tokens).toBe(300)
      const reused = await fetch(base + "/increase", { ...options, body: JSON.stringify({ ...body, amount: 50 }) })
      expect(reused.status).toBe(409)
      expect(await reused.text()).toContain("Approval key conflict")
      const stale = await fetch(base + "/increase", {
        ...options,
        body: JSON.stringify({ ...body, key: crypto.randomUUID() }),
      })
      expect(stale.status).toBe(409)
      const missing = await fetch("http://openscience.internal/session/ses_missing/subagents/budget")
      expect(missing.status).toBe(404)
      const unpooled = await Session.create({})
      const none = await fetch(`http://openscience.internal/session/${unpooled.id}/subagents/budget/increase`, options)
      expect(none.status).toBe(404)
      expect((await none.json()).name).toBe("NotFoundError")
      const invalid = await fetch(base + "/increase", { ...options, body: JSON.stringify({ ...body, amount: 0 }) })
      expect(invalid.status).toBe(400)
    },
  })
})

test("continuing a child whose agent was not recorded refuses instead of guessing one", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      await SubagentBudget.open({
        rootSessionID: parent.id,
        parentSessionID: parent.id,
        sessionID: child.id,
        assignmentID: "fixture",
        objective: "review",
        expectedOutput: "findings",
        model: { providerID: "test", modelID: "test" },
        route: "chatgpt",
        unit: "tokens",
        allocation: 100,
        settings: { tokens: 200 },
      })
      await SubagentBudget.release(child.id)
      const response = await Server.internalFetch()(
        `http://openscience.internal/session/${parent.id}/subagents/${child.id}/continue`,
        {
          method: "POST",
          headers: {
            "x-openscience-project": Instance.project.id,
            "x-openscience-directory": tmp.path,
            "content-type": "application/json",
          },
          body: JSON.stringify({ key: crypto.randomUUID() }),
        },
      )
      expect(response.status).toBe(409)
      expect(await response.text()).toContain("agent was not recorded")
      expect((await SubagentBudget.inspect(parent.id))?.continuations).toEqual({})
      const unknown = await Server.internalFetch()(
        `http://openscience.internal/session/${parent.id}/subagents/ses_000000000000unknownxxxxxx/continue`,
        {
          method: "POST",
          headers: {
            "x-openscience-project": Instance.project.id,
            "x-openscience-directory": tmp.path,
            "content-type": "application/json",
          },
          body: JSON.stringify({ key: crypto.randomUUID() }),
        },
      )
      expect(unknown.status).toBe(404)
      expect((await unknown.json()).name).toBe("NotFoundError")
    },
  })
})

test("deleting a root removes budget content and blocks orphaned child dispatch", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      await SubagentBudget.open({
        rootSessionID: parent.id,
        parentSessionID: parent.id,
        sessionID: child.id,
        assignmentID: "fixture",
        objective: "private objective",
        expectedOutput: "findings",
        model: { providerID: "test", modelID: "test" },
        route: "chatgpt",
        unit: "tokens",
        allocation: 100,
        settings: { tokens: 200 },
      })
      await Session.remove(parent.id)
      expect(await SubagentBudget.inspect(parent.id)).toBeUndefined()
      await expect(SubagentBudget.read(child.id)).rejects.toThrow(/deleted/)
    },
  })
})

test("disabled conversations expose no approved funds and reject increases", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      await SubagentBudget.initialize(parent.id, { enabled: false })
      const internal = Server.internalFetch()
      const headers = {
        "x-openscience-project": Instance.project.id,
        "x-openscience-directory": tmp.path,
        "content-type": "application/json",
      }
      const endpoint = `http://openscience.internal/session/${parent.id}/subagents/budget`
      const current = await internal(endpoint, { headers })
      const snapshot = await current.json()
      expect(snapshot.enabled).toBe(false)
      expect(snapshot.limits).toEqual({ usd: 0, tokens: 0 })
      const before = (await SubagentBudget.inspect(parent.id))!
      const response = await internal(endpoint + "/increase", {
        method: "POST",
        headers,
        body: JSON.stringify({ unit: "tokens", amount: 1000, revision: before.revision, key: crypto.randomUUID() }),
      })
      expect(response.status).toBe(409)
      expect(await SubagentBudget.inspect(parent.id)).toEqual(before)
    },
  })
})

test("subagent routes document their conflict responses", async () => {
  const { errors } = await import("../../src/server/error")
  expect(Object.keys(errors(400, 404, 409))).toEqual(["400", "404", "409"])
  expect(() => errors(418)).toThrow()
})
