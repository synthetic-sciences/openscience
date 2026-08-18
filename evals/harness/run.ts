import path from "node:path"
import { copyFile, lstat, mkdir, readFile, readdir, readlink, stat } from "node:fs/promises"
import { validateLaunchSuite } from "../launch/validate"

export const Harnesses = ["openscience", "claude-code", "deepseek-harness"] as const
export type Harness = (typeof Harnesses)[number]

type Flow = Awaited<ReturnType<typeof validateLaunchSuite>>["suite"]["flows"][number]
type Artifact = Flow["artifacts"][number]

type CommandOptions = {
  prompt: string
  binary?: string
  model?: string
  effort?: "normal" | "ultra"
  maxTurns?: number
}

type ProcessResult = {
  exitCode: number
  timedOut: boolean
  stdout: string
  stderr: string
  startedAt: string
  completedAt: string
  durationMs: number
}

const dir = import.meta.dir
const launch = path.resolve(dir, "../launch")
const runs = path.join(dir, "runs")
const MAX_OUTPUT = 2_000_000
const help = `Usage: bun evals/harness/run.ts --flow <id> [options]

Options:
  --list                         List frozen flows
  --harnesses <ids>              Comma-separated harness ids
  --openscience-model <id>       OpenScience provider/model
  --claude-model <id>            Claude Code model or alias
  --effort normal|ultra          OpenScience research effort
  --max-turns <count>            Claude Code turn ceiling
  --timeout-minutes <minutes>    Per-process timeout
  --output <directory>           Parent output directory
  --openscience-bin <path>       Override the OpenScience executable
  --claude-code-bin <path>       Override the Claude Code executable
  --deepseek-harness-bin <path>  Override the DeepSeek Harness executable
  --parallel                     Run selected harnesses concurrently
  --dry-run                      Resolve versions and commands only
  --include-held-out             Allow an explicit held-out flow
  --help                         Show this help`

function hash(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function redact(value: string, maximum = MAX_OUTPUT) {
  const safe = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|thk)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted-token]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
  return safe.length <= maximum ? safe : `${safe.slice(0, maximum)}\n[truncated]`
}

export function buildCommand(harness: Harness, input: CommandOptions) {
  if (harness === "openscience") {
    return [
      input.binary ?? "openscience",
      "run",
      "--format",
      "json",
      "--effort",
      input.effort ?? "normal",
      ...(input.model ? ["--model", input.model] : []),
      input.prompt,
    ]
  }
  if (harness === "claude-code") {
    return [
      input.binary ?? "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      String(input.maxTurns ?? 100),
      ...(input.model ? ["--model", input.model] : []),
      input.prompt,
    ]
  }
  return [input.binary ?? "dsh", "--profile", "headless", input.prompt]
}

export function buildPrompt(flow: Flow) {
  const fixtures = flow.fixtures.length
    ? ["Files copied into this workspace:", ...flow.fixtures.map((file) => `- ${file.replace(/^fixtures\//, "")}`)]
    : []
  return [
    flow.prompt,
    "",
    ...fixtures,
    ...(fixtures.length ? [""] : []),
    "Benchmark setup constraints:",
    ...flow.setup.map((item) => `- ${item}`),
    "",
    "Work only inside the current workspace. Finish the task and leave every requested artifact on disk.",
  ].join("\n")
}

export function parseHarnesses(value = Harnesses.join(",")): Harness[] {
  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const invalid = ids.filter((item) => !Harnesses.includes(item as Harness))
  if (invalid.length) throw new Error(`Unknown harness: ${invalid.join(", ")}`)
  if (ids.length === 0) throw new Error("Select at least one harness")
  return [...new Set(ids)] as Harness[]
}

