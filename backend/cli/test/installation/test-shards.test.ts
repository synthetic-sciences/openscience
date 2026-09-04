import { expect, test } from "bun:test"
import path from "path"
import { readdir } from "node:fs/promises"
import { affected, anyTest, entries, isolated, owner, plan, root, weights } from "../../../../tooling/repo/test-shards"

const tool = path.resolve(root, "../../tooling/repo/test-shards.ts")

async function files() {
  const all = await Array.fromAsync(new Bun.Glob("**/*.test.ts").scan({ cwd: root }))
  return all.filter((file) => !file.includes("node_modules/") && !file.includes("dist/"))
}

function covers(paths: string, file: string) {
  return paths.split(" ").some((item) => file === item.slice(2) || file.startsWith(`${item.slice(2)}/`))
}

test("every backend test file belongs to exactly one deep-ci shard", async () => {
  const shards = plan(await entries(), 4)
  const all = await files()

  expect(all.length).toBeGreaterThan(300)
  for (const file of all) expect(shards.filter((shard) => covers(shard.paths, file))).toHaveLength(1)
  expect(shards.reduce((sum, shard) => sum + shard.files, 0)).toBe(all.length)
  for (const shard of shards) for (const item of shard.paths.split(" ")) expect(item.startsWith("./")).toBe(true)
})

test("shards balance the measured weights and isolate project", async () => {
  const shards = plan(await entries(), 4)
  const alone = shards.filter((shard) => isolated.includes(shard.name))
  const rest = shards.filter((shard) => !isolated.includes(shard.name)).map((shard) => shard.seconds)

  expect(alone.map((shard) => shard.paths)).toEqual(["./test/project"])
  expect(shards).toHaveLength(5)
  expect(shards.map((shard) => shard.name)).toEqual(["compute", "tool", "science", "server", "project"])
  expect(Math.max(...rest) - Math.min(...rest)).toBeLessThanOrEqual(15)
  expect(plan(await entries(), 6)).toHaveLength(7)
})

