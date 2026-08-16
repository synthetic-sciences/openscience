import { expect, test } from "bun:test"
import { Environment } from "../../src/package/environment"
import { Requirement } from "../../src/package/requirement"
import type { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Sandbox } from "../../src/sandbox/sandbox"
import { executionSession, tmpdir } from "../fixture/fixture"

const read = (relative: string) => Bun.file(new URL(relative, import.meta.url).pathname).text()

test("the approval pattern is the canonical command string the card shows", () => {
  // The card and the permission matcher must use the ONE string. If they ever
  // diverge, the user approves one thing and another runs.
  expect(Requirement.pattern({ packages: ["numpy", "pandas"], environment: "default", index: "pypi.org/simple" })).toBe(
    "install numpy pandas → default [pypi.org/simple]",
  )
})

test("the tool asks with the package_install capability and the install* grant", async () => {
  const source = await read("../../src/tool/package.ts")
  // Pinned as constants because the spec pins them: the capability was
  // reserved in trust.ts and execution.ts with zero call sites, and the
  // standing grant mirrors notebook.ts, which shows "python (notebook)" and
  // stores the broad "python*".
  expect(source.includes('permission: "package_install"')).toBe(true)
  expect(source.includes('always: ["install*"]')).toBe(true)
})

test("the card is asked for before anything is installed", async () => {
  const source = await read("../../src/tool/package.ts")
  // Approval precedes the lock and the installer, not the other way round.
  expect(source.indexOf("ctx.ask")).toBeGreaterThan(-1)
  expect(source.indexOf("ctx.ask")).toBeLessThan(source.indexOf("Installer.install"))
})

test("resolution happens after approval, so the card shows the request", async () => {
  const source = await read("../../src/tool/package.ts")
  // Approving 2 names must not silently approve the 168-entry closure.
  expect(source.indexOf("ctx.ask")).toBeLessThan(source.indexOf("Installer.freeze"))
})

test("the tool is registered", async () => {
  const source = await read("../../src/tool/registry.ts")
  expect(source.includes("PackageTool")).toBe(true)
})

test("installs are not a paid action, so no spendFilter entry exists", async () => {
  const source = await read("../../src/permission/next.ts")
  // Governing principle: nothing is gated more strictly than arbitrary code
  // execution unless it costs money. An install costs nothing.
  expect(source.includes("package_install")).toBe(false)
})

test("the tool exists and declares its parameters", async () => {
  const { PackageTool } = await import("../../src/tool/package")
  expect(PackageTool.id).toBe("package_install")
})

// Everything above reads the source. These run the tool. Source assertions
// cannot tell whether the card actually fires, and the card is the entire
// point of this task.

async function context() {
  const session = await executionSession()
  const asks: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
  return {
    asks,
    ctx: {
      sessionID: session.id,
      messageID: "",
      callID: "",
      agent: "research",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => {},
      ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
        asks.push(req)
      },
    },
  }
}

const python = Bun.which("python3")
const live = Sandbox.backend() !== "none" && Boolean(python)

test.skipIf(!live)(
  "installing asks for approval with the canonical pattern, then lands the package",
  async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { PackageTool } = await import("../../src/tool/package")
        const tool = await PackageTool.init()
        const { asks, ctx } = await context()
        const result = await tool.execute(
          { packages: ["tqdm"], environment: "t1", language: "python" as const, source: false, wait: true },
          ctx,
        )

        expect(asks).toHaveLength(1)
        expect(asks[0]!.permission).toBe("package_install")
        expect(asks[0]!.patterns).toEqual(["install tqdm → t1 [pypi.org/simple]"])
        expect(asks[0]!.always).toEqual(["install*"])

        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.versions["tqdm"]).toMatch(/^\d/)
        // A first install into an empty environment is additive by definition.
        expect(result.metadata.additive).toBe(true)

        // The manifest records the request, not the closure.
        const stored = await Environment.read(Instance.project.id, "t1")
        expect(stored?.requested).toEqual(["tqdm"])
        expect(stored!.total).toBeGreaterThan(0)
      },
    })
  },
  300_000,
)

test.skipIf(!live)(
  "a fully-satisfied request installs nothing and never shows a card",
  async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { PackageTool } = await import("../../src/tool/package")
        const tool = await PackageTool.init()
        const first = await context()
        await tool.execute(
          { packages: ["tqdm"], environment: "t2", language: "python" as const, source: false, wait: true },
          first.ctx,
        )

        const second = await context()
        const result = await tool.execute(
          { packages: ["tqdm"], environment: "t2", language: "python" as const, source: false, wait: true },
          second.ctx,
        )
        // Nothing privileged happens, so nothing needs approving — and a
        // fully-satisfied request is not worth a turn.
        expect(second.asks).toHaveLength(0)
        expect(result.metadata.installed).toBe(false)
      },
    })
  },
  300_000,
)

test.skipIf(!live)(
  "a pinned version is never treated as already satisfied by a different one",
  async () => {
    // Regression. The skip check compared package NAMES only, so
    // `six==1.17.0` against an installed 1.16.0 returned "already installed",
    // skipped the install, and reported the change as additive — leaving the
    // environment on the old version while telling the agent it had the new
    // one, and leaving bound kernels un-restarted.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { PackageTool } = await import("../../src/tool/package")
        const tool = await PackageTool.init()
        await tool.execute(
          { packages: ["six==1.16.0"], environment: "pin", language: "python", source: false, wait: true },
          (await context()).ctx,
        )
        const upgrade = await context()
        const result = await tool.execute(
          { packages: ["six==1.17.0"], environment: "pin", language: "python", source: false, wait: true },
          upgrade.ctx,
        )
        // It really ran, it really asked, and it knows the change was not additive.
        expect(upgrade.asks).toHaveLength(1)
        expect(result.metadata.installed).toBe(true)
        expect(result.metadata.additive).toBe(false)
        expect(result.metadata.versions["six"]).toBe("1.17.0")
      },
    })
  },
  600_000,
)

test.skipIf(!live)(
  "a failed install throws the translated cause and writes no manifest",
  async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { PackageTool } = await import("../../src/tool/package")
        const tool = await PackageTool.init()
        const { ctx } = await context()
        const failure = await tool
          .execute(
            {
              packages: ["this-package-does-not-exist-anywhere-xyzzy"],
              environment: "t3",
              language: "python" as const,
              source: false,
              wait: true,
            },
            ctx,
          )
          .then(
            () => undefined,
            (error: Error) => error,
          )
        expect(failure).toBeDefined()
        // Nothing landed, so nothing is recorded as landed.
        expect(await Environment.read(Instance.project.id, "t3")).toBeUndefined()
      },
    })
  },
  300_000,
)
