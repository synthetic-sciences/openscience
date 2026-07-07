import type { Argv } from "yargs"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { Global } from "@/global"
import { Instance } from "../../project/instance"
import { Skill } from "../../skill/skill"
import { cmd } from "./cmd"
import { Install } from "../../skill/install/install"
import { Progress } from "../../skill/install/progress"
import { ConfigMarkdown } from "../../config/markdown"
import { runtimeRegexPass, classifierInjectionRegexPass, suspiciousRegexPass } from "../../skill/install/review"
import type { SkillEntry } from "../../skill/install/fetcher"
import { UI } from "../ui"

function userSkillTemplate(name: string, description: string, category: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ncategory: ${category}\n---\n\n# ${name}\n\nUse this skill when…\n\n## Instructions\n\n- \n`
}

async function openInEditor(initial: string): Promise<string> {
  const editor = process.env["VISUAL"] || process.env["EDITOR"]
  if (!editor) return initial
  const file = path.join(os.tmpdir(), `openscience-skill-${Date.now()}.md`)
  await Bun.write(file, initial)
  const parts = editor.split(" ").filter(Boolean)
  const proc = Bun.spawn({ cmd: [...parts, file], stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  await proc.exited
  const out = await Bun.file(file).text()
  await fs.rm(file, { force: true }).catch(() => {})
  return out
}

type SkillGroup = "preexisting" | "learned" | "installed"

function classifySkillLocation(loc: string): { group: SkillGroup; namespace?: string } {
  const installed = loc.match(/[\\/]installed-skills[\\/]([^\\/]+)[\\/]/)
  if (installed) return { group: "installed", namespace: installed[1] }
  if (loc.includes("/learned-skills/") || loc.includes("\\learned-skills\\")) {
    return { group: "learned" }
  }
  return { group: "preexisting" }
}

export const SkillCommand = cmd({
  command: "skill <subcommand>",
  describe: "manage URL-installed third-party skills",
  builder: (yargs: Argv) => {
    return yargs
      .command(SkillAddCommand)
      .command(SkillNewCommand)
      .command(SkillEditCommand)
      .command(SkillValidateCommand)
      .command(SkillListCommand)
      .command(SkillShowCommand)
      .command(SkillRemoveCommand)
      .command(SkillSetEntriesCommand)
      .demandCommand(1)
  },
  handler: () => {
    // each subcommand has its own handler; this top-level handler is only
    // reached via --help / no subcommand, which yargs handles via demandCommand
  },
})

const SkillAddCommand = cmd({
  command: "add <url>",
  describe: "install all skills from a public git repository",
  builder: (yargs: Argv) => {
    return yargs
      .positional("url", {
        describe: "git URL or gh: shorthand (e.g. gh:anthropics/superpowers)",
        type: "string",
        demandOption: true,
      })
      .option("skip-classifier", {
        describe:
          "skip the server-side LLM safety review and the cloud upload " +
          "side-effect (local-only install, at your own risk)",
        type: "boolean",
        default: false,
      })
  },
  handler: async (args) => {
    const progress = Progress.interactive()
    try {
      const result = await Install.add(args.url as string, {
        confirm: true,
        progress,
        skipClassifier: args["skip-classifier"] as boolean,
      })
      if (result.installed.length === 0 && result.rejected.length > 0) {
        UI.error(`Nothing installed. ${result.rejected.length} skill(s) rejected:`)
        for (const r of result.rejected) {
          UI.println(`  - ${r.name}: ${r.reason}`)
        }
        process.exit(1)
      }
      UI.println(`Installed ${result.installed.length} skill(s).`)
      if (result.rejected.length > 0) {
        UI.println(`Skipped ${result.rejected.length} rejected skill(s).`)
      }
    } catch (e) {
      UI.error(`skill add failed: ${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    }
  },
})

const SkillNewCommand = cmd({
  command: "new <name>",
  describe: "create a local user skill",
  builder: (yargs: Argv) => {
    return yargs
      .positional("name", {
        describe: "skill slug (a-z, 0-9, -, _)",
        type: "string",
        demandOption: true,
      })
      .option("description", { describe: "one-line description", type: "string" })
      .option("category", { describe: "category tag", type: "string", default: "user" })
      .option("editor", { describe: "open $EDITOR to write the body", type: "boolean", default: false })
  },
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const name = args.name as string
        const description = (args.description as string) || "Describe when this skill should be used."
        const category = args.category as string
        let body = userSkillTemplate(name, description, category)
        if (args.editor as boolean) body = await openInEditor(body).catch(() => body)
        try {
          const info = await Skill.writeUser({ name, content: body })
          UI.println(`Created user skill: ${info.name}`)
          UI.println(`  ${info.location}`)
        } catch (e) {
          UI.error(`skill new failed: ${e instanceof Error ? e.message : String(e)}`)
          process.exit(1)
        }
      },
    })
  },
})

const SkillEditCommand = cmd({
  command: "edit <name>",
  describe: "edit a local user skill in $EDITOR",
  builder: (yargs: Argv) => {
    return yargs.positional("name", { describe: "user skill name", type: "string", demandOption: true })
  },
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const name = args.name as string
        const info = await Skill.get(name)
        if (!info || !(info.location ?? "").includes("/user-skills/")) {
          UI.error(`No user skill named "${name}". Create one with: openscience skill new ${name}`)
          process.exit(1)
          return
        }
        const current = await Bun.file(info.location).text()
        const edited = await openInEditor(current)
        if (edited === current) {
          UI.println("No changes.")
          return
        }
        try {
          await Skill.writeUser({ name, content: edited })
          UI.println(`Updated user skill: ${name}`)
        } catch (e) {
          UI.error(`skill edit failed: ${e instanceof Error ? e.message : String(e)}`)
          process.exit(1)
        }
      },
    })
  },
})

const SkillValidateCommand = cmd({
  command: "validate <target>",
  describe: "validate a SKILL.md file or user skill name (frontmatter + safety review)",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", { describe: "path to SKILL.md or a user skill name", type: "string", demandOption: true })
      .option("strict", { describe: "fail on warnings too", type: "boolean", default: false })
  },
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const target = (args.target as string).trim()
        const file = await (async () => {
          if (target.endsWith(".md") || target.includes("/") || target.includes("\\")) return target
          const info = await Skill.get(target)
          if (!info) {
            UI.error(`no skill named "${target}"`)
            process.exit(1)
          }
          return info!.location
        })()

        const content = await Bun.file(file)
          .text()
          .catch(() => "")
        if (!content) {
          UI.error(`cannot read ${file}`)
          process.exit(1)
        }

        const md = await ConfigMarkdown.parse(file).catch((e) => {
          UI.error(`frontmatter parse failed: ${e instanceof Error ? e.message : String(e)}`)
          process.exit(1)
          return undefined
        })
        if (!md) return
        const parsed = Skill.Info.pick({
          name: true,
          description: true,
          category: true,
          tags: true,
          entry: true,
        }).safeParse(md.data)
        if (!parsed.success) {
          UI.error("invalid frontmatter: " + parsed.error.issues.map((i) => i.message).join("; "))
          process.exit(1)
          return
        }

        const entry: SkillEntry = {
          namespace: "user",
          name: parsed.data.name,
          description: parsed.data.description ?? "",
          content,
          scripts: [],
          references: [],
        }
        const rejected = [...runtimeRegexPass([entry]).rejected, ...classifierInjectionRegexPass([entry]).rejected]
        const warnings = suspiciousRegexPass([entry]).warnings

        for (const r of rejected) UI.error(`✗ ${r.name}: ${r.reason}`)
        for (const w of warnings) UI.println(`⚠ ${w.file}:${w.line} contains \`${w.pattern}\``)

        if (rejected.length > 0) {
          UI.error(`${parsed.data.name}: rejected (${rejected.length} issue${rejected.length === 1 ? "" : "s"}).`)
          process.exit(1)
        }
        if ((args.strict as boolean) && warnings.length > 0) {
          UI.error(`${parsed.data.name}: ${warnings.length} warning(s) under --strict.`)
          process.exit(1)
        }
        UI.println(`✓ ${parsed.data.name} is valid${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`)
      },
    })
  },
})

