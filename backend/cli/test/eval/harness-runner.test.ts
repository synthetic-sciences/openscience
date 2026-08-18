import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  buildCommand,
  buildPrompt,
  captureArtifacts,
  fingerprint,
  parseHarnesses,
  redact,
} from "../../../../evals/harness/run"
import { validateLaunchSuite } from "../../../../evals/launch/validate"

const root = await mkdtemp(path.join(tmpdir(), "openscience-harness-test-"))
const launch = path.resolve(import.meta.dir, "../../../../evals/launch")
const runner = path.resolve(import.meta.dir, "../../../../evals/harness/run.ts")

afterAll(() => rm(root, { recursive: true, force: true }))

describe("cross-harness runner", () => {
  test("builds argv without a shell for every supported harness", () => {
    expect(
      buildCommand("openscience", {
        prompt: "task",
        binary: "/bin/openscience",
        model: "deepseek/deepseek-chat",
        effort: "ultra",
      }),
    ).toEqual([
      "/bin/openscience",
      "run",
      "--format",
      "json",
      "--effort",
      "ultra",
      "--model",
      "deepseek/deepseek-chat",
      "task",
    ])
    expect(buildCommand("claude-code", { prompt: "task", maxTurns: 12 })).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "12",
      "task",
    ])
    expect(buildCommand("deepseek-harness", { prompt: "task" })).toEqual(["dsh", "--profile", "headless", "task"])
  })

  test("validates harness ids and redacts captured secrets", () => {
    expect(parseHarnesses("deepseek-harness,openscience,deepseek-harness")).toEqual(["deepseek-harness", "openscience"])
    expect(() => parseHarnesses("unknown")).toThrow("Unknown harness")
    expect(() => parseHarnesses(" ")).toThrow("Select at least one harness")
    const token = ["sk", "abcdefghijklmnop"].join("-")
    expect(redact(`Bearer abcdefghijklmnop ${token}`)).toBe("Bearer [redacted] [redacted-token]")
  })

  test("uses the frozen flow contract and hashes real artifacts", async () => {
    const validation = await validateLaunchSuite(launch)
    const flow = validation.suite.flows.find((item) => item.id === "python-csv-report")
    expect(flow).toBeDefined()
    if (!flow) return
    const prompt = buildPrompt(flow)
    expect(prompt).toContain("growth.csv")
    expect(prompt).toContain("Work only inside the current workspace")

    await mkdir(root, { recursive: true })
    await Bun.write(path.join(root, "growth-report.md"), "# Result\n")
    const artifacts = await captureArtifacts(root, flow.artifacts)
    expect(artifacts[0]).toMatchObject({ path: "growth-report.md", exists: true, valid: true })
    expect(artifacts[0].sha256).toHaveLength(64)
    expect(artifacts[1]).toEqual({ path: "growth-response.png", exists: false, valid: false })
  })

  test("exits after a successful dry run instead of retaining timeout timers", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        runner,
        "--flow",
        "citation-literature",
        "--harnesses",
        "openscience",
        "--openscience-bin",
        Bun.which("true")!,
        "--output",
        root,
        "--dry-run",
      ],
      { cwd: path.resolve(import.meta.dir, "../../../.."), stdout: "pipe", stderr: "pipe" },
    )
    const expiry = Promise.withResolvers<number>()
    const timer = setTimeout(() => expiry.resolve(124), 5_000)
    const code = await Promise.race([child.exited, expiry.promise])
    clearTimeout(timer)
    if (code === 124) child.kill("SIGKILL")
    expect(code).toBe(0)
  })

  test("fingerprints every workspace file, including untracked outputs", async () => {
    const workspace = path.join(root, "fingerprint")
    await mkdir(workspace, { recursive: true })
    for (const args of [
      ["init", "--quiet"],
      ["config", "user.name", "Harness Test"],
      ["config", "user.email", "harness@test.invalid"],
      ["commit", "--quiet", "--allow-empty", "-m", "baseline"],
    ]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: workspace }).exitCode).toBe(0)
    }
    const before = await fingerprint(workspace)
    await Bun.write(path.join(workspace, "untracked.txt"), "first result")
    const after = await fingerprint(workspace)
    expect(after.files).toBe(before.files + 1)
    expect(after.treeHash).not.toBe(before.treeHash)
  })
})
