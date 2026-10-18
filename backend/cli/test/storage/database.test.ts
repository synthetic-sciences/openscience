import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { ResearchDatabase } from "../../src/storage/database"
import { tmpdir } from "../fixture/fixture"

test("legacy session records migrate atomically with IDs and original files preserved", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  const records = [
    { key: ["session", "project_one", "ses_parent"], data: { id: "ses_parent", projectID: "project_one" } },
    { key: ["session", "project_one", "ses_child"], data: { id: "ses_child", parentID: "ses_parent" } },
    { key: ["message", "ses_child", "msg_one"], data: { id: "msg_one", sessionID: "ses_child" } },
    {
      key: ["part", "msg_one", "prt_tool"],
      data: { id: "prt_tool", sessionID: "ses_child", callID: "tool_stable", type: "tool" },
    },
    { key: ["todo", "ses_child"], data: [{ content: "continue" }] },
  ]
  for (const record of records)
    await Bun.write(path.join(tmp.path, "storage", ...record.key) + ".json", JSON.stringify(record.data))
  for (const record of records) expect(await store.read<typeof record.data>(record.key)).toEqual(record.data)
  expect(await store.list(["session", "project_one"])).toHaveLength(2)
  expect(await store.list(["part", "msg_one"])).toEqual([["part", "msg_one", "prt_tool"]])
  const db = new Database(store.filepath, { readonly: true })
  expect(db.query("SELECT id FROM part WHERE json_extract(data,'$.callID')='tool_stable'").get()).toEqual({
    id: "prt_tool",
  })
  db.close()
  await store.remove(records[0]!.key)
  await expect(ResearchDatabase.create(tmp.path).read(records[0]!.key)).rejects.toMatchObject({ code: "ENOENT" })
  expect(await Bun.file(path.join(tmp.path, "storage", ...records[0]!.key) + ".json").json()).toEqual(records[0]!.data)
})

test("a corrupt legacy record cannot commit a partial import or erase its source", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  const damaged = path.join(tmp.path, "storage", "message", "session", "bad.json")
  await Bun.write(damaged, "{truncated")
  await Bun.write(path.join(tmp.path, "storage", "session", "project", "good.json"), JSON.stringify({ id: "good" }))
  for (let index = 0; index < 255; index++)
    await Bun.write(
      path.join(tmp.path, "storage", "session", "project", `seed_${index}.json`),
      JSON.stringify({ id: `seed_${index}` }),
    )

  await expect(store.list([])).rejects.toThrow("original file is unchanged")
  expect(await Bun.file(damaged).text()).toBe("{truncated")
  const db = new Database(store.filepath, { readonly: true })
  expect(db.query("SELECT COUNT(*) AS count FROM session").get()).toEqual({ count: 0 })
  db.close()
  await Bun.write(damaged, JSON.stringify({ id: "bad" }))
  expect(await store.list([])).toHaveLength(257)
})

test("database mutation rollback, scoped listing and JSON null survive reopening", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  const key = ["message", "session_a", "message"]
  await store.write(key, { count: 1 })
  await store.write(["message", "session_b", "other"], null)
  await expect(
    store.update<{ count: number }>(key, (draft) => {
      draft.count = 99
      throw new Error("stop")
    }),
  ).rejects.toThrow("stop")
  expect(await store.read<{ count: number }>(key)).toEqual({ count: 1 })
  expect(await store.upsert<{ count: number }>(key, (current) => ({ count: (current?.count ?? 0) + 1 }))).toEqual({
    count: 2,
  })
  expect(await ResearchDatabase.create(tmp.path).read(["message", "session_b", "other"])).toBeNull()
  expect(await store.list(["message", "session_a"])).toEqual([key])
  expect(await store.list(["message", "missing"])).toEqual([])
})

test("separate processes serialize updates without losing increments", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  const key = ["todo", "shared"]
  await Bun.write(path.join(tmp.path, "storage", "session", "project", "legacy.json"), JSON.stringify({ id: "legacy" }))
  const script = path.join(tmp.path, "increment.ts")
  await Bun.write(
    script,
    `import { ResearchDatabase } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/storage/database.ts"))}; const store=ResearchDatabase.create(${JSON.stringify(tmp.path)}); for(let index=0;index<12;index++) await store.upsert<{count:number}>(["todo","shared"],current=>({count:(current?.count??0)+1}));`,
  )
  const results = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
    }),
  )
  expect(results).toHaveLength(3)
  expect(await store.read<{ count: number }>(key)).toEqual({ count: 36 })
})