const SkillListCommand = cmd({
  command: "list",
  describe: "list available skills",
  builder: (yargs: Argv) =>
    yargs.option("all", {
      describe: "include bundled OpenScience skills in the listing",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    // Skill.state() needs project-instance context so it can walk the
    // .claude/.openscience config dirs alongside the global cache + learned +
    // installed dirs. Mirror what ModelsCommand does.
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const all = await Skill.all()
        const showAll = args.all as boolean
        const bundled: Skill.Info[] = []
        const learned: Skill.Info[] = []
        const installed: Record<string, Skill.Info[]> = {}

        for (const s of all) {
          const cls = classifySkillLocation(s.location ?? "")
          if (cls.group === "installed") {
            const ns = cls.namespace ?? "_"
            ;(installed[ns] ??= []).push(s)
          } else if (cls.group === "learned") {
            learned.push(s)
          } else {
            bundled.push(s)
          }
        }

        const totalInstalled = Object.values(installed).reduce((a, l) => a + l.length, 0)
        const totalLearned = learned.length
        const totalBundled = bundled.length

        UI.println(`OpenScience bundled skills: ${totalBundled}`)
        UI.println(`learned skills: ${totalLearned}`)
        UI.println(`installed skills: ${totalInstalled}`)
        UI.println("")

        if (totalBundled === 0) {
          UI.println(
            "Bundled OpenScience skills did not load. Run `openscience login` and `openscience sync`, then try again.",
          )
          UI.println("Offline fallback only shows skills already cached on this machine.")
          UI.println("")
        } else if (totalBundled < 100) {
          UI.println(
            "Only a small bundled skill set is visible; this usually means the full OpenScience skill index was not fetched.",
          )
          UI.println("Run `openscience sync` or try again once online/authenticated.")
          UI.println("")
        } else if (!showAll) {
          UI.println("Use `openscience skill list --all` to show bundled OpenScience skills.")
          UI.println("")
        }

        if (showAll && totalBundled > 0) {
          UI.println(`bundled skills (${totalBundled})`)
          const groups = Map.groupBy(
            bundled.sort((a, b) => a.name.localeCompare(b.name)),
            (s) => s.category ?? "uncategorized",
          )
          for (const [category, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            UI.println(`  ${category} (${list.length})`)
            for (const s of list) UI.println(`    ${s.name}`)
          }
          UI.println("")
        }

        if (totalLearned === 0 && totalInstalled === 0) {
          UI.println("Install third-party skills with: openscience skill add <git-url>")
          return
        }

        if (totalLearned > 0) {
          UI.println(`learned skills (${totalLearned})`)
          for (const s of learned.sort((a, b) => a.name.localeCompare(b.name))) {
            UI.println(`  ${s.name}`)
          }
          UI.println("")
        }

        if (totalInstalled > 0) {
          UI.println(`installed skills (${totalInstalled})`)
          const namespaces = Object.keys(installed).sort((a, b) => a.localeCompare(b))
          for (const ns of namespaces) {
            const list = installed[ns].sort((a, b) => a.name.localeCompare(b.name))
            UI.println(`  ${ns} (${list.length})`)
            for (const s of list) UI.println(`    ${s.name}`)
          }
          UI.println("")
        }

        if (totalInstalled > 0) UI.println(`Run \`openscience skill show <namespace>[/<name>]\` for details.`)
      },
    })
  },
})

