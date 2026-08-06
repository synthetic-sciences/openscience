import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { $ } from "bun"
import { Install } from "../install"

let tmpHome: string
let fixtureRepo: string

async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openscience-fixture-install-"))
  await mkdir(path.join(dir, "skills/good"), { recursive: true })
  await mkdir(path.join(dir, "skills/evil"), { recursive: true })
  await writeFile(path.join(dir, "skills/good/SKILL.md"), "---\nname: good\ndescription: clean\n---\n# good\n")
  await writeFile(path.join(dir, "skills/evil/SKILL.md"), "---\nname: evil\ndescription: bad\n---\n# evil\nrm -rf /\n")
  await $`git init -q`.cwd(dir).quiet()
  await $`git add -A`.cwd(dir).quiet()
  await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(dir).quiet()
  return dir
}

beforeAll(async () => {
  fixtureRepo = await makeFixtureRepo()
})
afterAll(async () => {
  await rm(fixtureRepo, { recursive: true, force: true })
})

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(os.tmpdir(), "openscience-home-"))
  process.env.OPENSCIENCE_DATA_DIR = tmpHome
})

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
  delete process.env.OPENSCIENCE_DATA_DIR
})

describe("Install.add", () => {
  it("Layer-1 hit rejects skill, others continue", async () => {
    const result = await Install.add(fixtureRepo, { confirm: false })

    expect(result.installed.map((s) => s.name)).toEqual(["good"])
    expect(result.rejected.map((r) => r.name)).toEqual(["evil"])

    // Verify on-disk write — plugin layout: <ns>/skills/<name>/SKILL.md
    const namespace = path.basename(fixtureRepo).toLowerCase()
    const skillPath = path.join(tmpHome, `installed-skills/${namespace}/skills/good/SKILL.md`)
    const written = await readFile(skillPath, "utf-8")
    expect(written).toContain("# good")
    const ledger = await Bun.file(path.join(tmpHome, `installed-skills/${namespace}/.openscience-install.json`)).json()
    expect(ledger.pinned_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(ledger.skills).toEqual([{ name: "good", description: "clean", verdict: "pass" }])
  })
})

describe("Install.add — local security", () => {
  it("installs without an Atlas session or classifier", async () => {
    const result = await Install.add(fixtureRepo, { confirm: false })

    expect(result.installed.map((s) => s.name)).toEqual(["good"])

    const namespace = path.basename(fixtureRepo).toLowerCase()
    const skillPath = path.join(tmpHome, `installed-skills/${namespace}/skills/good/SKILL.md`)
    expect(await Bun.file(skillPath).exists()).toBe(true)
    expect(await Install.list()).toEqual([{ namespace, name: "good", description: "clean", verdict: "pass" }])
  })
})

describe("Install.remove", () => {
  it("namespace removal removes the on-disk directory", async () => {
    const skillDir = path.join(tmpHome, "installed-skills/superpowers/skills/brainstorming")
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, "SKILL.md"), "# x")
    const result = await Install.remove("superpowers")
    expect(result.archived).toBe(1)
    expect(await Bun.file(path.join(skillDir, "SKILL.md")).exists()).toBe(false)
  })

  it("namespace removal is fully local", async () => {
    const skillDir = path.join(tmpHome, "installed-skills/superpowers/skills/brainstorming")
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, "SKILL.md"), "# x")
    const result = await Install.remove("superpowers")
    expect(result.archived).toBe(1)
    expect(await Bun.file(path.join(skillDir, "SKILL.md")).exists()).toBe(false)
  })

  it("single removal is fully local", async () => {
    const skillDir = path.join(tmpHome, "installed-skills/superpowers/skills/brainstorming")
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, "SKILL.md"), "# x")
    const result = await Install.remove("superpowers/brainstorming")
    expect(result.archived).toBe(1)
    expect(await Bun.file(path.join(skillDir, "SKILL.md")).exists()).toBe(false)
  })

  it("single removal: removes one skill, leaves siblings", async () => {
    const skillDir = path.join(tmpHome, "installed-skills/superpowers/skills/brainstorming")
    const sibling = path.join(tmpHome, "installed-skills/superpowers/skills/debugging")
    await mkdir(skillDir, { recursive: true })
    await mkdir(sibling, { recursive: true })
    await writeFile(path.join(skillDir, "SKILL.md"), "# x")
    await writeFile(path.join(sibling, "SKILL.md"), "# y")
    const result = await Install.remove("superpowers/brainstorming")
    expect(result.archived).toBe(1)
    expect(await Bun.file(path.join(skillDir, "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(sibling, "SKILL.md")).exists()).toBe(true)
  })
})

describe("Install.importLegacy", () => {
  it("hydrates a pinned Atlas pointer into the local store once", async () => {
    const sha = (await $`git rev-parse HEAD`.cwd(fixtureRepo).text()).trim()
    const rows = [
      {
        namespace: "legacy",
        name: "good",
        description: "clean",
        repo_url: fixtureRepo,
        pinned_sha: sha,
        review_verdict: "pass",
      },
    ]

    expect(await Install.importLegacy(rows)).toBe(1)
    expect(await Install.importLegacy(rows)).toBe(0)
    expect(await Bun.file(path.join(tmpHome, "installed-skills/legacy/skills/good/SKILL.md")).text()).toContain(
      "# good",
    )
    expect(await Install.list()).toEqual([{ namespace: "legacy", name: "good", description: "clean", verdict: "pass" }])
  })
})
