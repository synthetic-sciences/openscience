import path from "node:path"

export interface ParsedSkillUrl {
  kind: "git"
  host: string
  owner: string
  repo: string
  ref: string | null
  path: string | null
  namespace: string
  cloneUrl: string
}

/** Parse a skill URL into its parts.
 *
 * Accepted forms:
 *   https://github.com/<owner>/<repo>
 *   https://github.com/<owner>/<repo>/tree/<ref>
 *   gh:<owner>/<repo>
 *   gh:<owner>/<repo>@<ref>
 *   gh:<owner>/<repo>[@<ref>]/<path…>
 *   https://gitlab.com/… or git+ssh://…  (generic git, treated as default ref)
 */
export function parseSkillUrl(input: string): ParsedSkillUrl {
  const raw = input.trim().replace(/\/+$/, "")
  if (!raw) throw new Error("empty URL")

  // gh: shorthand
  const ghMatch = raw.match(/^gh:([^/@]+)\/([^@/]+)(?:@([^/]+))?(?:\/(.+))?$/)
  if (ghMatch) {
    const [, owner, rawRepo, ref, p] = ghMatch
    const repo = rawRepo.replace(/\.git$/, "")
    return {
      kind: "git",
      host: "github.com",
      owner,
      repo,
      ref: ref ?? null,
      path: p ?? null,
      namespace: repo.toLowerCase(),
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
    }
  }

  // Full GitHub URL (with optional /tree/<ref>, optional .git suffix)
  const ghUrl = raw.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?(?:\/(.+))?$/)
  if (ghUrl) {
    const [, owner, repo, ref, p] = ghUrl
    return {
      kind: "git",
      host: "github.com",
      owner,
      repo,
      ref: ref ?? null,
      path: p ?? null,
      namespace: repo.toLowerCase(),
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
    }
  }

  // Generic https or git+ssh — derive owner/repo from the last two segments.
  const generic = raw.match(/^(https?|git\+ssh|ssh):\/\/[^/]+\/(.+)\/([^/]+?)(?:\.git)?$/)
  if (generic) {
    const [, , owner, repo] = generic
    const url = new URL(raw.replace(/^git\+/, ""))
    return {
      kind: "git",
      host: url.host,
      owner,
      repo,
      ref: null,
      path: null,
      namespace: repo.toLowerCase(),
      cloneUrl: raw.endsWith(".git") ? raw : `${raw}.git`,
    }
  }

  // Absolute filesystem path (mostly for tests / local dev) — namespace is
  // the last path segment; clone via git directly against the local path.
  if (raw.startsWith("/")) {
    const repo = path.basename(raw)
    return {
      kind: "git",
      host: "local",
      owner: "local",
      repo,
      ref: null,
      path: null,
      namespace: repo.toLowerCase(),
      cloneUrl: raw,
    }
  }

  throw new Error(`unrecognized skill URL: ${input}`)
}
