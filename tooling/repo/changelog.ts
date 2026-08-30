#!/usr/bin/env bun

import { $ } from "bun"
import { parseArgs } from "util"

export const team = ["ishaan1124", "openscience", "openscience-agent[bot]", "actions-user"]
const teamAuthors = new Set([...team, "Ishaan Gangwani"].map((author) => author.toLowerCase()))
const stableTag = /^v(\d+)\.(\d+)\.(\d+)$/
const internalCommit = /^(?:ignore|test|chore|ci|release)(?:\([^)]*\))?!?:/i
const conventionalPrefix = /^(?:feat|fix|refactor|docs|perf|build|style)(?:\([^)]*\))?!?:\s*/i

export async function getLatestRelease(skip?: string) {
  const target = skip?.replace(/^v/, "")
  const tags = await $`git tag --list "v*" --sort=-version:refname`.text()

  for (const candidate of tags.split("\n")) {
    const match = candidate.trim().match(stableTag)
    if (!match) continue
    const version = candidate.slice(1)
    if (target && version === target) continue
    return version
  }

  throw new Error("No stable release tags found")
}

type Commit = {
  hash: string
  author: string | null
  message: string
  areas: Set<string>
}

export async function getCommits(from: string, to: string): Promise<Commit[]> {
  const fromRef = from.startsWith("v") ? from : `v${from}`
  const toRef = to === "HEAD" ? to : to.startsWith("v") ? to : `v${to}`
  await $`git rev-parse --verify ${`${fromRef}^{commit}`}`.quiet()
  await $`git rev-parse --verify ${`${toRef}^{commit}`}`.quiet()

  // One local git walk provides the immutable commit metadata and touched
  // files. Record/unit separators make author names and subjects unambiguous.
  const range = `${fromRef}..${toRef}`
  const log =
    await $`git log ${range} --format=%x1e%H%x1f%aN%x1f%s --name-only -- backend/cli frontend/workspace frontend/desktop frontend/landing frontend/docs docs tooling/sdk tooling/plugin README.md ARCHITECTURE.md CONTRIBUTING.md SECURITY.md install`.text()

  const commits: Commit[] = []
  for (const record of log.split("\x1e")) {
    const [header, ...paths] = record.trim().split("\n")
    if (!header) continue
    const [hash, author, message] = header.split("\x1f")
    if (!hash || !message || internalCommit.test(message)) continue
    const areas = new Set<string>()

    for (const file of paths.filter(Boolean)) {
      if (file.startsWith("backend/cli/")) areas.add("core")
      else if (file.startsWith("frontend/workspace/")) areas.add("app")
      else if (file.startsWith("frontend/desktop/")) areas.add("desktop")
      else if (file.startsWith("frontend/landing/")) areas.add("website")
      else if (
        file.startsWith("frontend/docs/") ||
        file.startsWith("docs/") ||
        file === "README.md" ||
        file === "ARCHITECTURE.md" ||
        file === "CONTRIBUTING.md" ||
        file === "SECURITY.md"
      )
        areas.add("docs")
      else if (file.startsWith("tooling/sdk/")) areas.add("sdk")
      else if (file.startsWith("tooling/plugin/")) areas.add("plugin")
      else if (file === "install") areas.add("core")
    }

    if (areas.size === 0) continue

    commits.push({
      hash: hash.slice(0, 7),
      author: author?.trim() || null,
      message,
      areas,
    })
  }

  return filterRevertedCommits(commits)
}

function filterRevertedCommits(commits: Commit[]): Commit[] {
  const revertPattern = /^Revert "(.+)"$/
  const seen = new Map<string, Commit>()

  for (const commit of commits) {
    const match = commit.message.match(revertPattern)
    if (match) {
      // It's a revert - remove the original if we've seen it
      const original = match[1]!
      if (seen.has(original)) seen.delete(original)
      else seen.set(commit.message, commit) // Keep revert if original not in range
    } else {
      // Regular commit - remove if its revert exists, otherwise add
      const revertMsg = `Revert "${commit.message}"`
      if (seen.has(revertMsg)) seen.delete(revertMsg)
      else seen.set(commit.message, commit)
    }
  }

  return [...seen.values()]
}

