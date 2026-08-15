import { expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { Environment } from "../../src/package/environment"

const project = "proj_test"

test("the manifest lives under data and the directory under cache", () => {
  // Not interchangeable: the manifest is the source of truth and the directory
  // is derived, so a cache cleaner must be able to remove one without
  // destroying the record of what the environment is.
  expect(Environment.manifest(project, "default")).toBe(path.join(Global.Path.data, "envs", project, "default.json"))
  expect(Environment.directory(project, "default")).toBe(path.join(Global.Path.cache, "envs", project, "default"))
})

test("a written environment reads back", async () => {
  const value = {
    name: "e1",
    language: "python" as const,
    requested: ["numpy"],
    installed: { numpy: "2.1.0" },
    total: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  await Environment.write(project, value)
  expect(await Environment.read(project, "e1")).toEqual(value)
})

test("writing a manifest that could not be read back throws instead", async () => {
  // Regression. JSON.stringify drops undefined-valued keys, so a caller that
  // omits one — a tool invoked without zod having applied its defaults — wrote
  // a manifest that read() then rejected. The environment existed on disk,
  // held installed packages, and was invisible to the inventory: silent, and
  // indistinguishable from "never created" at every call site.
  const bad = { name: "hole", requested: [], installed: {}, total: 0, createdAt: 1, updatedAt: 1 }
  await expect(Environment.write(project, bad as never)).rejects.toThrow("unreadable")
  expect(await Environment.read(project, "hole")).toBeUndefined()
})

test("a manifest that round-trips is exactly what write validated", async () => {
  const value = {
    name: "roundtrip",
    language: "python" as const,
    requested: ["numpy"],
    installed: { numpy: "2.1.0" },
    total: 1,
    createdAt: 1,
    updatedAt: 2,
  }
  await Environment.write(project, value)
  expect(await Environment.read(project, "roundtrip")).toEqual(value)
})

test("reading an environment that does not exist is undefined, not a throw", async () => {
  expect(await Environment.read(project, "never-created")).toBeUndefined()
})

test("list returns every environment for the project and none from another", async () => {
  await Environment.write(project, {
    name: "e2",
    language: "python",
    requested: [],
    installed: {},
    total: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  await Environment.write("other_project", {
    name: "e3",
    language: "python",
    requested: [],
    installed: {},
    total: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  const names = (await Environment.list(project)).map((e) => e.name)
  expect(names).toContain("e2")
  expect(names).not.toContain("e3")
})

test("a corrupt manifest is skipped, not fatal to the whole listing", async () => {
  // One hand-edited or half-written file must not make every environment in
  // the project invisible.
  const fs = await import("fs/promises")
  const file = Environment.manifest(project, "corrupt")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, "{not json")
  const names = (await Environment.list(project)).map((e) => e.name)
  expect(names).not.toContain("corrupt")
  expect(names).toContain("e2")
})

// The additivity rule decides whether kernels restart, so each direction is
// asserted separately rather than as one truthiness check.
test("adding a package is additive", () => {
  expect(Environment.additive({ numpy: "2.1.0" }, { numpy: "2.1.0", pandas: "2.2.0" })).toBe(true)
})

test("an unchanged set is additive", () => {
  expect(Environment.additive({ numpy: "2.1.0" }, { numpy: "2.1.0" })).toBe(true)
})

test("an upgrade is NOT additive — a loaded module would stay stale", () => {
  expect(Environment.additive({ numpy: "2.1.0" }, { numpy: "2.2.0" })).toBe(false)
})

test("a downgrade is NOT additive", () => {
  expect(Environment.additive({ numpy: "2.2.0" }, { numpy: "2.1.0" })).toBe(false)
})

test("a removal is NOT additive", () => {
  expect(Environment.additive({ numpy: "2.1.0", pandas: "2.2.0" }, { numpy: "2.1.0" })).toBe(false)
})

test("the lock serialises two installs into the same environment", async () => {
  const order: string[] = []
  const first = Environment.lock(project, "locked", async () => {
    order.push("first-start")
    await Bun.sleep(50)
    order.push("first-end")
  })
  const second = Environment.lock(project, "locked", async () => {
    order.push("second-start")
  })
  await Promise.all([first, second])
  // Not interleaved: a cell that lazily imports a submodule mid-install can
  // load a half-written file, so this is correctness, not scheduling.
  expect(order).toEqual(["first-start", "first-end", "second-start"])
})

test("a different environment is not blocked by a held lock", async () => {
  const order: string[] = []
  const held = Environment.lock(project, "envA", async () => {
    await Bun.sleep(80)
    order.push("A")
  })
  const free = Environment.lock(project, "envB", async () => {
    order.push("B")
  })
  await Promise.all([held, free])
  expect(order).toEqual(["B", "A"])
})

test("busy() reports the lock while it is held and clears after", async () => {
  let seen = false
  await Environment.lock(project, "watched", async () => {
    seen = Environment.busy(project, "watched")
  })
  expect(seen).toBe(true)
  expect(Environment.busy(project, "watched")).toBe(false)
})

test("the lock releases even when the body throws", async () => {
  await Environment.lock(project, "boom", async () => {
    throw new Error("install failed")
  }).catch(() => {})
  // Otherwise one failed install bricks that environment for the process
  // lifetime — the same latching bug the egress runtime shipped with.
  expect(Environment.busy(project, "boom")).toBe(false)
})

test("a throw in the first holder does not cancel the one queued behind it", async () => {
  const order: string[] = []
  const failing = Environment.lock(project, "chain", async () => {
    order.push("first")
    throw new Error("boom")
  })
  const queued = Environment.lock(project, "chain", async () => {
    order.push("second")
    return "done"
  })
  await failing.catch(() => {})
  expect(await queued).toBe("done")
  expect(order).toEqual(["first", "second"])
})

test("the lock returns the body's value to its own caller", async () => {
  expect(await Environment.lock(project, "value", async () => 42)).toBe(42)
})
