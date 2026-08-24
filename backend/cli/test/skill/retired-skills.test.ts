import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Install } from "../../src/skill/install/install"
import { RETIRED_ATLAS_SKILL_NAMES } from "../../src/skill/retired"

const originalDataDir = process.env.OPENSCIENCE_DATA_DIR

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.OPENSCIENCE_DATA_DIR
  else process.env.OPENSCIENCE_DATA_DIR = originalDataDir
})

test("retirement list covers the exact Atlas skill union published on npm", () => {
  expect([...RETIRED_ATLAS_SKILL_NAMES]).toEqual([
    "atlas",
    "atlas-auto",
    "atlas-auto-cli",
    "atlas-autoresearch",
    "atlas-cli",
    "atlas-frontier",
    "atlas-lab",
    "atlas-lookahead",
    "atlas-lookahead-cli",
    "atlas-loop",
    "atlas-map",
    "atlas-optimize",
    "atlas-paper",
    "atlas-plan",
    "atlas-prove",
    "atlas-prove-cli",
    "atlas-record",
    "atlas-reproduce",
    "atlas-reproduce-cli",
    "atlas-search",
    "atlas-survey",
    "atlas-survey-cli",
    "atlas-to-graph",
    "atlas-to-graph-cli",
    "atlas-tree",
    "atlas-tree-cli",
  ])
})

test("purges only exact retired skills from installed files and metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-skills-"))
  process.env.OPENSCIENCE_DATA_DIR = root
  const namespace = path.join(root, "installed-skills", "example")
  const skills = path.join(namespace, "skills")
  try {
    for (const name of [
      "atlas",
      "atlas-survey-cli",
      "initialize-atlas-graph",
      "initialize-research-graph",
      "initialize-research-graphs",
    ]) {
      await Bun.write(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`)
    }
    await Bun.write(
      path.join(namespace, ".openscience-install.json"),
      JSON.stringify({
        repo_url: "https://example.test/skills.git",
        pinned_sha: "a".repeat(40),
        installed_at: "2026-08-24T00:00:00.000Z",
        skills: [
          { name: "initialize-atlas-graph", description: "retired", verdict: "pass" },
          { name: "initialize-research-graph", description: "retired", verdict: "pass" },
          { name: "initialize-research-graphs", description: "kept", verdict: "pass" },
        ],
      }),
    )
    await Bun.write(
      path.join(namespace, "openscience-skills.json"),
      JSON.stringify({
        entries: ["initialize-atlas-graph", "initialize-research-graph", "initialize-research-graphs"],
      }),
    )

    expect(await Install.purgeRetired()).toBe(4)
    expect(await Bun.file(path.join(skills, "atlas", "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(skills, "atlas-survey-cli", "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(skills, "initialize-atlas-graph", "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(skills, "initialize-research-graph", "SKILL.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(skills, "initialize-research-graphs", "SKILL.md")).exists()).toBe(true)
    expect((await Bun.file(path.join(namespace, ".openscience-install.json")).json()).skills).toEqual([
      { name: "initialize-research-graphs", description: "kept", verdict: "pass" },
    ])
    expect((await Bun.file(path.join(namespace, "openscience-skills.json")).json()).entries).toEqual([
      "initialize-research-graphs",
    ])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("preserves malformed but parseable install metadata while purging", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-ledger-"))
  process.env.OPENSCIENCE_DATA_DIR = root
  const namespace = path.join(root, "installed-skills", "malformed")
  const ledgerPath = path.join(namespace, ".openscience-install.json")
  try {
    await Bun.write(ledgerPath, "{}\n")
    expect(await Install.purgeRetired()).toBe(0)
    expect(await Bun.file(ledgerPath).text()).toBe("{}\n")

    const metadata = { skills: [null, { description: "unknown" }, { name: "atlas" }] }
    await Bun.write(ledgerPath, JSON.stringify(metadata) + "\n")
    expect(await Install.purgeRetired()).toBe(0)
    expect((await Bun.file(ledgerPath).json()).skills).toEqual([null, { description: "unknown" }])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("legacy import skips retired product skills without fetching them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-import-"))
  process.env.OPENSCIENCE_DATA_DIR = root
  try {
    const imported = await Install.importLegacy(
      ["atlas", "atlas-tree-cli", "initialize-atlas-graph", "initialize-research-graph"].map((name) => ({
        namespace: "legacy",
        name,
        description: "retired",
        repo_url: "https://invalid.example/should-not-fetch.git",
        pinned_sha: "b".repeat(40),
        review_verdict: "pass",
      })),
    )
    expect(imported).toBe(0)
    expect(await Bun.file(path.join(root, "installed-skills", "legacy", ".openscience-install.json")).exists()).toBe(
      false,
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
