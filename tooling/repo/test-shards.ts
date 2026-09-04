#!/usr/bin/env bun

// Backend test sharding for CI.
//
// Bun 1.3 has no stable multi-process test runner, so Deep CI runs the
// backend/cli suite as a GitHub matrix of directory shards balanced greedily
// from the measured weights below, and Fast CI runs only the entries a change
// can affect. Paths carry the ./ prefix on purpose: bun treats a bare
// positional argument as a substring filter (test/openscience also matches
// test/openscience-env.test.ts) but anchors ./-prefixed arguments to a path.
//
//   bun tooling/repo/test-shards.ts                       JSON matrix for deep-ci.yml
//   bun tooling/repo/test-shards.ts --shards 6            same, with a different width
//   git diff --name-only BASE HEAD | bun tooling/repo/test-shards.ts affected
//                                                         JSON groups for ci.yml

import path from "node:path"
import { readdir } from "node:fs/promises"

export const root = path.resolve(import.meta.dir, "../../backend/cli")

export type Entry = { name: string; paths: string[]; seconds: number; files: number }
export type Shard = { name: string; paths: string; seconds: number; files: number }

/** Single-process seconds per backend/cli/test directory, measured from Deep CI
 * run 100947377021 (2026-09-04; 372 files, 838 s). `root` covers
 * backend/cli/test/*.test.ts and `src` covers backend/cli/src/**\/*.test.ts.
 * Every test directory on disk must appear here and vice versa; refresh the
 * numbers when the shard balance drifts. */
export const weights: Record<string, number> = {
  compute: 203,
  tool: 145,
  science: 143,
  server: 117,
  session: 53,
  project: 47,
  provider: 28,
  installation: 24,
  mcp: 11,
  file: 10,
  process: 9,
  openscience: 9,
  lsp: 5,
  skill: 4,
  global: 4,
  snapshot: 3,
  auth: 3,
  storage: 3,
  cli: 3,
  runtime: 2,
  util: 2,
  config: 1,
  agent: 1,
  credentials: 1,
  permission: 1,
  sandbox: 1,
  artifact: 1,
  eval: 1,
  plugin: 1,
  settings: 1,
  question: 1,
  acp: 1,
  shell: 1,
  fixture: 1,
  patch: 1,
  web: 1,
  id: 1,
  root: 1,
  src: 1,
}

/** Directories that get a bun process of their own: test/project crashes when
 * it shares a process with the other multiprocess suites. */
export const isolated = ["project"]

/** Owners for backend/cli/src areas that have no same-named test directory. */
const aliases: Record<string, string> = {
  bun: "root",
  pty: "root",
  scheduler: "root",
  env: "root",
  bus: "session",
  command: "cli",
  flag: "cli",
  format: "util",
  research: "science",
  worktree: "project",
}

/** Repo paths outside backend/cli/src whose tests live in one directory. */
const prefixes: [string, string][] = [
  [".github/", "installation"],
  ["frontend/desktop/", "installation"],
  ["tooling/repo/", "installation"],
  ["tooling/launcher/", "installation"],
  ["backend/cli/bin/", "installation"],
  ["backend/cli/script/", "installation"],
  ["backend/cli/skills/", "skill"],
  ["evals/", "eval"],
]
const exact: Record<string, string> = {
  install: "installation",
  "frontend/landing/public/install": "installation",
}

/** Owner of a change that can affect any backend test. Not a directory name:
 * test/global and src/global are a real weighted entry, so a string such as
 * "global" cannot double as this sentinel. */
export const anyTest = "*"

/** Changes that can affect any test. The affected lane runs the root files
 * and reports that full coverage waits for Deep CI. */
const shared = [
  "bun.lock",
  "package.json",
  "bunfig.toml",
  "backend/cli/package.json",
  "backend/cli/bunfig.toml",
  "backend/cli/tsconfig.json",
  "backend/cli/test/preload.ts",
]

function area(file: string, base: string) {
  const rest = file.slice(base.length)
  return rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : undefined
}

/** Map a repo-relative path to the weighted entry that covers it, `anyTest`
 * when any test may be affected, or undefined when no backend test can be. */
export function owner(file: string) {
  if (shared.includes(file)) return anyTest
  // test/fixture holds helpers every suite loads plus a few tests of its own.
  if (file.startsWith("backend/cli/test/fixture/")) return file.endsWith(".test.ts") ? "fixture" : anyTest
  if (exact[file]) return exact[file]
  const prefix = prefixes.find(([value]) => file.startsWith(value))
  if (prefix) return prefix[1]
  if (file.startsWith("backend/cli/test/")) return area(file, "backend/cli/test/") ?? "root"
  if (file.startsWith("backend/cli/src/")) {
    const dir = area(file, "backend/cli/src/")
    if (!dir) return "cli"
    return aliases[dir] ?? (dir in weights ? dir : anyTest)
  }
  if (file.startsWith("backend/cli/")) return anyTest
  return undefined
}

