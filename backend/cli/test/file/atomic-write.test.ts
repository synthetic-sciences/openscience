import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FileIdentity } from "../../src/file/identity"
import { SafeFileIO } from "../../src/file/safe-io"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

const supported = process.platform === "darwin" || process.platform === "linux"

test.skipIf(!supported)("approved writes never disappear or expose partial bytes to another process", async () => {
  await using fixture = await tmpdir()
  const target = path.join(fixture.path, "shared.txt")
  const ready = path.join(fixture.path, "ready")
  const stop = path.join(fixture.path, "stop")
  const request = path.join(fixture.path, "request")
  const ack = path.join(fixture.path, "ack")
  const script = path.join(fixture.path, "reader.cjs")
  const contents = ["a".repeat(8192), "b".repeat(24576)]
  await fs.writeFile(target, contents[0])
  await fs.writeFile(
    script,
    `const fs = require("node:fs");
const [target, ready, stop, request, ack] = process.argv.slice(2);
const contents = ["a".repeat(8192), "b".repeat(24576)];
const seen = new Set(); let reads = 0; let acknowledged = "";
const deadline = Date.now() + 10000;
try {
  while (!fs.existsSync(stop) && Date.now() < deadline) {
    const current = fs.readFileSync(target, "utf8");
    const index = contents.indexOf(current);
    if (index < 0) throw new Error("reader observed partial contents");
    seen.add(index); reads++;
    if (reads === 1) fs.writeFileSync(ready, "ready");
    const pending = fs.existsSync(request) ? fs.readFileSync(request, "utf8") : "";
    if (pending && pending !== acknowledged) {
      fs.writeFileSync(ack, pending); acknowledged = pending;
    }
  }
  if (!fs.existsSync(stop)) throw new Error("reader deadline");
  console.log(JSON.stringify({ reads, seen: [...seen] }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
`,
  )
  const reader = Bun.spawn([process.execPath, script, target, ready, stop, request, ack], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const finished = { value: false }
  void reader.exited.then(() => {
    finished.value = true
  })
  const fstat = FileIdentity.fstat
  let sequence = 0
  let acknowledging = Promise.resolve()
  const barrier = spyOn(FileIdentity, "fstat").mockImplementation(async (fd) => {
    const result = await fstat(fd)
    if (!result.isFile() || finished.value) return result
    // Let an independent reader inspect the pathname while the real writer
    // validates a held file descriptor. A rename-away implementation leaves
    // the pathname absent at this boundary; an atomic exchange keeps it live.
    const pending = acknowledging.then(async () => {
      if (finished.value) return
      const receipt = String(++sequence)
      await fs.writeFile(request, receipt)
      const deadline = Date.now() + 2_000
      while (!finished.value && Date.now() < deadline) {
        if ((await fs.readFile(ack, "utf8").catch(() => "")) === receipt) return
        await Bun.sleep(5)
      }
      if (!finished.value) throw new Error("reader did not acknowledge file validation")
    })
    acknowledging = pending.catch(() => {})
    await pending
    return result
  })
  try {
    const deadline = Date.now() + 3_000
    while (!finished.value && Date.now() < deadline && !(await Bun.file(ready).exists())) await Bun.sleep(10)
    expect(await Bun.file(ready).exists()).toBe(true)
    for (let index = 0; index < 8; index++) {
      const approved = await SafeFileIO.read(target)
      await SafeFileIO.write(target, contents[(index + 1) % 2], approved)
    }
    await fs.writeFile(stop, "stop")
    const [code, stdout, stderr] = await Promise.all([
      reader.exited,
      new Response(reader.stdout).text(),
      new Response(reader.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    const receipt = JSON.parse(stdout) as { reads: number; seen: number[] }
    expect(receipt.reads).toBeGreaterThan(8)
    expect(receipt.seen.toSorted()).toEqual([0, 1])
    expect(await fs.readFile(target, "utf8")).toBe(contents[0])
    expect((await fs.readdir(fixture.path)).filter((name) => name.startsWith(".openscience-"))).toEqual([])
  } finally {
    barrier.mockRestore()
    reader.kill()
    await reader.exited
  }
})

test.skipIf(!supported)("a failed replacement validation preserves the approved bytes", async () => {
  await using fixture = await tmpdir()
  const target = path.join(fixture.path, "result.txt")
  await fs.writeFile(target, "approved")
  const approved = await SafeFileIO.read(target)
  const fstat = FileIdentity.fstat
  let injected = false
  const barrier = spyOn(FileIdentity, "fstat").mockImplementation(async (fd) => {
    const result = await fstat(fd)
    if (!injected && result.isFile() && FileIdentity.same(result, approved)) {
      injected = true
      throw new Error("injected replacement validation failure")
    }
    return result
  })
  try {
    await expect(SafeFileIO.write(target, "replacement", approved)).rejects.toThrow(
      "injected replacement validation failure",
    )
    expect(injected).toBe(true)
    expect(await fs.readFile(target, "utf8")).toBe("approved")
    expect((await fs.readdir(fixture.path)).filter((name) => name.startsWith(".openscience-"))).toEqual([])
  } finally {
    barrier.mockRestore()
  }
})

test.skipIf(!supported)(
  "replacement recovery never overwrites a concurrent writer or loses the approved bytes",
  async () => {
    await using fixture = await tmpdir()
    const target = path.join(fixture.path, "result.txt")
    await fs.writeFile(target, "approved")
    const approved = await SafeFileIO.read(target)
    const fstat = FileIdentity.fstat
    let injected = false
    const barrier = spyOn(FileIdentity, "fstat").mockImplementation(async (fd) => {
      const result = await fstat(fd)
      if (!injected && result.isFile()) {
        const current = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        // Preserve ordinary before-mutation validation: race only once the new
        // value is installed, or inside the old rename-away implementation's gap.
        if (current !== "replacement" && current !== undefined) return result
        injected = true
        await fs.writeFile(target, "concurrent")
      }
      return result
    })
    try {
      await expect(SafeFileIO.write(target, "replacement", approved)).rejects.toThrow()
      expect(injected).toBe(true)
      expect(await fs.readFile(target, "utf8")).toBe("concurrent")
      const retained = (await fs.readdir(fixture.path)).filter((name) => name.startsWith(".openscience-"))
      expect(await Promise.all(retained.map((name) => fs.readFile(path.join(fixture.path, name), "utf8")))).toContain(
        "approved",
      )
    } finally {
      barrier.mockRestore()
    }
  },
)

test.skipIf(!supported)("a completed write leaves no staging file behind and does not warn about one", async () => {
  await using fixture = await tmpdir()
  const target = path.join(fixture.path, "notes.md")
  await SafeFileIO.write(target, "first")
  const approved = await SafeFileIO.read(target)
  await SafeFileIO.write(target, "second", approved)
  expect(await fs.readFile(target, "utf8")).toBe("second")
  expect((await fs.readdir(fixture.path)).filter((file) => file.startsWith(".openscience-"))).toEqual([])
  // The staging file was already removed by the write itself; its absence is
  // the expected end state, not a retained file to recover.
  await Log.flush()
  const log = await fs.readFile(path.join(Global.Path.log, "dev.log"), "utf8").catch(() => "")
  const retained = log
    .split("\n")
    .filter((line) => line.includes("retained for recovery") && line.includes(fixture.path))
  expect(retained).toEqual([])
})
