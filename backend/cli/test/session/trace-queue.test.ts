import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { TraceQueue } from "../../src/session/trace-queue"
import { resetTraceQueue } from "../fixture/trace-queue"
import { installation, traceEvent } from "../fixture/trace-event"

const source = path.join(Global.Path.data, "usage-logging.json")
beforeEach(async () => {
  await resetTraceQueue()
  await Bun.file(source)
    .delete()
    .catch(() => undefined)
})
afterEach(async () => {
  await resetTraceQueue()
  await Bun.file(source)
    .delete()
    .catch(() => undefined)
})

test("legacy installation, exact events and a backlog beyond the old cap migrate without loss", async () => {
  const rows = Array.from({ length: 2048 }, (_, index) => traceEvent(index + 1))
  await Bun.write(source, JSON.stringify({ installation, queue: rows, delivered: 7 }))
  expect(await TraceQueue.status()).toMatchObject({ installation, queued: 2048, delivered: 7 })
  const revision = (await TraceQueue.read()).revision
  expect(await TraceQueue.enqueue(traceEvent(2049), revision)).toBe(true)
  expect(await TraceQueue.status()).toMatchObject({ queued: 2049 })
  expect((await TraceQueue.batch("fixture-account"))[0]).toEqual(rows[0]!)
  expect(
    await (await Storage.research()).query((db) => db.query("SELECT COUNT(*) AS count FROM trace_event").get()),
  ).toEqual({ count: 2049 })
  expect(await Bun.file(source).json()).toMatchObject({ installation, delivered: 7 })
})

test("delivery retries preserve event identity and acknowledgement accounting is idempotent", async () => {
  const row = traceEvent()
  const revision = (await TraceQueue.read()).revision
  await TraceQueue.enqueue(row, revision)
  await TraceQueue.beginDelivery("first", row.account, [row], revision)
  await TraceQueue.response("first", 503)
  await TraceQueue.failure("Queued records will be retried.")
  expect(await TraceQueue.batch(row.account)).toEqual([row])
  await TraceQueue.beginDelivery("second", row.account, [row], revision)
  await TraceQueue.response("second", 200)
  await TraceQueue.acknowledge("second", [], [row.event.event_id], true, revision)
  await TraceQueue.acknowledge("first", [row.event.event_id], [], true, revision)
  expect(await TraceQueue.status()).toMatchObject({ queued: 0, delivered: 1 })
  const evidence = await (
    await Storage.research()
  ).query((db) => ({
    events: db.query("SELECT id,state FROM trace_event").all(),
    links: db.query("SELECT event_id FROM trace_delivery_event ORDER BY delivery_id").all(),
  }))
  expect(evidence.events).toEqual([{ id: row.event.event_id, state: "acknowledged" }])
  expect(evidence.links).toEqual([{ event_id: row.event.event_id }, { event_id: row.event.event_id }])
})

test("FIFO order is stable when event timestamps are identical", async () => {
  await Bun.write(source, JSON.stringify({ installation, queue: [traceEvent(2), traceEvent(1)] }))
  expect((await TraceQueue.batch("fixture-account")).map((row) => row.event.event_id)).toEqual([
    traceEvent(2).event.event_id,
    traceEvent(1).event.event_id,
  ])
})

test("all rejected records survive and opting out removes both database payloads and legacy backup payloads", async () => {
  await Bun.write(
    source,
    JSON.stringify({ installation, quarantined: Array.from({ length: 80 }, (_, index) => traceEvent(index + 1)) }),
  )
  expect(await TraceQueue.status()).toMatchObject({ quarantined: 80 })
  const previous = (await TraceQueue.read()).revision
  await TraceQueue.setEnabled(false)
  expect(await TraceQueue.status()).toMatchObject({ enabled: false, quarantined: 0, queued: 0 })
  expect(await TraceQueue.enqueue(traceEvent(100), previous)).toBe(false)
  expect(await Bun.file(source).json()).toMatchObject({ enabled: false, queue: [], quarantined: [] })
  expect(
    await (await Storage.research()).query((db) => db.query("SELECT COUNT(*) AS count FROM trace_event").get()),
  ).toEqual({ count: 0 })
})

