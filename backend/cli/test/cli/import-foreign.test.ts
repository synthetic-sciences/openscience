import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cli = path.join(import.meta.dir, "../../src/index.ts")

let root: string
let env: Record<string, string>
let project: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-import-foreign-"))
  project = path.join(root, "project")
  const claude = path.join(root, "claude-projects", "-proj")
  const codex = path.join(root, "codex-sessions")
  await Promise.all([
    fs.mkdir(project, { recursive: true }),
    fs.mkdir(claude, { recursive: true }),
    fs.mkdir(codex, { recursive: true }),
    fs.mkdir(path.join(root, "config"), { recursive: true }),
  ])
  const t = (s: number) => new Date(Date.parse("2026-11-01T10:00:00Z") + s * 1000).toISOString()
  const records = [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      cwd: project,
      timestamp: t(0),
      message: { role: "user", content: "cli question" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      cwd: project,
      timestamp: t(1),
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "cli answer" }],
        stop_reason: "end_turn",
      },
    },
  ]
  await fs.writeFile(path.join(claude, "conv-cli.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  env = {
    ...(process.env as Record<string, string>),
    HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_DISABLE_PROJECT_CONFIG: "1",
    OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENSCIENCE_DISABLE_BUNDLED_SKILLS: "1",
    OPENSCIENCE_DISABLE_MODELS_FETCH: "1",
    OPENSCIENCE_DISABLE_AUTOUPDATE: "1",
    OPENSCIENCE_API_BASE: "http://127.0.0.1:9",
    OPENSCIENCE_IMPORT_ROOT_CLAUDE: path.join(root, "claude-projects"),
    OPENSCIENCE_IMPORT_ROOT_CODEX: codex,
    BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function openscience(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "import", ...args], {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

describe("openscience import --from-claude / --from-codex", () => {
  test("imports a Claude Code conversation and prints the session and outcome", async () => {
    const first = await openscience("--from-claude", "conv-cli", "--folder-access", "none")
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout).toMatch(/Imported session: ses_\w+/)
    expect(first.stdout).toContain("New session created")
    const again = await openscience("--from-claude", "conv-cli", "--folder-access", "none")
    expect(again.code, again.stderr).toBe(0)
    expect(again.stdout).toContain("Nothing new to import")
  }, 60_000)

  test("an unknown Codex id exits 1", async () => {
    const result = await openscience("--from-codex", "no-such-id", "--folder-access", "none")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Session not found")
  }, 60_000)

  test("a file together with --from-claude exits 1", async () => {
    const result = await openscience("session.json", "--from-claude", "conv-cli")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("either a file or")
  }, 60_000)

  test("without a terminal and without --folder-access the folder is not connected", async () => {
    const result = await openscience("--from-claude", "conv-cli")
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain("Folder not connected")
  }, 60_000)

  test("--all in a fresh folder imports its conversations", async () => {
    const result = await openscience("--all")
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain("created  cli question")
    expect(result.stdout).toContain("Imported 1: created 1")
    const again = await openscience("--all")
    expect(again.stdout).toContain("unchanged  cli question")
  }, 60_000)

  test("--all --from-codex limits to Codex and says when nothing matches", async () => {
    const result = await openscience("--all", "--from-codex")
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain("No Claude Code or Codex conversations ran in this project's folders.")
    const both = await openscience("--all", "--from-claude", "--from-codex")
    expect(both.code, both.stderr).toBe(0)
    expect(both.stdout).toContain("Imported 1: created 1")
  }, 60_000)

  test("--all with an id or with --folder-access exits 1", async () => {
    expect((await openscience("--all", "--from-claude", "conv-cli")).code).toBe(1)
    expect((await openscience("--all", "--folder-access", "write")).code).toBe(1)
  }, 60_000)
})
