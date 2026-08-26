import os from "node:os"
import path from "node:path"
import { chmod, mkdir } from "node:fs/promises"
import { DEV_PROMPT_IDS, devPrompt } from "./dev-prompts"
import { gitFingerprint } from "./run"

const DEFAULT_PORT = 4196
const DEFAULT_UI_PORT = 4444
const DEFAULT_MODEL = "openrouter/openai/gpt-5.6-sol"

export type DevLabLayout = ReturnType<typeof devLabLayout>

export function devLabLayout(home = os.homedir(), configured = process.env.OPENSCIENCE_DEV_ROOT) {
  const root = path.resolve(configured?.trim() || path.join(home, ".openscience-dev", "researchagent-test"))
  return {
    root,
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
    xdgData: path.join(root, "xdg", "data"),
    campaigns: path.join(root, "campaigns"),
  }
}

const inherited = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const

/** Build a deliberately narrow child environment. Provider and service keys
 * are not inherited; use the lab's interactive auth/settings flow so secrets
 * live only in its owner-only data root. */
export function labEnvironment(
  layout: DevLabLayout,
  identity: { sourceSha: string; sourceWorktreeHash: string; runId: string },
  source: NodeJS.ProcessEnv = process.env,
) {
  const env = Object.fromEntries(inherited.flatMap((key) => (source[key] ? [[key, source[key]!]] : [])))
  return {
    ...env,
    OPENSCIENCE_DATA_DIR: layout.data,
    OPENSCIENCE_CONFIG_DIR: layout.config,
    OPENSCIENCE_DEV_ROOT: layout.root,
    XDG_DATA_HOME: layout.xdgData,
    XDG_CACHE_HOME: layout.cache,
    XDG_STATE_HOME: layout.state,
    OPENSCIENCE_DISABLE_AUTOUPDATE: "1",
    OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST: "1",
    OPENSCIENCE_SOURCE_SHA: identity.sourceSha,
    OPENSCIENCE_SOURCE_WORKTREE_HASH: identity.sourceWorktreeHash,
    OPENSCIENCE_RUN_ID: identity.runId,
  }
}

async function prepare(layout: DevLabLayout) {
  for (const directory of Object.values(layout)) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
}

async function launch(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(command, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command[0]} exited with ${code}`)
}

async function main() {
  const [action = "help", argument, ...rest] = Bun.argv.slice(2)
  const repoRoot = path.resolve(import.meta.dir, "../..")
  const layout = devLabLayout()
  await prepare(layout)
  const source = await gitFingerprint(repoRoot)
  const identity = {
    sourceSha: source.head,
    sourceWorktreeHash: source.sourceHash,
    runId: process.env.OPENSCIENCE_RUN_ID?.trim() || `dev-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
  }
  const env = labEnvironment(layout, identity)
  const port = Number(process.env.OPENSCIENCE_DEV_PORT ?? DEFAULT_PORT)
  const baseUrl = `http://127.0.0.1:${port}`

  if (action === "server") {
    await launch(
      [
        "bun",
        "--no-env-file",
        "run",
        "--cwd",
        "backend/cli",
        "--conditions=browser",
        "src/index.ts",
        "serve",
        "--port",
        String(port),
      ],
      repoRoot,
      env,
    )
    return
  }
  if (action === "workspace") {
    await launch(
      ["bun", "run", "--cwd", "frontend/workspace", "dev", "--", "--port", String(DEFAULT_UI_PORT)],
      repoRoot,
      { ...env, VITE_OPENSCIENCE_SERVER_URL: baseUrl },
    )
    return
  }
  if (action === "auth") {
    await launch(
      ["bun", "--no-env-file", "run", "--cwd", "backend/cli", "--conditions=browser", "src/index.ts", "auth", "login"],
      repoRoot,
      env,
    )
    return
  }
  if (action === "run") {
    const prompt = devPrompt(argument ?? "")
    const model = process.env.OPENSCIENCE_DEV_MODEL?.trim() || DEFAULT_MODEL
    await launch(
      [
        "bun",
        "--no-env-file",
        "evals/cadence-harness/run.ts",
        "--prompt",
        prompt.id,
        "--base-url",
        baseUrl,
        "--model",
        model,
        ...rest,
      ],
      repoRoot,
      env,
    )
    return
  }
  if (action === "paths") {
    console.log(JSON.stringify({ ...layout, baseUrl, uiUrl: `http://127.0.0.1:${DEFAULT_UI_PORT}` }, null, 2))
    return
  }
  console.log(`OpenScience thin-agent dev lab

  bun evals/cadence-harness/dev-lab.ts auth
  bun evals/cadence-harness/dev-lab.ts server
  bun evals/cadence-harness/dev-lab.ts workspace
  bun evals/cadence-harness/dev-lab.ts run <${DEV_PROMPT_IDS.join("|")}> [runner flags]
  bun evals/cadence-harness/dev-lab.ts paths`)
}

if (import.meta.main) await main()
