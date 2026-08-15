import { expect, test } from "bun:test"
import { PackagePrompt } from "../../src/package/prompt"
import { SystemPrompt } from "../../src/session/system"

test("packages() returns the capability block, shaped like compute()", async () => {
  const block = await SystemPrompt.packages("proj_empty_for_shape")
  expect(block).toHaveLength(1)
  expect(block[0]).toContain("<package-capability>")
  expect(block[0]).toContain("</package-capability>")
})

test("an empty inventory tells the agent the first install creates one", () => {
  const rendered = PackagePrompt.render({ environments: [] })
  expect(rendered).toContain("No environments exist yet")
})

test("an inventory lists requested packages only, with a dependency count", () => {
  const rendered = PackagePrompt.render({
    environments: [{ name: "default", language: "python", requested: ["numpy", "pandas"], total: 168, busy: false }],
  })
  expect(rendered).toContain("default (python): numpy, pandas (+166 deps)")
  // The resolved closure is dominated by libgcc/harfbuzz/qt6-main and would
  // bury the contract in font libraries.
  expect(rendered).not.toContain("libgcc")
})

test("a busy environment is flagged so the agent does not execute into it", () => {
  const rendered = PackagePrompt.render({
    environments: [{ name: "default", language: "python", requested: [], total: 0, busy: true }],
  })
  expect(rendered).toContain("INSTALL IN PROGRESS")
})

test("the contract promises refusal, not a missing network", () => {
  const rendered = PackagePrompt.render({ environments: [] })
  // The old wording said "the agent shell has no network", which the allowlist
  // proxy made false — and it implied the venv-in-workspace route was
  // impossible when it is exactly what works.
  expect(rendered).not.toContain("no network")
  expect(rendered).toContain("refused")
  expect(rendered).toContain("virtualenv you create yourself")
})

test("the inventory reflects a real written environment", async () => {
  const { Environment } = await import("../../src/package/environment")
  const project = "proj_inventory"
  await Environment.write(project, {
    name: "torch",
    language: "python",
    requested: ["torch"],
    installed: { torch: "2.4.0", filelock: "3.15.4" },
    total: 2,
    createdAt: 1,
    updatedAt: 1,
  })
  const rendered = await PackagePrompt.system(project)
  expect(rendered).toContain("torch (python): torch (+1 deps)")
})

test("a busy environment is reported from the live lock, not a stored flag", async () => {
  const { Environment } = await import("../../src/package/environment")
  const project = "proj_busy"
  await Environment.write(project, {
    name: "held",
    language: "python",
    requested: [],
    installed: {},
    total: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  let rendered = ""
  await Environment.lock(project, "held", async () => {
    rendered = await PackagePrompt.system(project)
  })
  // A stored flag would survive a crash and permanently mark a healthy
  // environment busy. The lock lives in memory and is the truth.
  expect(rendered).toContain("INSTALL IN PROGRESS")
  expect(await PackagePrompt.system(project)).not.toContain("INSTALL IN PROGRESS")
})

test("an unknown project renders the empty inventory rather than throwing", async () => {
  expect(await PackagePrompt.system("proj_never_seen")).toContain("No environments exist yet")
})

test("after a real install, the agent's contract lists what it installed", async () => {
  // The whole point of this task. Before it, `system()` read a global
  // environments.json that nothing wrote, so the agent was told "No
  // environments exist yet" forever — including immediately after installing
  // something — which makes the contract's first rule ("answer whether a
  // package is available from the inventory above") actively misleading.
  const { Sandbox } = await import("../../src/sandbox/sandbox")
  if (Sandbox.backend() === "none" || !Bun.which("python3")) return
  const { Instance } = await import("../../src/project/instance")
  const { PackageTool } = await import("../../src/tool/package")
  const { executionSession, tmpdir } = await import("../fixture/fixture")
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await PackageTool.init()
      const before = await PackagePrompt.system(Instance.project.id)
      expect(before).toContain("No environments exist yet")

      await tool.execute({ packages: ["tqdm"], environment: "seen", language: "python", source: false, wait: true }, {
        sessionID: session.id,
        messageID: "",
        callID: "",
        agent: "research",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } as never)

      const after = await PackagePrompt.system(Instance.project.id)
      expect(after).not.toContain("No environments exist yet")
      expect(after).toContain("seen (python): tqdm")
    },
  })
}, 600_000)

test("the injection is unconditional, beside compute()", async () => {
  // The load-bearing mechanism is that this reaches EVERY request for EVERY
  // agent — not a skill override, which only reaches a skill's front page and
  // never its reference files or a third-party skill cloned from GitHub.
  const source = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url).pathname).text()
  // A boolean, not toContain(source): a failing toContain prints the whole
  // 86KB file into the runner output and buries every other result.
  expect(source.includes("await SystemPrompt.packages()")).toBe(true)
})

test("the agent is told uv is preferred, and what the Windows remedy actually is", async () => {
  // The agent's advice was wrong in a real session. Hitting the ungrantable
  // base interpreter, it told the user to get "an admin granting the
  // OpenScience sandbox read/execute permission on C:\Python312" — which cannot
  // work: icacls only changes an ACL you own, and an all-users install is owned
  // by SYSTEM. The remedy is a Python the user owns, not more permissions on one
  // they do not.
  //
  // probe() has always preferred uv over venv; the agent simply had no way to
  // know, so it could not name the right fix.
  const guidance = await Bun.file(new URL("../../src/package/prompt.ts", import.meta.url).pathname).text()
  expect(guidance).toContain("Environments are built with uv when it is present")
  expect(guidance).toContain("a Python the user owns")
  expect(guidance).toContain("not elevated permissions")

  const tool = await Bun.file(new URL("../../src/tool/package.ts", import.meta.url).pathname).text()
  expect(tool).toContain("can only be granted read access to paths the user owns")

  // And the Windows-specific half is GATED. bubblewrap and seatbelt read
  // anything the user can read, so this consideration is meaningless there — and
  // a tool description ships on every request, so unconditional platform trivia
  // is a cost every Linux and macOS user pays forever for advice they can never
  // act on.
  for (const text of [guidance, tool]) {
    const at = text.indexOf("a Python the user owns") >= 0 ? text.indexOf("a Python the user owns") : text.indexOf("C:")
    expect(text.slice(0, at)).toContain('process.platform === "win32"')
  }
})
