import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertNoRetiredProductSkills, bundleDigest, directoryDigest } from "../../src/skill/bundle-format"
import { BundledSkills } from "../../src/skill/bundled"

async function raceFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-skills-race-"))
  const entries = [
    {
      path: "research/example/SKILL.md",
      bytes: new TextEncoder().encode("---\nname: example\ndescription: test\n---\n"),
    },
    ...Array.from({ length: 64 }, (_, index) => ({
      path: `research/example/references/${index}.txt`,
      bytes: new TextEncoder().encode(`reference ${index}\n`.repeat(100)),
    })),
  ]
  const archive = path.join(tmp, "skills.tar.gz")
  await Bun.Archive.write(archive, Object.fromEntries(entries.map((entry) => [entry.path, entry.bytes])), {
    compress: "gzip",
  })
  return {
    tmp,
    input: { archive, digest: bundleDigest(entries), files: entries.length, skills: 1, cache: path.join(tmp, "cache") },
    async [Symbol.asyncDispose]() {
      await fs.rm(tmp, { recursive: true, force: true })
    },
  }
}

test("concurrent initializers share one complete bundle without deleting each other's staging files", async () => {
  await using bundle = await raceFixture()
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => BundledSkills.materialize(bundle.input)))
  expect(results.filter((result) => result.status === "rejected")).toEqual([])
  const roots = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
  expect(new Set(roots).size).toBe(1)
  expect(await directoryDigest(roots[0])).toBe(bundle.input.digest)
  expect(await fs.readdir(bundle.input.cache)).toEqual([bundle.input.digest])
})

test("separate processes can initialize the same bundled skill cache", async () => {
  await using bundle = await raceFixture()
  const start = path.join(bundle.tmp, "start")
  const module = new URL("../../src/skill/bundled.ts", import.meta.url).href
  const workers = Array.from({ length: 4 }, (_, index) => {
    const ready = path.join(bundle.tmp, `ready-${index}`)
    const script = `
      import { BundledSkills } from ${JSON.stringify(module)};
      await Bun.write(${JSON.stringify(ready)}, "ready");
      const deadline = Date.now() + 10_000;
      while (!(await Bun.file(${JSON.stringify(start)}).exists())) {
        if (Date.now() > deadline) throw new Error("Fixture start timed out");
        await Bun.sleep(5);
      }
      console.log(await BundledSkills.materialize(${JSON.stringify(bundle.input)}));
    `
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
    return {
      ready,
      result: Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
    }
  })
  const deadline = Date.now() + 10_000
  while (!(await Promise.all(workers.map((worker) => Bun.file(worker.ready).exists()))).every(Boolean)) {
    if (Date.now() > deadline) break
    await Bun.sleep(5)
  }
  await Bun.write(start, "start")
  const results = await Promise.all(workers.map((worker) => worker.result))
  expect(results.filter(([code]) => code !== 0)).toEqual([])
  expect(new Set(results.map(([, stdout]) => stdout.trim())).size).toBe(1)
  expect(await directoryDigest(path.join(bundle.input.cache, bundle.input.digest))).toBe(bundle.input.digest)
  expect(await fs.readdir(bundle.input.cache)).toEqual([bundle.input.digest])
})

test("failed extraction is cleaned up and an incomplete cache can be repaired", async () => {
  await using bundle = await raceFixture()
  const broken = path.join(bundle.tmp, "broken.tar.gz")
  await Bun.write(broken, "invalid archive")
  await expect(BundledSkills.materialize({ ...bundle.input, archive: broken })).rejects.toThrow()
  expect(await fs.readdir(bundle.input.cache)).toEqual([])
  await Bun.write(path.join(bundle.input.cache, bundle.input.digest, "incomplete.txt"), "interrupted extraction")
  const root = await BundledSkills.materialize(bundle.input)
  expect(await directoryDigest(root)).toBe(bundle.input.digest)
  expect(await Bun.file(path.join(root, "incomplete.txt")).exists()).toBe(false)
})

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
