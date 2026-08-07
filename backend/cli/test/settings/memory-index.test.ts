import { afterEach, beforeEach, expect, test } from "bun:test"
import { Memory } from "../../src/settings/memory"
import { MemoryIndex } from "../../src/settings/memory-index"
import { Storage } from "../../src/storage/storage"

// Unique tokens per test keep searches isolated even though the per-process
// storage dir is shared across the suite.

beforeEach(async () => {
  await Memory.set("global", { enabled: true, categories: [] })
})

afterEach(async () => {
  await Memory.set("global", { enabled: false, categories: [] })
})

test("a saved note becomes a full-text hit", async () => {
  await Memory.append("global", { text: "Prefers viridis colormaps for heatmaps", category: "Plotting" })
  const hits = await MemoryIndex.search("viridis heatmaps")
  const hit = hits.find((h) => h.kind === "note" && h.text.includes("viridis"))
  expect(hit).toBeDefined()
  expect(hit?.scope).toBe("global")
  expect(hit?.category).toBe("Plotting")
  expect(hit?.score).toBeNumber()
})

test("notes of a disabled scope are not searchable", async () => {
  await Memory.set("global", {
    enabled: false,
    categories: [{ id: "c", name: "Off", notes: [{ id: "1", text: "quokka disabled note", createdAt: Date.now() }] }],
  })
  const hits = await MemoryIndex.search("quokka")
  expect(hits.find((h) => h.kind === "note")).toBeUndefined()
})

test("swept session messages are searchable and filterable by project", async () => {
  const session = "ses_idx_" + Math.random().toString(36).slice(2)
  const message = "msg_idx_" + Math.random().toString(36).slice(2)
  await Storage.write(["session", "proj_idx_a", session], { id: session })
  await Storage.write(["message", session, message], {
    id: message,
    sessionID: session,
    role: "user",
    time: { created: Date.now() },
  })
  await Storage.write(["part", message, "prt_1"], {
    id: "prt_1",
    messageID: message,
    sessionID: session,
    type: "text",
    text: "we benchmarked the axolotl regeneration pipeline yesterday",
  })

  const hits = await MemoryIndex.search("axolotl regeneration")
  const hit = hits.find((h) => h.kind === "session" && h.sessionID === session)
  expect(hit).toBeDefined()
  expect(hit?.messageID).toBe(message)
  expect(hit?.role).toBe("user")

  const scoped = await MemoryIndex.search("axolotl regeneration", { project: "proj_idx_a" })
  expect(scoped.find((h) => h.sessionID === session)).toBeDefined()
  const foreign = await MemoryIndex.search("axolotl regeneration", { project: "proj_idx_other" })
  expect(foreign.find((h) => h.sessionID === session)).toBeUndefined()
})

test("incomplete assistant messages are skipped until completed", async () => {
  const session = "ses_str_" + Math.random().toString(36).slice(2)
  const message = "msg_str_" + Math.random().toString(36).slice(2)
  const streaming = {
    id: message,
    sessionID: session,
    role: "assistant",
    time: { created: Date.now() },
  }
  await Storage.write(["message", session, message], streaming)
  await Storage.write(["part", message, "prt_1"], {
    id: "prt_1",
    messageID: message,
    sessionID: session,
    type: "text",
    text: "capybara thermodynamics results are in",
  })

  expect((await MemoryIndex.search("capybara thermodynamics")).find((h) => h.sessionID === session)).toBeUndefined()

  await Storage.write(["message", session, message], {
    ...streaming,
    time: { created: streaming.time.created, completed: Date.now() },
  })
  expect((await MemoryIndex.search("capybara thermodynamics")).find((h) => h.sessionID === session)).toBeDefined()
})

test("synthetic text parts are not indexed", async () => {
  const session = "ses_syn_" + Math.random().toString(36).slice(2)
  const message = "msg_syn_" + Math.random().toString(36).slice(2)
  await Storage.write(["message", session, message], {
    id: message,
    sessionID: session,
    role: "user",
    time: { created: Date.now() },
  })
  await Storage.write(["part", message, "prt_1"], {
    id: "prt_1",
    messageID: message,
    sessionID: session,
    type: "text",
    synthetic: true,
    text: "wombat injected scaffolding text",
  })
  expect((await MemoryIndex.search("wombat scaffolding")).find((h) => h.sessionID === session)).toBeUndefined()
})

test("the index is disposable: reset rebuilds from JSON and storage", async () => {
  await Memory.append("global", { text: "Numbat surveys run at dawn", category: "Fieldwork" })
  expect((await MemoryIndex.search("numbat dawn")).find((h) => h.kind === "note")).toBeDefined()

  await MemoryIndex.reset()

  const hits = await MemoryIndex.search("numbat dawn")
  expect(hits.find((h) => h.kind === "note" && h.text.includes("Numbat"))).toBeDefined()
})

test("queries with no usable terms return nothing", async () => {
  expect(await MemoryIndex.search("  ...  ")).toEqual([])
})
