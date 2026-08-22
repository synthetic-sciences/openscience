import path from "node:path"
import { ulid } from "ulid"
import z from "zod"
import { AuthoritySignal } from "../project/authority-signal"
import { Instance } from "../project/instance"
import { ProjectLegacy } from "../project/legacy"
import { Provenance } from "../science/provenance/store"
import { Storage } from "../storage/storage"
import { ArtifactFile } from "./artifacts"
import { SafeFileIO } from "./safe-io"
import { markdownImages } from "@synsci/util/markdown"

export namespace PublicationReview {
  export type Authority = {
    root: string
    scan: boolean
    sessionID?: string
    read(file: string): Promise<string>
  }

  export const Check = z.enum(["citation", "numeric", "figure", "provenance"])
  export type Check = z.infer<typeof Check>

  export const Severity = z.enum(["blocking", "major", "minor", "info"])
  export type Severity = z.infer<typeof Severity>

  export const FindingStatus = z.enum(["open", "resolved", "overridden"])
  export type FindingStatus = z.infer<typeof FindingStatus>

  export const Location = z.object({
    path: z.string(),
    line: z.number().int().positive().optional(),
  })
  export type Location = z.infer<typeof Location>

  export const Resolution = z.object({
    kind: z.enum(["resolved", "overridden"]),
    actor: z.string(),
    reason: z.string(),
    at: z.number(),
  })
  export type Resolution = z.infer<typeof Resolution>

  export const Finding = z.object({
    id: z.string(),
    check: Check,
    severity: Severity,
    status: FindingStatus,
    title: z.string(),
    detail: z.string(),
    evidence: z.string().array(),
    location: Location,
    resolution: Resolution.optional(),
  })
  export type Finding = z.infer<typeof Finding>

  export const Event = z.object({
    version: z.number().int().positive(),
    type: z.enum(["generated", "resolved", "overridden", "finalized"]),
    actor: z.string(),
    at: z.number(),
    findingID: z.string().optional(),
    reason: z.string().optional(),
  })
  export type Event = z.infer<typeof Event>

