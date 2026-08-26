import { createHash } from "node:crypto"
import type { MessageV2 } from "./message-v2"

export namespace SessionLoopState {
  export type Continuation = "output" | "contract" | "compaction" | "task"

  export type Info = {
    epoch?: string
    step: number
    outputContinuations: number
    contractContinuations: number
    overflowCompactions: number
  }

  export type PendingCompaction = {
    carrier: MessageV2.WithParts & { info: MessageV2.User }
    summary: MessageV2.WithParts & { info: MessageV2.Assistant }
    finalized: boolean
    continuation: boolean
  }

  type CompactionEvent = {
    type: "compaction"
    transaction?: string
    before?: number
    reclaimed: number
  }

  type CompactionFinalized = {
    type: "compaction-finalized"
    transaction: string
    summaryID: string
    trigger: "proactive" | "overflow" | "manual"
    before: number
    reclaimed: number
  }

  const key = "openscience.loop"

  export function partID(transaction: string, slot: string) {
    const digest = createHash("sha256").update(`${transaction}:${slot}`).digest("hex")
    return `prt_${digest.slice(0, 26)}`
  }

  export function prompt(epoch: string): NonNullable<MessageV2.User["internal"]> {
    return { type: "prompt", epoch }
  }

  export function intent(input: {
    kind: Continuation
    text: string
    epoch: string
    transaction: string
  }): NonNullable<MessageV2.User["internal"]> {
    return {
      type: "continuation",
      kind: input.kind,
      text: input.text,
      epoch: input.epoch,
      transaction: input.transaction,
    }
  }

  export function controls(message: MessageV2.User) {
    return {
      system: message.system,
      tools: message.tools,
      delegation: message.delegation,
      delegationSettings: message.delegationSettings,
      variant: message.variant,
      tier: message.tier,
      inference: message.inference,
    }
  }

  export function messageEpoch(message: MessageV2.User) {
    return message.internal?.epoch
  }

  /** Read-time compatibility only. Retired reviewer continuations resume as a
   * normal task on the current research agent; no reviewer profile or writable
   * review workflow is reintroduced. */
  function compatibleContinuation(value: unknown): Continuation | undefined {
    if (value === "output" || value === "contract" || value === "compaction" || value === "task") return value
    if (value === "review" || value === "review-summary") return "task"
  }

  export function messageKind(message: MessageV2.User): Continuation | undefined {
    if (message.internal?.type !== "continuation") return
    if (message.internal.transaction !== message.id) return
    return compatibleContinuation((message.internal as { kind?: unknown }).kind)
  }

  export function continuation(kind: Continuation) {
    return {
      [key]: {
        version: 2,
        type: "continuation",
        kind,
      },
    }
  }

  export function compaction(input: Omit<CompactionEvent, "type">) {
    return {
      [key]: {
        version: 2,
        type: "compaction",
        transaction: input.transaction,
        before: input.before,
        reclaimed: input.reclaimed,
      },
    }
  }

  export function compactionReset(transaction?: string) {
    return {
      [key]: {
        version: 2,
        type: "compaction-reset",
        transaction,
      },
    }
  }

  export function compactionFinalized(input: Omit<CompactionFinalized, "type">) {
    return {
      [key]: {
        version: 2,
        type: "compaction-finalized",
        ...input,
      },
    }
  }

  function metadata(part: MessageV2.Part) {
    if (part.type !== "text") return
    const value = part.metadata?.[key]
    if (!value || typeof value !== "object") return
    return value as Record<string, unknown>
  }

  function legacy(part: MessageV2.Part): Continuation | undefined {
    if (part.type !== "text" || !part.synthetic) return
    if (part.text.startsWith("Your previous response reached the output limit")) return "output"
    if (part.text.startsWith("The durable research completion contract is not satisfied yet.")) return "contract"
    if (part.text.startsWith("Independent review completed")) return "task"
    if (part.text.startsWith("Run an independent review of")) return "task"
  }

  export function continuationKind(part: MessageV2.Part): Continuation | undefined {
    const value = metadata(part)
    if ((value?.version === 1 || value?.version === 2) && value.type === "continuation") {
      return compatibleContinuation(value.kind)
    }
    return legacy(part)
  }