function option(name: string) {
  const tokens = Bun.argv.slice(2)
  const inline = tokens.find((token) => token.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = tokens.indexOf(`--${name}`)
  if (index === -1) return
  const value = tokens[index + 1]
  return value && !value.startsWith("--") ? value : "true"
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

function positive(name: string, fallback: number) {
  const value = Number(option(name) ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`)
  return value
}

async function command(args: string[], cwd: string, env = process.env): Promise<ProcessResult> {
  const started = Date.now()
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timeout = positive("timeout-minutes", 120) * 60_000
  const expiry = Promise.withResolvers<{ timedOut: true; exitCode: 124 }>()
  const timer = setTimeout(() => expiry.resolve({ timedOut: true, exitCode: 124 }), timeout)
  const state = await Promise.race([
    child.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
    expiry.promise,
  ])
  clearTimeout(timer)
  if (state.timedOut) child.kill("SIGTERM")
  const exitCode = state.timedOut
    ? await Promise.race([child.exited, Bun.sleep(5_000).then(() => 124)])
    : state.exitCode
  if (state.timedOut && exitCode === 124) child.kill("SIGKILL")
  const completed = Date.now()
  return {
    exitCode,
    timedOut: state.timedOut,
    stdout: redact(await stdout),
    stderr: redact(await stderr),
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    durationMs: completed - started,
  }
}

async function git(args: string[], cwd: string) {
  const result = await command(["git", ...args], cwd)
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function baseline(workspace: string) {
  await git(["init", "--quiet"], workspace)
  await git(["config", "user.name", "OpenScience Benchmark"], workspace)
  await git(["config", "user.email", "benchmark@openscience.local"], workspace)
  await git(["add", "--all"], workspace)
  await git(["commit", "--quiet", "--allow-empty", "-m", "benchmark fixture baseline"], workspace)
  return git(["rev-parse", "HEAD"], workspace)
}

export async function fingerprint(workspace: string) {
  const [head, status] = await Promise.all([
    git(["rev-parse", "HEAD"], workspace),
    git(["status", "--porcelain=v1", "-z"], workspace),
  ])
  const scan = async (folder: string, prefix = ""): Promise<unknown[]> => {
    const entries = (await readdir(folder, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))
    const nested = await Promise.all(
      entries.map(async (entry) => {
        if (!prefix && entry.name === ".git") return []
        const name = prefix ? `${prefix}/${entry.name}` : entry.name
        const file = path.join(folder, entry.name)
        if (entry.isDirectory()) return scan(file, name)
        const info = await lstat(file)
        if (entry.isSymbolicLink()) {
          return [{ path: name, type: "symlink", mode: info.mode & 0o777, targetHash: hash(await readlink(file)) }]
        }
        if (!entry.isFile()) return [{ path: name, type: "other", mode: info.mode & 0o777 }]
        const value = await readFile(file)
        return [{ path: name, type: "file", mode: info.mode & 0o777, bytes: value.byteLength, sha256: hash(value) }]
      }),
    )
    return nested.flat()
  }
  const files = await scan(workspace)
  return {
    head,
    dirty: status.length > 0,
    files: files.length,
    treeHash: hash(JSON.stringify(files)),
    statusHash: hash(status),
  }
}

async function fixtures(flow: Flow, workspace: string) {
  await Promise.all(
    flow.fixtures.map(async (name) => {
      const source = path.resolve(launch, name)
      if (!source.startsWith(`${path.join(launch, "fixtures")}${path.sep}`)) {
        throw new Error(`Fixture escapes the launch suite: ${name}`)
      }
      const target = path.resolve(workspace, name.replace(/^fixtures\//, ""))
      if (!target.startsWith(`${workspace}${path.sep}`)) throw new Error(`Fixture escapes the workspace: ${name}`)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(source, target)
    }),
  )
}

export async function captureArtifacts(workspace: string, artifacts: Artifact[]) {
  return Promise.all(
    artifacts.map(async (artifact) => {
      const file = path.resolve(workspace, artifact.path)
      if (!file.startsWith(`${workspace}${path.sep}`)) {
        return { path: artifact.path, exists: false, valid: false, error: "path_escape" }
      }
      const info = await stat(file).catch(() => undefined)
      if (!info?.isFile()) return { path: artifact.path, exists: false, valid: false }
      const value = await readFile(file)
      return {
        path: artifact.path,
        exists: true,
        valid: true,
        bytes: value.byteLength,
        sha256: hash(value),
      }
    }),
  )
}

function binary(harness: Harness) {
  const name = harness === "claude-code" ? "claude" : harness === "deepseek-harness" ? "dsh" : "openscience"
  return option(`${harness}-bin`) ?? name
}

async function version(executable: string, cwd: string) {
  const result = await command([executable, "--version"], cwd)
  if (result.exitCode !== 0) throw new Error(`${executable} --version failed: ${result.stderr || result.stdout}`)
  return { exitCode: result.exitCode, output: (result.stdout || result.stderr).trim() }
}

async function execute(input: { harness: Harness; flow: Flow; root: string; prompt: string; dry: boolean }) {
  const workspace = path.join(input.root, input.harness, "workspace")
  await mkdir(workspace, { recursive: true })
  await fixtures(input.flow, workspace)
  await Bun.write(
    path.join(workspace, "BENCHMARK.md"),
    `${input.flow.title}\n\nSetup:\n${input.flow.setup.map((item) => `- ${item}`).join("\n")}\n`,
  )
  const head = await baseline(workspace)
  const executable = binary(input.harness)
  const available =
    Bun.which(executable) ??
    (path.isAbsolute(executable) && (await Bun.file(executable).exists()) ? executable : undefined)
  if (!available) throw new Error(`${input.harness} binary not found: ${executable}`)
  const args = buildCommand(input.harness, {
    prompt: input.prompt,
    binary: available,
    model: input.harness === "openscience" ? option("openscience-model") : option("claude-model"),
    effort: option("effort") === "ultra" ? "ultra" : "normal",
    maxTurns: positive("max-turns", 100),
  })
  const meta = {
    harness: input.harness,
    binary: available,
    version: await version(available, workspace),
    command: args.map((arg) => (arg === input.prompt ? "{prompt}" : arg)),
    promptHash: hash(input.prompt),
    baseline: head,
  }
  if (input.dry) return { ...meta, dryRun: true }

  const env = {
    ...process.env,
    ...(input.harness === "deepseek-harness" ? { DSH_HOME: path.join(input.root, input.harness, "home") } : {}),
  }
  const result = await command(args, workspace, env)
  const artifacts = await captureArtifacts(workspace, input.flow.artifacts)
  const output = {
    ...meta,
    ...result,
    status: result.exitCode === 0 && artifacts.every((artifact) => artifact.exists) ? "completed" : "failed",
    fingerprint: await fingerprint(workspace),
    artifacts,
  }
  await Promise.all([
    Bun.write(path.join(input.root, input.harness, "stdout.log"), result.stdout),
    Bun.write(path.join(input.root, input.harness, "stderr.log"), result.stderr),
    Bun.write(path.join(input.root, input.harness, "run.json"), json(output)),
  ])
  return output
}

async function main() {
  const validation = await validateLaunchSuite()
  if (validation.errors.length) throw new Error(validation.errors.join("\n"))
  if (option("help")) {
    console.log(help)
    return
  }
  if (option("list")) {
    for (const flow of validation.suite.flows) console.log(`${flow.split.padEnd(11)} ${flow.id}`)
    return
  }
  const flowID = option("flow")
  if (!flowID || flowID === "true") throw new Error("Pass --flow <id>. Use --list to inspect the frozen flows.")
  const flow = validation.suite.flows.find((item) => item.id === flowID)
  if (!flow) throw new Error(`Unknown flow: ${flowID}`)
  if (flow.split === "held_out" && option("include-held-out") !== "true") {
    throw new Error("Held-out flows require --include-held-out")
  }
  const selected = parseHarnesses(option("harnesses"))
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const root = path.resolve(
    option("output") ?? runs,
    `${stamp}-${safeName(flow.id)}-${crypto.randomUUID().slice(0, 8)}`,
  )
  await mkdir(root, { recursive: true })
  const prompt = buildPrompt(flow)
  const dry = option("dry-run") === "true"
  const invoke = (harness: Harness) => execute({ harness, flow, root, prompt, dry })
  const results =
    option("parallel") === "true"
      ? await Promise.all(selected.map(invoke))
      : await selected.reduce<Promise<unknown[]>>(
          async (pending, harness) => [...(await pending), await invoke(harness)],
          Promise.resolve([]),
        )
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    flow: { id: flow.id, split: flow.split, title: flow.title },
    suite: { version: validation.suite.version, hash: validation.hash },
    sources: {
      deepseekHarness: {
        repository: "https://github.com/deepseek-ai/deepseek-harness",
        commit: "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca",
        version: "0.1.0-rc.7",
      },
    },
    results,
  }
  await Bun.write(path.join(root, "manifest.json"), json(manifest))
  console.log(`${dry ? "Prepared" : "Completed"} ${selected.length} harness run(s) in ${root}`)
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