test("a newer database format is rejected without rewriting its records", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  await store.write(["todo", "session"], { content: "preserve" })
  const future = new Database(store.filepath)
  future.exec("PRAGMA user_version=99")
  future.close()
  await expect(store.read(["todo", "session"])).rejects.toThrow("requires a newer OpenScience")
  const verify = new Database(store.filepath, { readonly: true })
  expect(verify.query("PRAGMA user_version").get()).toEqual({ user_version: 99 })
  expect(verify.query("SELECT data FROM todo WHERE id='session'").get()).toEqual({
    data: JSON.stringify({ content: "preserve" }),
  })
  verify.close()
})

test("version-one databases gain the trace outbox without replacing existing session records", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  const key = ["session", "project", "session_stable"]
  await store.write(key, { id: "session_stable", parentID: "parent_stable" })
  const old = new Database(store.filepath)
  old.exec(`DROP TABLE trace_delivery_event; DROP TABLE trace_delivery; DROP TABLE trace_binding;
    DROP TABLE trace_event; DROP TABLE trace_settings; DROP TABLE model_call; DROP TABLE trace;
    PRAGMA user_version=1;`)
  old.close()
  const upgraded = ResearchDatabase.create(tmp.path)
  expect(await upgraded.read<{ id: string; parentID: string }>(key)).toEqual({
    id: "session_stable",
    parentID: "parent_stable",
  })
  await upgraded.write(["model_call", "session_stable", "call_stable"], { id: "call_stable", outcome: "pending" })
  expect(
    await ResearchDatabase.create(tmp.path).read<{ id: string; outcome: string }>([
      "model_call",
      "session_stable",
      "call_stable",
    ]),
  ).toEqual({
    id: "call_stable",
    outcome: "pending",
  })
  expect(await upgraded.query((db) => db.query("PRAGMA user_version").get())).toEqual({ user_version: 5 })
  expect(await upgraded.query((db) => db.query("SELECT COUNT(*) AS count FROM trace_event").get())).toEqual({
    count: 0,
  })
})

test("adding receipt tables preserves existing version-three model-call and outbox evidence", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  await store.write(["model_call", "session", "call"], { id: "call", outcome: "pending" })
  const previous = new Database(store.filepath)
  previous.exec("DROP TABLE charge; DROP TABLE task_receipt; PRAGMA user_version=3;")
  previous
    .query(`INSERT INTO trace_event(id,account,session_id,model_route,data,state,queued_at) VALUES (?,?,?,?,?,?,?)`)
    .run("event_stable", "account", "session", "managed", "{}", "queued", 1)
  previous.close()
  const upgraded = ResearchDatabase.create(tmp.path)
  expect(await upgraded.read<{ id: string; outcome: string }>(["model_call", "session", "call"])).toEqual({
    id: "call",
    outcome: "pending",
  })
  expect(await upgraded.query((db) => db.query("SELECT id,state FROM trace_event").all())).toEqual([
    { id: "event_stable", state: "queued" },
  ])
  await upgraded.write(["charge", "account", "receipt"], { receipt_id: "receipt", charged_microusd: "1" })
  expect(
    await ResearchDatabase.create(tmp.path).read<{ receipt_id: string; charged_microusd: string }>([
      "charge",
      "account",
      "receipt",
    ]),
  ).toEqual({ receipt_id: "receipt", charged_microusd: "1" })
})

test("version-four receipt evidence survives adding billing imports and their relational links", async () => {
  await using tmp = await tmpdir()
  const store = ResearchDatabase.create(tmp.path)
  await store.write(["charge", "account", "receipt"], { receipt_id: "receipt", charged_microusd: "1" })
  const previous = new Database(store.filepath)
  previous.exec(
    "DROP TABLE billing_import_item; DROP TABLE billing_record; DROP TABLE billing_import; PRAGMA user_version=4;",
  )
  previous.close()
  const upgraded = ResearchDatabase.create(tmp.path)
  expect(
    await upgraded.read<{ receipt_id: string; charged_microusd: string }>(["charge", "account", "receipt"]),
  ).toEqual({ receipt_id: "receipt", charged_microusd: "1" })
  await upgraded.transaction((db) => {
    db.query("INSERT INTO billing_import(id,data) VALUES (?,?)").run("import", "{}")
    db.query("INSERT INTO billing_record(id,data) VALUES (?,?)").run("record", "{}")
    db.query("INSERT INTO billing_import_item(import_id,record_id) VALUES (?,?)").run("import", "record")
  })
  expect(
    await ResearchDatabase.create(tmp.path).query((db) => db.query("SELECT record_id FROM billing_import_item").all()),
  ).toEqual([{ record_id: "record" }])
  await upgraded.transaction((db) => db.query("DELETE FROM billing_import WHERE id=?").run("import"))
  expect(await upgraded.query((db) => db.query("SELECT record_id FROM billing_import_item").all())).toEqual([])
})
