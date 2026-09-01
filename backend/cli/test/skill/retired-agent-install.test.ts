import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { purgeRetiredAtlasAgentInstall } from "../../src/skill/retired-install"

const BEGIN = "<!-- BEGIN atlas-skills (managed by `atlas install`) -->"
const END = "<!-- END atlas-skills -->"

function adapter(brand: "Atlas" | "Gateway" = "Gateway", intro?: string) {
  return `# ${brand} skills

${intro ? `${intro}\n\n` : ""}${brand} is the research-map CLI from Synthetic Sciences. The skills below
tell you when to use which ${brand} command.

\`\`\`bash
atlas help --format=json
atlas help <command> --schema --format=json
\`\`\`

---

## atlas

Generated Atlas instructions.

---

`
}

const adapterPrefixes = (["Atlas", "Gateway"] as const).map((brand) => {
  const bytes = new TextEncoder().encode(adapter(brand))
  return [bytes.byteLength, new Bun.CryptoHasher("sha256").update(bytes).digest("hex")] as const
})

function purge(root: string) {
  return purgeRetiredAtlasAgentInstall(root, { adapterPrefixes })
}

async function file(root: string, relative: string, content: string) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, content)
  return target
}

test("purges every exact atlas-install adapter and hook while preserving shared config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-agent-install-"))
  try {
    const codex = await file(root, ".codex/AGENTS.md", `personal before\n\n${BEGIN}\n${adapter()}${END}\nother after\n`)
    const windsurf = await file(root, ".codeium/windsurf/memories/global_rules.md", `${BEGIN}\n${adapter()}${END}\n`)
    const cursorRule = await file(
      root,
      ".cursor/rules/atlas.mdc",
      `---\ndescription: Gateway research-map skills (auto-managed by \`atlas install\`)\nalwaysApply: true\n---\n\n${adapter()}`,
    )
    const aiderIntro =
      "Wire this file into Aider by adding `read: ~/.aider-atlas-conventions.md` to your `.aider.conf.yml`, or pass `--read ~/.aider-atlas-conventions.md` on the CLI."
    const continueIntro =
      "Reference this file from your Continue config (config.json `systemMessage` or a custom rule) to teach Gateway commands to the assistant."
    const aider = await file(root, ".aider-atlas-conventions.md", adapter("Gateway", aiderIntro))
    const continued = await file(root, ".continue/atlas-skills.md", adapter("Gateway", continueIntro))
    const goose = await file(root, ".config/goose/instructions/atlas.md", adapter())
    const atlasPackage = path.join(root, "node_modules", "@synsci", "atlas", "skills", "atlas")
    await fs.mkdir(atlasPackage, { recursive: true })
    const claudeLink = path.join(root, ".claude", "skills", "atlas")
    await fs.mkdir(path.dirname(claudeLink), { recursive: true })
    await fs.symlink(atlasPackage, claudeLink, process.platform === "win32" ? "junction" : "dir")
    const claude = await file(
      root,
      ".claude/settings.json",
      `${JSON.stringify(
        {
          theme: "dark",
          hooks: {
            PostToolUse: [
              {
                matcher: "WebSearch|WebFetch",
                hooks: [
                  {
                    type: "command",
                    command: 'node "/usr/lib/node_modules/@synsci/atlas/src/atlas-runtime/hooks/web-log-hook.mjs"',
                  },
                  { type: "command", command: "echo keep" },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    )
    const cursorHooks = await file(
      root,
      ".cursor/hooks.json",
      `${JSON.stringify(
        {
          version: 1,
          note: "keep",
          hooks: {
            postToolUse: [
              {
                command: 'node "C:\\\\npm\\node_modules\\@synsci\\atlas\\src\\atlas-runtime\\hooks\\web-log-hook.mjs"',
                matcher: "WebSearch",
              },
              { command: "echo keep", matcher: "Shell" },
            ],
          },
        },
        null,
        2,
      )}\n`,
    )

    expect(await purge(root)).toBe(9)
    expect(await Bun.file(codex).text()).toBe("personal before\nother after\n")
    expect(await Bun.file(windsurf).exists()).toBe(false)
    for (const target of [cursorRule, goose]) expect(await Bun.file(target).exists()).toBe(false)
    for (const target of [aider, continued]) {
      expect(await Bun.file(target).exists()).toBe(true)
      expect(await Bun.file(target).text()).toBe("")
    }
    expect(await Bun.file(claudeLink).exists()).toBe(false)
    expect(await Bun.file(claude).json()).toEqual({
      theme: "dark",
      hooks: {
        PostToolUse: [{ matcher: "WebSearch|WebFetch", hooks: [{ type: "command", command: "echo keep" }] }],
      },
    })
    expect(await Bun.file(cursorHooks).json()).toEqual({
      version: 1,
      note: "keep",
      hooks: { postToolUse: [{ command: "echo keep", matcher: "Shell" }] },
    })
    expect(await purge(root)).toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("preserves user-owned same-path files and malformed shared configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-agent-preserve-"))
  try {
    const personalCursor = `# My atlas notes\n\n${adapter()}\nauto-managed by \`atlas install\`\nalwaysApply: true\n`
    const cursor = await file(root, ".cursor/rules/atlas.mdc", personalCursor)
    const aider = await file(root, ".aider-atlas-conventions.md", "# Personal conventions\n")
    const codex = await file(root, ".codex/AGENTS.md", `${BEGIN}\nunterminated personal content\n`)
    const claude = await file(root, ".claude/settings.json", "{not-json\n")
    const hooks = await file(
      root,
      ".cursor/hooks.json",
      '{"hooks":{"postToolUse":[{"command":"echo keep"},{"command":"node /personal/web-log-hook.mjs"}]}}\n',
    )
    const personalTarget = path.join(root, "personal", "skills", "atlas-lab")
    await fs.mkdir(personalTarget, { recursive: true })
    const personalLink = path.join(root, ".claude", "skills", "atlas-lab")
    await fs.mkdir(path.dirname(personalLink), { recursive: true })
    await fs.symlink(personalTarget, personalLink, process.platform === "win32" ? "junction" : "dir")
    await file(root, ".claude/skills/atlas-map/SKILL.md", "# user-owned directory\n")

    expect(await purge(root)).toBe(0)
    expect(await Bun.file(cursor).text()).toBe(personalCursor)
    expect(await Bun.file(aider).text()).toBe("# Personal conventions\n")
    expect(await Bun.file(codex).text()).toContain("unterminated personal content")
    expect(await Bun.file(claude).text()).toBe("{not-json\n")
    expect(await Bun.file(hooks).json()).toEqual({
      hooks: { postToolUse: [{ command: "echo keep" }, { command: "node /personal/web-log-hook.mjs" }] },
    })
    expect(await fs.lstat(personalLink).then((value) => value.isSymbolicLink())).toBe(true)
    expect(await Bun.file(path.join(root, ".claude/skills/atlas-map/SKILL.md")).text()).toBe("# user-owned directory\n")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("recognizes Atlas-era adapters and preserves a version-only Cursor hook file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-agent-atlas-era-"))
  try {
    const aiderIntro =
      "Wire this file into Aider by adding `read: ~/.aider-atlas-conventions.md` to your `.aider.conf.yml`, or pass `--read ~/.aider-atlas-conventions.md` on the CLI."
    const continueIntro =
      "Reference this file from your Continue config (config.json `systemMessage` or a custom rule) to teach Atlas commands to the assistant."
    await file(
      root,
      ".cursor/rules/atlas.mdc",
      `---\ndescription: Atlas research-map skills (auto-managed by \`atlas install\`)\nalwaysApply: true\n---\n\n${adapter("Atlas")}`,
    )
    await file(root, ".aider-atlas-conventions.md", adapter("Atlas", aiderIntro))
    await file(root, ".continue/atlas-skills.md", adapter("Atlas", continueIntro))
    await file(root, ".config/goose/instructions/atlas.md", adapter("Atlas"))
    const cursorHooks = await file(
      root,
      ".cursor/hooks.json",
      `${JSON.stringify({
        version: 1,
        hooks: {
          postToolUse: [
            {
              command: "node /opt/node_modules/@synsci/atlas/src/atlas-runtime/hooks/web-log-hook.mjs",
            },
          ],
        },
      })}\n`,
    )

    expect(await purge(root)).toBe(5)
    for (const target of [".cursor/rules/atlas.mdc", ".config/goose/instructions/atlas.md"]) {
      expect(await Bun.file(path.join(root, target)).exists()).toBe(false)
    }
    for (const target of [".aider-atlas-conventions.md", ".continue/atlas-skills.md"]) {
      expect(await Bun.file(path.join(root, target)).exists()).toBe(true)
      expect(await Bun.file(path.join(root, target)).text()).toBe("")
    }
    expect(await Bun.file(cursorHooks).json()).toEqual({ version: 1 })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("runs the retirement migration before constructing the command parser", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "../../src/index.ts")).text()
  const cleanup = source.indexOf("await purgeRetiredAtlasAgentInstall(Global.Path.home)")
  const parser = source.indexOf("const cli = yargs(")
  expect(cleanup).toBeGreaterThan(-1)
  expect(parser).toBeGreaterThan(cleanup)
})