test("corrupt legacy preferences fail closed and a repaired opt-out is preserved", async () => {
  await Bun.write(source, "{truncated")
  await expect(TraceQueue.read()).rejects.toThrow()
  expect(await Bun.file(source).text()).toBe("{truncated")
  await Bun.write(source, JSON.stringify({ installation, enabled: false, queue: [traceEvent()] }))
  expect(await TraceQueue.status()).toMatchObject({ enabled: false, queued: 0 })
  expect(await TraceQueue.enqueue(traceEvent(), (await TraceQueue.read()).revision)).toBe(false)
})

test("oversized records are quarantined explicitly without blocking subsequent deliverable events", async () => {
  const large = traceEvent(1)
  large.event.payload = { content: "x".repeat(2 * 1024 * 1024) }
  const small = traceEvent(2)
  const revision = (await TraceQueue.read()).revision
  await TraceQueue.enqueue(large, revision)
  await TraceQueue.enqueue(small, revision)
  expect(await TraceQueue.batch(small.account)).toEqual([small])
  expect(await TraceQueue.status()).toMatchObject({ queued: 1, quarantined: 1 })
  expect(
    await (
      await Storage.research()
    ).query((db) => db.query("SELECT error FROM trace_event WHERE id=?").get(large.event.event_id)),
  ).toEqual({ error: "local_size_limit" })
})

test("delayed uploads and rejected HTTP attempts expose only content-free diagnostics", async () => {
  const settings = await TraceQueue.read()
  const row = traceEvent()
  row.event.payload = { private: "not part of health" }
  await TraceQueue.enqueue(row, settings.revision)
  await (
    await Storage.research()
  ).transaction((db) => db.query("UPDATE trace_event SET queued_at=?").run(Date.now() - 300_001))
  expect(await TraceQueue.status()).toMatchObject({ stalled: true })
  const id = crypto.randomUUID()
  await TraceQueue.beginDelivery(id, row.account, [row], settings.revision)
  await TraceQueue.response(id, 422)
  await TraceQueue.reject(id, [row], 422)
  const status = await TraceQueue.status()
  expect(status).toMatchObject({
    stalled: false,
    lastAttempt: { deliveryID: id, state: "rejected", httpStatus: 422 },
    rejection: { eventID: row.event.event_id, reason: "http_422" },
  })
  expect(JSON.stringify(status)).not.toContain("not part of health")
})

test("tool trace bindings survive beyond the old memory cap and are removed by opt-out", async () => {
  const revision = (await TraceQueue.read()).revision
  for (let index = 0; index < 513; index++)
    await TraceQueue.bind({
      account: "fixture-account",
      revision,
      credential: "a".repeat(64),
      sessionID: `ses_${index}`,
      messageID: `msg_${index}`,
      route: "byok",
      provider: "openai",
      model: "fixture",
    })
  expect(await TraceQueue.binding("ses_0", "msg_0")).toMatchObject({ sessionID: "ses_0" })
  await TraceQueue.setEnabled(false)
  expect(await TraceQueue.binding("ses_0", "msg_0")).toBeUndefined()
})

test("separate processes enqueue without losing events or changing the installation identity", async () => {
  const settings = await TraceQueue.read()
  const script = path.join(Global.Path.data, `trace-producer-${crypto.randomUUID()}.ts`)
  await Bun.write(
    script,
    `
    import { TraceQueue } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/trace-queue.ts"))};
    import { traceEvent } from ${JSON.stringify(path.resolve(import.meta.dir, "../fixture/trace-event.ts"))};
    const settings = await TraceQueue.read();
    for (let index = 0; index < 12; index++) {
      const row = traceEvent(Number(process.argv[2]) + index);
      row.event.installation_id = settings.installation;
      if (!await TraceQueue.enqueue(row, settings.revision)) throw new Error("Event was rejected");
    }
    console.log(settings.installation);
  `,
  )
  try {
    await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const child = Bun.spawn([process.execPath, script, String(index * 12 + 1)], {
          env: {
            ...process.env,
            OPENSCIENCE_DATA_DIR: Global.Path.data,
            OPENSCIENCE_CONFIG_DIR: Global.Path.config,
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [output, error, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(exit, error).toBe(0)
        expect(output.trim()).toBe(settings.installation)
      }),
    )
    expect(await TraceQueue.status()).toMatchObject({ installation: settings.installation, queued: 36 })
    expect(new Set((await TraceQueue.batch("fixture-account")).map((row) => row.event.event_id)).size).toBe(36)
  } finally {
    await Bun.file(script).delete()
  }
})
