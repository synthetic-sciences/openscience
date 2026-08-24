import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { basename } from "path"
import { UI } from "../ui"
import { OpenScience, API_BASE } from "../../openscience"
import { computeDedupeKey, initProjectDetailed, mergeProjectRootsAndPin } from "../../server/routes/atlas-bridge"
import type { InitProjectFailure } from "../../server/routes/atlas-bridge"
import { GitOutput } from "../../util/git-output"

/**
 * `openscience project` — manage the Synthetic Sciences project root for a folder.
 *
 * `init` (find-or-create) links this repo to a private research graph — the same
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
  describe: "manage the Synthetic Sciences research graph for this folder",
  builder: (yargs) => yargs.command(ProjectInitCommand).command(ProjectMergeCommand).demandCommand(),
  async handler() {},
})

const ProjectInitCommand = cmd({
  command: "init",
  describe: "create or link this repo's Synthetic Sciences research graph (dedupe-safe)",
  builder: (yargs) =>
    yargs
      .option("dir", { type: "string", describe: "folder to resolve (defaults to the current directory)" })
      .option("format", { choices: ["text", "json"] as const, default: "text", describe: "output format" }),
  async handler(args) {
    const json = args.format === "json"
    const session = await OpenScience.getSession()
    if (!session) {
      // Fail fast: without a managed session no request can succeed, so don't
      // let this surface later as a network error.
      if (json) {
        process.stdout.write(JSON.stringify({ project_id: null, error: "unauthenticated", host: API_BASE }) + "\n")
        return
      }
      UI.empty()
      prompts.log.error("Not connected to Synthetic Sciences. Run `openscience login` first.")
      return
    }
    const opened = (args.dir as string | undefined) || process.cwd()
    const fallback: InitProjectFailure = { kind: "backend", host: API_BASE }
    const result = await initProjectDetailed(opened).catch(() => ({ projectId: null, failure: fallback }))
    if (json) {
      const failure = result.failure
      process.stdout.write(
        JSON.stringify({
          project_id: result.projectId,
          ...(failure
            ? { error: failure.kind, status: failure.status, message: failure.message, host: failure.host }
            : {}),
        }) + "\n",
      )
      return
    }
    UI.empty()
    if (result.projectId) {
      prompts.log.success(`Research graph ready — project ${result.projectId}`)
      prompts.log.info("Pinned to .openscience/project.json; the canvas will show it on next open.")
      return
    }
    reportInitFailure(result.failure)
  },
})

/** One honest, actionable line per failure class — never the old blanket
 *  "check login" for what is actually a DNS error or a 500. */
function reportInitFailure(failure: InitProjectFailure | undefined) {
  const f = failure ?? { kind: "backend" as const, host: API_BASE }
  const detail = f.message ? ` — ${f.message}` : ""
  switch (f.kind) {
    case "unauthenticated":
      prompts.log.error(
        f.status
          ? `${f.host} rejected your saved session (HTTP ${f.status})${detail}. Run \`openscience login\` to re-authenticate.`
          : "Not connected to Synthetic Sciences. Run `openscience login` first.",
      )
      break
    case "unreachable":
      prompts.log.error(
        `Could not reach Synthetic Sciences at ${f.host}${f.status ? ` (HTTP ${f.status})` : ""}${detail}.`,
      )
      prompts.log.info(
        "You are logged in — this is a network/service issue, not an auth issue. Check connectivity (and any OPENSCIENCE_API_BASE/SYNSC_API_BASE override), then retry.",
      )
      break
    case "access":
      prompts.log.error(`Authenticated against ${f.host}, but your account cannot create a research graph${detail}.`)
      prompts.log.info("Check account access at https://app.syntheticsciences.ai.")
      break
    default:
      prompts.log.error(
        `Synthetic Sciences could not initialize the graph${f.status ? ` (HTTP ${f.status} from ${f.host})` : ""}${detail}.`,
      )
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  return (await GitOutput.text(args, cwd)) ?? ""
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
  describe: "pick one canonical research-graph root for this folder and collapse duplicates",
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
      prompts.log.error("Not authenticated. Run `openscience login` first.")
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
      prompts.log.error(`Could not list research-graph roots${res ? ` (HTTP ${res.status})` : ""}.`)
      prompts.outro("Aborted")
      return
    }
    const data = (await res.json().catch(() => ({}))) as any
    const allRoots: Root[] = (Array.isArray(data?.nodes) ? data.nodes : [])
      .map((n: any) => ({ node_id: rootId(n) ?? "", title: String(n?.title ?? "untitled"), ref: rootRef(n) }))
      .filter((r: Root) => r.node_id)

    // Prefer the authoritative dedupe marker. Only use the historical title
    // heuristic when no keyed root exists; mixing the two pools could absorb an
    // unrelated old root that happens to share a repository name.
    const refKey = `atlas-project-dedupe:${key}`
    const lname = name.toLowerCase()
    const keyedCandidates = allRoots.filter((r) => r.ref === refKey)
    const titleCandidates = allRoots.filter((r) => r.title.toLowerCase().includes(lname))
    const pool = keyedCandidates.length > 0 ? keyedCandidates : titleCandidates
    if (pool.length === 0) {
      prompts.log.warn("No research-graph roots match this folder; refusing to merge unrelated account roots.")
      prompts.outro("Nothing to merge")
      return
    }
    if (pool.length <= 1) {
      prompts.log.info("Only one matching root — the server will verify it before the local project pin is written.")
    } else {
      prompts.log.warn(`Found ${pool.length} duplicate roots for "${name}".`)
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

    const canonicalId = String(chosen)
    const others = pool.filter((r) => r.node_id !== canonicalId)
    if (others.length > 0) {
      prompts.note(
        [
          `Keep: ${pool.find((r) => r.node_id === canonicalId)?.title ?? canonicalId} (${canonicalId})`,
          "",
          "Re-parent children and delete these duplicate roots:",
          ...others.map((r) => `  • ${r.title} (${r.node_id})`),
        ].join("\n"),
        "Server merge",
      )
      const confirmed = await prompts.confirm({
        message: `Merge ${others.length} duplicate root${others.length === 1 ? "" : "s"} into the selected project?`,
      })
      if (prompts.isCancel(confirmed) || !confirmed) {
        prompts.cancel("Cancelled — no roots or local pins changed.")
        return
      }
    }

    // The server owns the destructive merge transaction. Only a confirmed
    // success may create the local pin; a 404/405 safely tries the historical
    // `/api/agent/projects/merge` contract, while every real v1 failure stops.
    let outcome: Awaited<ReturnType<typeof mergeProjectRootsAndPin>>
    try {
      outcome = await mergeProjectRootsAndPin(
        directory,
        key,
        canonicalId,
        others.map((r) => r.node_id),
      )
    } catch (e) {
      prompts.log.error(`Could not merge project roots: ${e instanceof Error ? e.message : String(e)}`)
      prompts.outro("No local project pin was written")
      return
    }

    prompts.log.success(
      `Merged ${outcome.merge.deleted_nodes ?? others.length} duplicate root${others.length === 1 ? "" : "s"} into ${canonicalId}.`,
    )
    if (!outcome.pinned) {
      prompts.log.warn(
        "The server merge succeeded, but this checkout is read-only and .openscience/project.json could not be written.",
      )
      prompts.outro("Server merge complete")
      return
    }
    prompts.log.success(`Pinned ${canonicalId} for this folder (.openscience/project.json).`)
    prompts.outro("Done")
  },
})
