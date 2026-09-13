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
    expect(argv[argv.indexOf("--n-attempts") + 1]).toBe("1")
    expect(argv).not.toContain("OPENSCIENCE_DISABLE_BUNDLED_SKILLS")

    const limited = await python([
      "campaign.py",
      "argv",
      "--bench",
      "terminal-bench-science",
      "--model",
      "anthropic/claude-opus-5",
      "--binary",
      "/tmp/openscience",
      "--limit",
      "1",
      "--attempts",
      "3",
      "--skills",
      "none",
    ])
    expect(limited.exitCode).toBe(0)
    const limitedArgv = JSON.parse(limited.stdout) as string[]
    expect(limitedArgv).toContain("--n-tasks")
    expect(limitedArgv[limitedArgv.indexOf("--n-attempts") + 1]).toBe("3")
    expect(limitedArgv).toContain("skills=none")
  })

  test("local-path benches require a task directory and pass it as --path", async () => {
    const missing = await python([
      "campaign.py",
      "argv",
      "--bench",
      "drugdiscoverybench",
      "--model",
      "openai/gpt-5.5",
      "--version",
      "2.0.78",
    ])
    expect(missing.exitCode).not.toBe(0)

    const result = await python([
      "campaign.py",
      "argv",
      "--bench",
      "drugdiscoverybench",
      "--model",
      "openai/gpt-5.5",
      "--version",
      "2.0.78",
      "--dataset-path",
      "/data/ddb/benchmark/tasks",
    ])
    expect(result.exitCode).toBe(0)
    const argv = JSON.parse(result.stdout) as string[]
    expect(argv[argv.indexOf("--path") + 1]).toBe("/data/ddb/benchmark/tasks")
    expect(argv).toContain("--environment-build-timeout-multiplier")
    expect(argv).not.toContain("-d")
  })

  test("TB4 science argv includes the frozen Harbor task names", async () => {
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
    expect(result.exitCode).toBe(0)
    const argv = JSON.parse(result.stdout) as string[]
    expect(argv).toContain("terminal-bench/terminal-bench@4.0.0")
    expect(argv).toContain("--include-task-name")
    expect(argv).toContain("gsea-proteomics")
    expect(argv).toContain("wdm-design")
  })

  test("freezes TB4 science IDs from task.toml domain metadata", async () => {
    const dataset = path.join(scratch, "tb4")
    const harness = path.join(scratch, "harness")
    await mkdir(path.join(dataset, "keep-me"), { recursive: true })
    await mkdir(path.join(dataset, "also-science"), { recursive: true })
    await mkdir(path.join(dataset, "skip-me"), { recursive: true })
    await mkdir(harness, { recursive: true })
    await Bun.write(path.join(dataset, "keep-me", "task.toml"), 'domain = "science"\n')
    await Bun.write(path.join(dataset, "also-science", "task.toml"), '[metadata]\ncategory = "science"\n')
    await Bun.write(path.join(dataset, "skip-me", "task.toml"), 'domain = "software"\n')
    await Bun.write(path.join(harness, "campaign.py"), await Bun.file(path.join(root, "campaign.py")).text())
    await Bun.write(path.join(harness, "tb4-science-tasks.json"), '{"tasks":null}\n')
    const result = await python(["campaign.py", "freeze-tb4", "--dataset-dir", dataset], {
      cwd: harness,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim().split("\n").sort().join("\n")).toBe("also-science\nkeep-me")
    const frozen = JSON.parse(await Bun.file(path.join(harness, "tb4-science-tasks.json")).text()) as {
      tasks: string[]
    }
    expect(frozen.tasks).toEqual(["also-science", "keep-me"])
  })

  test("ResearchClaw adapter takes the prompt text their runner substitutes for <PROMPT>", async () => {
    const workspace = path.join(scratch, "claw-workspace")
    await mkdir(workspace, { recursive: true })
    const recorded = path.join(scratch, "claw-argv.json")
    const fake = path.join(scratch, "fake-openscience")
    await Bun.write(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(recorded)}\nprintf '{"type":"done","status":"completed","exitCode":0}\\n'\n`,
    )
    await Bun.spawn(["chmod", "+x", fake]).exited

    const prompt = "Reproduce the hidden paper's main result.\nWrite report/report.md"
    const result = await python([
      "adapters/researchclaw.py",
      "-p",
      prompt,
      "-w",
      workspace,
      "--model",
      "openai/gpt-5.5",
      "--binary",
      fake,
    ])
    expect(result.exitCode).toBe(0)
    const [first] = result.stdout.split("\n")
    expect(JSON.parse(first)).toMatchObject({ model: "openai/gpt-5.5", agent: "openscience" })
    const argv = (await Bun.file(recorded).text()).replace(/\n$/, "").split("\n")
    expect(argv.slice(0, 2)).toEqual(["run", "--format"])
    expect(argv).toContain("--auto-approve")
    expect(argv.slice(-3).join("\n")).toBe(["--", ...prompt.split("\n")].join("\n"))
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