  export const Finalization = z.object({
    actor: z.string(),
    at: z.number(),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    dependencyHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  export type Finalization = z.infer<typeof Finalization>

  export const Dependency = z.object({
    kind: z.enum(["bibliography", "figure"]),
    path: z.string(),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  export type Dependency = z.infer<typeof Dependency>

  export const Summary = z.object({
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    blocking: z.number().int().nonnegative(),
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    overridden: z.number().int().nonnegative(),
  })
  export type Summary = z.infer<typeof Summary>

  export const Report = z.object({
    format: z.literal("openscience.publication-review.v1"),
    id: z.string(),
    projectID: z.string(),
    path: z.string(),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    dependencies: Dependency.array().default([]),
    version: z.number().int().positive(),
    status: z.enum(["blocked", "warnings", "ready"]),
    summary: Summary,
    findings: Finding.array(),
    events: Event.array(),
    finalized: Finalization.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export type Report = z.infer<typeof Report>

  export const State = Report.extend({
    stale: z.boolean(),
  })
  export type State = z.infer<typeof State>

  export const RunInput = z.object({
    path: z.string().trim().min(1).max(10_000),
    actor: z.string().trim().min(1).max(200).default("OpenScience"),
  })
  export type RunInput = z.infer<typeof RunInput>

  export const ResolveInput = z.object({
    status: z.enum(["resolved", "overridden"]),
    actor: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(20_000),
  })
  export type ResolveInput = z.infer<typeof ResolveInput>

  export const FinalizeInput = z.object({
    actor: z.string().trim().min(1).max(200),
  })
  export type FinalizeInput = z.infer<typeof FinalizeInput>

  const prefix = () => ["publication_review", Instance.project.id]
  const key = (id: string) => [...prefix(), id]
  const sourceLimit = 32 * 1024 * 1024
  const bibliographyLimit = 16 * 1024 * 1024
  const figureLimit = 64 * 1024 * 1024

  async function migrate() {
    await ProjectLegacy.adopt("publication_review", Instance.project.id, (value, projectID) => ({
      ...Report.parse(value),
      projectID,
    }))
  }

  export async function run(input: RunInput, authority?: Authority): Promise<Report> {
    await migrate()
    const parsed = RunInput.parse(input)
    const source = await target(parsed.path, authority)
    if (![".md", ".markdown"].includes(path.extname(source.absolute).toLowerCase())) {
      throw new Error("Publication preflight currently requires a Markdown manuscript")
    }
    const snapshot = await SafeFileIO.optional(source.absolute, { maxBytes: sourceLimit })
    if (!snapshot) throw new Error(`Publication manuscript not found: ${parsed.path}`)
    const text = snapshot.bytes.toString("utf8")
    const artifactHash = byteHash(snapshot.bytes)
    const scan = !authority || authority.scan
    const [graph, provenance, audit, bib] = await Promise.all([
      scan
        ? Provenance.project({
            projectID: Instance.project.id,
            directory: Instance.directory,
          })
        : Promise.resolve({ nodes: [], edges: [] }),
      scan
        ? ArtifactFile.provenance(source.root, source.local)
        : Promise.resolve({ path: source.local, tracked: false, dirty: false, status: "local" as const }),
      scan ? ArtifactFile.audit(source.root) : Promise.resolve(undefined),
      bibliography(text, source, authority),
    ])
    const figure = await figures(text, source, graph.nodes, authority)
    const dependencies = [...bib.map((item) => item.dependency), ...figure.dependencies]
      .filter(
        (item, index, values) =>
          values.findIndex((candidate) => candidate.kind === item.kind && candidate.path === item.path) === index,
      )
      .toSorted((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path))
    const findings = [
      ...(await citations(text, source, bib)),
      ...(await numbers(text, source)),
      ...figure.findings,
      ...(await reproducibility(source, provenance, audit)),
    ]
    const now = Date.now()
    const report: Report = {
      format: "openscience.publication-review.v1",
      id: `review_${ulid()}`,
      projectID: Instance.project.id,
      path: source.relative,
      artifactHash,
      dependencies,
      version: 1,
      status: status(findings),
      summary: summary(findings),
      findings: findings.toSorted(compare),
      events: [{ version: 1, type: "generated", actor: parsed.actor, at: now }],
      createdAt: now,
      updatedAt: now,
    }
    const save = async () => {
      const current = authority ? await authority.read(source.absolute) : source.absolute
      if (current !== source.absolute || (await digest(current)) !== artifactHash) {
        throw new Error("The manuscript changed while its publication preflight was being generated; retry it")
      }
      if (!(await dependenciesCurrent(report, source, authority))) {
        throw new Error(
          "A bibliography or figure changed while its publication preflight was being generated; retry it",
        )
      }
      await Storage.write(key(report.id), report)
    }
    if (authority) await AuthoritySignal.exclusive(save)
    else await save()
    return Report.parse(report)
  }

  export async function latest(filepath: string, authority?: Authority): Promise<Report | undefined> {
    return (await history(filepath, authority)).at(-1)
  }

  export async function current(filepath: string, authority?: Authority): Promise<State | undefined> {
    const report = await latest(filepath, authority)
    if (!report) return
    const source = await target(filepath, authority)
    const inspect = async () => {
      const current = await revalidate(source, authority)
      const sourceCurrent = (await digest(current.absolute).catch(() => "")) === report.artifactHash
      const stale = !sourceCurrent || !(await dependenciesCurrent(report, current, authority))
      await revalidate(current, authority)
      return State.parse({ ...report, stale })
    }
    if (!authority) return inspect()
    return AuthoritySignal.exclusive(inspect)
  }

  export async function history(filepath: string, authority?: Authority): Promise<Report[]> {
    await migrate()
    const source = await target(filepath, authority)
    const keys = await Storage.list(prefix())
    const reports = await Promise.all(
      keys.map((item) => Storage.read<unknown>(item).then((value) => Report.parse(value))),
    )
    const result = reports
      .filter((report) => report.path === source.relative)
      .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    if (!authority) return result
    return AuthoritySignal.exclusive(async () => {
      await revalidate(source, authority)
      return result
    })
  }

  export async function get(id: string): Promise<Report> {
    await migrate()
    return Report.parse(await Storage.read<unknown>(key(id)))
  }

  export async function resolve(
    id: string,
    findingID: string,
    input: ResolveInput,
    authority?: Authority,
  ): Promise<Report> {
    await migrate()
    const parsed = ResolveInput.parse(input)
    const update = async () => {
      if (authority) {
        const report = await get(id)
        const requested = path.isAbsolute(report.path) ? report.path : path.resolve(Instance.worktree, report.path)
        const source = await target(requested, authority)
        if (source.relative !== report.path)
          throw new Error("The publication preflight belongs to a different manuscript")
      }
      return Report.parse(
        await Storage.update<Report>(key(id), (report) => {
          if (report.finalized) throw new Error("A finalized publication preflight cannot be changed")
          const finding = report.findings.find((item) => item.id === findingID)
          if (!finding) throw new Error(`Review finding ${findingID} was not found`)
          const now = Date.now()
          finding.status = parsed.status
          finding.resolution = {
            kind: parsed.status,
            actor: parsed.actor,
            reason: parsed.reason,
            at: now,
          }
          report.version += 1
          report.updatedAt = now
          report.status = status(report.findings)
          report.summary = summary(report.findings)
          report.events.push({
            version: report.version,
            type: parsed.status,
            actor: parsed.actor,
            at: now,
            findingID,
            reason: parsed.reason,
          })
        }),
      )
    }
    if (!authority) return update()
    return AuthoritySignal.exclusive(update)
  }

  export async function finalize(id: string, input: FinalizeInput, authority?: Authority): Promise<Report> {
    const parsed = FinalizeInput.parse(input)
    const update = async () => {
      const current = await get(id)
      await assertCurrentLocked(current, undefined, authority)
      if (current.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) {
        throw new Error("Resolve or explicitly override all blocking findings before finalization")
      }
      return Report.parse(
        await Storage.update<Report>(key(id), (report) => {
          if (report.finalized) return
          const now = Date.now()
          report.version += 1
          report.updatedAt = now
          report.finalized = {
            actor: parsed.actor,
            at: now,
            artifactHash: report.artifactHash,
            dependencyHash: dependencyHash(report.dependencies),
          }
          report.events.push({
            version: report.version,
            type: "finalized",
            actor: parsed.actor,
            at: now,
          })
        }),
      )
    }
    if (!authority) return update()
    return AuthoritySignal.exclusive(update)
  }

  export async function assertReady(
    filepath: string,
    id: string,
    artifactHash?: string,
    authority?: Authority,
  ): Promise<Report> {
    const report = await get(id)
    const source = await target(filepath, authority)
    if (report.path !== source.relative) throw new Error("The publication preflight belongs to a different manuscript")
    await assertCurrent(report, artifactHash, authority)
    if (!report.finalized) throw new Error("The publication preflight has not been finalized")
    if (report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) {
      throw new Error("The publication preflight still has open blocking findings")
    }
    return report
  }

  async function citations(
    text: string,
    source: Awaited<ReturnType<typeof target>>,
    bib: Awaited<ReturnType<typeof bibliography>>,
  ): Promise<Finding[]> {
    const lines = prose(text)
    const definitions = new Set(
      lines
        .map((line) => /^\s*\[\^([^\]]+)\]:/.exec(line.text)?.[1])
        .filter((value): value is string => Boolean(value)),
    )
    const references = new Set<string>()
    for (const line of lines) {
      for (const match of line.text.matchAll(/\[\^([^\]]+)\](?!:)/g)) {
        if (definitions.has(match[1]!)) continue
        references.add(`${match[1]}\0${line.line}`)
      }
    }
    const keys = new Set<string>()
    for (const item of bib) {
      for (const match of item.text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) keys.add(match[1]!)
    }
    const cites = new Map<string, number>()
    for (const line of lines) {
      for (const match of line.text.matchAll(/(?<![A-Za-z0-9._%+])@([A-Za-z][A-Za-z0-9_.:+/-]*)/g)) {
        if (!cites.has(match[1]!)) cites.set(match[1]!, line.line)
      }
    }
    const missing = await Promise.all(
      [...cites]
        .filter(([key]) => !keys.has(key))
        .map(([key, line]) =>
          finding({
            check: "citation",
            severity: "blocking",
            title: `Bibliography key @${key} is unresolved`,
            detail: "The manuscript cites a key that is absent from its local bibliography files.",
            evidence: bib.length
              ? bib.map((item) => path.relative(source.root, item.file).replaceAll("\\", "/"))
              : ["No local bibliography file was found."],
            location: { path: source.relative, line },
          }),
        ),
    )
    const footnotes = await Promise.all(
      [...references].map((value) => {
        const [label, line] = value.split("\0")
        return finding({
          check: "citation",
          severity: "blocking",
          title: `Footnote [^${label}] has no definition`,
          detail: "Add a matching footnote definition or remove the unresolved reference.",
          evidence: [`Referenced at ${source.relative}:${line}`],
          location: { path: source.relative, line: Number(line) },
        })
      }),
    )
    const placeholders = await Promise.all(
      lines.flatMap((line) => {
        if (!/\[(?:citation needed|cite|reference needed)\]|\bTODO\s*:?\s*cite\b/i.test(line.text)) return []
        return [
          finding({
            check: "citation",
            severity: "blocking",
            title: "Citation placeholder remains in the manuscript",
            detail: "Replace the placeholder with a resolvable source before publication.",
            evidence: [line.text.trim()],
            location: { path: source.relative, line: line.line },
          }),
        ]
      }),
    )
    return [...missing, ...footnotes, ...placeholders]
  }

  async function numbers(text: string, source: Awaited<ReturnType<typeof target>>): Promise<Finding[]> {
    const lines = prose(text)
    return Promise.all(
      lines.flatMap((line) => {
        const claim =
          /\b\d+(?:\.\d+)?\s*%/.test(line.text) ||
          /\bp\s*(?:<|>|=|≤|≥)\s*0?\.\d+/i.test(line.text) ||
          /\b(?:confidence interval|CI)\b/i.test(line.text) ||
          /\b\d+(?:\.\d+)?\s*(?:mg|µg|μg|ng|kg|mL|µL|μL|mm|cm|nm|µm|μm|Hz|kDa)\b/.test(line.text)
        if (!claim) return []
        const traced =
          /(?<![A-Za-z0-9._%+])@[A-Za-z][A-Za-z0-9_.:+/-]*/.test(line.text) ||
          /\b(?:figure|fig\.?|table|supplement(?:ary)?)\s*[A-Za-z0-9]/i.test(line.text) ||
          /\[[^\]]+\]\([^)]*\.(?:csv|tsv|json|jsonl|parquet|arrow|xlsx?|ipynb)(?:[?#][^)]*)?\)/i.test(line.text)
        if (traced) return []
        return [
          finding({
            check: "numeric",
            severity: "major",
            title: "Numeric claim has no inline evidence trace",
            detail:
              "Link this reported value to a citation, table, figure, notebook, or local data artifact so it can be independently checked.",
            evidence: [line.text.trim()],
            location: { path: source.relative, line: line.line },
          }),
        ]
      }),
    )
  }

  async function figures(
    text: string,
    source: Awaited<ReturnType<typeof target>>,
    nodes: Awaited<ReturnType<typeof Provenance.project>>["nodes"],
    authority?: Authority,
  ): Promise<{ findings: Finding[]; dependencies: Dependency[] }> {
    const findings: Finding[] = []
    const dependencies: Dependency[] = []
    for (const image of markdownImages(text)) {
      const alt = image.alt.trim()
      const value = image.target.trim()
      if (/^(?:https?:|data:|blob:)/i.test(value)) continue
      const requested = path.resolve(path.dirname(source.absolute), decode(value.split(/[?#]/)[0]!))
      const absolute = authority
        ? await authority.read(requested).catch(() => undefined)
        : (await Instance.containsCanonicalPath(requested))
          ? requested
          : undefined
      const relative = path.relative(source.root, requested).replaceAll("\\", "/")
      const inside = Boolean(absolute)
      const snapshot = absolute
        ? await SafeFileIO.optional(absolute, { maxBytes: figureLimit }).catch(() => undefined)
        : undefined
      if (!absolute || !snapshot) {
        findings.push(
          await finding({
            check: "figure",
            severity: "blocking",
            title: `Figure ${value} is missing`,
            detail: inside
              ? "The local figure referenced by this manuscript does not exist."
              : "The figure reference resolves outside the opened project.",
            evidence: [relative],
            location: { path: source.relative, line: image.line },
          }),
        )
        continue
      }
      dependencies.push(dependency("figure", absolute, snapshot.bytes, source))
      if (!alt) {
        findings.push(
          await finding({
            check: "figure",
            severity: "minor",
            title: `Figure ${value} has no alternative text`,
            detail: "Add concise alternative text describing the scientific content of the figure.",
            evidence: [relative],
            location: { path: source.relative, line: image.line },
          }),
        )
      }
      const recorded = nodes.some((node) => {
        if (node.kind !== "artifact" || !("path" in node) || !node.path) return false
        const owner = typeof node.meta?.directory === "string" ? node.meta.directory : source.root
        const nodePath = path.isAbsolute(node.path) ? node.path : path.resolve(owner, node.path)
        return path.resolve(nodePath) === path.resolve(absolute)
      })
      if (recorded) continue
      findings.push(
        await finding({
          check: "figure",
          severity: "major",
          title: `Figure ${value} has no recorded provenance`,
          detail: "Record the generating run, code, and source inputs for this local figure.",
          evidence: [relative, "No matching artifact node exists in the project provenance graph."],
          location: { path: source.relative, line: image.line },
        }),
      )
    }
    return { findings, dependencies }
  }

  async function reproducibility(
    source: Awaited<ReturnType<typeof target>>,
    provenance: ArtifactFile.Provenance,
    audit?: ArtifactFile.Audit,
  ): Promise<Finding[]> {
    const output: Finding[] = []
    if (!provenance.tracked || !provenance.commit) {
      output.push(
        await finding({
          check: "provenance",
          severity: "blocking",
          title: "Manuscript has no reachable Git snapshot",
          detail: "Track and commit the manuscript so the reviewed source can be recovered.",
          evidence: [`Git status: ${provenance.status}`],
          location: { path: source.relative },
        }),
      )
    } else if (provenance.dirty) {
      output.push(
        await finding({
          check: "provenance",
          severity: "blocking",
          title: "Manuscript differs from its recorded Git snapshot",
          detail: "Commit the preflight-checked manuscript bytes before marking the publication ready.",
          evidence: [`Git status: ${provenance.status}`, `Latest commit: ${provenance.commit.sha}`],
          location: { path: source.relative },
        }),
      )
    }
    const failures = (audit?.checks ?? []).filter((check) => check.status === "fail")
    for (const check of failures) {
      if (check.id === "git-repository" || check.id === "git-commit") continue
      output.push(
        await finding({
          check: "provenance",
          severity: "blocking",
          title: check.label,
          detail: check.detail,
          evidence: [`Project reproducibility check: ${check.id}`],
          location: { path: source.relative },
        }),
      )
    }
    const warnings = (audit?.checks ?? []).filter((check) => check.status === "warn")
    for (const check of warnings) {
      if (check.id === "git-clean" && provenance.dirty) continue
      output.push(
        await finding({
          check: "provenance",
          severity: "minor",
          title: check.label,
          detail: check.detail,
          evidence: [`Project reproducibility check: ${check.id}`],
          location: { path: source.relative },
        }),
      )
    }
    return output
  }

  async function bibliography(text: string, source: Awaited<ReturnType<typeof target>>, authority?: Authority) {
    const frontmatter = /^---\s*\n([\s\S]*?)\n---/m.exec(text)?.[1] ?? ""
    const lines = frontmatter.split(/\r?\n/)
    const row = lines.findIndex((line) => /^\s*bibliography\s*:/.test(line))
    const value = row < 0 ? "" : lines[row]!.replace(/^\s*bibliography\s*:\s*/, "").trim()
    const inline = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).split(",") : value ? [value] : []
    const tail = row < 0 ? [] : lines.slice(row + 1)
    const stop = tail.findIndex((line) => !/^\s+-\s+/.test(line))
    const block = value ? [] : tail.slice(0, stop < 0 ? tail.length : stop).map((line) => line.replace(/^\s+-\s+/, ""))
    const declared = [...inline, ...block].map((item) => item.trim().replace(/^(['"])(.*)\1$/, "$2")).filter(Boolean)
    const candidates = [
      ...declared.map((file) => path.resolve(path.dirname(source.absolute), file)),
      path.join(path.dirname(source.absolute), "references.bib"),
      path.join(path.dirname(source.absolute), "bibliography.bib"),
      path.join(path.dirname(source.absolute), "refs.bib"),
      path.join(source.root, "references.bib"),
      path.join(source.root, "bibliography.bib"),
      path.join(source.root, "refs.bib"),
    ]
    const unique = [...new Set(candidates)]
    const safe = await Promise.all(
      unique.map(async (file) => {
        const authorized = authority
          ? await authority.read(file).catch(() => undefined)
          : (await Instance.containsCanonicalPath(file))
            ? file
            : undefined
        if (!authorized) return
        const snapshot = await SafeFileIO.optional(authorized, { maxBytes: bibliographyLimit }).catch(() => undefined)
        return snapshot
          ? {
              file: authorized,
              text: snapshot.bytes.toString("utf8"),
              dependency: dependency("bibliography", authorized, snapshot.bytes, source),
            }
          : undefined
      }),
    )
    return safe.filter((item): item is { file: string; text: string; dependency: Dependency } => Boolean(item))
  }

  async function target(value: string, authority?: Authority) {
    const requested = path.isAbsolute(value) ? value : path.resolve(authority?.root ?? Instance.directory, value)
    const absolute = authority ? await authority.read(requested) : requested
    if (!authority && !(await Instance.containsCanonicalPath(absolute))) {
      throw new Error(`Publication preflight target is outside the project: ${value}`)
    }
    const project = await Instance.containsCanonicalPath(absolute)
    const root = authority?.root ?? Instance.worktree
    return {
      absolute,
      root,
      local: path.relative(root, absolute).replaceAll("\\", "/"),
      relative: project ? path.relative(Instance.worktree, absolute).replaceAll("\\", "/") : absolute,
    }
  }

  async function assertCurrentLocked(report: Report, artifactHash?: string, authority?: Authority) {
    const requested = path.isAbsolute(report.path) ? report.path : path.resolve(Instance.worktree, report.path)
    const source = await target(requested, authority)
    if ((artifactHash ?? (await digest(source.absolute).catch(() => ""))) !== report.artifactHash) {
      throw new Error("The manuscript changed after this publication preflight was generated")
    }
    if (!(await dependenciesCurrent(report, source, authority))) {
      throw new Error("A bibliography or figure changed after this publication preflight was generated")
    }
    if (
      report.finalized &&
      (report.finalized.artifactHash !== report.artifactHash ||
        (report.finalized.dependencyHash !== undefined &&
          report.finalized.dependencyHash !== dependencyHash(report.dependencies)))
    ) {
      throw new Error("The finalized publication preflight integrity record is inconsistent")
    }
    await revalidate(source, authority)
  }

  async function assertCurrent(report: Report, artifactHash?: string, authority?: Authority) {
    if (!authority) return assertCurrentLocked(report, artifactHash)
    return AuthoritySignal.exclusive(() => assertCurrentLocked(report, artifactHash, authority))
  }

  async function revalidate(source: Awaited<ReturnType<typeof target>>, authority?: Authority) {
    if (!authority) return source
    const current = await target(source.absolute, authority)
    if (current.absolute !== source.absolute || current.relative !== source.relative) {
      throw new Error("Publication filesystem authority changed during review access")
    }
    return current
  }

  async function dependenciesCurrent(
    report: Report,
    source: Awaited<ReturnType<typeof target>>,
    authority?: Authority,
  ) {
    for (const item of report.dependencies) {
      const requested = path.isAbsolute(item.path) ? item.path : path.resolve(source.root, item.path)
      const absolute = authority ? await authority.read(requested) : requested
      if (!authority && !(await Instance.containsCanonicalPath(absolute))) return false
      if ((await digest(absolute).catch(() => "")) !== item.artifactHash) return false
    }
    return true
  }

  function dependency(
    kind: Dependency["kind"],
    file: string,
    bytes: Uint8Array,
    source: Awaited<ReturnType<typeof target>>,
  ): Dependency {
    const relative = path.relative(source.root, file)
    const value =
      relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        ? file
        : relative.split(path.sep).join("/")
    return { kind, path: value, artifactHash: byteHash(bytes) }
  }

  function dependencyHash(dependencies: Dependency[]) {
    return byteHash(Buffer.from(JSON.stringify(stable(dependencies))))
  }

  async function finding(input: Omit<Finding, "id" | "status">): Promise<Finding> {
    return {
      ...input,
      id: `finding_${(await hash(JSON.stringify(stable(input)))).slice(0, 20)}`,
      status: "open",
    }
  }

  function summary(findings: Finding[]): Summary {
    return {
      total: findings.length,
      open: findings.filter((finding) => finding.status === "open").length,
      blocking: findings.filter((finding) => finding.severity === "blocking").length,
      major: findings.filter((finding) => finding.severity === "major").length,
      minor: findings.filter((finding) => finding.severity === "minor").length,
      info: findings.filter((finding) => finding.severity === "info").length,
      resolved: findings.filter((finding) => finding.status === "resolved").length,
      overridden: findings.filter((finding) => finding.status === "overridden").length,
    }
  }

  function status(findings: Finding[]): Report["status"] {
    if (findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) return "blocked"
    if (findings.some((finding) => finding.status === "open")) return "warnings"
    return "ready"
  }

  function compare(a: Finding, b: Finding) {
    const rank: Record<Severity, number> = { blocking: 0, major: 1, minor: 2, info: 3 }
    return (
      rank[a.severity] - rank[b.severity] || (a.location.line ?? 0) - (b.location.line ?? 0) || a.id.localeCompare(b.id)
    )
  }

  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    )
  }

  async function digest(file: string) {
    return byteHash((await SafeFileIO.read(file, { maxBytes: sourceLimit })).bytes)
  }

  function byteHash(bytes: Uint8Array) {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(bytes)
    return hasher.digest("hex")
  }

  function decode(value: string) {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  function prose(text: string) {
    const lines = text.split(/\r?\n/)
    const state = {
      frontmatter: /^---\s*$/.test(lines[0] ?? ""),
      fence: "",
      size: 0,
      comment: false,
    }
    return lines.map((value, index) => {
      if (state.frontmatter) {
        if (index > 0 && /^---\s*$/.test(value)) state.frontmatter = false
        return { text: "", line: index + 1 }
      }
      const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(value)?.[1]
      if (marker) {
        const char = marker[0]!
        if (!state.fence) {
          state.fence = char
          state.size = marker.length
        } else if (state.fence === char && marker.length >= state.size) {
          state.fence = ""
          state.size = 0
        }
        return { text: "", line: index + 1 }
      }
      if (state.fence || /^(?: {4}|\t)/.test(value)) return { text: "", line: index + 1 }
      const visible = uncomment(value, state)
      return {
        text: visible.replace(/(`+)(.*?)\1/g, (match) => " ".repeat(match.length)),
        line: index + 1,
      }
    })
  }

  function uncomment(value: string, state: { comment: boolean }) {
    const output: string[] = []
    const cursor = { value: 0 }
    while (cursor.value < value.length) {
      if (state.comment) {
        const end = value.indexOf("-->", cursor.value)
        if (end < 0) return output.join("")
        state.comment = false
        cursor.value = end + 3
        continue
      }
      const start = value.indexOf("<!--", cursor.value)
      if (start < 0) {
        output.push(value.slice(cursor.value))
        break
      }
      output.push(value.slice(cursor.value, start))
      state.comment = true
      cursor.value = start + 4
    }
    return output.join("")
  }

  async function hash(value: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }
}
