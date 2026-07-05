import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { $ } from "bun"
import { fetchManifest } from "../fetcher"

let fixtureRepo: string

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openscience-fixture-"))
  await mkdir(path.join(dir, "skills/brainstorming"), { recursive: true })
  await mkdir(path.join(dir, "skills/debugging"), { recursive: true })
  await writeFile(
    path.join(dir, "skills/brainstorming/SKILL.md"),
    `---
name: brainstorming
description: Use before creative work.
---

# Brainstorming
body`,
  )
  await writeFile(
    path.join(dir, "skills/debugging/SKILL.md"),
    `---
name: debugging
description: Run when investigating failures.
---

# Debugging
body`,
  )
  await $`git init -q`.cwd(dir).quiet()
  await $`git add -A`.cwd(dir).quiet()
  await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(dir).quiet()
  return dir
}

beforeAll(async () => {
  fixtureRepo = await makeFixture()
})
afterAll(async () => {
  await rm(fixtureRepo, { recursive: true, force: true })
})

describe("fetchManifest", () => {
  it("enumerates SKILL.md files from a local git repo", async () => {
    const result = await fetchManifest({
      kind: "git",
      host: "local",
      owner: "t",
      repo: "fixture",
      ref: null,
      path: null,
      namespace: "fixture",
      cloneUrl: fixtureRepo,
    })
    try {
      expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/)
      const sorted = [...result.manifest].sort((a, b) => a.name.localeCompare(b.name))
      expect(sorted.map((s) => s.name)).toEqual(["brainstorming", "debugging"])
      expect(sorted[0].content).toContain("name: brainstorming")
      expect(sorted[0].namespace).toBe("fixture")
      // No manifest in this fixture → entries is null (all skills are entries)
      expect(result.entries).toBeNull()
    } finally {
      await rm(result.tmpDir, { recursive: true, force: true })
    }
  })

  it("reads openscience-skills.json entries from repo root when present", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openscience-manifest-"))
    await mkdir(path.join(dir, "skills/public-skill"), { recursive: true })
    await mkdir(path.join(dir, "skills/helper-skill"), { recursive: true })
    await writeFile(
      path.join(dir, "skills/public-skill/SKILL.md"),
      "---\nname: public-skill\ndescription: visible\n---\n# x",
    )
    await writeFile(
      path.join(dir, "skills/helper-skill/SKILL.md"),
      "---\nname: helper-skill\ndescription: internal\n---\n# y",
    )
    await writeFile(path.join(dir, "openscience-skills.json"), JSON.stringify({ entries: ["public-skill"] }))
    await $`git init -q`.cwd(dir).quiet()
    await $`git add -A`.cwd(dir).quiet()
    await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(dir).quiet()

    try {
      const result = await fetchManifest({
        kind: "git",
        host: "local",
        owner: "t",
        repo: "manifest",
        ref: null,
        path: null,
        namespace: "manifest",
        cloneUrl: dir,
      })
      expect(result.entries).toEqual(["public-skill"])
      await rm(result.tmpDir, { recursive: true, force: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects when no skills/**/SKILL.md found", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "openscience-empty-"))
    await $`git init -q`.cwd(empty).quiet()
    await writeFile(path.join(empty, "README.md"), "no skills")
    await $`git add -A`.cwd(empty).quiet()
    await $`git -c user.email=t@t -c user.name=t commit -q -m x`.cwd(empty).quiet()
    try {
      await expect(
        fetchManifest({
          kind: "git",
          host: "local",
          owner: "t",
          repo: "empty",
          ref: null,
          path: null,
          namespace: "empty",
          cloneUrl: empty,
        }),
      ).rejects.toThrow(/no skills found/i)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
