import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
import { SessionRoutes } from "../../src/server/routes/session"
import { TaskReceipts } from "../../src/session/task-receipts"
import { Session } from "../../src/session"
import { SessionTraceStore } from "../../src/session/trace-store"
import { Storage } from "../../src/storage/storage"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const file = path.join(Global.Path.data, "openscience-session.json")
const previous = process.env.OPENSCIENCE_API_BASE
const token = "thk_local-receipts-fixture"
const account = { api_key: token, user_id: "receipt-user", organization_id: "00000000-0000-4000-8000-000000000012" }
beforeEach(() => Bun.write(file, JSON.stringify(account)))
afterEach(async () => {
  await Bun.file(file)
    .delete()
    .catch(() => undefined)
  if (previous === undefined) delete process.env.OPENSCIENCE_API_BASE
  else process.env.OPENSCIENCE_API_BASE = previous
})
async function call(sessionID: string, id: string = crypto.randomUUID()) {
  await SessionTraceStore.recordModelCall({
    id,
    sessionID,
    messageID: "msg_fixture",
    route: "managed",
    provider: "openrouter",
    model: "fixture",
    occurredAt: Date.now(),
  })
  return id
}
function server(reply: (request: Request) => Promise<Response>) {
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: reply })
  process.env.OPENSCIENCE_API_BASE = remote.url.toString()
  return { [Symbol.dispose]: () => remote.stop(true) }
}
function response(ids: string[]) {
  return {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    calls: ids.map((id) => ({ call_id: id, state: "settled", hold_id: `hold_${id}`, receipt_id: `receipt_${id}` })),
    receipts: ids.map((id) => ({
      receipt_id: `receipt_${id}`,
      hold_id: `hold_${id}`,
      charged_microusd: "1234567",
      settled_at: new Date().toISOString(),
      provider: "openrouter",
      model: "fixture",
    })),
  }
}

test("task receipts include workers, preserve exact amounts and save stable charge identities", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({ title: "private lead title" })
      const worker = await Session.create({ parentID: root.id, title: "private worker title" })
      const ids = [await call(root.id), await call(worker.id)]
      const requests: unknown[] = []
      using remote = server(async (request) => {
        expect(new URL(request.url).pathname).toBe("/api/credits/call-receipts")
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`)
        expect(request.headers.get("x-organization-id")).toBe(account.organization_id)
        const body = (await request.json()) as { call_ids: string[] }
        requests.push(body)
        return Response.json(response(body.call_ids))
      })
      const result = await TaskReceipts.check(root.id)
      expect(requests).toEqual([{ call_ids: ids }])
      expect(result).toMatchObject({
        state: "available",
        sessions: 2,
        managedCalls: 2,
        missingCallIDs: 0,
        chargedMicrousd: "2469134",
      })
      expect(result.receipts.map((item) => item.receipt_id)).toEqual(ids.map((id) => `receipt_${id}`))
      expect(JSON.stringify(result)).not.toContain("private")
      const route = await SessionRoutes().request(`/${root.id}/receipts`, { method: "POST" })
      expect(route.status).toBe(200)
      expect(route.headers.get("cache-control")).toBe("no-store")
      expect(await route.json()).toMatchObject({ state: "available", chargedMicrousd: "2469134" })
      const stored = await (
        await Storage.research()
      ).query((db) => db.query<{ id: string }, []>("SELECT id FROM charge ORDER BY id").all())
      expect(ids.every((id) => stored.some((row) => row.id === `receipt_${id}`))).toBe(true)
      await Session.remove(root.id)
      expect(
        await (await Storage.research()).query((db) => db.query("SELECT id FROM task_receipt WHERE id=?").get(root.id)),
      ).toBeNull()
    },
  })
})

test("pending, missing and unidentifiable calls never become settled zero receipts", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      const id = await call(root.id)
      await call(root.id, "legacy_without_http_id")
      using remote = server(async () =>
        Response.json({
          schema_version: 1,
          checked_at: new Date().toISOString(),
          calls: [{ call_id: id, state: "pending", hold_id: "hold_pending", receipt_id: null }],
          receipts: [],
        }),
      )
      expect(await TaskReceipts.check(root.id)).toMatchObject({
        state: "available",
        missingCallIDs: 1,
        chargedMicrousd: "0",
        receipts: [],
        calls: [{ state: "pending" }],
      })
      await Session.remove(root.id)
    },
  })
})

test("a workspace switch during receipt lookup discards the old account result", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      const id = await call(root.id)
      using remote = server(async () => {
        await Bun.write(file, JSON.stringify({ ...account, organization_id: "other" }))
        return Response.json(response([id]))
      })
      expect(await TaskReceipts.check(root.id)).toMatchObject({
        state: "unavailable",
        reason: "account_changed",
        receipts: [],
        calls: [],
      })
      await Session.remove(root.id)
    },
  })
})

test("foreign or duplicated receipt call identities make the report unavailable", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      await call(root.id)
      using remote = server(async () => Response.json(response([crypto.randomUUID()])))
      expect(await TaskReceipts.check(root.id)).toMatchObject({
        state: "unavailable",
        reason: "invalid_report",
        receipts: [],
      })
      await Session.remove(root.id)
    },
  })
})

test("large tasks request every call in bounded batches without truncating the receipt total", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      for (let index = 0; index < 129; index++) await call(root.id)
      const sizes: number[] = []
      using remote = server(async (request) => {
        const body = (await request.json()) as { call_ids: string[] }
        sizes.push(body.call_ids.length)
        return Response.json(response(body.call_ids))
      })
      const result = await TaskReceipts.check(root.id)
      expect(sizes).toEqual([128, 1])
      expect(result).toMatchObject({
        state: "available",
        managedCalls: 129,
        chargedMicrousd: (129n * 1234567n).toString(),
      })
      expect(result.receipts).toHaveLength(129)
      await Session.remove(root.id)
    },
  })
})

test("a failure after one successful batch never exposes a partial total as a completed lookup", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      for (let index = 0; index < 129; index++) await call(root.id)
      let requests = 0
      using remote = server(async (request) => {
        const body = (await request.json()) as { call_ids: string[] }
        if (++requests === 2) return new Response("private server diagnostic", { status: 503 })
        return Response.json(response(body.call_ids))
      })
      const result = await TaskReceipts.check(root.id)
      expect(result).toMatchObject({ state: "unavailable", reason: "server_unavailable", receipts: [], calls: [] })
      expect(result.chargedMicrousd).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain("private")
      await Session.remove(root.id)
    },
  })
})