  export function external(message: MessageV2.WithParts) {
    if (message.info.role !== "user") return false
    if (message.info.internal?.type === "prompt") return true
    return message.parts.some((part) => {
      if (part.type === "text") return !part.synthetic && !part.ignored
      if (part.type === "compaction") return !part.auto
      return part.type === "file" || part.type === "agent" || part.type === "conversation" || part.type === "subtask"
    })
  }

  export function currentEpoch(messages: MessageV2.WithParts[]) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.info.role !== "user") continue
      if (message.info.internal?.epoch) return message.info.internal.epoch
      if (external(message)) return message.info.id
    }
  }

  function scope(messages: MessageV2.WithParts[]) {
    const epoch = currentEpoch(messages)
    if (!epoch) return { epoch, messages, legacy: true }
    const anchor = messages.findIndex(
      (message) =>
        message.info.role === "user" && (message.info.id === epoch || message.info.internal?.epoch === epoch),
    )
    const selected = anchor === -1 ? messages : messages.slice(anchor)
    const modern = selected.some((message) => message.info.role === "user" && !!message.info.internal?.epoch)
    return { epoch, messages: selected, legacy: !modern }
  }

  /** Rebuild bounded loop counters from one durable user-turn epoch. New
   * sessions use immutable message intent; prefix/metadata recognition is
   * confined to an epoch containing no durable epoch markers. */
  export function restore(messages: MessageV2.WithParts[]): Info {
    const selected = scope(messages)
    const users = new Map(
      selected.messages
        .filter((message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user")
        .map((message) => [message.info.id, message.info] as const),
    )
    const state = selected.messages.reduce<Info & { durableStep?: number }>(
      (state, message) => {
        if (message.info.role === "assistant") {
          const parent = users.get(message.info.parentID)
          const related =
            selected.legacy || (!!parent && (parent.internal?.epoch === selected.epoch || parent.id === selected.epoch))
          if (!related) return state
          const summary = message.info.summary === true
          const finished = !!message.info.finish
          const stepped = !message.info.error || message.parts.length > 0 || summary
          return {
            ...state,
            step: state.step + Number(stepped),
            durableStep: Math.max(state.durableStep ?? 0, message.info.internal?.step ?? 0) || undefined,
            outputContinuations:
              finished && message.info.finish !== "length" && !summary ? 0 : state.outputContinuations,
            overflowCompactions: summary
              ? state.overflowCompactions
              : message.info.finish === "compact"
                ? state.overflowCompactions + 1
                : finished
                  ? 0
                  : state.overflowCompactions,
          }
        }
        const kind = messageKind(message.info)
        const kinds = kind
          ? [kind]
          : selected.legacy
            ? message.parts.flatMap((part) => {
                const found = legacy(part)
                return found ? [found] : []
              })
            : []
        return kinds.reduce<Info & { durableStep?: number }>((next, value) => {
          if (value === "output") return { ...next, outputContinuations: next.outputContinuations + 1 }
          if (value === "contract") return { ...next, contractContinuations: next.contractContinuations + 1 }
          return next
        }, state)
      },
      {
        epoch: selected.epoch,
        step: 0,
        outputContinuations: 0,
        contractContinuations: 0,
        overflowCompactions: 0,
      },
    )
    return {
      epoch: selected.epoch,
      step: state.durableStep ?? state.step,
      outputContinuations: state.outputContinuations,
      contractContinuations: state.contractContinuations,
      overflowCompactions: state.overflowCompactions,
    }
  }

  export function incomplete(messages: MessageV2.WithParts[]) {
    const selected = scope(messages)
    return selected.messages.filter((message): message is MessageV2.WithParts & { info: MessageV2.User } => {
      if (message.info.role !== "user") return false
      const intent = message.info.internal
      if (intent?.type === "compaction") {
        const id = partID(intent.transaction || message.info.id, "carrier")
        return !message.parts.some((part) => part.id === id && part.type === "compaction")
      }
      if (intent?.type !== "continuation") return false
      const kind = compatibleContinuation(intent.kind)
      if (!kind) return false
      const id = partID(intent.transaction || message.info.id, "continuation")
      const legacyReviewer = intent.kind === "review" || intent.kind === "review-summary"
      return !message.parts.some(
        (part) => (part.id === id || legacyReviewer) && part.type === "text" && continuationKind(part) === kind,
      )
    })
  }

  export function repair(message: MessageV2.User) {
    const intent = message.internal
    if (intent?.type === "compaction") {
      return {
        id: partID(intent.transaction || message.id, "carrier"),
        type: "compaction" as const,
        auto: intent.auto,
        focus: intent.focus,
        handoffFile: intent.handoffFile,
        trigger: intent.trigger,
      }
    }
    if (intent?.type !== "continuation") return
    const kind = compatibleContinuation(intent.kind)
    if (!kind) return
    return {
      id: partID(intent.transaction || message.id, "continuation"),
      type: "text" as const,
      text: intent.text,
      synthetic: true,
      metadata: continuation(kind),
    }
  }

  export function overflowRecovery(input: {
    assistant?: MessageV2.Assistant
    unanswered: boolean
    attempts: number
  }): "none" | "compact" | "fail" {
    if (!input.unanswered || input.assistant?.finish !== "compact") return "none"
    if (input.assistant.summary === true || input.attempts > 1) return "fail"
    return "compact"
  }

  export function terminalError(input: { user: MessageV2.User; assistant?: MessageV2.Assistant }) {
    return !!input.assistant?.error && input.assistant.parentID === input.user.id
  }

  function isFinalized(
    carrier: MessageV2.WithParts & { info: MessageV2.User },
    summary: MessageV2.WithParts & { info: MessageV2.Assistant },
  ) {
    const intent = carrier.info.internal
    if (intent?.type !== "compaction") return false
    const transaction = intent.transaction || carrier.info.id
    return carrier.parts.some((part) => {
      if (part.id !== partID(transaction, "finalization")) return false
      const value = metadata(part)
      return (
        value?.version === 2 &&
        value.type === "compaction-finalized" &&
        value.transaction === transaction &&
        value.summaryID === summary.info.id
      )
    })
  }

  /** Locate a completed compaction transaction that still needs idempotent
   * finalization and/or its automatic continuation. Ignored command notices do
   * not supersede an interrupted turn; a new substantive prompt does. */
  export function pendingCompaction(messages: MessageV2.WithParts[]): PendingCompaction | undefined {
    const index = messages.findLastIndex(
      (message) =>
        message.info.role === "assistant" &&
        message.info.summary === true &&
        !!message.info.finish &&
        !message.info.error &&
        message.info.finish !== "compact",
    )
    if (index === -1) return
    const summary = messages[index] as MessageV2.WithParts & { info: MessageV2.Assistant }
    const carrier = messages.find(
      (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
        message.info.role === "user" && message.info.id === summary.info.parentID,
    )
    if (!carrier || carrier.info.internal?.type !== "compaction") return
    const intent = carrier.info.internal
    const finalized = isFinalized(carrier, summary)
    const after = messages.slice(index + 1)
    const continued = after.some(
      (message) =>
        message.info.role === "user" &&
        message.info.internal?.type === "continuation" &&
        message.info.internal.kind === "compaction" &&
        message.info.internal.transaction === message.info.id &&
        message.info.id === intent.continuationID &&
        message.info.internal.epoch === intent.epoch,
    )
    const superseded = after.some(external)
    const continuation = intent.auto && !continued && !superseded
    if (finalized && !continuation) return
    return { carrier, summary, finalized, continuation }
  }

  export function breaker(messages: MessageV2.WithParts[], ratio: number) {
    const apply = (count: number, value: Record<string, unknown>) => {
      if (value.type === "compaction-reset") return 0
      if (value.type !== "compaction" && value.type !== "compaction-finalized") return count
      if (value.type === "compaction-finalized" && value.trigger === "manual") return count
      const before = typeof value.before === "number" ? value.before : undefined
      const reclaimed = typeof value.reclaimed === "number" ? value.reclaimed : undefined
      if (!before || before <= 0 || reclaimed === undefined) return count
      return reclaimed / before >= ratio ? 0 : count + 1
    }
    const modern = messages.some((message) => message.info.role === "user" && !!message.info.internal?.epoch)
    if (!modern) {
      return messages.reduce(
        (count, message) =>
          message.info.role !== "user"
            ? count
            : message.parts.reduce((next, part) => {
                const value = metadata(part)
                if (value?.version !== 1 && value?.version !== 2) return next
                if (value.type !== "compaction" && value.type !== "compaction-reset") return next
                return apply(next, value)
              }, count),
        0,
      )
    }

    // Modern markers are accepted only when their transaction points back to
    // runtime-owned transcript state. Sorting by that monotonic transaction ID
    // keeps replay order independent of the hashed deterministic part IDs.
    const users = new Map(
      messages
        .filter((message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user")
        .map((message) => [message.info.id, message] as const),
    )
    const assistants = new Map(
      messages
        .filter(
          (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
            message.info.role === "assistant",
        )
        .map((message) => [message.info.id, message] as const),
    )
    const events = messages
      .flatMap((message) => {
        if (message.info.role !== "user") return []
        const info = message.info
        const internal = info.internal
        if (!internal?.epoch) return []
        const epoch = internal.epoch
        return message.parts.flatMap((part) => {
          const value = metadata(part)
          if (value?.version !== 2) return []
          if (value.type === "compaction-finalized") {
            if (info.internal?.type !== "compaction") return []
            const transaction = info.internal.transaction
            const summaryID = typeof value.summaryID === "string" ? value.summaryID : undefined
            const summary = summaryID ? assistants.get(summaryID) : undefined
            if (value.transaction !== transaction || part.id !== partID(transaction, "finalization")) return []
            if (!summary || summary.info.parentID !== info.id || !summary.info.summary || !summary.info.internal?.step)
              return []
            return [{ transaction, value }]
          }
          if (value.type !== "compaction" && value.type !== "compaction-reset") return []
          const transaction = typeof value.transaction === "string" ? value.transaction : undefined
          const slot = value.type === "compaction-reset" ? "breaker-reset" : "breaker"
          if (!transaction || part.id !== partID(transaction, slot)) return []
          if (value.type === "compaction-reset" && info.internal?.type === "prompt" && transaction === info.id) {
            return [{ transaction, value }]
          }
          const assistant = assistants.get(transaction)
          if (!assistant?.info.internal?.step || assistant.info.parentID !== info.id) return []
          const parent = users.get(assistant.info.parentID)
          if (!parent?.info.internal?.epoch || parent.info.internal.epoch !== epoch) return []
          return [{ transaction, value }]
        })
      })
      .sort((a, b) => a.transaction.localeCompare(b.transaction))
    return events.reduce((count, event) => apply(count, event.value), 0)
  }

  export function protectedPart(message: MessageV2.User, part: MessageV2.Part) {
    const intent = message.internal
    if (intent?.type === "continuation") {
      return part.id === partID(intent.transaction || message.id, "continuation")
    }
    if (intent?.type === "compaction") {
      const transaction = intent.transaction || message.id
      return part.id === partID(transaction, "carrier") || part.id === partID(transaction, "finalization")
    }
    return false
  }

  function reserved(part: MessageV2.Part) {
    return part.type === "text" && !!part.metadata && Object.hasOwn(part.metadata, key)
  }

  function owned(message: MessageV2.User | MessageV2.Assistant, part: MessageV2.Part) {
    if (reserved(part)) return true
    if (message.role === "assistant") return message.summary === true
    return protectedPart(message, part)
  }

  /** Public part edits may change the text of an existing ordinary part, but
   * cannot mint parts or mutate runtime ownership/metadata. */
  export function validatePartUpdate(input: {
    message: MessageV2.User | MessageV2.Assistant
    previous?: MessageV2.Part
    next: MessageV2.Part
  }) {
    if (!input.previous) return "Part does not exist"
    if (owned(input.message, input.previous)) {
      return "Runtime-owned session parts cannot be edited"
    }
    if (input.previous.type !== input.next.type) return "Part type cannot be edited"
    if (reserved(input.next)) {
      return "Reserved OpenScience runtime metadata cannot be edited"
    }
    if (input.previous.type === "text" && input.next.type === "text") {
      if (input.previous.synthetic !== input.next.synthetic || input.previous.ignored !== input.next.ignored) {
        return "Text visibility and ownership cannot be edited"
      }
    }
  }

  export function validatePartDelete(input: { message: MessageV2.User | MessageV2.Assistant; part?: MessageV2.Part }) {
    if (!input.part) return "Part does not exist"
    if (owned(input.message, input.part)) return "Runtime-owned session parts cannot be deleted"
  }
}