test("version and help invocations retire managed instructions before yargs exits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-agent-builtins-"))
  try {
    const codex = path.join(root, ".codex", "AGENTS.md")
    const cli = path.join(import.meta.dir, "../../src/index.ts")
    for (const argument of ["--version", "--help"]) {
      await file(root, ".codex/AGENTS.md", `${BEGIN}\n${adapter("Atlas")}${END}\n`)
      const proc = Bun.spawn([process.execPath, cli, argument], {
        env: {
          ...process.env,
          HOME: root,
          OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
          OPENSCIENCE_DATA_DIR: path.join(root, "data"),
          OPENSCIENCE_TEST_HOME: root,
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(exitCode, `${argument}: ${stderr || stdout}`).toBe(0)
      const remaining = await Bun.file(codex)
        .text()
        .catch(() => undefined)
      expect(remaining, `${argument} left ${JSON.stringify(remaining)}`).toBeUndefined()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("preserves CRLF around a balanced managed block", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-agent-crlf-"))
  try {
    const codex = await file(
      root,
      ".codex/AGENTS.md",
      `before\r\n\r\n${BEGIN}\r\n${adapter().replaceAll("\n", "\r\n")}${END}\r\n\r\nafter\r\n`,
    )
    expect(await purge(root)).toBe(1)
    expect(await Bun.file(codex).text()).toBe("before\r\nafter\r\n")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("removes a generated adapter prefix while preserving appended user notes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-agent-appended-"))
  try {
    const continueIntro =
      "Reference this file from your Continue config (config.json `systemMessage` or a custom rule) to teach Gateway commands to the assistant."
    const continued = await file(
      root,
      ".continue/atlas-skills.md",
      `${adapter("Gateway", continueIntro)}# Personal Continue notes\nKeep this.\n`,
    )
    expect(await purge(root)).toBe(1)
    expect(await Bun.file(continued).text()).toBe("# Personal Continue notes\nKeep this.\n")
    expect(await purge(root)).toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "preserves dotfile symlinks while clearing exact generated targets",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-retired-agent-symlinks-"))
    try {
      const codexTarget = await file(root, "dotfiles/AGENTS.md", `${BEGIN}\n${adapter("Atlas")}${END}\n`)
      const codexLink = path.join(root, ".codex", "AGENTS.md")
      await fs.mkdir(path.dirname(codexLink), { recursive: true })
      await fs.symlink(codexTarget, codexLink)

      const continueIntro =
        "Reference this file from your Continue config (config.json `systemMessage` or a custom rule) to teach Gateway commands to the assistant."
      const continueTarget = await file(root, "dotfiles/atlas-skills.md", adapter("Gateway", continueIntro))
      const continueLink = path.join(root, ".continue", "atlas-skills.md")
      await fs.mkdir(path.dirname(continueLink), { recursive: true })
      await fs.symlink(continueTarget, continueLink)

      expect(await purge(root)).toBe(2)
      expect((await fs.lstat(codexLink)).isSymbolicLink()).toBe(true)
      expect((await fs.lstat(continueLink)).isSymbolicLink()).toBe(true)
      expect(await Bun.file(codexTarget).text()).toBe("")
      expect(await Bun.file(continueTarget).text()).toBe("")
      expect(await purge(root)).toBe(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