const sections = {
  core: "Core",
  app: "App",
  desktop: "Desktop",
  website: "Website",
  docs: "Docs",
  sdk: "SDK",
  plugin: "SDK",
} as const

function getSection(areas: Set<string>): string {
  // Priority order for multi-area commits
  const priority = ["core", "app", "desktop", "website", "docs", "sdk", "plugin"]
  for (const area of priority) {
    if (areas.has(area)) return sections[area as keyof typeof sections]
  }
  return "Core"
}

function isCommunityAuthor(author: string | null): author is string {
  return !!author && !teamAuthors.has(author.toLowerCase())
}

function humanize(message: string) {
  const clean = message.replace(conventionalPrefix, "").trim()
  if (!clean) return message.trim()
  return clean[0]!.toUpperCase() + clean.slice(1)
}

export function generateChangelog(commits: Commit[]) {
  const grouped = new Map<string, string[]>()
  for (const commit of commits) {
    const section = getSection(commit.areas)
    const attribution = isCommunityAuthor(commit.author) ? ` (${commit.author})` : ""
    const entry = `- ${humanize(commit.message)}${attribution}`

    if (!grouped.has(section)) grouped.set(section, [])
    grouped.get(section)!.push(entry)
  }

  const sectionOrder = ["Core", "App", "Desktop", "Website", "Docs", "SDK"]
  const lines: string[] = []
  for (const section of sectionOrder) {
    const entries = grouped.get(section)
    if (!entries || entries.length === 0) continue
    lines.push(`## ${section}`)
    lines.push(...entries)
  }

  return lines
}

function contributorsFor(commits: Commit[]) {
  const contributors = new Map<string, Set<string>>()

  for (const commit of commits) {
    if (!isCommunityAuthor(commit.author)) continue
    if (!contributors.has(commit.author)) contributors.set(commit.author, new Set())
    contributors.get(commit.author)!.add(humanize(commit.message))
  }

  return contributors
}

export async function getContributors(from: string, to: string) {
  return contributorsFor(await getCommits(from, to))
}

export async function buildNotes(from: string, to: string) {
  const commits = await getCommits(from, to)

  if (commits.length === 0) {
    return []
  }

  console.log("generating changelog since " + from)

  const notes = generateChangelog(commits)
  console.log("---- Generated Changelog ----")
  console.log(notes.join("\n"))
  console.log("-----------------------------")
  console.log("changelog generation complete")

  const contributors = contributorsFor(commits)

  if (contributors.size > 0) {
    notes.push("")
    notes.push(`**Thank you to ${contributors.size} community contributor${contributors.size > 1 ? "s" : ""}:**`)
    for (const [author, userCommits] of contributors) {
      notes.push(`- ${author}:`)
      for (const c of userCommits) {
        notes.push(`  - ${c}`)
      }
    }
  }

  return notes
}

// CLI entrypoint
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      from: { type: "string", short: "f" },
      to: { type: "string", short: "t", default: "HEAD" },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: bun tooling/repo/changelog.ts [options]

Options:
  -f, --from <version>   Starting version (default: latest stable git tag)
  -t, --to <ref>         Ending ref (default: HEAD)
  -h, --help             Show this help message

Examples:
  bun tooling/repo/changelog.ts                     # Latest release to HEAD
  bun tooling/repo/changelog.ts --from 1.0.200      # v1.0.200 to HEAD
  bun tooling/repo/changelog.ts -f 1.0.200 -t 1.0.205
`)
    process.exit(0)
  }

  const to = values.to!
  const from = values.from ?? (await getLatestRelease())

  console.log(`Generating changelog: v${from} -> ${to}\n`)

  const notes = await buildNotes(from, to)
  console.log("\n=== Final Notes ===")
  console.log(notes.join("\n"))
}
