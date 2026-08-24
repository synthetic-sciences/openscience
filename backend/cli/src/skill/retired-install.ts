import fs from "node:fs/promises"
import path from "node:path"
import { RETIRED_ATLAS_SKILL_NAMES } from "./retired"

const BEGIN = "<!-- BEGIN atlas-skills (managed by `atlas install`) -->"
const END = "<!-- END atlas-skills -->"
const ATLAS_SKILL_PATH = "/@synsci/atlas/skills/"
const ATLAS_HOOK_PATH = "/@synsci/atlas/src/atlas-runtime/hooks/web-log-hook.mjs"
const PUBLISHED_ADAPTER_PREFIXES = [
  [31_247, "abb989615437fce06013a17f14b3c075fc713a43e4b0c0a130beb04924347e0c"],
  [39_358, "d2bf1806b6bd53b89fe5368827913447be966e5a8541f00c6d053c595ec0cd28"],
  [40_920, "5835838cc5e46bb88cfab02dfd3c6c60046007ef5f1ef6ba2baccd6c64ae96d2"],
  [40_386, "549bb056ba3858f7f57a82e403e1222728cb898ac493d40376ca5e8e8093d656"],
  [52_629, "d5f5a7241a454cafe8850e40da497488c40a2f3ab5194a7af4a5e1ace88da598"],
  [53_783, "fcb83b876e3d3dfdcc35217f4025d69163e20f25d71352105caf8d143a34494f"],
  [53_875, "4858e77f789aedb90314aff091c0783dfcfba6b5257018cd8b80bde99576d111"],
  [58_112, "d3f883002db3082c9b9874c2c083d83295c5b1ccd671bebe8a991ce9f8a303f1"],
  [61_641, "bf2fbc172827df22e63c31928b9709ad2586c8422dec574dceafcd437bb14ccd"],
  [61_737, "4f62d8027d4cbe5b39067a1be6e75eb981d9faa10d1ea9d57683124e31218d69"],
] as const satisfies readonly (readonly [number, string])[]

type AdapterPrefix = readonly [bytes: number, sha256: string]

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function generatedPrelude(brand: "Atlas" | "Gateway", intro?: string) {
  return `# ${brand} skills\n\n${intro ? `${intro}\n\n` : ""}${brand} is the research-map CLI from Synthetic Sciences. The skills below`
}

function generatedAdapterRemainder(
  source: Uint8Array,
  kind: "cursor" | "aider" | "continue" | "goose",
  prefixes: readonly AdapterPrefix[],
) {
  let value: string
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(source)
  } catch {
    return
  }
  let canonical: string
  let wrapperBytes: number
  const brand =
    value.startsWith("# Atlas skills\n\n") || value.startsWith("---\ndescription: Atlas research-map skills ")
      ? "Atlas"
      : "Gateway"
  if (kind === "cursor") {
    const frontmatter = `---\ndescription: ${brand} research-map skills (auto-managed by \`atlas install\`)\nalwaysApply: true\n---\n\n`
    if (!value.startsWith(`${frontmatter}${generatedPrelude(brand)}`)) return
    canonical = value.slice(frontmatter.length)
    wrapperBytes = new TextEncoder().encode(frontmatter).byteLength
  } else if (kind === "aider") {
    const intro =
      "Wire this file into Aider by adding `read: ~/.aider-atlas-conventions.md` to your `.aider.conf.yml`, or pass `--read ~/.aider-atlas-conventions.md` on the CLI."
    if (!value.startsWith(generatedPrelude(brand, intro))) return
    const header = `# ${brand} skills\n\n`
    const wrapper = `${intro}\n\n`
    canonical = `${header}${value.slice(header.length + wrapper.length)}`
    wrapperBytes = new TextEncoder().encode(wrapper).byteLength
  } else if (kind === "continue") {
    const intro = `Reference this file from your Continue config (config.json \`systemMessage\` or a custom rule) to teach ${brand} commands to the assistant.`
    if (!value.startsWith(generatedPrelude(brand, intro))) return
    const header = `# ${brand} skills\n\n`
    const wrapper = `${intro}\n\n`
    canonical = `${header}${value.slice(header.length + wrapper.length)}`
    wrapperBytes = new TextEncoder().encode(wrapper).byteLength
  } else if (!value.startsWith(generatedPrelude(brand))) {
    return
  } else {
    canonical = value
    wrapperBytes = 0
  }
  if (!value.includes("atlas help --format=json") || !value.includes("atlas help <command> --schema --format=json")) {
    return
  }

  const canonicalBytes = new TextEncoder().encode(canonical)
  for (const [bytes, expected] of prefixes) {
    if (canonicalBytes.byteLength < bytes || source.byteLength < bytes + wrapperBytes) continue
    const actual = new Bun.CryptoHasher("sha256").update(canonicalBytes.subarray(0, bytes)).digest("hex")
    if (actual === expected) return source.subarray(bytes + wrapperBytes)
  }
}

