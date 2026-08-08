import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessEvolution {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const Relative = z
    .string()
    .min(1)
    .max(1_000)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !value.endsWith("/") &&
        !value.includes("\\") &&
        !value.split("/").some((part) => !part || part === "." || part === ".."),
      "Evolution manifest paths must be normalized relative POSIX paths",
    )

  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable)
    if (!input || typeof input !== "object") return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, stable(value)]),
    )
  }
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(stable(input))).digest("hex")
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  export const Artifact = z
    .object({
      uri: z.string().min(1).max(2_048),
      sha256: Hash,
    })
    .strict()

  export const Subject = z
    .object({
      type: z.literal("candidate"),
      id: Hash,
      artifact: Artifact,
    })
    .strict()

  export const File = z
    .object({
      path: Relative,
      sha256: Hash,
      bytes: z.number().int().nonnegative().max(1_000_000_000),
      lineHashes: z.array(Hash).max(1_000_000),
    })
    .strict()

  export const Files = z
    .array(File)
    .min(1)
    .max(100_000)
    .superRefine((items, ctx) => {
      const paths = items.map((item) => item.path)
      if (new Set(paths).size !== paths.length) {
        ctx.addIssue({ code: "custom", message: "Evolution manifest paths must be unique" })
      }
      if (same(paths, paths.toSorted())) return
      ctx.addIssue({ code: "custom", message: "Evolution manifest files must be path-sorted" })
    })

  export const Snapshot = z
    .object({
      artifact: Artifact,
      schemaSHA256: Hash,
      files: Files,
    })
    .strict()

  export const Parent = z
    .object({
      id: Hash,
      artifact: Artifact,
      receiptID: Hash,
      snapshotSHA256: Hash,
      delta: Artifact,
    })
    .strict()

  export const Parents = z
    .array(Parent)
    .max(2)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Trace parents must be unique")
    .refine(
      (items) =>
        same(
          items.map((item) => item.id),
          items.map((item) => item.id).toSorted(),
        ),
      "Trace parents must be ID-sorted",
    )

  export const Validator = z
    .object({
      name: z.literal("trace-evolutionary-candidate"),
      version: z.literal(1),
      scriptSHA256: Hash,
    })
    .strict()

  export const Submit = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
      protocol: HarnessContract.Evolution,
      subject: Subject,
      snapshot: Snapshot,
      parents: Parents,
      validator: Validator,
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
  export type Submit = z.input<typeof Submit>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()

  export const ParentDelta = z
    .object({
      id: Hash,
      receiptID: Hash,
      filesChanged: z.number().int().nonnegative(),
      addedLines: z.number().int().nonnegative(),
      deletedLines: z.number().int().nonnegative(),
    })
    .strict()

  export const Diagnostics = z
    .object({
      files: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
      sourceLines: z.number().int().nonnegative(),
      depth: z.number().int().nonnegative(),
      ancestors: z.number().int().nonnegative(),
      addedLines: z.number().int().nonnegative(),
      deletedLines: z.number().int().nonnegative(),
      ancestralDeletedLines: z.number().int().nonnegative(),
      reintroducedLines: z.number().int().nonnegative(),
      reintroducedHashes: z.number().int().nonnegative(),
      reintroducedFraction: z.number().min(0).max(1),
      novelLines: z.number().int().nonnegative(),
      sourceChanged: z.boolean(),
      cycleDetected: z.boolean(),
      parents: z.array(ParentDelta).max(2),
    })
    .strict()
  export type Diagnostics = z.infer<typeof Diagnostics>

  export const Info = z
    .object({
      schemaVersion: z.literal(1),
      receiptID: Hash,
      submissionID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      subject: Subject,
      evaluator: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "external"]),
        })
        .strict(),
      protocol: HarnessContract.Evolution,
      snapshot: Snapshot,
      parents: Parents,
      validator: Validator,
      diagnostics: Diagnostics,
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
  export type Info = z.infer<typeof Info>

  type Delta = {
    files: Array<{
      path: string
      status: "added" | "deleted" | "modified"
      beforeSHA256?: string
      afterSHA256?: string
    }>
    added: string[]
    deleted: string[]
  }

  const lines = (files: z.infer<typeof Files>) => {
    const counts = new Map<string, number>()
    for (const file of files) {
      for (const hash of file.lineHashes) counts.set(hash, (counts.get(hash) ?? 0) + 1)
    }
    return counts
  }

  const maximum = (snapshots: z.infer<typeof Snapshot>[]) => {
    const counts = new Map<string, number>()
    for (const snapshot of snapshots) {
      for (const [hash, count] of lines(snapshot.files)) counts.set(hash, Math.max(counts.get(hash) ?? 0, count))
    }
    return counts
  }

  const expand = (left: Map<string, number>, right: Map<string, number>) =>
    [...left.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .flatMap(([hash, count]) => Array.from({ length: Math.max(0, count - (right.get(hash) ?? 0)) }, () => hash))

  const change = (base: z.infer<typeof Snapshot>, target: z.infer<typeof Snapshot>): Delta => {
    const before = new Map(base.files.map((file) => [file.path, file]))
    const after = new Map(target.files.map((file) => [file.path, file]))
    const files = [...new Set([...before.keys(), ...after.keys()])]
      .toSorted()
      .reduce<Delta["files"]>((result, file) => {
        const prior = before.get(file)
        const next = after.get(file)
        if (prior?.sha256 === next?.sha256) return result
        if (!prior) return [...result, { path: file, status: "added", afterSHA256: next!.sha256 }]
        if (!next) return [...result, { path: file, status: "deleted", beforeSHA256: prior.sha256 }]
        return [
          ...result,
          {
            path: file,
            status: "modified",
            beforeSHA256: prior.sha256,
            afterSHA256: next.sha256,
          },
        ]
      }, [])
    const prior = lines(base.files)
    const next = lines(target.files)
    return { files, added: expand(next, prior), deleted: expand(prior, next) }
  }

  const transition = (snapshot: z.infer<typeof Snapshot>, parents: Info[]): Pick<Delta, "added" | "deleted"> => {
    if (!parents.length) return { added: [], deleted: [] }
    const current = lines(snapshot.files)
    const base = maximum(parents.map((parent) => parent.snapshot))
    return { added: expand(current, base), deleted: expand(base, current) }
  }

  const intersect = (left: string[], right: string[]) => {
    const available = new Map<string, number>()
    for (const hash of right) available.set(hash, (available.get(hash) ?? 0) + 1)
    return left.filter((hash) => {
      const count = available.get(hash) ?? 0
      if (!count) return false
      available.set(hash, count - 1)
      return true
    })
  }

  export function manifestSHA256(protocol: HarnessContract.Evolution, files: z.infer<typeof Files>) {
    const value = HarnessContract.Evolution.parse(protocol)
    return digest({ schemaVersion: 1, lineAlgorithm: value.lineAlgorithm, files: Files.parse(files) })
  }

  export function deltaSHA256(input: {
    subject: z.infer<typeof Subject>
    snapshot: z.infer<typeof Snapshot>
    parent: Pick<Info, "subject" | "snapshot">
  }) {
    const delta = change(input.parent.snapshot, input.snapshot)
    return digest({
      schemaVersion: 1,
      parent: {
        id: input.parent.subject.id,
        artifactSHA256: input.parent.subject.artifact.sha256,
        snapshotSHA256: input.parent.snapshot.artifact.sha256,
      },
      candidate: {
        id: input.subject.id,
        artifactSHA256: input.subject.artifact.sha256,
        snapshotSHA256: input.snapshot.artifact.sha256,
      },
      files: delta.files,
      addedLineHashes: delta.added,
      deletedLineHashes: delta.deleted,
    })
  }

  function validate(snapshot: z.infer<typeof Snapshot>, protocol: HarnessContract.Evolution) {
    if (snapshot.schemaSHA256 !== protocol.manifestSchemaSHA256) {
      throw new Error(`Evolution snapshot schema does not match the immutable harness contract`)
    }
    if (snapshot.artifact.sha256 !== manifestSHA256(protocol, snapshot.files)) {
      throw new Error(`Evolution snapshot manifest content hash is invalid`)
    }
    if (snapshot.files.length > protocol.maxFiles) throw new Error(`Evolution snapshot exceeds its file limit`)
    if (snapshot.files.some((file) => file.bytes > protocol.maxFileBytes)) {
      throw new Error(`Evolution snapshot exceeds its per-file byte limit`)
    }
    const bytes = snapshot.files.reduce((sum, file) => sum + file.bytes, 0)
    if (bytes > protocol.maxTotalBytes) throw new Error(`Evolution snapshot exceeds its total byte limit`)
    const count = snapshot.files.reduce((sum, file) => sum + file.lineHashes.length, 0)
    if (count > protocol.maxSourceLines) throw new Error(`Evolution snapshot exceeds its source-line limit`)
    for (const file of snapshot.files) {
      const rooted = protocol.roots.some(
        (root) => root === "." || file.path === root || file.path.startsWith(`${root}/`),
      )
      if (!rooted) throw new Error(`Evolution snapshot file ${file.path} is outside the committed roots`)
      if (!protocol.extensions.some((extension) => file.path.endsWith(extension))) {
        throw new Error(`Evolution snapshot file ${file.path} has an uncommitted extension`)
      }
      const excluded = protocol.exclude.some((item) => file.path === item || file.path.startsWith(`${item}/`))
      if (excluded) throw new Error(`Evolution snapshot includes excluded file ${file.path}`)
    }
  }

  const request = (input: {
    runID: string
    sessionID: string
    protocol: HarnessContract.Evolution
    subject: z.infer<typeof Subject>
    snapshot: z.infer<typeof Snapshot>
    parents: z.infer<typeof Parent>[]
    validator: z.infer<typeof Validator>
    evidence: string[]
    evaluatedAt: number
  }) => digest(input)

  const lineage = (parents: Info[], items: Record<string, Info>) => {
    const seen = new Map<string, Info>()
    const visit = (receipt: Info) => {
      if (seen.has(receipt.receiptID)) return
      seen.set(receipt.receiptID, receipt)
      for (const parent of receipt.parents) {
        const prior = items[parent.receiptID]
        if (prior) visit(prior)
      }
    }
    for (const parent of parents) visit(parent)
    return [...seen.values()].toSorted((left, right) => left.receiptID.localeCompare(right.receiptID))
  }

  function derive(snapshot: z.infer<typeof Snapshot>, parents: Info[], items: Record<string, Info>) {
    const current = transition(snapshot, parents)
    const ancestors = lineage(parents, items)
    const deleted = ancestors.flatMap((receipt) => {
      const prior = receipt.parents.map((parent) => items[parent.receiptID]!).filter(Boolean)
      return transition(receipt.snapshot, prior).deleted
    })
    const reintroduced = intersect(current.added, deleted)
    const bytes = snapshot.files.reduce((sum, file) => sum + file.bytes, 0)
    const sourceLines = snapshot.files.reduce((sum, file) => sum + file.lineHashes.length, 0)
    const deltas = parents
      .map((parent) => {
        const delta = change(parent.snapshot, snapshot)
        return {
          id: parent.subject.id,
          receiptID: parent.receiptID,
          filesChanged: delta.files.length,
          addedLines: delta.added.length,
          deletedLines: delta.deleted.length,
        }
      })
      .toSorted((left, right) => left.id.localeCompare(right.id))
    return Diagnostics.parse({
      files: snapshot.files.length,
      bytes,
      sourceLines,
      depth: parents.length ? Math.max(...parents.map((parent) => parent.diagnostics.depth)) + 1 : 0,
      ancestors: ancestors.length,
      addedLines: current.added.length,
      deletedLines: current.deleted.length,
      ancestralDeletedLines: deleted.length,
      reintroducedLines: reintroduced.length,
      reintroducedHashes: new Set(reintroduced).size,
      reintroducedFraction: current.added.length ? reintroduced.length / current.added.length : 0,
      novelLines: current.added.length - reintroduced.length,
      sourceChanged: deltas.some((parent) => parent.filesChanged > 0),
      cycleDetected: reintroduced.length > 0,
      parents: deltas,
    })
  }

  const State = z
    .object({
      schemaVersion: z.literal(1),
      items: z.record(Hash, Info),
      order: z.array(Hash),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.order).size !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Evolution receipt order must be unique" })
      }
      const subjects = new Set<string>()
      const seen: Record<string, Info> = {}
      for (const id of value.order) {
        const receipt = value.items[id]
        if (!receipt) {
          ctx.addIssue({ code: "custom", path: ["order"], message: `Evolution receipt ${id} is missing` })
          continue
        }
        if (receipt.receiptID !== id) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Evolution receipt key does not match its ID" })
        }
        const payload = structuredClone(receipt) as Record<string, unknown>
        delete payload.receiptID
        if (digest(payload) !== id) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Evolution receipt content hash is invalid" })
        }
        if (subjects.has(receipt.subject.id)) {
          ctx.addIssue({ code: "custom", path: ["items", id], message: "Candidate evolution receipt is not unique" })
        }
        subjects.add(receipt.subject.id)
        try {
          validate(receipt.snapshot, receipt.protocol)
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            path: ["items", id],
            message: error instanceof Error ? error.message : "Evolution snapshot is invalid",
          })
        }
        const parents = receipt.parents.map((parent) => seen[parent.receiptID]!).filter(Boolean)
        if (parents.length !== receipt.parents.length) {
          ctx.addIssue({
            code: "custom",
            path: ["items", id, "parents"],
            message: "Evolution parents must reference earlier receipts",
          })
        } else {
          for (const parent of receipt.parents) {
            const prior = seen[parent.receiptID]!
            if (
              prior.subject.id !== parent.id ||
              !same(prior.subject.artifact, parent.artifact) ||
              prior.snapshot.artifact.sha256 !== parent.snapshotSHA256
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["items", id, "parents"],
                message: "Evolution parent identity does not match its referenced receipt",
              })
            }
            if (
              parent.delta.sha256 !==
              deltaSHA256({ subject: receipt.subject, snapshot: receipt.snapshot, parent: prior })
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["items", id, "parents"],
                message: "Evolution parent delta content hash is invalid",
              })
            }
          }
          const diagnostics = derive(receipt.snapshot, parents, seen)
          if (!same(receipt.diagnostics, diagnostics)) {
            ctx.addIssue({
              code: "custom",
              path: ["items", id, "diagnostics"],
              message: "Evolution diagnostics derivation drifted",
            })
          }
        }
        if (
          receipt.submissionID !==
          request({
            runID: receipt.runID,
            sessionID: receipt.sessionID,
            protocol: receipt.protocol,
            subject: receipt.subject,
            snapshot: receipt.snapshot,
            parents: receipt.parents,
            validator: receipt.validator,
            evidence: receipt.evidence,
            evaluatedAt: receipt.evaluatedAt,
          })
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["items", id],
            message: "Evolution submission content hash is invalid",
          })
        }
        seen[id] = receipt
      }
      for (const id of Object.keys(value.items)) {
        if (value.order.includes(id)) continue
        ctx.addIssue({ code: "custom", path: ["items", id], message: "Evolution receipt is absent from journal order" })
      }
    })
  type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "evolution")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const empty = (): State => ({ schemaVersion: 1, items: {}, order: [] })
  const state = (input: Record<string, unknown>) => State.parse(Object.keys(input).length ? input : empty())

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const bound = HarnessContract.Info.parse(contract)
    const protocol = bound.evolution
    if (!protocol) throw new Error(`No evolution trace protocol is bound to session ${value.sessionID}`)
    if (bound.sessionID !== value.sessionID || bound.runID !== value.runID) {
      throw new Error(`Evolution receipt does not match the bound harness run`)
    }
    if (!same(value.protocol, protocol))
      throw new Error(`Evolution protocol does not match the immutable harness contract`)
    if (value.validator.scriptSHA256 !== protocol.validatorSHA256) {
      throw new Error(`Evolution validator does not match the immutable harness contract`)
    }
    if (value.evaluatedAt > Date.now() + 300_000) throw new Error(`Evolution receipt is implausibly future-dated`)
    validate(value.snapshot, protocol)
    const search = await import("./search").then((module) => module.HarnessSearch.read(value.sessionID))
    if (search.runID !== bound.runID) throw new Error(`Evolution receipt search belongs to a different harness run`)
    const candidate = search.candidates[value.subject.id]
    if (!candidate) throw new Error(`Evolution receipt candidate does not exist in the bound search`)
    if (!same(candidate.artifact, value.subject.artifact)) {
      throw new Error(`Evolution receipt artifact does not match the candidate artifact`)
    }
    if (value.evaluatedAt < candidate.createdAt) throw new Error(`Evolution validation predates the candidate`)
    const expected = candidate.parentIDs.toSorted()
    if (
      !same(
        value.parents.map((parent) => parent.id),
        expected,
      )
    ) {
      throw new Error(`Evolution receipt parents do not match the candidate lineage`)
    }
    const evidence = value.evidence.toSorted()
    const output: { value?: Info } = {}
    await JsonStore.update(file(value.sessionID), (data) => {
      const current = state(data)
      const parents = value.parents.map((parent) => {
        const receipt = current.items[parent.receiptID]
        if (!receipt) throw new Error(`Evolution parent receipt ${parent.receiptID} does not exist`)
        if (
          receipt.subject.id !== parent.id ||
          !same(receipt.subject.artifact, parent.artifact) ||
          receipt.snapshot.artifact.sha256 !== parent.snapshotSHA256
        ) {
          throw new Error(`Evolution parent does not match its immutable trace receipt`)
        }
        if (receipt.evaluatedAt > value.evaluatedAt) {
          throw new Error(`Evolution candidate trace predates its parent trace`)
        }
        const expectedDelta = deltaSHA256({ subject: value.subject, snapshot: value.snapshot, parent: receipt })
        if (parent.delta.sha256 !== expectedDelta) {
          throw new Error(`Evolution parent delta content hash is invalid`)
        }
        const delta = change(receipt.snapshot, value.snapshot)
        if (delta.added.length + delta.deleted.length > protocol.maxChangedLines) {
          throw new Error(`Evolution parent delta exceeds its changed-line limit`)
        }
        return receipt
      })
      const submissionID = request({
        runID: value.runID,
        sessionID: value.sessionID,
        protocol,
        subject: value.subject,
        snapshot: value.snapshot,
        parents: value.parents,
        validator: value.validator,
        evidence,
        evaluatedAt: value.evaluatedAt,
      })
      const existing = current.order
        .map((id) => current.items[id]!)
        .find((item) => item.subject.id === value.subject.id)
      if (existing) {
        if (existing.submissionID !== submissionID) {
          throw new Error(`Evolution receipt for candidate ${value.subject.id} is immutable once recorded`)
        }
        output.value = existing
        return current
      }
      const diagnostics = derive(value.snapshot, parents, current.items)
      const payload = {
        schemaVersion: 1 as const,
        submissionID,
        runID: value.runID,
        sessionID: value.sessionID,
        contractFingerprint: HarnessContract.fingerprint(bound),
        subject: value.subject,
        evaluator: {
          name: bound.benchmark.evaluator,
          version: bound.benchmark.evaluatorVersion!,
          source: bound.benchmark.evaluatorSource!,
        },
        protocol,
        snapshot: value.snapshot,
        parents: value.parents,
        validator: value.validator,
        diagnostics,
        evidence,
        evaluatedAt: value.evaluatedAt,
        recordedAt: Date.now(),
      }
      const receipt = Info.parse({ ...payload, receiptID: digest(payload) })
      output.value = receipt
      return State.parse({
        ...current,
        items: { ...current.items, [receipt.receiptID]: receipt },
        order: [...current.order, receipt.receiptID],
      })
    })
    if (!output.value) throw new Error(`Evolution receipt was not durable after recording`)
    return output.value
  }

  export async function read(sessionID: string, receiptID: string) {
    const current = state(await JsonStore.read(file(sessionID)))
    return current.items[Hash.parse(receiptID)] ?? null
  }

  export async function list(sessionID: string) {
    const current = state(await JsonStore.read(file(sessionID)))
    return current.order.map((id) => current.items[id]!)
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    candidateID: string
    evaluatedAt: number
    recordedAt: number
  }) {
    const receipt = await read(input.contract.sessionID, input.receiptID)
    if (!receipt) throw new Error(`Evolution receipt ${input.receiptID} does not exist`)
    if (receipt.runID !== input.contract.runID) throw new Error(`Evolution receipt does not match the harness run`)
    if (receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract)) {
      throw new Error(`Evolution receipt does not match the immutable harness contract`)
    }
    if (!same(receipt.protocol, input.contract.evolution)) {
      throw new Error(`Evolution receipt does not match the bound protocol`)
    }
    if (receipt.subject.id !== input.candidateID) {
      throw new Error(`Evolution receipt does not match the evaluated candidate`)
    }
    if (receipt.evaluatedAt > input.evaluatedAt) {
      throw new Error(`Benchmark evaluation predates its referenced evolution receipt`)
    }
    if (receipt.recordedAt > input.recordedAt) {
      throw new Error(`Benchmark evaluation was recorded before its evolution receipt`)
    }
    return receipt
  }
}
