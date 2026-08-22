import { describe, expect, test } from "bun:test"
import { GitOutput } from "../../src/util/git-output"
import { ProcessOutput } from "../../src/util/process-output"
import { tmpdir } from "../fixture/fixture"

describe("bounded process output", () => {
  test("kills a real process as soon as stdout exceeds the byte budget", async () => {
    const proc = Bun.spawn([process.execPath, "-e", 'for (;;) process.stdout.write("x".repeat(64 * 1024))'], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const result = await ProcessOutput.collect(proc, { maxBytes: 4 * 1024, timeoutMs: 5_000 })

    expect(result.bytes.byteLength).toBe(4 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(await Promise.race([proc.exited.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true)
  })

  test("force-stops a silent process at the wall-clock deadline", async () => {
    const proc = Bun.spawn([process.execPath, "-e", "await new Promise(() => {})"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const started = performance.now()
    const result = await ProcessOutput.collect(proc, { maxBytes: 1024, timeoutMs: 50 })

    expect(result.bytes.byteLength).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(await Promise.race([proc.exited.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true)
  })

  test("preserves complete UTF-8 output below the limit", async () => {
    const proc = Bun.spawn([process.execPath, "-e", 'process.stdout.write("αβγ")'], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const result = await ProcessOutput.collect(proc, { maxBytes: 1024, timeoutMs: 5_000 })

    expect(result).toMatchObject({ code: 0, timedOut: false, truncated: false })
    expect(result.bytes.toString()).toBe("αβγ")
  })
})

describe("bounded Git output", () => {
  test("does not return a repository-controlled config value beyond the cap", async () => {
    await using tmp = await tmpdir({ git: true })
    const config = `${await Bun.file(`${tmp.path}/.git/config`).text()}\n[remote "origin"]\n\turl = https://example.com/${"x".repeat(8 * 1024)}\n`
    await Bun.write(`${tmp.path}/.git/config`, config)

    const result = await GitOutput.run(["config", "--get", "remote.origin.url"], tmp.path, { maxBytes: 1024 })
    expect(result.bytes.byteLength).toBe(1024)
    expect(result.truncated).toBe(true)
    expect(await GitOutput.text(["config", "--get", "remote.origin.url"], tmp.path, { maxBytes: 1024 })).toBe(undefined)
  })

  test("detects a dirty repository without retaining its full porcelain listing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/untracked.txt`, "dirty")

    const result = await GitOutput.run(["status", "--porcelain"], tmp.path, { maxBytes: 1 })
    expect(result.bytes.toString()).toBe("?")
    expect(result.truncated).toBe(true)
  })

  test("bounds synchronous Git capture used before queued code executes", async () => {
    await using tmp = await tmpdir({ git: true })
    expect(GitOutput.textSync(["rev-parse", "HEAD"], tmp.path)).toMatch(/^[a-f0-9]{40}$/)
    const config = `${await Bun.file(`${tmp.path}/.git/config`).text()}\n[remote "origin"]\n\turl = https://example.com/${"x".repeat(8 * 1024)}\n`
    await Bun.write(`${tmp.path}/.git/config`, config)

    const result = GitOutput.runSync(["config", "--get", "remote.origin.url"], tmp.path, { maxBytes: 1024 })
    expect(result.bytes.byteLength).toBe(1024)
    expect(result.truncated).toBe(true)
    expect(GitOutput.textSync(["config", "--get", "remote.origin.url"], tmp.path, { maxBytes: 1024 })).toBe(undefined)
  })
})
