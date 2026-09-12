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

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-skills-bundle-"))
  const source = path.join(tmp, "source")
  const cache = path.join(tmp, "cache")
  const archive = path.join(tmp, "skills.tar.gz")
  await fs.mkdir(path.join(source, "research", "example"), { recursive: true })
  await Bun.write(
    path.join(source, "research", "example", "SKILL.md"),
    "---\nname: example\ndescription: offline example\n---\n\n# Example\n",
  )
  const digest = await directoryDigest(source)
  await Bun.Archive.write(
    archive,
    { "research/example/SKILL.md": await Bun.file(path.join(source, "research", "example", "SKILL.md")).bytes() },
    { compress: "gzip" },
  )
  return { tmp, cache, archive, digest }
}

test("a burst of instances shares one extraction instead of racing the rename", async () => {
  const { tmp, cache, archive, digest } = await fixture()
  try {
    const input = { archive, digest, files: 1, skills: 1, cache }
    const roots = await Promise.all(Array.from({ length: 6 }, () => BundledSkills.materialize(input)))
    expect(new Set(roots).size).toBe(1)
    // No abandoned temporary extraction directories remain beside the bundle.
    expect((await fs.readdir(cache)).filter((name) => name.startsWith("."))).toEqual([])
    expect(await Bun.file(path.join(roots[0]!, "research", "example", "SKILL.md")).text()).toContain("offline example")
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test("two processes installing the same bundle both succeed on one root", async () => {
  const { tmp, cache, archive, digest } = await fixture()
  try {
    const script = `
      import { BundledSkills } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/skill/bundled.ts"))}
      const root = await BundledSkills.materialize(${JSON.stringify({ archive, digest, files: 1, skills: 1, cache })})
      console.log(root)
    `
    const runs = Array.from({ length: 3 }, () =>
      Bun.spawn(["bun", "-e", script], { cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" }),
    )
    const results = await Promise.all(
      runs.map(async (run) => ({
        code: await run.exited,
        out: (await new Response(run.stdout).text()).trim(),
        err: await new Response(run.stderr).text(),
      })),
    )
    for (const result of results) expect(result.err.includes("ENOTEMPTY") || result.code !== 0).toBe(false)
    expect(new Set(results.map((result) => result.out)).size).toBe(1)
    expect(results[0]!.out).toBe(path.join(cache, digest))
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