async function tests(directory: string) {
  const files = await Array.fromAsync(new Bun.Glob("**/*.test.ts").scan({ cwd: directory }))
  return files.filter((file) => !file.includes("node_modules/") && !file.includes("dist/")).toSorted()
}

/** Every weighted entry with its ./-prefixed bun test arguments, failing when
 * a directory is missing from the weight table, the table names a directory
 * that no longer has tests, or a test file sits outside every entry. */
export async function entries(cwd = root): Promise<Entry[]> {
  const all = await tests(cwd)
  const directories = (await readdir(path.join(cwd, "test"), { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .toSorted()
  const result: Entry[] = []
  for (const name of directories) {
    const files = all.filter((file) => file.startsWith(`test/${name}/`))
    if (files.length === 0) continue
    if (!(name in weights)) {
      throw new Error(`test/${name} has no weight; add it to weights in tooling/repo/test-shards.ts`)
    }
    result.push({ name, paths: [`./test/${name}`], seconds: weights[name], files: files.length })
  }
  const rootFiles = all.filter((file) => file.startsWith("test/") && !file.slice("test/".length).includes("/"))
  result.push({
    name: "root",
    paths: rootFiles.map((file) => `./${file}`),
    seconds: weights.root,
    files: rootFiles.length,
  })
  const srcFiles = all.filter((file) => file.startsWith("src/"))
  result.push({ name: "src", paths: ["./src"], seconds: weights.src, files: srcFiles.length })
  const stale = Object.keys(weights).filter((name) => !result.some((entry) => entry.name === name))
  if (stale.length > 0) {
    throw new Error(
      `weights name directories without tests: ${stale.join(", ")}; remove them from tooling/repo/test-shards.ts`,
    )
  }
  const covered = result.reduce((sum, entry) => sum + entry.files, 0)
  if (covered !== all.length) {
    const orphans = all.filter(
      (file) =>
        !file.startsWith("src/") &&
        !directories.some((name) => file.startsWith(`test/${name}/`)) &&
        !rootFiles.includes(file),
    )
    throw new Error(`${all.length - covered} backend test files belong to no shard: ${orphans.join(", ")}`)
  }
  return result
}

function seconds(items: Entry[]) {
  return items.reduce((sum, item) => sum + item.seconds, 0)
}

function shard(items: Entry[]): Shard {
  return {
    name: items[0].name,
    paths: items.flatMap((item) => item.paths).join(" "),
    seconds: seconds(items),
    files: items.reduce((sum, item) => sum + item.files, 0),
  }
}

/** Greedy longest-first packing into `count` shards, plus one shard per
 * isolated directory. A shard is named after its heaviest entry. */
export function plan(items: Entry[], count: number): Shard[] {
  const alone = items.filter((item) => isolated.includes(item.name))
  const rest = items
    .filter((item) => !isolated.includes(item.name))
    .toSorted((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name))
  const bins = Array.from({ length: Math.max(1, count) }, () => [] as Entry[])
  for (const item of rest) {
    bins.reduce((best, bin) => (seconds(bin) < seconds(best) ? bin : best)).push(item)
  }
  return [...bins.filter((bin) => bin.length > 0), ...alone.map((item) => [item])].map(shard)
}

/** Groups for the pull request lane: the root files always run, every entry
 * that owns a changed path joins one group, and isolated entries get their
 * own. `global` lists changes whose blast radius only Deep CI covers. */
export function affected(changed: string[], items: Entry[]) {
  const names = new Set(["root"])
  const global: string[] = []
  for (const file of changed) {
    const name = owner(file)
    if (name === anyTest) global.push(file)
    else if (name) names.add(name)
  }
  const selected = items.filter((item) => names.has(item.name))
  const groups = plan(selected, 1)
  return { groups, global, seconds: groups.reduce((sum, group) => sum + group.seconds, 0) }
}

function width(args: string[]) {
  const index = args.indexOf("--shards")
  if (index === -1) return 4
  const value = Number(args[index + 1])
  if (!Number.isInteger(value) || value < 1) throw new Error("--shards requires a positive integer")
  return value
}

async function changed() {
  const text = await Bun.stdin.text()
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  try {
    const output =
      args[0] === "affected" ? affected(await changed(), await entries()) : plan(await entries(), width(args))
    console.log(JSON.stringify(output))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // On GitHub, put weight-table drift on the pull request check itself. The
    // runner reads workflow commands from stderr too, and ci.yml sends stdout
    // to a file.
    console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message)
    process.exit(1)
  }
}
