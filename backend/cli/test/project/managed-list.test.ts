import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const managedModule = new URL("../../src/project/managed.ts", import.meta.url).href
const projectModule = new URL("../../src/project/project.ts", import.meta.url).href
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("managed project listing", () => {
  test("returns OpenScience-owned workspaces without arbitrary resolved directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-managed-list-"))
    roots.push(root)
    const script = path.join(root, "verify.ts")
    await Bun.write(
      script,
      [
        `import { ManagedProject } from ${JSON.stringify(managedModule)}`,
        `import { Project } from ${JSON.stringify(projectModule)}`,
        'import fs from "node:fs/promises"',
        'import path from "node:path"',
        'const unrelatedRoot = path.join(process.env.OPENSCIENCE_TEST_HOME, "unrelated")',
        "await fs.mkdir(unrelatedRoot, { recursive: true })",
        'const owned = await ManagedProject.create("Owned study")',
        "const unrelated = (await Project.fromDirectory(unrelatedRoot)).project",
        "const listed = await ManagedProject.list()",
        'if (!listed.some((project) => project.id === owned.id && project.origin === "openscience")) throw new Error("owned project missing")',
        'if (listed.some((project) => project.id === unrelated.id)) throw new Error("unrelated directory leaked into Home")',
        'if (!(await Project.list()).some((project) => project.id === unrelated.id)) throw new Error("generic project resolution was unexpectedly removed")',
      ].join("\n"),
    )
    const proc = Bun.spawn([process.execPath, script], {
      cwd: root,
      env: {
        ...process.env,
        OPENSCIENCE_TEST_HOME: path.join(root, "home"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    if (exit !== 0) throw new Error(stderr || stdout || `managed project verifier exited ${exit}`)
    expect(exit).toBe(0)
  })
})
