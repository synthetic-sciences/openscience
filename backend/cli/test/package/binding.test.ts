import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Environment } from "../../src/package/environment"
import { Installer } from "../../src/package/installer"
import { findPython } from "../../src/tool/notebook"
import { tmpdir } from "../fixture/fixture"

const python = Bun.which("python3")

const read = (relative: string) => Bun.file(new URL(relative, import.meta.url).pathname).text()

test.skipIf(!python)("a kernel bound to an environment runs that environment's interpreter", async () => {
  await using dir = await tmpdir()
  const env = path.join(dir.path, "env")
  await Installer.create(env, { kind: "venv", binary: python! })
  expect(fs.existsSync(Installer.interpreter(env))).toBe(true)
  expect((await findPython(undefined, env)).binary).toBe(Installer.interpreter(env))
})

test("an environment that does not exist falls back to the host interpreter", async () => {
  // Failing closed here would make a typo'd environment name look like a
  // broken machine — the exact failure mode this whole design started from,
  // where a missing pip, a severed network and a read-only site-packages all
  // surfaced as one opaque error.
  const resolved = await findPython(undefined, "/nonexistent/env")
  expect(resolved).not.toContain("/nonexistent/env")
})

test("no environment at all is the unchanged host lookup", async () => {
  expect(await findPython()).toBeString()
})

test("environment binding is not part of the kernel identity", async () => {
  const source = await read("../../src/science/kernel/registry.ts")
  const identity = source.slice(source.indexOf("export type KernelIdentity"), source.indexOf("type KernelCell"))
  // Adding it to the tuple would rekey every persisted record and orphan them.
  expect(identity.includes("environment")).toBe(false)
})

test("the binding is carried under a name that cannot collide with KernelEnvironment", async () => {
  const source = await read("../../src/science/kernel/registry.ts")
  // The entry already has an `environment` field of type KernelEnvironment —
  // the kernel's runtime context (cwd, sandbox platform), nothing to do with
  // packages. Merging the two would silently bind kernels to the wrong thing.
  expect(source.includes("boundEnvironment")).toBe(true)
})

test("changing the bound environment restarts the kernel rather than reusing it", async () => {
  const source = await read("../../src/science/kernel/registry.ts")
  // Staleness is compared at the registry level, because ExecutionAuthority's
  // signature carries no kernel identity and so cannot see this.
  expect(source.includes("value.boundEnvironment !== ")).toBe(true)
})

test("the notebook tool exposes environment beside kernel", async () => {
  const source = await read("../../src/tool/notebook.ts")
  expect(source.includes("environment: z")).toBe(true)
})

test("the R kernel tool exposes environment too", async () => {
  const source = await read("../../src/tool/rkernel.ts")
  expect(source.includes("environment: z")).toBe(true)
})

test("the derived directory is stable for a project and name", () => {
  expect(Environment.directory("p", "e")).toBe(Environment.directory("p", "e"))
})

// Everything above is structural. This runs a real kernel and asks it what it
// can import — the only assertion that can distinguish "the parameter is
// plumbed" from "the kernel actually runs in that environment".

async function context() {
  const { executionSession } = await import("../fixture/fixture")
  const session = await executionSession()
  return {
    sessionID: session.id,
    messageID: "",
    callID: "",
    agent: "research",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

const live = (await import("../../src/sandbox/sandbox")).Sandbox.backend() !== "none" && Boolean(python)

test.skipIf(!live)(
  "a package installed into one environment is importable there and absent elsewhere",
  async () => {
    const { Instance } = await import("../../src/project/instance")
    const { NotebookTool } = await import("../../src/tool/notebook")
    const { PackageTool } = await import("../../src/tool/package")
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const install = await PackageTool.init()
        await install.execute(
          { packages: ["tqdm"], environment: "bound", language: "python", source: false, wait: true },
          await context(),
        )

        const notebook = await NotebookTool.init()
        const inBound = await notebook.execute(
          {
            code: "import tqdm; print('BOUND', tqdm.__version__)",
            kernel: "k-bound",
            environment: "bound",
            timeout: 120_000,
          },
          await context(),
        )
        expect(inBound.metadata.output).toContain("BOUND")

        // A second REAL environment, created by installing something else into
        // it. Naming an environment that does not exist would not prove
        // isolation: findPython deliberately falls back to the host
        // interpreter, and the host may well have tqdm — measured, it does.
        await install.execute(
          { packages: ["six"], environment: "other", language: "python", source: false, wait: true },
          await context(),
        )
        const elsewhere = await notebook.execute(
          {
            code: [
              "import importlib.util as u",
              "print('TQDM', 'FOUND' if u.find_spec('tqdm') else 'ABSENT')",
              "print('SIX', 'FOUND' if u.find_spec('six') else 'ABSENT')",
            ].join("\n"),
            kernel: "k-other",
            environment: "other",
            timeout: 120_000,
          },
          await context(),
        )
        // If binding were cosmetic both kernels would see the same site-packages
        // and this would report TQDM FOUND — the exact false green a
        // plumbing-only test cannot rule out.
        expect(elsewhere.metadata.output).toContain("TQDM ABSENT")
        expect(elsewhere.metadata.output).toContain("SIX FOUND")
      },
    })
  },
  600_000,
)

test.skipIf(!live)(
  "an additive install keeps kernel state, a version change discards it",
  async () => {
    const { Instance } = await import("../../src/project/instance")
    const { NotebookTool } = await import("../../src/tool/notebook")
    const { PackageTool } = await import("../../src/tool/package")
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const install = await PackageTool.init()
        const notebook = await NotebookTool.init()
        // ONE context for every cell. A fresh session id is a different
        // KernelIdentity and therefore a different kernel, so re-deriving it
        // per cell would look exactly like a restart and make this test pass
        // for the wrong reason — measured: `marker` was undefined between two
        // consecutive cells with no install between them.
        const shared = await context()
        const cell = async (code: string) =>
          (await notebook.execute({ code, kernel: "k-restart", environment: "restart", timeout: 120_000 }, shared))
            .metadata.output

        await install.execute(
          { packages: ["six==1.16.0"], environment: "restart", language: "python", source: false, wait: true },
          shared,
        )
        await cell("marker = 'alive'")
        expect(await cell("print(marker)")).toContain("alive")

        // Additive: a package that was not there before. A live kernel stays
        // correct, because a new module imports on first use.
        const additive = await install.execute(
          { packages: ["tqdm"], environment: "restart", language: "python", source: false, wait: true },
          shared,
        )
        expect(additive.metadata.additive).toBe(true)
        expect(await cell("print(marker)")).toContain("alive")

        // Not additive: six changes version. The module already loaded into the
        // interpreter would stay at 1.16.0 in memory while the files on disk say
        // 1.17.0 — silently wrong, which is why this restarts.
        const changed = await install.execute(
          { packages: ["six==1.17.0"], environment: "restart", language: "python", source: false, wait: true },
          shared,
        )
        expect(changed.metadata.additive).toBe(false)
        expect(await cell("print(marker)")).toContain("NameError")
      },
    })
  },
  900_000,
)
