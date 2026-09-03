import { ComputeJobs } from "@/compute/jobs"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SearchDedupe } from "./search-dedupe"
import { SessionStatus } from "./status"
import { observableToolFailure, observableToolStatus } from "./tool-outcome"
import { SessionTraceStore } from "./trace-store"
import { SessionHarness } from "./harness"
import { SessionResearch } from "./research"
import { Review } from "@/science/provenance/review"
import { Provenance } from "@/science/provenance/store"
import { Instance } from "@/project/instance"
import { TokenUsage } from "@synsci/util/token-usage"
import { TaskAttempt } from "@/tool/task-attempt"
import { ArtifactStore } from "@/artifact/store"
import z from "zod"

export namespace SessionTrace {
  const Tokens = z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  })

  const Usage = z.object({
    cost: z.number(),
    tokens: Tokens.omit({ reasoning: true }).extend({
      cache: Tokens.shape.cache,
    }),
  })

  export const Tool = z.object({
    id: z.string(),
    callID: z.string(),
    messageID: z.string(),
    name: z.string(),
    category: z.enum(["tool", "search", "kernel", "child", "artifact", "review", "external"]),
    status: z.enum(["pending", "running", "completed", "partial", "error"]),
    title: z.string().optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    durationMs: z.number().optional(),
    inputHash: z.string(),
    inputKeys: z.array(z.string()),
  })

  export const Inference = z.object({
    messageID: z.string(),
    parentMessageID: z.string(),
    agent: z.string(),
    model: z.string(),
    provider: z.string(),
    effort: z.string(),
    source: z.enum(["managed", "byok", "chatgpt", "local", "oauth", "unknown"]),
    tier: z.string().optional(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
    durationMs: z.number().optional(),
    cost: z.number(),
    tokens: Tokens,
  })

  export const Child = z.object({
    toolID: z.string(),
    sessionID: z.string().optional(),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    status: z.enum(["pending", "running", "completed", "partial", "error"]),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    durationMs: z.number().optional(),
    toolCalls: z.number().optional(),
    failedToolCalls: z.number().optional(),
    usage: Usage.optional(),
  })

  export const Search = z.object({
    toolID: z.string(),
    messageID: z.string(),
    tool: z.string(),
    query: z.string().optional(),
    signature: z.string(),
    status: z.enum(["pending", "running", "completed", "error"]),
    dedupeHit: z.boolean(),
    dedupeOf: z
      .object({
        messageID: z.string(),
        partID: z.string(),
        callID: z.string(),
      })
      .optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    durationMs: z.number().optional(),
  })

  export const Kernel = z.object({
    toolID: z.string(),
    messageID: z.string(),
    language: z.enum(["python", "r"]),
    status: z.enum(["pending", "running", "completed", "error"]),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    durationMs: z.number().optional(),
    executionCount: z.number().optional(),
    provenanceID: z.string().optional(),
  })

  export const Job = z.object({
    id: z.string(),
    name: z.string(),
    target: z.enum(["local", "ssh", "modal"]),
    targetLabel: z.string(),
    status: ComputeJobs.Status,
    createdAt: z.string(),
    startedAt: z.string().optional(),
    lastActivityAt: z.string().optional(),
    completedAt: z.string().optional(),
    durationMs: z.number().optional(),
    exitCode: z.number().nullable().optional(),
    resources: ComputeJobs.Resources.optional(),
    artifactCount: z.number(),
  })

  export const Artifact = z.object({
    toolID: z.string(),
    messageID: z.string(),
    action: z.literal("save_file"),
    artifactID: z.string().optional(),
    versionID: z.string().optional(),
    path: z.string().optional(),
    kind: z.string().optional(),
    sha256: z.string().optional(),
    provenanceID: z.string().optional(),
    producedAt: z.number().optional(),
    durable: z.boolean(),
    completedAt: z.number().optional(),
  })

  export const Finding = z.object({
    toolID: z.string(),
    messageID: z.string(),
    id: z.string().optional(),
    target: z.string().optional(),
    relation: z.enum(["refutes", "supports"]).optional(),
    severity: z.enum(["blocking", "major", "minor", "info"]).optional(),
    claim: z.string().optional(),
    issue: z.string().optional(),
    evidence: z.string().optional(),
    status: z.enum(["open", "addressed", "confirmed"]).optional(),
    completedAt: z.number().optional(),
  })

  export const Failure = z.object({
    kind: z.enum(["model", "runtime", "tool", "approval", "job"]),
    id: z.string(),
    message: z.string(),
    createdAt: z.number(),
  })

  export const Turn = z.object({
    messageID: z.string(),
    agent: z.string(),
    startedAt: z.number(),
    firstUsefulOutputAt: z.number().optional(),
    timeToFirstUsefulOutputMs: z.number().optional(),
    completedAt: z.number().optional(),
    totalCompletionTimeMs: z.number().optional(),
    toolCalls: z.number(),
    childCount: z.number(),
    cost: z.number(),
    tokens: Tokens,
  })

  export const External = z.object({
    kind: z.enum(["model", "api", "compute"]),
    id: z.string(),
    name: z.string(),
    source: z.string(),
    external: z.boolean(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    cost: z.number().optional(),
  })

  export const Info = z.object({
    version: z.literal(1),
    session: z.object({
      id: z.string(),
      parentID: z.string().optional(),
      title: z.string(),
      status: z.enum(["idle", "retry", "busy", "compacting"]),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
    summary: z.object({
      startedAt: z.number(),
      firstUsefulOutputAt: z.number().optional(),
      timeToFirstUsefulOutputMs: z.number().optional(),
      completedAt: z.number().optional(),
      totalCompletionTimeMs: z.number().optional(),
      cost: z.number(),
      tokens: Tokens,
      inferenceCalls: z.number().int().nonnegative(),
      toolCalls: z.number(),
      toolCallsPerInference: z.number().nonnegative().optional(),
      toolExecutionMs: z.number().nonnegative(),
      toolCriticalPathMs: z.number().nonnegative(),
      toolMaxConcurrency: z.number().int().nonnegative(),
      toolParallelism: z.number().nonnegative().optional(),
      toolContractBytes: z.number().int().nonnegative().optional(),
      contractBytes: z.number().int().nonnegative().optional(),
      childCount: z.number(),
      searchCount: z.number(),
      dedupeHits: z.number(),
      approvalCount: z.number(),
      artifactSaves: z.number(),
      reviewerFindings: z.number(),
      failureCount: z.number(),
      retryCount: z.number(),
    }),
    turns: z.array(Turn),
    inference: z.array(Inference),
    tools: z.array(Tool),
    children: z.array(Child),
    searches: z.array(Search),
    kernels: z.array(Kernel),
    jobs: z.array(Job),
    approvals: z.array(SessionTraceStore.Approval),
    external: z.array(External),
    artifacts: z.array(Artifact),
    reviewerFindings: z.array(Finding),
    failures: z.array(Failure),
    retries: z.array(SessionTraceStore.Retry),
    harness: z.array(SessionTraceStore.Harness),
    harnessReport: SessionHarness.Report,
    research: SessionResearch.Assessment.extend({
      contract: SessionResearch.Contract.optional(),
    }),
    privacy: z.object({
      local: z.literal(true),
      atlasRequired: z.literal(false),
      hiddenReasoningStored: z.literal(false),
      toolOutputsCopied: z.literal(false),
      promptContentStored: z.literal(false),
    }),
  })
  export type Info = z.infer<typeof Info>

  const emptyTokens = () => ({
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  function addTokens(target: ReturnType<typeof emptyTokens>, value: MessageV2.Assistant["tokens"]) {
    target.input += value.input
    target.output += value.output
    target.reasoning += value.reasoning
    target.cache.read += value.cache.read
    target.cache.write += value.cache.write
    return target
  }

  function object(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    return value as Record<string, unknown>
  }

  function string(value: unknown) {
    return typeof value === "string" ? value : undefined
  }

  function number(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }

  function times(part: MessageV2.ToolPart, now: number) {
    if (part.state.status === "pending") return {}
    const startedAt = part.state.time.start
    const completedAt =
      part.state.status === "completed" || part.state.status === "error" ? part.state.time.end : undefined
    return {
      startedAt,
      completedAt,
      durationMs: (completedAt ?? now) - startedAt,
    }
  }

  function toolTiming(tools: z.infer<typeof Tool>[], now: number) {
    const intervals = tools
      .flatMap((tool) => {
        if (tool.startedAt === undefined) return []
        const end = tool.completedAt ?? now
        if (end < tool.startedAt) return []
        return [{ start: tool.startedAt, end }]
      })
      .toSorted((a, b) => a.start - b.start || a.end - b.end)
    const merged = intervals.reduce<Array<{ start: number; end: number }>>((all, item) => {
      const prior = all.at(-1)
      if (!prior || item.start > prior.end) return [...all, { ...item }]
      prior.end = Math.max(prior.end, item.end)
      return all
    }, [])
    const execution = intervals.reduce((sum, item) => sum + item.end - item.start, 0)
    const critical = merged.reduce((sum, item) => sum + item.end - item.start, 0)
    const concurrency = intervals
      .filter((item) => item.end > item.start)
      .flatMap((item) => [
        { time: item.start, delta: 1 },
        { time: item.end, delta: -1 },
      ])
      .toSorted((a, b) => a.time - b.time || a.delta - b.delta)
      .reduce(
        (value, item) => {
          value.current += item.delta
          value.max = Math.max(value.max, value.current)
          return value
        },
        { current: 0, max: 0 },
      ).max
    return {
      toolExecutionMs: execution,
      toolCriticalPathMs: critical,
      toolMaxConcurrency: concurrency,
      toolParallelism: critical > 0 ? execution / critical : undefined,
    }
  }

  function metadata(part: MessageV2.ToolPart) {
    if (part.state.status === "pending") return {}
    return part.state.metadata ?? {}
  }

  const kernelTools = new Set(["python", "r", "notebook", "rkernel"])

  function category(part: MessageV2.ToolPart): z.infer<typeof Tool>["category"] {
    if (part.tool === "task") return "child"
    if (kernelTools.has(part.tool)) return "kernel"
    if (SearchDedupe.applies(part.tool, part.state.input)) return "search"
    if (part.tool === "artifact") return "artifact"
    if (part.tool === "provenance_review") return "review"
    if (
      part.tool === "webfetch" ||
      part.tool === "science_fetch" ||
      part.tool === "atlas" ||
      part.tool.startsWith("query_")
    ) {
      return "external"
    }
    return "tool"
  }

  function errorMessage(error: unknown) {
    if (error instanceof Error) return error.message
    const record = object(error)
    const data = object(record?.data)
    return string(data?.message) ?? string(record?.message) ?? string(record?.name) ?? "Unknown model failure"
  }

  function runtimeGate(message: MessageV2.Assistant) {
    return /(?:research contract runtime budget is exhausted|bounded research run reached its (?:hard runtime limit|finalization boundary))/i.test(
      errorMessage(message.error),
    )
  }

  function query(input: Record<string, unknown>) {
    return ["query", "term", "symbol", "id", "operation"]
      .map((key) => string(input[key]))
      .find((value) => value !== undefined)
  }

  function useful(message: MessageV2.WithParts) {
    const values = message.parts.flatMap((part) => {
      if (part.type === "tool" && part.state.status === "completed") return [part.state.time.end]
      if (part.type === "text" && part.text.trim()) {
        return [
          part.time?.end ??
            part.time?.start ??
            (message.info.role === "assistant" ? message.info.time.completed : undefined),
        ]
      }
      return []
    })
    return values.filter((value): value is number => value !== undefined).toSorted((a, b) => a - b)[0]
  }

  /** `messages` lets a caller that already holds the complete, oldest-first
   * transcript skip a second read of the session. */
  export async function build(sessionID: string, options?: { messages?: MessageV2.WithParts[] }): Promise<Info> {
    const [session, messages, stored, allJobs, contract, storedVersions] = await Promise.all([
      Session.get(sessionID),
      options?.messages ?? Session.messages({ sessionID }),
      SessionTraceStore.read(sessionID),
      ComputeJobs.list().catch(() => [] as ComputeJobs.Job[]),
      SessionResearch.read(sessionID),
      ArtifactStore.listSessionVersions(Instance.project.id, sessionID),
    ])
    const now = Date.now()
    const users = new Map(
      messages.filter((message) => message.info.role === "user").map((message) => [message.info.id, message]),
    )
    const assistants = messages.filter(
      (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } => message.info.role === "assistant",
    )
    const parts = assistants.flatMap((message) =>
      message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"),
    )
    const scope = { projectID: Instance.project.id, directory: Instance.directory }
    const [reviews, graph] = await Promise.all([
      contract || parts.some((part) => part.tool === "provenance_review" || part.tool === "task")
        ? Review.list(scope).catch(() => [] as Review.Entry[])
        : [],
      contract ? Provenance.project(scope).catch(() => ({ nodes: [], edges: [] })) : { nodes: [], edges: [] },
    ])
    const tools = parts.map((part) => ({
      id: part.id,
      callID: part.callID,
      messageID: part.messageID,
      name: part.tool,
      category: category(part),
      status: observableToolStatus(part),
      title: part.state.status === "completed" ? part.state.title : undefined,
      ...times(part, now),
      inputHash: SearchDedupe.signature(part.state.input),
      inputKeys: Object.keys(part.state.input).toSorted(),
    }))
    const manifests = new Set(stored.harness.map((item) => item.messageID))
    const inference = assistants
      .filter((message) => {
        if (TaskAttempt.syntheticWrapper(message)) return false
        if (runtimeGate(message.info)) return false
        if (message.info.providerID === "openscience" && message.info.modelID === "local") return false
        if (manifests.has(message.info.id)) return true
        const tokens = message.info.tokens
        const used = TokenUsage.total(tokens)
        return message.info.cost > 0 || used > 0 || message.info.finish !== undefined
      })
      .map((message) => {
        const parent = users.get(message.info.parentID)
        const route = parent?.info.role === "user" ? parent.info.inference : undefined
        return {
          messageID: message.info.id,
          parentMessageID: message.info.parentID,
          agent: message.info.agent,
          model: message.info.modelID,
          provider: message.info.providerID,
          effort:
            message.info.reasoningEffort ??
            route?.effort ??
            (parent?.info.role === "user" ? parent.info.variant : undefined) ??
            "unknown",
          source: route?.source ?? ("unknown" as const),
          tier: parent?.info.role === "user" ? parent.info.tier : undefined,
          startedAt: message.info.time.created,
          completedAt: message.info.time.completed,
          durationMs: message.info.time.completed ? message.info.time.completed - message.info.time.created : undefined,
          cost: message.info.cost,
          tokens: message.info.tokens,
        }
      })
    const children = parts
      .filter((part) => part.tool === "task")
      .map((part) => {
        const meta = metadata(part)
        const model = object(meta.model)
        const usage = Usage.safeParse(meta.usage)
        return {
          toolID: part.id,
          sessionID: string(meta.sessionId),
          agent: string(part.state.input.subagent_type) ?? "unknown",
          model:
            string(model?.providerID) && string(model?.modelID)
              ? { providerID: string(model?.providerID)!, modelID: string(model?.modelID)! }
              : undefined,
          status: observableToolStatus(part),
          ...times(part, now),
          durationMs: number(meta.durationMs) ?? times(part, now).durationMs,
          toolCalls: number(meta.toolCalls),
          failedToolCalls: number(meta.failedToolCalls),
          usage: usage.success ? usage.data : undefined,
        }
      })
    const searches = parts
      .filter((part) => SearchDedupe.applies(part.tool, part.state.input))
      .map((part) => {
        const meta = metadata(part)
        const dedupe = object(meta.dedupeOf)
        return {
          toolID: part.id,
          messageID: part.messageID,
          tool: part.tool,
          query: query(part.state.input),
          signature: SearchDedupe.signature(part.state.input),
          status: observableToolStatus(part),
          dedupeHit: meta.dedupeHit === true,
          dedupeOf:
            string(dedupe?.messageID) && string(dedupe?.partID) && string(dedupe?.callID)
              ? {
                  messageID: string(dedupe?.messageID)!,
                  partID: string(dedupe?.partID)!,
                  callID: string(dedupe?.callID)!,
                }
              : undefined,
          ...times(part, now),
        }
      })
    const kernels = parts
      .filter((part) => kernelTools.has(part.tool))
      .map((part) => {
        const meta = metadata(part)
        return {
          toolID: part.id,
          messageID: part.messageID,
          language: part.tool === "python" || part.tool === "notebook" ? ("python" as const) : ("r" as const),
          kernel: string(part.state.input.kernel) ?? "agent",
          status: observableToolStatus(part),
          ...times(part, now),
          executionCount: number(meta.executionCount),
          provenanceID: string(meta.provenanceID),
        }
      })
    const jobs = allJobs
      .filter((job) => job.session_id === sessionID)
      .map((job) => {
        const startedAt = job.started_at ? Date.parse(job.started_at) : undefined
        const completedAt = job.completed_at ? Date.parse(job.completed_at) : undefined
        return {
          id: job.id,
          name: job.name,
          target: job.target.kind,
          targetLabel: job.target_label,
          status: job.status,
          createdAt: job.created_at,
          startedAt: job.started_at,
          lastActivityAt: job.last_activity_at,
          completedAt: job.completed_at,
          durationMs:
            startedAt !== undefined && Number.isFinite(startedAt)
              ? (completedAt !== undefined && Number.isFinite(completedAt) ? completedAt : now) - startedAt
              : undefined,
          exitCode: job.exit_code,
          resources: job.resources,
          artifactCount: job.artifacts?.length ?? 0,
        }
      })
    const storedByID = new Map(storedVersions.map((version) => [version.id, version]))
    const toolArtifacts = parts
      .filter(
        (part) =>
          part.tool === "artifact" && part.state.status === "completed" && part.state.input.action === "save_file",
      )
      .map((part) => {
        const meta = metadata(part)
        const saved = object(meta.savedArtifact)
        const reportedVersionID = string(saved?.versionID)
        const immutable = reportedVersionID ? storedByID.get(reportedVersionID) : undefined
        const versionID = immutable?.id ?? reportedVersionID
        const sha256 = immutable?.sha256 ?? string(saved?.sha256)
        const target = versionID && sha256 ? ArtifactStore.reviewTargetID(versionID, sha256) : undefined
        const edge = target ? graph.edges.find((item) => item.to === target && item.relation === "produced") : undefined
        const producer = edge ? graph.nodes.find((item) => item.id === edge.from && item.kind === "run") : undefined
        const producedAt = producer ? Date.parse(producer.recordedAt) : Number.NaN
        return {
          toolID: part.id,
          messageID: part.messageID,
          action: "save_file" as const,
          artifactID: immutable?.artifactID ?? string(saved?.id),
          versionID,
          path: immutable?.sourcePath ?? string(saved?.path) ?? string(part.state.input.path),
          kind: string(saved?.kind),
          sha256,
          provenanceID: producer?.id,
          producedAt: Number.isFinite(producedAt) ? producedAt : undefined,
          durable: true,
          completedAt: immutable?.createdAt ?? times(part, now).completedAt,
        }
      })
    const toolVersions = new Set(
      toolArtifacts.map((artifact) => artifact.versionID).filter((id): id is string => id !== undefined),
    )
    const artifacts = [
      ...toolArtifacts,
      ...storedVersions
        .filter((version) => !toolVersions.has(version.id))
        .map((version) => {
          const target = ArtifactStore.reviewTargetID(version.id, version.sha256)
          const edge = graph.edges.find((item) => item.to === target && item.relation === "produced")
          const producer = edge ? graph.nodes.find((item) => item.id === edge.from && item.kind === "run") : undefined
          const producedAt = producer ? Date.parse(producer.recordedAt) : Number.NaN
          return {
            toolID: `artifact-store:${version.id}`,
            messageID: version.messageID ?? `artifact-store:${sessionID}`,
            action: "save_file" as const,
            artifactID: version.artifactID,
            versionID: version.id,
            path: version.sourcePath,
            sha256: version.sha256,
            provenanceID: producer?.id,
            producedAt: Number.isFinite(producedAt) ? producedAt : undefined,
            durable: true,
            completedAt: version.createdAt,
          }
        }),
    ].toSorted((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0) || a.toolID.localeCompare(b.toolID))
    const persisted = reviews
      .filter((entry) => {
        const finding = (entry.finding.meta ?? {}) as Record<string, unknown>
        const target = (entry.targetNode?.meta ?? {}) as Record<string, unknown>
        return finding.sessionID === sessionID || target.sessionID === sessionID
      })
      .map((entry) => {
        const meta = (entry.finding.meta ?? {}) as Record<string, unknown>
        const severity =
          meta.severity === "blocking" ||
          meta.severity === "major" ||
          meta.severity === "minor" ||
          meta.severity === "info"
            ? meta.severity
            : undefined
        return {
          toolID: string(meta.callID) ?? entry.finding.id,
          messageID: string(meta.messageID) ?? `review:${entry.finding.id}`,
          id: entry.finding.id,
          target: entry.target,
          relation: entry.verdict,
          severity,
          claim: string(meta.claim),
          issue: string(meta.issue),
          evidence: string(meta.evidence),
          status: entry.status,
          completedAt: Number.isFinite(Date.parse(entry.finding.recordedAt))
            ? Date.parse(entry.finding.recordedAt)
            : undefined,
        }
      })
    const recorded = parts
      .filter((part) => part.tool === "provenance_review" && part.state.status === "completed")
      .map((part) => {
        const meta = metadata(part)
        const relation = meta.relation === "refutes" || meta.relation === "supports" ? meta.relation : undefined
        const severity =
          meta.severity === "blocking" ||
          meta.severity === "major" ||
          meta.severity === "minor" ||
          meta.severity === "info"
            ? meta.severity
            : undefined
        return {
          toolID: part.id,
          messageID: part.messageID,
          id: string(meta.id),
          target: string(meta.target),
          relation,
          severity,
          claim: string(part.state.input.claim),
          issue: string(part.state.input.issue),
          evidence: string(part.state.input.evidence),
          status: undefined,
          completedAt: times(part, now).completedAt,
        }
      })
    const ids = new Set(persisted.map((item) => item.id).filter((id): id is string => id !== undefined))
    const reviewerFindings = [...persisted, ...recorded.filter((item) => !item.id || !ids.has(item.id))]
    const failures: z.infer<typeof Failure>[] = [
      ...assistants
        .filter((message) => message.info.error)
        .map((message) => ({
          kind: runtimeGate(message.info) ? ("runtime" as const) : ("model" as const),
          id: message.info.id,
          message: errorMessage(message.info.error),
          createdAt: message.info.time.completed ?? message.info.time.created,
        })),
      ...parts
        .map((part) => ({ part, message: observableToolFailure(part) }))
        .filter((item): item is typeof item & { message: string } => item.message !== undefined)
        .map((part) => ({
          kind: "tool" as const,
          id: part.part.id,
          message: part.message,
          createdAt: times(part.part, now).completedAt ?? now,
        })),
      ...Object.values(stored.approvals)
        .filter((approval) => approval.reply === "reject")
        .map((approval) => ({
          kind: "approval" as const,
          id: approval.id,
          message: `${approval.permission} was rejected`,
          createdAt: approval.repliedAt ?? approval.requestedAt,
        })),
      ...jobs
        .filter((job) => job.status === "failed" || job.status === "interrupted")
        .map((job) => ({
          kind: "job" as const,
          id: job.id,
          message: `${job.name} ${job.status}`,
          createdAt: job.completedAt ? Date.parse(job.completedAt) : Date.parse(job.createdAt),
        })),
    ]
    const turns = Array.from(users.values()).map((user) => {
      const owned = assistants.filter((message) => message.info.parentID === user.info.id)
      const first = owned
        .map(useful)
        .filter((value): value is number => value !== undefined)
        .toSorted((a, b) => a - b)[0]
      const completed = owned
        .map((message) => message.info.time.completed)
        .filter((value): value is number => value !== undefined)
        .toSorted((a, b) => b - a)[0]
      const tokens = owned.reduce((total, message) => addTokens(total, message.info.tokens), emptyTokens())
      const ownedTools = owned.flatMap((message) =>
        message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"),
      )
      return {
        messageID: user.info.id,
        agent: user.info.role === "user" ? user.info.agent : "unknown",
        startedAt: user.info.time.created,
        firstUsefulOutputAt: first,
        timeToFirstUsefulOutputMs: first === undefined ? undefined : first - user.info.time.created,
        completedAt: completed,
        totalCompletionTimeMs: completed === undefined ? undefined : completed - user.info.time.created,
        toolCalls: ownedTools.length,
        childCount: ownedTools.filter((part) => part.tool === "task").length,
        cost: owned.reduce((total, message) => total + message.info.cost, 0),
        tokens,
      }
    })
    const startedAt = turns[0]?.startedAt ?? session.time.created
    const firstUsefulOutputAt = turns
      .map((turn) => turn.firstUsefulOutputAt)
      .filter((value): value is number => value !== undefined)
      .toSorted((a, b) => a - b)[0]
    const completedAt =
      SessionStatus.get(sessionID).type === "idle"
        ? turns
            .map((turn) => turn.completedAt)
            .filter((value): value is number => value !== undefined)
            .toSorted((a, b) => b - a)[0]
        : undefined
    const tokens = inference.reduce((total, item) => addTokens(total, item.tokens), emptyTokens())
    const timing = toolTiming(tools, now)
    const harness = stored.harness.at(-1)
    const inferenceCalls = Math.max(inference.length, stored.harness.length)
    const external: z.infer<typeof External>[] = [
      ...inference.map((item) => ({
        kind: "model" as const,
        id: item.messageID,
        name: `${item.provider}/${item.model}`,
        source: item.source,
        external: item.source !== "local",
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        cost: item.cost,
      })),
      ...parts
        .filter((part) => category(part) === "search" || category(part) === "external")
        .map((part) => ({
          kind: "api" as const,
          id: part.id,
          name: part.tool,
          source: part.tool === "atlas" ? "atlas" : "network",
          external: true,
          startedAt: times(part, now).startedAt,
          completedAt: times(part, now).completedAt,
        })),
      ...jobs.map((job) => ({
        kind: "compute" as const,
        id: job.id,
        name: job.name,
        source: job.target,
        external: job.target === "ssh" || job.target === "modal",
        startedAt: job.startedAt ? Date.parse(job.startedAt) : undefined,
        completedAt: job.completedAt ? Date.parse(job.completedAt) : undefined,
      })),
    ]
    const approvals = Object.values(stored.approvals).toSorted((a, b) => a.requestedAt - b.requestedAt)
    const research = SessionResearch.assess(contract, {
      artifacts,
      jobs,
      kernels,
      busy: SessionStatus.get(sessionID).type !== "idle",
    })
    const harnessReport = SessionHarness.analyze({
      records: stored.harness,
      inference: inference.map((item) => ({
        messageID: item.messageID,
        parentMessageID: item.parentMessageID,
        provider: item.provider,
        model: item.model,
        attempt: stored.retries
          .filter((retry) => retry.messageID === item.messageID)
          .reduce((attempt, retry) => Math.max(attempt, retry.attempt + 1), 1),
      })),
      tools: tools.map((item) => ({
        id: item.id,
        messageID: item.messageID,
        name: item.name,
        inputHash: item.inputHash,
        status: item.status,
      })),
    })
    return Info.parse({
      version: 1,
      session: {
        id: session.id,
        parentID: session.parentID,
        title: session.title,
        status: SessionStatus.get(sessionID).type,
        createdAt: session.time.created,
        updatedAt: session.time.updated,
      },
      summary: {
        startedAt,
        firstUsefulOutputAt,
        timeToFirstUsefulOutputMs: firstUsefulOutputAt === undefined ? undefined : firstUsefulOutputAt - startedAt,
        completedAt,
        totalCompletionTimeMs: completedAt === undefined ? undefined : completedAt - startedAt,
        cost: inference.reduce((total, item) => total + item.cost, 0),
        tokens,
        inferenceCalls,
        toolCalls: tools.length,
        toolCallsPerInference: inferenceCalls ? tools.length / inferenceCalls : undefined,
        ...timing,
        toolContractBytes: harness?.toolBytes,
        contractBytes: harness?.contractBytes,
        childCount: children.length,
        searchCount: searches.length,
        dedupeHits: searches.filter((search) => search.dedupeHit).length,
        approvalCount: approvals.length,
        artifactSaves: artifacts.length,
        reviewerFindings: reviewerFindings.length,
        failureCount: failures.length,
        retryCount: stored.retries.length,
      },
      turns,
      inference,
      tools,
      children,
      searches,
      kernels,
      jobs,
      approvals,
      external,
      artifacts,
      reviewerFindings,
      failures,
      retries: stored.retries,
      harness: stored.harness,
      harnessReport,
      research: {
        ...research,
        ...(contract ? { contract } : {}),
      },
      privacy: {
        local: true,
        atlasRequired: false,
        hiddenReasoningStored: false,
        toolOutputsCopied: false,
        promptContentStored: false,
      },
    })
  }
}
