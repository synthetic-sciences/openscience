import { expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { SessionTraceStore } from "../../src/session/trace-store"

test("model-call history migrates with stable identities and is no longer truncated at 2048 calls", async () => {
  const sessionID = `ses_trace_database_${crypto.randomUUID()}`
  const source = path.join(Global.Path.data, "trace", `${sessionID}.json`)
  const call = (index: number): SessionTraceStore.ModelCall => ({
    id: `call_${index}`,
    sessionID,
    messageID: "msg_trace",
    route: "byok",
    provider: "openai",
    model: "fixture",
    occurredAt: index,
  })
  const calls = Array.from({ length: 2048 }, (_, index) => call(index))
  calls[0]!.hold = "orgh_preserved"
  await Bun.write(source, JSON.stringify({ modelCalls: calls }))
  expect((await SessionTraceStore.read(sessionID)).modelCalls).toHaveLength(2048)
  await SessionTraceStore.recordModelCall({ ...call(0), reportedCostUSD: 0 })
  await SessionTraceStore.recordModelCall(call(2048))
  const state = await SessionTraceStore.read(sessionID)
  expect(state.modelCalls).toHaveLength(2049)
  expect(state.modelCalls[0]).toMatchObject({ id: "call_0", hold: "orgh_preserved", reportedCostUSD: 0 })
  expect(await Bun.file(source).json()).toMatchObject({ modelCalls: calls })
  await SessionTraceStore.remove(sessionID)
  expect((await SessionTraceStore.read(sessionID)).modelCalls).toEqual([])
  expect(await Bun.file(source).exists()).toBe(false)
})

test("explicit record deletion removes its legacy backup as well as its database row", async () => {
  const key = ["message", `ses_deleted_${crypto.randomUUID()}`, "msg_deleted"]
  const source = path.join(Global.Path.data, "storage", ...key) + ".json"
  await Storage.write(key, { id: key[2], sessionID: key[1] })
  await Bun.write(source, JSON.stringify({ id: key[2], sessionID: key[1] }))
  await Storage.remove(key)
  await expect(Storage.read(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
  expect(await Bun.file(source).exists()).toBe(false)
})
