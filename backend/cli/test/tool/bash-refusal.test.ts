import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Refuse } from "../../src/package/refuse"
import { BashTool } from "../../src/tool/bash"
import type { PermissionNext } from "../../src/permission/next"
import { executionSession, tmpdir } from "../fixture/fixture"

async function context() {
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

/**
 * The tokenisation `bash.ts` performs, reproduced against the same parser it
 * uses, so this breaks if that tokenisation changes shape. No mock: it is the
 * real tree-sitter grammar, because the whole question this file answers is
 * whether a real shell line reaches the refusal — a hand-built string array
 * would assert nothing about that.
 */
async function commands(line: string) {
  const { Parser, Language } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "file" },
  })
  await Parser.init({ locateFile: () => treeWasm })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "file" },
  })
  const parser = new Parser()
  parser.setLanguage(await Language.load(bashWasm))
  const tree = parser.parse(line)!
  const out: string[][] = []
  for (const node of tree.rootNode.descendantsOfType("command")) {
    if (!node) continue
    const command: string[] = []
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      if (!["command_name", "word", "string", "raw_string", "concatenation"].includes(child.type)) continue
      command.push(child.text)
    }
    out.push(command)
  }
  return out
}

test("a real parse of the venv bypass reaches the refusal", async () => {
  // The exact line measured to succeed on feat/sandbox-network-policy, with no
  // tool and no approval card.
  const line = "python3 -m venv /w/venv && /w/venv/bin/pip install tqdm"
  const parsed = await commands(line)
  const refusals = parsed.map((c) => Refuse.installer(c)).filter(Boolean)
  expect(refusals).toHaveLength(1)
  expect(refusals[0]).toContain("package_install")
})

test("a compound command is refused on its installer clause, not its first clause", async () => {
  const parsed = await commands("cd /w && pip install numpy")
  expect(parsed.some((c) => Refuse.installer(c))).toBe(true)
})

test("ordinary shell work parses to no refusal", async () => {
  const parsed = await commands("python analysis.py && pip list")
  expect(parsed.every((c) => !Refuse.installer(c))).toBe(true)
})

test("an installer named only inside a quoted argument is not refused", async () => {
  // `echo` is the command; the rest are its operands. A regex over the raw
  // line would refuse this and be wrong.
  const parsed = await commands(`echo "pip install numpy"`)
  expect(parsed.every((c) => !Refuse.installer(c))).toBe(true)
})

// The tests above prove the matcher and the tokenisation. These prove the tool
// actually calls it — without them the refusal could be dead code and every
// other test in this file would still be green.

test("the real bash tool refuses an install and never runs it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const bash = await BashTool.init()
      const failure = await bash
        .execute({ command: "pip install tqdm", description: "Install tqdm" }, await context())
        .then(
          () => undefined,
          (error: Error) => error,
        )
      expect(failure?.message).toContain("package_install")
    },
  })
})

test("the refusal happens before the permission ask, not after", async () => {
  // Otherwise the user is asked to approve a command that is then refused
  // anyway — a prompt whose only possible outcome is an error.
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const bash = await BashTool.init()
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const ctx = {
        ...(await context()),
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute({ command: "pip install tqdm", description: "Install tqdm" }, ctx).catch(() => {})
      expect(requests).toHaveLength(0)
    },
  })
})

test("the real bash tool still runs an ordinary command", async () => {
  // The refusal must not have become a blanket denial.
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const bash = await BashTool.init()
      const result = await bash.execute({ command: "echo ok", description: "Echo" }, await context())
      expect(result.metadata.output).toContain("ok")
    },
  })
})

test("sandbox status never claims confinement on a machine with no backend", async () => {
  // Observed on Windows: "status enabled (agent shell commands are confined to
  // the workspace)" printed on a machine where Sandbox.backend() is "none" and
  // nothing confines anything. A false statement about a security property is
  // the worst thing this command can print, so the sentence now keys off
  // whether a backend EXISTS, not merely off the config being on.
  const source = await Bun.file(new URL("../../src/cli/cmd/sandbox.ts", import.meta.url).pathname).text()
  expect(source.includes("are NOT confined here: no backend on this platform")).toBe(true)
  // Three states, not two — the ternary must consider availability.
  expect(source.includes("d.available")).toBe(true)
})

test("nothing printed on a backend-less machine carries non-ASCII", async () => {
  // A Windows console decodes our UTF-8 as its OEM code page. An em dash in the
  // "unavailable" line arrived as mojibake in a real run. Everything reachable
  // WITHOUT a backend — which is exactly the Windows path — stays ASCII.
  const source = await Bun.file(new URL("../../src/cli/cmd/sandbox.ts", import.meta.url).pathname).text()
  const printed = source
    .split("\n")
    .filter((l) => l.includes("UI.println") || l.includes("TEXT_WARNING") || l.includes("TEXT_DANGER"))
    .filter((l) => !l.includes("c.skipped") && !l.trimStart().startsWith("//"))
    .join("\n")
  // eslint-disable-next-line no-control-regex
  expect(printed).not.toMatch(/[^\x00-\x7F]/)
})

test("sandbox status does not claim containment it has not verified", async () => {
  // It printed "are confined to the workspace" on a Windows run whose very next
  // command, `sandbox test`, failed containment. A backend being AVAILABLE is not
  // the same as it working, and status runs nothing that could tell the
  // difference, so it must report only what it knows.
  const source = await Bun.file(new URL("../../src/cli/cmd/sandbox.ts", import.meta.url).pathname).text()
  // Comments are not code: this asserts the flag is not USED, and the comment
  // explaining why it was removed must not trip it.
  const code = source
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
  expect(code).not.toContain('"are confined to the workspace"')
  expect(code).toContain("are launched through")
  expect(code).toContain("sandbox test")
  // And it must be PRINTED, not merely computed. `effect` was built with all
  // three states and then never interpolated, while the status line beside it
  // kept saying "are confined to approved paths" whenever the sandbox was
  // enabled — the two-state claim `effect` exists to replace. Every assertion
  // above passed the whole time, because they only proved the string was in the
  // file.
  expect(code).toContain("${effect}")
  expect(code).not.toContain('" are confined to approved paths"')
})

test("every option `sandbox enable` declares is actually read", () => {
  // `--allow-host` was declared, documented in `--help`, and read by nothing.
  // It parsed cleanly and the hosts never reached the config, so
  // `sandbox enable --network allowlist --allow-host files.pythonhosted.org`
  // reported success and was then followed by a blocked request to exactly that
  // host — the failure looks like the allowlist not working rather than like a
  // dropped flag.
  //
  // Generic on purpose: the next option added gets this for free, which is the
  // only reason a test this shape is worth having over one assertion.
  const source = require("fs").readFileSync(
    new URL("../../src/cli/cmd/sandbox.ts", import.meta.url).pathname,
    "utf8",
  ) as string
  const enable = source.slice(source.indexOf("const EnableCommand"), source.indexOf("const DisableCommand"))
  const declared = [...enable.matchAll(/\.option\("([^"]+)"/g)].map((m) => m[1]!)
  expect(declared).toContain("allow-host")
  const handler = enable.slice(enable.indexOf("handler:"))
  for (const option of declared) {
    // Either bracket access (`args["allow-host"]`) or dotted (`args.allow`).
    const used = handler.includes(`args["${option}"]`) || new RegExp(`args\\.${option}\\b`).test(handler)
    expect(used, `sandbox enable declares --${option} but never reads it`).toBe(true)
  }
})
