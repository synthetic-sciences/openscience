import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { mkdirSync, writeFileSync } from "fs"
import { basename, join } from "path"
import { UI } from "../ui"
import { OpenScience, API_BASE } from "../../openscience"
import { computeDedupeKey, initProject } from "../../server/routes/atlas-bridge"

/**
 * `openscience project` — manage the Atlas project root for a folder.
 *
 * `init` (find-or-create) links this repo to an Atlas research graph — the same
 * dedupe-safe path the web "Initialize" button uses. Agent-runnable, so a skill
 * can set the graph up from chat.
 *
 * `merge` (alias `pick`) collapses pre-existing duplicate roots created before
 * server-side dedupe: it lists candidate roots, lets the user pick the
 * canonical one, and writes it to `.openscience/project.json` so future syncs from
 * this folder reuse it. It never auto-merges.
 */
export const ProjectCommand = cmd({
  command: "project",
  describe: "manage the Atlas project for this folder",
  builder: (yargs) => yargs.command(ProjectInitCommand).command(ProjectMergeCommand).demandCommand(),
  async handler() {},
})

const ProjectInitCommand = cmd({
  command: "init",
  describe: "create or link this repo's Atlas research graph (dedupe-safe)",
  builder: (yargs) =>
    yargs
      .option("dir", { type: "string", describe: "folder to resolve (defaults to the current directory)" })
      .option("format", { choices: ["text", "json"] as const, default: "text", describe: "output format" }),
  async handler(args) {
    const json = args.format === "json"
    const session = await OpenScience.getSession()
    if (!session) {
      if (json) {
        process.stdout.write(JSON.stringify({ project_id: null, error: "unauthenticated" }) + "\n")
        return
      }
      UI.empty()
      prompts.log.error("Not authenticated. Run `openscience connect login` first.")
      return
    }
    const opened = (args.dir as string | undefined) || process.cwd()
    const projectId = await initProject(opened).catch(() => null)
    if (json) {
      process.stdout.write(JSON.stringify({ project_id: projectId }) + "\n")
      return
    }
    UI.empty()
    if (projectId) {
      prompts.log.success(`Atlas research graph ready — project ${projectId}`)
      prompts.log.info("Pinned to .openscience/project.json; the canvas will show it on next open.")
    } else {
      prompts.log.error(
        "Could not initialize the graph. Check `openscience connect login` and that your account has an active Atlas plan.",
      )
    }
  },
})

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.trim()
  } catch {
    return ""
  }
}

function normalizeRemote(remote: string): string | null {
  const t = remote.trim()
  if (!t) return null
  const ssh = t.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`
  const https = t.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (https) return `https://github.com/${https[1]}/${https[2]}`
  return t
}

type Root = { node_id: string; title: string; ref: string | null }

function rootId(n: any): string | null {
  return n?.node_id ?? n?.id ?? null
}

function rootRef(n: any): string | null {
  return n?.external_transcript_ref ?? n?.repo_context?.external_transcript_ref ?? null
}

const ProjectMergeCommand = cmd({
  command: ["merge", "pick"],
  describe: "pick one canonical Atlas root for this folder and collapse duplicates",
  builder: (yargs) =>
    yargs.option("dir", {
      type: "string",
      describe: "folder to resolve (defaults to the current directory)",
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("OpenScience — project merge")

    const session = await OpenScience.getSession()
    if (!session) {
      prompts.log.error("Not authenticated. Run `openscience connect login` first.")
      prompts.outro("Aborted")
      return
    }

    const opened = (args.dir as string | undefined) || process.cwd()
    // The project is the git repo, not the opened folder — resolve to the repo
    // top-level so the dedupe key matches the web bridge (repo-rooted).
    const top = await git(["rev-parse", "--show-toplevel"], opened)
    const directory = top || opened
    const name = basename(directory)
    const remote = await git(["config", "--get", "remote.origin.url"], directory)
    const repoUrl = remote ? normalizeRemote(remote) : null
    const key = computeDedupeKey(directory, repoUrl)
    prompts.log.info(`Folder: ${directory}\nDedupe key: ${key}`)

    // Pull root nodes (= graphs/projects) and surface likely duplicates.
    const res = await fetch(`${API_BASE}/api/v1/nodes?root_only=true`, {
      headers: { Authorization: `Bearer ${session.api_key}`, Accept: "application/json" },
    }).catch(() => null)
    if (!res || !res.ok) {
      prompts.log.error(`Could not list Atlas roots${res ? ` (HTTP ${res.status})` : ""}.`)
      prompts.outro("Aborted")
      return
    }
    const data = (await res.json().catch(() => ({}))) as any
    const allRoots: Root[] = (Array.isArray(data?.nodes) ? data.nodes : [])
      .map((n: any) => ({ node_id: rootId(n) ?? "", title: String(n?.title ?? "untitled"), ref: rootRef(n) }))
      .filter((r: Root) => r.node_id)

    // Candidates: roots whose ref already carries this key, or whose title
    // matches the folder name (the "Project: <name>" roots created eagerly).
    const refKey = `atlas-project-dedupe:${key}`
    const lname = name.toLowerCase()
    const candidates = allRoots.filter(
      (r) => r.ref === refKey || r.title.toLowerCase().includes(lname),
    )
    const pool = candidates.length > 0 ? candidates : allRoots
    if (pool.length === 0) {
      prompts.log.warn("No Atlas project roots found for your account.")
      prompts.outro("Nothing to merge")
      return
    }
    if (candidates.length <= 1) {
      prompts.log.info(
        candidates.length === 1
          ? "Only one matching root — nothing to collapse, but you can still pin it."
          : "No title/key match for this folder; showing all roots so you can pin one.",
      )
    } else {
      prompts.log.warn(`Found ${candidates.length} duplicate roots for "${name}".`)
    }

    const chosen = await prompts.select({
      message: "Pick the canonical project root to keep:",
      options: pool.map((r) => ({
        value: r.node_id,
        label: r.title,
        hint: r.ref === refKey ? `${r.node_id} · already keyed` : r.node_id,
      })),
    })
    if (prompts.isCancel(chosen)) {
      prompts.cancel("Cancelled — no changes made.")
      return
    }

    // Pin locally: PR-B's find-or-create reads this marker first, so every
    // future sync from this folder collapses onto the chosen root.
    try {
      mkdirSync(join(directory, ".openscience"), { recursive: true })
      writeFileSync(
        join(directory, ".openscience", "project.json"),
        JSON.stringify(
          { project_id: chosen, dedupe_key: key, resolved_at: new Date().toISOString() },
          null,
          2,
        ) + "\n",
      )
    } catch (e) {
      prompts.log.error(`Could not write .openscience/project.json: ${e instanceof Error ? e.message : String(e)}`)
      prompts.outro("Aborted")
      return
    }

    prompts.log.success(`Pinned ${chosen} for this folder (.openscience/project.json).`)
    const others = pool.filter((r) => r.node_id !== chosen)
    if (others.length > 0) {
      prompts.note(
        [
          "Future syncs from this folder now reuse the chosen root.",
          "",
          "The other roots are left untouched (no silent merge). To fully",
          "collapse them server-side (cross-machine) or re-parent their",
          "children, do it from the Atlas web UI — the CLI contract has no",
          "node-update/re-parent endpoint yet.",
          "",
          "Other roots:",
          ...others.map((r) => `  • ${r.title} (${r.node_id})`),
        ].join("\n"),
        "Next steps",
      )
    }
    prompts.outro("Done")
  },
})
