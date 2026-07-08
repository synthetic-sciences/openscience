import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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

test("loadProjectDotenv skips execution-affecting vars and empty values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-dotenv-"))
  fs.writeFileSync(
    path.join(dir, ".env"),
    "NODE_OPTIONS=--require /tmp/evil.js\nLD_PRELOAD=/tmp/evil.so\nEMPTY=\nANTHROPIC_API_KEY=sk-ant-ok\n",
  )
  const env: NodeJS.ProcessEnv = {}
  const applied = loadProjectDotenv(dir, env)
  expect(env.NODE_OPTIONS).toBeUndefined() // dangerous — never from .env
  expect(env.LD_PRELOAD).toBeUndefined()
  expect(env.EMPTY).toBeUndefined() // empty skipped
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-ok")
  expect(applied).toEqual(["ANTHROPIC_API_KEY"])
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
