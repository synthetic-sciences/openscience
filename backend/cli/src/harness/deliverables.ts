import path from "path"
import fs from "node:fs/promises"
import type { Hooks, Plugin } from "@synsci/plugin"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { Filesystem } from "@/util/filesystem"
import { HarnessState } from "./state"

/**
 * When the request names its outputs, hold the model to them: detect the
 * specification on the first message, and before the turn ends check every
 * named file mechanically (present, non-empty, parses, no placeholders, no
 * NaN/Inf, no duplicate ids). One message lists the failures; two rounds at
 * most, then the model's answer stands.
 */
export namespace Deliverables {
  const EXTENSIONS =
    "csv|tsv|json|jsonl|md|txt|png|jpg|jpeg|svg|pdf|parquet|npy|npz|yaml|yml|toml|py|ipynb|xlsx|html|tex|bib|fasta|pdb|cif|sdf|h5|hdf5|nc|tif|tiff|zip|tar|gz"
  const PATH = new RegExp(
    `(?<![\\w@/\\\\.-])((?:(?:[a-z]:[\\\\/]|\\\\\\\\[\\w.-]+[\\\\/][\\w$ .-]+[\\\\/]|/)(?:[\\w .-]+[\\\\/])*[\\w .-]+\\.(?:${EXTENSIONS})|(?:[\\w.-]+[\\\\/])*[\\w.-]+\\.(?:${EXTENSIONS})))(?![\\w/\\\\])`,
    "gi",
  )
  const INTENT =
    /\b(?:write|save|store|export|output|produce|create|emit|dump)\b[^.\n]{0,80}\b(?:to|as|in|at|into|named|called)\b/i
  const SHAPE = /\b(?:columns?|schema|keys?|fields?|header|format|rounded|decimal|units?|sorted by|one row per)\b/i
  const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|placeholder|dummy|lorem ipsum|xxx+|fill me|to be filled|<insert)\b/i
  const NEGATED =
    /\b(?:skip|don'?t|do not|not|later|except|ignore|without|omit|leave|instead of|rather than|no need)\b/i
  // A file the request tells the model to consult is an input, not something
  // it owes: "Read CONTRACTS.md and study.json first" names no deliverable.
  // The nearest verb before a path decides; "read config.yaml, then write
  // results/out.csv" keeps only the output.
  const INPUT = /\b(?:read|inspect|consult|open|load|follow|see|check|review|use|given|based on|according to)\b/gi
  const PRODUCES = /\b(?:write|save|store|export|output|produce|create|emit|dump|generate|deliver)\b/gi
  const NAN = /(?:^|[,\t;\s])(?:nan|NaN|NAN|inf|-inf|Inf|-Inf|Infinity|-Infinity|#N\/A)(?=$|[,\t;\s])/
  const MAX_BYTES = 64 * 1024 * 1024

  /** Paths whose nearest preceding verb says the model reads them. */
  function consulted(sentence: string) {
    const verbs = [
      ...[...sentence.matchAll(INPUT)].map((match) => ({ index: match.index, input: true })),
      ...[...sentence.matchAll(PRODUCES)].map((match) => ({ index: match.index, input: false })),
    ].sort((left, right) => left.index - right.index)
    return [...sentence.matchAll(PATH)]
      .filter((match) => verbs.filter((verb) => verb.index < match.index).at(-1)?.input === true)
      .map((match) => match[1])
  }

  /** File paths a request names as outputs, in order of appearance, when it
   * reads like an output specification at all. */
  export function detect(text: string): string[] {
    // A path named in a sentence that waives it ("skip X for now") is the
    // user's decision, not a missing deliverable.
    const sentences = text.split(/(?<=[.!?;])\s+|\n+/)
    const waived = new Set([
      ...sentences
        .filter((sentence) => NEGATED.test(sentence))
        .flatMap((sentence) => [...sentence.matchAll(PATH)].map((match) => match[1])),
      ...sentences.flatMap(consulted),
    ])
    // An abbreviated path (".../inputs/labels.csv", "…/out.csv") names a
    // place the writer elided, not a file anyone can check.
    const paths = [...new Set([...text.matchAll(PATH)].map((match) => match[1]))].filter(
      (candidate) =>
        !/^(?:https?|www\.)/i.test(candidate) &&
        !candidate.endsWith(".py") &&
        !/(?:^|\/)(?:\.{3,}|…)(?:\/|$)/.test(candidate) &&
        !waived.has(candidate),
    )
    if (!paths.length) return []
    if (!INTENT.test(text) && !SHAPE.test(text) && paths.length < 2) return []
    return paths
  }

  export type Check = { path: string; problems: string[] }

  async function parseCheck(file: string, bytes: Uint8Array): Promise<string[]> {
    const ext = path.extname(file).toLowerCase()
    const text = () => new TextDecoder().decode(bytes)
    if (ext === ".json") {
      try {
        JSON.parse(text())
        return []
      } catch (error) {
        return [`does not parse as JSON (${error instanceof Error ? error.message.split("\n")[0] : "invalid"})`]
      }
    }
    if (ext === ".jsonl") {
      const bad = text()
        .split("\n")
        .filter((line) => line.trim())
        .findIndex((line) => {
          try {
            JSON.parse(line)
            return false
          } catch {
            return true
          }
        })
      return bad === -1 ? [] : [`line ${bad + 1} does not parse as JSON`]
    }
    if (ext === ".csv" || ext === ".tsv") {
      const separator = ext === ".csv" ? "," : "\t"
      const lines = text()
        .split(/\r?\n/)
        .filter((line) => line.length)
      if (lines.length < 2) return ["has a header but no data rows"]
      const width = lines[0].split(separator).length
      const problems: string[] = []
      const ragged = lines.findIndex((line) => line.split(separator).length !== width)
      if (ragged > 0 && !lines[ragged].includes('"')) problems.push(`row ${ragged + 1} has a different column count`)
      if (lines.some((line) => NAN.test(line))) problems.push("contains NaN or Inf values")
      const header = lines[0].split(separator).map((cell) => cell.trim().toLowerCase())
      const idColumn = header.findIndex((name) => name === "id" || name.endsWith("_id") || name === "name")
      if (idColumn >= 0) {
        const ids = lines.slice(1).map((line) => line.split(separator)[idColumn]?.trim())
        if (new Set(ids).size !== ids.length) problems.push(`duplicate values in the ${header[idColumn]} column`)
      }
      return problems
    }
    if (ext === ".npy") return bytes[0] === 0x93 && text().slice(1, 6) === "NUMPY" ? [] : ["is not a NumPy .npy file"]
    if (ext === ".npz" || ext === ".zip") return bytes[0] === 0x50 && bytes[1] === 0x4b ? [] : ["is not a zip archive"]
    if (ext === ".parquet") {
      const head = new TextDecoder().decode(bytes.subarray(0, 4))
      const tail = new TextDecoder().decode(bytes.subarray(bytes.length - 4))
      return head === "PAR1" && tail === "PAR1" ? [] : ["is not a Parquet file"]
    }
    if (ext === ".toml") {
      try {
        Bun.TOML.parse(text())
        return []
      } catch {
        return ["does not parse as TOML"]
      }
    }
    if (ext === ".yaml" || ext === ".yml") {
      const yaml = (Bun as unknown as { YAML?: { parse(text: string): unknown } }).YAML
      if (!yaml) return []
      try {
        yaml.parse(text())
        return []
      } catch {
        return ["does not parse as YAML"]
      }
    }
    if (ext === ".png") return bytes[0] === 0x89 && bytes[1] === 0x50 ? [] : ["is not a PNG image"]
    if (ext === ".pdf") return text().startsWith("%PDF") ? [] : ["is not a PDF"]
    return []
  }

  /** Where a relative output may live: the tool directory first, then the
   * project's files, without duplicates. */
  export async function roots(sessionID: string): Promise<string[]> {
    const tool = await SessionFilesystem.toolDirectory(sessionID).catch(() => undefined)
    const project = Instance.directory
    return [...new Set([tool, project].filter((value): value is string => !!value))]
  }

  /** The check of one named output across the places it may live: the first
   * passing result wins; otherwise the first root's problems are reported,
   * with "does not exist" only when it exists nowhere. */
  export async function checkIn(roots: string[], name: string): Promise<Check> {
    const results = await Promise.all(roots.map((root) => check(root, name)))
    const passed = results.find((result) => result.problems.length === 0)
    if (passed) return passed
    const present = results.find(
      (result) =>
        !result.problems.includes("does not exist") && !result.problems.includes("is outside allowed output roots"),
    )
    const missing = results.find((result) => result.problems.includes("does not exist"))
    return present ?? missing ?? results[0] ?? { path: name, problems: ["does not exist"] }
  }

  /** Mechanical checks for one named output; an empty list means it passed. */
  export async function check(root: string, name: string): Promise<Check> {
    const absolute = path.isAbsolute(name)
    if (!absolute && (path.win32.isAbsolute(name) || path.posix.isAbsolute(name))) {
      return { path: name, problems: ["is outside allowed output roots"] }
    }
    const allowed = await Filesystem.canonical(root)
    const target = absolute ? name : path.resolve(root, name)
    if (
      !allowed ||
      (!Filesystem.contains(path.resolve(root), target) && !Filesystem.contains(allowed, target))
    ) {
      return { path: name, problems: ["is outside allowed output roots"] }
    }
    const file = await Filesystem.canonical(target)
    if (!file || !Filesystem.contains(allowed, file)) {
      return { path: name, problems: ["is outside allowed output roots"] }
    }
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat) return { path: name, problems: ["does not exist"] }
    if (!stat.isFile()) return { path: name, problems: ["is not a regular file"] }
    if (stat.size === 0) return { path: name, problems: ["is empty"] }
    if (stat.size > MAX_BYTES) return { path: name, problems: [] }
    const bytes = new Uint8Array(await fs.readFile(file))
    const problems = await parseCheck(file, bytes)
    const ext = path.extname(file).toLowerCase()
    const textual = [
      ".csv",
      ".tsv",
      ".json",
      ".jsonl",
      ".md",
      ".txt",
      ".yaml",
      ".yml",
      ".toml",
      ".tex",
      ".bib",
      ".html",
    ]
    if (textual.includes(ext) && PLACEHOLDER.test(new TextDecoder().decode(bytes))) {
      problems.push("contains placeholder text (TODO, TBD, placeholder, dummy or similar)")
    }
    return { path: name, problems }
  }

  export function render(failures: Check[]) {
    return [
      "Before finishing, the deliverables checklist was checked mechanically. These named outputs are not ready:",
      ...failures.map((failure) => `- ${failure.path}: ${failure.problems.join("; ")}`),
      "Produce the real file for each, or state precisely why it cannot be produced; do not write placeholder values.",
    ].join("\n")
  }
}