function strip(source: string) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  const begin = source.indexOf(BEGIN)
  if (begin === -1) return
  const end = source.indexOf(END, begin + BEGIN.length)
  if (end === -1) return
  const before = source.slice(0, begin).replace(/(?:\r?\n)+$/, "")
  const after = source.slice(end + END.length).replace(/^(?:\r?\n)+/, "")
  const cleaned = [before, after].filter(Boolean).join(newline)
  return cleaned ? `${cleaned.replace(/(?:\r?\n)+$/, "")}${newline}` : ""
}

async function clearOrRemove(file: string, stat: Awaited<ReturnType<typeof fs.lstat>>) {
  // Dotfile managers commonly make these paths symlinks. Preserve that
  // topology and clear the exact generated target rather than unlinking it.
  if (stat.isSymbolicLink()) await Bun.write(file, "")
  else await fs.rm(file, { force: true })
}

async function clearAdapter(
  file: string,
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  kind: "cursor" | "aider" | "continue" | "goose",
) {
  // Aider and Continue ask users to reference these exact sidecar paths from
  // separate configuration. Keep an empty regular file so retirement does not
  // turn those references into missing-file warnings. Cursor and Goose own
  // their adapter paths outright and can remove exact generated regular files.
  if (stat.isSymbolicLink() || kind === "aider" || kind === "continue") await Bun.write(file, "")
  else await fs.rm(file, { force: true })
}

async function block(file: string) {
  const source = await Bun.file(file)
    .text()
    .catch(() => undefined)
  if (source === undefined) return 0
  const cleaned = strip(source)
  if (cleaned === undefined) return 0
  if (!cleaned) {
    const stat = await fs.lstat(file)
    await clearOrRemove(file, stat)
  } else await Bun.write(file, cleaned)
  return 1
}

async function adapter(
  file: string,
  kind: "cursor" | "aider" | "continue" | "goose",
  prefixes: readonly AdapterPrefix[],
) {
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) return 0
  const source = await Bun.file(file)
    .arrayBuffer()
    .then((value) => new Uint8Array(value))
    .catch(() => undefined)
  if (!source) return 0
  const remainder = generatedAdapterRemainder(source, kind, prefixes)
  if (remainder === undefined) return 0
  if (remainder.byteLength > 0) await Bun.write(file, remainder)
  else await clearAdapter(file, stat, kind)
  return 1
}

async function json(file: string) {
  return Bun.file(file)
    .json()
    .then((value) => (record(value) ? value : undefined))
    .catch(() => undefined)
}

function command(value: unknown) {
  if (!record(value) || typeof value.command !== "string") return false
  const normalized = value.command.replaceAll("\\", "/").toLowerCase()
  return normalized.includes(ATLAS_HOOK_PATH)
}

function pointsToRetiredAtlasPackage(target: string): boolean {
  return target.replaceAll("\\", "/").toLowerCase().includes(ATLAS_SKILL_PATH)
}

