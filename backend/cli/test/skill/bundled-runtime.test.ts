import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertNoRetiredProductSkills, directoryDigest } from "../../src/skill/bundle-format"
import { BundledSkills } from "../../src/skill/bundled"

test("materializes and verifies the complete bundled skill archive offline", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-skills-bundle-"))
  const source = path.join(tmp, "source")
  const cache = path.join(tmp, "cache")
  const archive = path.join(tmp, "skills.tar.gz")
  try {
    await fs.mkdir(path.join(source, "research", "example", "scripts"), { recursive: true })
    await fs.mkdir(path.join(source, "research", "example", "references"), { recursive: true })
    await Promise.all([
      Bun.write(
        path.join(source, "research", "example", "SKILL.md"),
        "---\nname: example\ndescription: offline example\n---\n\n# Example\n",
      ),
      Bun.write(path.join(source, "research", "example", "scripts", "run.py"), "print('ok')\n"),
      Bun.write(path.join(source, "research", "example", "references", ".env.example"), "TOKEN=\n"),
    ])
    const digest = await directoryDigest(source)
    const skill = await Bun.file(path.join(source, "research", "example", "SKILL.md")).bytes()
    const script = await Bun.file(path.join(source, "research", "example", "scripts", "run.py")).bytes()
    const hidden = await Bun.file(path.join(source, "research", "example", "references", ".env.example")).bytes()
    await Bun.Archive.write(
      archive,
      {
        "research/example/SKILL.md": skill,
        "research/example/scripts/run.py": script,
        "research/example/references/.env.example": hidden,
      },
      { compress: "gzip" },
    )

    const root = await BundledSkills.materialize({ archive, digest, files: 3, skills: 1, cache })
    expect(await Bun.file(path.join(root, "research", "example", "SKILL.md")).text()).toContain("offline example")
    expect(await Bun.file(path.join(root, "research", "example", "references", ".env.example")).text()).toBe("TOKEN=\n")
    expect(await BundledSkills.materialize({ archive, digest, files: 3, skills: 1, cache })).toBe(root)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test("rejects retired Atlas and graph skills before archive generation", () => {
  for (const name of [
    "atlas",
    "atlas-lab",
    "atlas-survey-cli",
    "initialize-atlas-graph",
    "initialize-research-graph",
  ]) {
    expect(() =>
      assertNoRetiredProductSkills([
        {
          path: `research/${name}/SKILL.md`,
          bytes: new TextEncoder().encode(`---\nname: ${name}\ndescription: retired\n---\n`),
        },
      ]),
    ).toThrow(`Retired product skill ${name}`)
  }
  expect(() =>
    assertNoRetiredProductSkills([
      {
        path: "biology/human-protein-atlas/SKILL.md",
        bytes: new TextEncoder().encode(
          "---\nname: human-protein-atlas\ndescription: Query the Human Protein Atlas.\n---\n",
        ),
      },
    ]),
  ).not.toThrow()
})
