import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { parseDotenv, loadProjectDotenv } from "../../src/openscience/dotenv"

test("parseDotenv handles export prefix, quotes, comments, blanks, and embedded =", () => {
  const raw = [
    "# a comment",
    "",
    "ANTHROPIC_API_KEY=sk-ant-plain",
    "export OPENAI_API_KEY=sk-openai",
    'QUOTED="has spaces"',
    "SINGLE='single'",
    "WITH_EQ=a=b=c",
    "EMPTY=",
    "1INVALID=nope",
    "  SPACED_KEY = trimmed  ",
  ].join("\n")
  expect(parseDotenv(raw)).toEqual([
    ["ANTHROPIC_API_KEY", "sk-ant-plain"],
    ["OPENAI_API_KEY", "sk-openai"],
    ["QUOTED", "has spaces"],
    ["SINGLE", "single"],
    ["WITH_EQ", "a=b=c"],
    ["EMPTY", ""],
    ["SPACED_KEY", "trimmed"],
  ])
})

test("parseDotenv strips inline comments on unquoted values but keeps # inside quotes", () => {
  const raw = [
    "OPENROUTER_API_KEY=sk-or-abc123 # personal key",
    "NOSPACE=sk-value#notacomment",
    'QUOTED="a # b" # trailing',
    "SINGLEQ='c # d'",
  ].join("\n")
  expect(parseDotenv(raw)).toEqual([
    ["OPENROUTER_API_KEY", "sk-or-abc123"],
    ["NOSPACE", "sk-value#notacomment"],
    ["QUOTED", "a # b"],
    ["SINGLEQ", "c # d"],
  ])
})

test("loadProjectDotenv skips host control-plane, routing, loader vars and empty values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-dotenv-"))
  fs.writeFileSync(
    path.join(dir, ".env"),
    [
      "OPENSCIENCE_CONFIG_CONTENT={malicious}",
      "OPENSCIENCE_PERMISSION={malicious}",
      "SYNSC_API_BASE=https://attacker.invalid",
      "PATH=/tmp/attacker-bin",
      "NODE_OPTIONS=--require /tmp/evil.js",
      "LD_PRELOAD=/tmp/evil.so",
      "HTTPS_PROXY=https://attacker.invalid",
      "ANTHROPIC_BASE_URL=https://attacker.invalid",
      "EMPTY=",
      "RESEARCH_DATASET=local.csv",
      "ANTHROPIC_API_KEY=sk-ant-ok",
      "",
    ].join("\n"),
  )
  const env: NodeJS.ProcessEnv = {}
  const applied = loadProjectDotenv(dir, env)
  expect(env.NODE_OPTIONS).toBeUndefined() // dangerous — never from .env
  expect(env.LD_PRELOAD).toBeUndefined()
  expect(env.OPENSCIENCE_CONFIG_CONTENT).toBeUndefined()
  expect(env.OPENSCIENCE_PERMISSION).toBeUndefined()
  expect(env.SYNSC_API_BASE).toBeUndefined()
  expect(env.PATH).toBeUndefined()
  expect(env.HTTPS_PROXY).toBeUndefined()
  expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  expect(env.EMPTY).toBeUndefined() // empty skipped
  expect(env.RESEARCH_DATASET).toBe("local.csv")
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-ok")
  expect(applied).toEqual(["RESEARCH_DATASET", "ANTHROPIC_API_KEY"])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("loadProjectDotenv applies only unset vars (shell export wins) and returns applied names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-dotenv-"))
  fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=from-dotenv\nGROQ_API_KEY=gsk-dotenv\n")
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "from-shell" }
  const applied = loadProjectDotenv(dir, env)
  expect(env.ANTHROPIC_API_KEY).toBe("from-shell") // shell export wins over .env
  expect(env.GROQ_API_KEY).toBe("gsk-dotenv") // unset → applied
  expect(applied).toEqual(["GROQ_API_KEY"])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("loadProjectDotenv: .env.local takes precedence over .env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-dotenv-"))
  fs.writeFileSync(path.join(dir, ".env"), "OPENROUTER_API_KEY=from-env\n")
  fs.writeFileSync(path.join(dir, ".env.local"), "OPENROUTER_API_KEY=from-env-local\n")
  const env: NodeJS.ProcessEnv = {}
  loadProjectDotenv(dir, env)
  expect(env.OPENROUTER_API_KEY).toBe("from-env-local")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("loadProjectDotenv on a dir with no .env is a no-op", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-dotenv-"))
  const env: NodeJS.ProcessEnv = {}
  expect(loadProjectDotenv(dir, env)).toEqual([])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("an untrusted repository dotenv cannot inject plugins, provider keys, or loader controls at boot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-dotenv-boot-"))
  const host = path.join(dir, "host")
  const marker = path.join(dir, "plugin-ran")
  const plugin = path.join(dir, "injected-plugin.ts")
  const fixture = path.join(import.meta.dir, "..", "fixture", "dotenv-project-process.ts")
  try {
    fs.mkdirSync(host, { recursive: true })
    fs.writeFileSync(
      plugin,
      `await Bun.write(${JSON.stringify(marker)}, "executed")\nexport default async () => ({})\n`,
    )
    fs.writeFileSync(
      path.join(dir, ".env"),
      [
        `OPENSCIENCE_CONFIG_CONTENT='${JSON.stringify({ plugin: [pathToFileURL(plugin).href] })}'`,
        "OPENAI_API_KEY=attacker-owned-project-key",
        `GIT_ASKPASS=${path.join(dir, "attacker-askpass")}`,
        "",
      ].join("\n"),
    )
    const env = { ...process.env }
    delete env.OPENSCIENCE_CONFIG_CONTENT
    delete env.OPENAI_API_KEY
    delete env.GIT_ASKPASS
    env.OPENSCIENCE_TEST_HOME = host
    env.OPENSCIENCE_CONFIG_DIR = path.join(host, "config")
    env.OPENSCIENCE_DATA_DIR = path.join(host, "data")
    const proc = Bun.spawn([process.execPath, fixture, marker], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    const result = stdout
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as {
            marker: boolean
            inline: string | null
            provider: string | null
            askpass: string | null
          }
        } catch {
          return undefined
        }
      })
      .findLast(Boolean)
    expect(result).toEqual({ marker: false, inline: null, provider: null, askpass: null })
    expect(fs.existsSync(marker)).toBe(false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
