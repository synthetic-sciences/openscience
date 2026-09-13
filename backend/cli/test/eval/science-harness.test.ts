import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"

const root = path.resolve(import.meta.dir, "../../../../evals/science-harness")
const scratch = path.join(import.meta.dir, `.science-harness-${process.pid}`)

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function python(args: string[], options?: { cwd?: string }) {
  const proc = Bun.spawn(["python3", ...args], {
    cwd: options?.cwd ?? root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("science harness campaign", () => {
  test("prints a Harbor argv that keeps the product adapter and bundled skills", async () => {
    const result = await python([
      "campaign.py",
      "argv",
      "--bench",
      "terminal-bench-science",
      "--model",
      "anthropic/claude-opus-5",
      "--binary",
      "/tmp/openscience",
    ])
    expect(result.exitCode).toBe(0)
    const argv = JSON.parse(result.stdout) as string[]
    expect(argv).toContain("openscience_harbor.agent:OpenScienceAgent")
    expect(argv).toContain("terminal-bench-science/terminal-bench-science@v0.1")
    expect(argv).toContain("skills=bundled")
    expect(argv).not.toContain("OPENSCIENCE_DISABLE_BUNDLED_SKILLS")
  })

  test("requires a frozen TB4 science subset before constructing argv", async () => {
    const result = await python([
      "campaign.py",
      "argv",
      "--bench",
      "terminal-bench-4-science",
      "--model",
      "anthropic/claude-opus-5",
      "--version",
      "2.0.78",
    ])
    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain("frozen task IDs")
  })

  test("freezes TB4 science IDs from task.toml domain metadata", async () => {
    const dataset = path.join(scratch, "tb4")
    const harness = path.join(scratch, "harness")
    await mkdir(path.join(dataset, "keep-me"), { recursive: true })
    await mkdir(path.join(dataset, "skip-me"), { recursive: true })
    await mkdir(harness, { recursive: true })
    await Bun.write(path.join(dataset, "keep-me", "task.toml"), 'domain = "science"\n')
    await Bun.write(path.join(dataset, "skip-me", "task.toml"), 'domain = "software"\n')
    await Bun.write(path.join(harness, "campaign.py"), await Bun.file(path.join(root, "campaign.py")).text())
    await Bun.write(path.join(harness, "tb4-science-tasks.json"), '{"tasks":null}\n')
    const result = await python(["campaign.py", "freeze-tb4", "--dataset-dir", dataset], {
      cwd: harness,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("keep-me")
    const frozen = JSON.parse(await Bun.file(path.join(harness, "tb4-science-tasks.json")).text()) as {
      tasks: string[]
    }
    expect(frozen.tasks).toEqual(["keep-me"])
  })

  test("ResearchClaw and Bix adapters invoke the same headless run contract", async () => {
    const claw = await python(["adapters/researchclaw.py", "--help"])
    expect(claw.exitCode).toBe(0)
    expect(claw.stdout).toContain("--workspace")

    const prompt = path.join(scratch, "instruction.txt")
    await mkdir(scratch, { recursive: true })
    await Bun.write(prompt, "reproduce the published table")
    const bix = await python([
      "adapters/bixbench3.py",
      "command",
      "--model",
      "anthropic/claude-opus-5",
      "--instruction-file",
      prompt,
      "--skills",
      "none",
    ])
    expect(bix.exitCode).toBe(0)
    const spec = JSON.parse(bix.stdout) as {
      argv: string[]
      cwd: string
      env: Record<string, string>
    }
    expect(spec.cwd).toBe("/workspace/work")
    expect(spec.argv).toContain("--auto-approve")
    expect(spec.argv).toContain("--workspace")
    expect(spec.env.OPENSCIENCE_DISABLE_BUNDLED_SKILLS).toBe("1")
  })
})