async function claudeSkillLinks(home: string) {
  let removed = 0
  for (const name of RETIRED_ATLAS_SKILL_NAMES) {
    const link = path.join(home, ".claude", "skills", name)
    const stat = await fs.lstat(link).catch(() => undefined)
    if (!stat?.isSymbolicLink()) continue
    const rawTarget = await fs.readlink(link).catch(() => "")
    if (!rawTarget) continue
    const resolved = path.resolve(path.dirname(link), rawTarget)
    const realTarget = await fs.realpath(resolved).catch(() => resolved)
    if (!pointsToRetiredAtlasPackage(realTarget) && !pointsToRetiredAtlasPackage(resolved)) continue
    await fs.rm(link, { force: true })
    removed++
  }
  return removed
}

function group(value: unknown) {
  if (!record(value) || !Array.isArray(value.hooks)) return value
  const hooks = value.hooks.filter((entry) => !command(entry))
  if (hooks.length === value.hooks.length) return value
  if (hooks.length === 0) return
  return { ...value, hooks }
}

function hookCount(values: unknown[]) {
  return values.reduce<number>((count, value) => {
    if (!record(value) || !Array.isArray(value.hooks)) return count
    return count + value.hooks.filter(command).length
  }, 0)
}

async function claude(file: string) {
  const root = await json(file)
  if (!root) return 0
  const hooks = record(root.hooks) ? root.hooks : undefined
  const groups = hooks && Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : undefined
  if (!groups || hookCount(groups) === 0) return 0
  const cleaned = groups.map(group).filter((value) => value !== undefined)
  const nextHooks = { ...hooks }
  if (cleaned.length > 0) nextHooks.PostToolUse = cleaned
  else delete nextHooks.PostToolUse
  const next = { ...root }
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks
  else delete next.hooks
  await Bun.write(file, `${JSON.stringify(next, null, 2)}\n`)
  return 1
}

async function cursor(file: string) {
  const root = await json(file)
  if (!root) return 0
  const hooks = record(root.hooks) ? root.hooks : undefined
  const entries = hooks && Array.isArray(hooks.postToolUse) ? hooks.postToolUse : undefined
  if (!entries || !entries.some(command)) return 0
  const cleaned = entries.filter((entry) => !command(entry))
  const nextHooks = { ...hooks }
  if (cleaned.length > 0) nextHooks.postToolUse = cleaned
  else delete nextHooks.postToolUse
  const next = { ...root }
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks
  else delete next.hooks
  await Bun.write(file, `${JSON.stringify(next, null, 2)}\n`)
  return 1
}

/** Remove only artifacts written by the retired `atlas install` command.
 * User-authored same-path files, malformed JSON, and unrelated hooks remain. */
export async function purgeRetiredAtlasAgentInstall(
  home: string,
  options: { adapterPrefixes?: readonly AdapterPrefix[] } = {},
) {
  const prefixes = options.adapterPrefixes ?? PUBLISHED_ADAPTER_PREFIXES
  const actions = [
    claudeSkillLinks(home),
    block(path.join(home, ".codex", "AGENTS.md")),
    block(path.join(home, ".codeium", "windsurf", "memories", "global_rules.md")),
    adapter(path.join(home, ".cursor", "rules", "atlas.mdc"), "cursor", prefixes),
    adapter(path.join(home, ".aider-atlas-conventions.md"), "aider", prefixes),
    adapter(path.join(home, ".continue", "atlas-skills.md"), "continue", prefixes),
    adapter(path.join(home, ".config", "goose", "instructions", "atlas.md"), "goose", prefixes),
    claude(path.join(home, ".claude", "settings.json")),
    cursor(path.join(home, ".cursor", "hooks.json")),
  ]
  return Promise.all(actions).then((results) => results.reduce<number>((sum, value) => sum + value, 0))
}