test("the weight table matches the test directories on disk", async () => {
  const directories = (await readdir(path.join(root, "test"), { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => item.name)

  expect(Object.keys(weights).toSorted()).toEqual([...directories, "root", "src"].toSorted())
  for (const value of Object.values(weights)) expect(value).toBeGreaterThan(0)
})

test("changed paths map to their test directories, root files always run, and project stays alone", async () => {
  const items = await entries()
  const rootPaths = items.find((item) => item.name === "root")!.paths

  const pair = affected(["backend/cli/src/session/prompt.ts", "backend/cli/src/tool/bash.ts"], items)
  expect(pair.groups).toHaveLength(1)
  for (const item of ["./test/session", "./test/tool", ...rootPaths]) expect(pair.groups[0].paths).toContain(item)
  expect(pair.global).toEqual([])
  expect(pair.seconds).toBe(weights.session + weights.tool + weights.root)

  const project = affected(["backend/cli/src/project/instance.ts", "backend/cli/test/server/routes.test.ts"], items)
  expect(project.groups.map((group) => group.paths)).toEqual([
    expect.stringContaining("./test/server"),
    "./test/project",
  ])

  const nothing = affected(["docs/readme.md", "frontend/workspace/src/app.tsx"], items)
  expect(nothing.groups.map((group) => group.paths)).toEqual([rootPaths.join(" ")])

  const anywhere = affected(
    ["backend/cli/test/fixture/fixture.ts", "bun.lock", "backend/cli/src/mystery/index.ts"],
    items,
  )
  expect(anywhere.global).toEqual([
    "backend/cli/test/fixture/fixture.ts",
    "bun.lock",
    "backend/cli/src/mystery/index.ts",
  ])
  expect(anywhere.groups.map((group) => group.paths)).toEqual([rootPaths.join(" ")])

  // test/global is a real directory, not the any-test sentinel.
  const global = affected(["backend/cli/src/global/data-dir.ts", "backend/cli/test/global/data-root.test.ts"], items)
  expect(global.groups).toHaveLength(1)
  expect(global.groups[0].paths.split(" ")).toContain("./test/global")
  expect(global.global).toEqual([])
  expect(global.seconds).toBe(weights.global + weights.root)

  // A test inside test/fixture selects the fixture entry; its helpers stay global.
  const fixture = affected(["backend/cli/test/fixture/spawn.test.ts"], items)
  expect(fixture.groups).toHaveLength(1)
  expect(fixture.groups[0].paths.split(" ")).toContain("./test/fixture")
  expect(fixture.global).toEqual([])
  expect(fixture.seconds).toBe(weights.fixture + weights.root)
})

test("owners cover release tooling, workflows, scripts, and aliased source areas", () => {
  expect(owner(".github/workflows/ci.yml")).toBe("installation")
  expect(owner("tooling/repo/test-shards.ts")).toBe("installation")
  expect(owner("tooling/launcher/bin/synsci.mjs")).toBe("installation")
  expect(owner("frontend/desktop/src/updater.mjs")).toBe("installation")
  expect(owner("install")).toBe("installation")
  expect(owner("installer.md")).toBeUndefined()
  expect(owner("backend/cli/script/build.ts")).toBe("installation")
  expect(owner("backend/cli/skills/x/SKILL.md")).toBe("skill")
  expect(owner("evals/launch/validate.ts")).toBe("eval")
  expect(owner("backend/cli/src/index.ts")).toBe("cli")
  expect(owner("backend/cli/src/pty/replay.ts")).toBe("root")
  expect(owner("backend/cli/src/bus/index.ts")).toBe("session")
  expect(owner("backend/cli/src/provider/anthropic.ts")).toBe("provider")
  expect(owner("backend/cli/test/compute/jobs.test.ts")).toBe("compute")
  expect(owner("backend/cli/test/bun.test.ts")).toBe("root")
  expect(owner("backend/cli/src/global/data-dir.ts")).toBe("global")
  expect(owner("backend/cli/test/global/data-dir.test.ts")).toBe("global")
  expect(owner("backend/cli/test/fixture/spawn.test.ts")).toBe("fixture")
  expect(owner("backend/cli/test/fixture/fixture.ts")).toBe(anyTest)
  expect(owner("backend/cli/test/fixture/lsp/fake-lsp-server.js")).toBe(anyTest)
  expect(owner("backend/cli/test/preload.ts")).toBe(anyTest)
  expect(owner("backend/cli/package.json")).toBe(anyTest)
  expect(owner("backend/cli/src/mystery/index.ts")).toBe(anyTest)
  expect(anyTest in weights).toBe(false)
})

test("the CLI prints the deep-ci matrix and the affected groups as JSON", async () => {
  const items = await entries()

  const matrix = await Bun.$`${process.execPath} ${tool}`.text()
  expect(JSON.parse(matrix)).toEqual(plan(items, 4))
  const wide = await Bun.$`${process.execPath} ${tool} --shards 6`.text()
  expect(JSON.parse(wide)).toEqual(plan(items, 6))

  const changed = "backend/cli/src/tool/bash.ts\nbackend/cli/src/project/instance.ts\n"
  const groups = await Bun.$`printf '%s' ${changed} | ${process.execPath} ${tool} affected`.text()
  expect(JSON.parse(groups)).toEqual(affected(changed.trim().split("\n"), items))
})

test("the CLI reports a bad plan on stderr, as a GitHub annotation on a runner, and exits non-zero", async () => {
  const { GITHUB_ACTIONS: _, ...env } = process.env
  const local = await Bun.$`${process.execPath} ${tool} --shards 0`.env(env).nothrow().quiet()
  const runner = await Bun.$`${process.execPath} ${tool} --shards 0`
    .env({ ...env, GITHUB_ACTIONS: "true" })
    .nothrow()
    .quiet()

  expect(local.exitCode).toBe(1)
  expect(local.stdout.toString()).toBe("")
  expect(local.stderr.toString()).toBe("--shards requires a positive integer\n")
  expect(runner.exitCode).toBe(1)
  expect(runner.stdout.toString()).toBe("")
  expect(runner.stderr.toString()).toBe("::error::--shards requires a positive integer\n")
})