const SkillShowCommand = cmd({
  command: "show <target>",
  describe: "show details of an installed namespace or single skill",
  builder: (yargs: Argv) => {
    return yargs.positional("target", {
      describe: "<namespace> (lists skills with descriptions) or <namespace>/<name> (full SKILL.md)",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    const target = (args.target as string).trim()
    const skills = await Install.list()

    if (target.includes("/")) {
      const [ns, name] = target.split("/", 2)
      const match = skills.find((s) => s.namespace === ns && s.name === name)
      if (!match) {
        UI.error(`Not installed: ${target}`)
        process.exit(1)
      }
      UI.println(`${ns}/${name}`)
      UI.println(`  ${match.description}`)
      UI.println(`  verdict: ${match.verdict}`)
      const skillPath = path.join(Global.Path.data, "installed-skills", ns, "skills", name, "SKILL.md")
      try {
        const content = await fs.readFile(skillPath, "utf-8")
        UI.println("")
        UI.println("─── SKILL.md ───")
        UI.println(content)
      } catch {
        UI.println("")
        UI.println(`(SKILL.md not on disk at ${skillPath} — run \`openscience\` to trigger sync)`)
      }
      return
    }

    // Namespace view: list skills in the namespace with descriptions
    const inNs = skills.filter((s) => s.namespace === target)
    if (inNs.length === 0) {
      UI.error(`Namespace not installed: ${target}`)
      process.exit(1)
    }
    UI.println(`${target} (${inNs.length} skill${inNs.length === 1 ? "" : "s"})`)
    UI.println("")
    const sorted = [...inNs].sort((a, b) => a.name.localeCompare(b.name))
    const widest = Math.max(...sorted.map((s) => s.name.length), 12)
    for (const s of sorted) {
      const tag = s.verdict === "warn" ? "  ⚠" : ""
      const desc = s.description.length > 70 ? s.description.slice(0, 70) + "…" : s.description
      UI.println(`  ${s.name.padEnd(widest)}${tag}  ${desc}`)
    }
  },
})

const SkillSetEntriesCommand = cmd({
  command: "set-entries <namespace> <entries>",
  describe:
    "override which skills in a namespace surface in the / picker. " +
    "Writes openscience-skills.json locally for the namespace.",
  builder: (yargs: Argv) => {
    return yargs
      .positional("namespace", {
        describe: "installed namespace (e.g. superpowers)",
        type: "string",
        demandOption: true,
      })
      .positional("entries", {
        describe: "comma-separated entry skill names (e.g. using-superpowers)",
        type: "string",
        demandOption: true,
      })
  },
  handler: async (args) => {
    const ns = (args.namespace as string).trim()
    const entries = (args.entries as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const nsDir = path.join(Global.Path.data, "installed-skills", ns)
    try {
      await fs.stat(nsDir)
    } catch {
      UI.error(`namespace '${ns}' not installed`)
      process.exit(1)
    }
    await fs.writeFile(path.join(nsDir, "openscience-skills.json"), JSON.stringify({ entries }, null, 2))
    UI.println(
      `Marked ${entries.length} skill(s) as entries for ${ns}. ` + `Others stay loaded but hidden from / picker.`,
    )
  },
})

const SkillRemoveCommand = cmd({
  command: "remove <target>",
  describe: "uninstall a skill or whole namespace",
  builder: (yargs: Argv) => {
    return yargs.positional("target", {
      describe: "<namespace> or <namespace>/<name>",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    const result = await Install.remove(args.target as string)
    UI.println(`Archived ${result.archived} skill(s).`)
  },
})