export const DeliverablesUnit: Plugin = async () => {
  const hooks: Hooks = {
    async "chat.message"(input, output) {
      const state = HarnessState.get(input.sessionID)
      if (state.deliverables.length) return
      // A worker's brief is written by the lead and names the files it may
      // touch or must read; the lead holds the checklist for the user's
      // request and checks the deliverables it asked for itself.
      const session = await Session.get(input.sessionID).catch(() => undefined)
      if (session?.parentID) return
      // Only the person's own words specify deliverables. A synthetic prompt
      // (a worker's report waking the lead, a harness continuation) is full
      // of paths it discusses, none of which the user asked for.
      const spoken = output.parts.filter(
        (part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic,
      )
      if (!spoken.length) return
      // Only the first real request defines the deliverables; later turns may
      // steer the work but the checklist stays anchored to what was asked.
      // Every prompt carries an `internal` marker for restart replay, so the
      // anchor is the first user message with text the person typed.
      const earlier = (await Session.messages({ sessionID: input.sessionID }).catch(() => [])).filter(
        (message) =>
          message.info.role === "user" &&
          message.info.id !== output.message.id &&
          message.info.internal?.type !== "continuation" &&
          message.parts.some((part) => part.type === "text" && !part.synthetic),
      )
      if (earlier.length) return
      state.deliverables = Deliverables.detect(spoken.map((part) => part.text).join("\n"))
    },
    async "loop.before_finish"(input, output) {
      const state = HarnessState.get(input.sessionID)
      if (!state.deliverables.length) return
      // A relative output may sit in the tool directory or in the project's
      // files: the environment names both, and an isolated session's agent
      // rightly puts durable deliverables in the project rather than its
      // scratch. A file that passes in either place is ready; checking the
      // scratch alone sent one agent off to duplicate finished files there.
      const roots = await Deliverables.roots(input.sessionID)
      if (!roots.length) return
      const checks = await Promise.all(state.deliverables.map((name) => Deliverables.checkIn(roots, name)))
      const failures = checks.filter((check) => check.problems.length)
      state.deliverablesFailing = failures.length > 0
      if (!failures.length || state.deliverableRounds >= 2) return
      state.deliverableRounds++
      output.message = Deliverables.render(failures)
    },
    async event({ event }) {
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
    },
  }
  return hooks
}
