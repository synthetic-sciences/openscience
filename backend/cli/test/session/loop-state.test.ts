import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionLoopState } from "../../src/session/loop-state"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

function text(id: string, value: string, input?: { synthetic?: boolean; kind?: SessionLoopState.Continuation }) {
  return {
    id: input?.kind ? SessionLoopState.partID(id, "continuation") : `${id}_part`,
    messageID: id,
    sessionID: "ses_test",
    type: "text" as const,
    text: value,
    synthetic: input?.synthetic,
    metadata: input?.kind ? SessionLoopState.continuation(input.kind) : undefined,
  }
}

function user(id: string, parts: MessageV2.Part[], kind?: SessionLoopState.Continuation): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: 1 },
      agent: "research",
      model: { providerID: "test", modelID: "test" },
      effort: "normal",
      internal: kind
        ? SessionLoopState.intent({
            kind,
            text: parts.find((part) => part.type === "text")?.text ?? "continue",
            epoch: "u1",
            transaction: id,
          })
        : undefined,
    },
    parts,
  }
}

function assistant(id: string, parentID: string, finish: string, summary = false, step?: number): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      parentID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      mode: summary ? "compaction" : "research",
      agent: summary ? "compaction" : "research",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens,
      modelID: "test",
      providerID: "test",
      internal: step ? { step } : undefined,
      finish,
      summary: summary || undefined,
    },
    parts: [],
  }
}

describe("session loop restart state", () => {
  test("output recovery remains resumable after a transcript reload", () => {
    const history = [
      user("u1", [text("u1", "build the project")]),
      assistant("a1", "u1", "length"),
      user("c1", [text("c1", "continue", { synthetic: true, kind: "output" })], "output"),
      assistant("a2", "c1", "length"),
      user("c2", [text("c2", "continue", { synthetic: true, kind: "output" })], "output"),
      assistant("a3", "c2", "length"),
    ]
    const reloaded = JSON.parse(JSON.stringify(history)) as MessageV2.WithParts[]
    const state = SessionLoopState.restore(reloaded)
    expect(state).toMatchObject({ step: 3, outputContinuations: 2 })
    expect(
      MessageV2.outputRecovery({
        finish: "length",
        unanswered: true,
        bare: false,
        attempts: state.outputContinuations,
      }),
    ).toBe("continue")
  })

  test("a completed non-length response resets only output recovery", () => {
    const history = [
      user("u1", [text("u1", "run")]),
      assistant("a1", "u1", "length"),
      user("c1", [text("c1", "continue", { synthetic: true, kind: "output" })], "output"),
      assistant("a2", "c1", "tool-calls"),
      user("c2", [text("c2", "contract", { synthetic: true, kind: "contract" })], "contract"),
    ]
    expect(SessionLoopState.restore(history)).toMatchObject({
      step: 2,
      outputContinuations: 0,
      contractContinuations: 1,
    })
  })

  test("research contract bounds survive restart and reset on a real user turn", () => {
    const history = [
      user("u1", [text("u1", "research this")]),
      assistant("a1", "u1", "stop"),
      user("c1", [text("c1", "contract", { synthetic: true, kind: "contract" })], "contract"),
    ]
    expect(SessionLoopState.restore(history)).toMatchObject({
      step: 1,
      contractContinuations: 1,
    })
    expect(SessionLoopState.restore([...history, user("u2", [text("u2", "new request")])])).toEqual({
      epoch: "u2",
      step: 0,
      outputContinuations: 0,
      contractContinuations: 0,
      overflowCompactions: 0,
      preflightRecoveries: 0,
    })
  })

  test("does not charge a pre-step terminal error as a model step", () => {
    const error = assistant("e1", "u1", "stop")
    if (error.info.role !== "assistant") throw new Error("bad fixture")
    error.info.finish = undefined
    error.info.error = { name: "UnknownError", data: { message: "request is too large" } }
    expect(SessionLoopState.restore([user("u1", [text("u1", "oversized")]), error]).step).toBe(0)

    error.parts.push({
      id: "step1",
      messageID: error.info.id,
      sessionID: error.info.sessionID,
      type: "step-start",
    })
    expect(SessionLoopState.restore([user("u1", [text("u1", "oversized")]), error]).step).toBe(1)
  })

  test("a durable terminal error is not retried unless a newer prompt exists", () => {
    const request = user("001", [text("001", "run")])
    const error = assistant("002", "001", "")
    if (request.info.role !== "user" || error.info.role !== "assistant") throw new Error("bad fixture")
    error.info.error = { name: "UnknownError", data: { message: "insufficient balance" } }
    expect(SessionLoopState.terminalError({ user: request.info, assistant: error.info })).toBe(true)
    const retry = user("003", [text("003", "try again")])
    if (retry.info.role !== "user") throw new Error("bad fixture")
    expect(SessionLoopState.terminalError({ user: retry.info, assistant: error.info })).toBe(false)
    const delayed = assistant("004", "001", "")
    if (delayed.info.role !== "assistant") throw new Error("bad fixture")
    delayed.info.error = error.info.error
    expect(SessionLoopState.terminalError({ user: retry.info, assistant: delayed.info })).toBe(false)
  })

  test.each(["compaction", "continuation"] as const)(
    "a %s record cannot restart a terminal error attached to its real prompt",
    (type) => {
      const carrier = user("c1", [], "compaction")
      const error = assistant("e1", "u1", "")
      if (carrier.info.role !== "user" || error.info.role !== "assistant") throw new Error("bad fixture")
      if (type === "compaction") carrier.info.internal = { type, auto: true, epoch: "u1", transaction: "c1" }
      error.info.error = { name: "UnknownError", data: { message: "assembled conversation exceeds input limit" } }
      expect(SessionLoopState.terminalError({ user: carrier.info, assistant: error.info })).toBe(true)

      const unrelated = { ...carrier.info, internal: { ...carrier.info.internal!, epoch: "u2" } }
      expect(SessionLoopState.terminalError({ user: unrelated, assistant: error.info })).toBe(false)
      const fresh = user("u2", [text("u2", "a genuine new request")])
      if (fresh.info.role !== "user") throw new Error("bad fixture")
      fresh.info.internal = SessionLoopState.prompt("u2")
      expect(SessionLoopState.terminalError({ user: fresh.info, assistant: error.info })).toBe(false)
      // Only synthetic carriers inherit the old stop; even a malformed real
      // prompt with a stale epoch must not be mistaken for a continuation.
      fresh.info.internal = SessionLoopState.prompt("u1")
      expect(SessionLoopState.terminalError({ user: fresh.info, assistant: error.info })).toBe(false)
    },
  )

  test("an atomic assistant claim restores the exact step and ignores unrelated assistants", () => {
    const command: MessageV2.TextPart = { ...text("cmd", "/status"), ignored: true }
    const history = [
      user("u1", [text("u1", "research")]),
      assistant("a1", "u1", "tool-calls"),
      assistant("a2", "u1", "tool-calls", false, 2),
      user("cmd", [command]),
      assistant("notice", "cmd", "stop"),
    ]
    expect(SessionLoopState.restore(history).step).toBe(2)
    expect(SessionLoopState.restore(history.slice(0, 2)).step).toBe(1)
    expect(SessionLoopState.restore([...history.slice(0, 2), assistant("a2", "u1", "", false, 2)]).step).toBe(2)
  })

  test("ignored command assistants cannot reset modern turn counters", () => {
    const source = user("u1", [text("u1", "research")])
    if (source.info.role !== "user") throw new Error("bad fixture")
    source.info.internal = SessionLoopState.prompt(source.info.id)
    const continuation = user("c1", [text("c1", "continue", { synthetic: true, kind: "output" })], "output")
    const command: MessageV2.TextPart = { ...text("cmd", "/status"), ignored: true }
    const history = [
      source,
      assistant("a1", "u1", "length", false, 1),
      continuation,
      user("cmd", [command]),
      assistant("notice", "cmd", "stop"),
    ]
    expect(SessionLoopState.restore(history)).toMatchObject({ step: 1, outputContinuations: 1 })
  })

  test("manual compaction and subtask-only prompts begin fresh step epochs", () => {
    const source = user("u1", [text("u1", "long research")])
    if (source.info.role !== "user") throw new Error("bad fixture")
    source.info.internal = SessionLoopState.prompt(source.info.id)
    const history = [source, assistant("a1", "u1", "tool-calls", false, 9)]
    const command = user("cmd", [
      {
        id: "cmd_part",
        messageID: "cmd",
        sessionID: "ses_test",
        type: "subtask",
        prompt: "inspect",
        description: "bounded inspection",
        agent: "execute",
      },
    ])
    if (command.info.role !== "user") throw new Error("bad fixture")
    command.info.internal = SessionLoopState.prompt(command.info.id)
    expect(SessionLoopState.restore([...history, command])).toEqual({
      epoch: "cmd",
      step: 0,
      outputContinuations: 0,
      contractContinuations: 0,
      overflowCompactions: 0,
      preflightRecoveries: 0,
    })

    const manual = user("compact", [
      {
        id: SessionLoopState.partID("compact", "carrier"),
        messageID: "compact",
        sessionID: "ses_test",
        type: "compaction",
        auto: false,
        trigger: "manual",
      },
    ])
    if (manual.info.role !== "user") throw new Error("bad fixture")
    manual.info.internal = {
      type: "compaction",
      auto: false,
      epoch: manual.info.id,
      transaction: manual.info.id,
      trigger: "manual",
    }
    expect(SessionLoopState.restore([...history, manual])).toMatchObject({ epoch: "compact", step: 0 })
  })

  test("overflow and step limits include compaction work after restart", () => {
    const history = [
      user("u1", [text("u1", "oversized request")]),
      assistant("a1", "u1", "compact"),
      user("cc1", [
        {
          id: "cc1_part",
          messageID: "cc1",
          sessionID: "ses_test",
          type: "compaction",
          auto: true,
          trigger: "overflow",
        },
      ]),
      assistant("s1", "cc1", "stop", true),
      user("c1", [text("c1", "continue", { synthetic: true })]),
      assistant("a2", "c1", "compact"),
    ]
    expect(SessionLoopState.restore(JSON.parse(JSON.stringify(history)))).toMatchObject({
      step: 3,
      overflowCompactions: 2,
    })
  })

  test("recovers only an automatic summary missing its post-compaction continuation", () => {
    const carrier = user("cc1", [
      {
        id: "cc1_part",
        messageID: "cc1",
        sessionID: "ses_test",
        type: "compaction",
        auto: true,
        trigger: "proactive",
      },
    ])
    if (carrier.info.role !== "user") throw new Error("bad fixture")
    carrier.info.internal = {
      type: "compaction",
      auto: true,
      epoch: "u1",
      transaction: "cc1",
      trigger: "proactive",
      continuationID: "c1",
    }
    carrier.parts[0]!.id = SessionLoopState.partID("cc1", "carrier")
    const interrupted = [user("u1", [text("u1", "research")]), carrier, assistant("s1", "cc1", "stop", true)]
    expect(SessionLoopState.pendingCompaction(JSON.parse(JSON.stringify(interrupted)))?.carrier.info.id).toBe("cc1")
    expect(
      SessionLoopState.pendingCompaction([
        ...interrupted,
        user(
          "c1",
          [text("c1", "Continue from the 'Next Move'", { synthetic: true, kind: "compaction" })],
          "compaction",
        ),
      ]),
    ).toMatchObject({ finalized: false, continuation: false })

    const manual = user("cc2", [
      {
        id: "cc2_part",
        messageID: "cc2",
        sessionID: "ses_test",
        type: "compaction",
        auto: false,
        trigger: "manual",
      },
    ])
    if (manual.info.role !== "user") throw new Error("bad fixture")
    manual.info.internal = {
      type: "compaction",
      auto: false,
      epoch: "cc2",
      transaction: "cc2",
      trigger: "manual",
    }
    manual.parts[0]!.id = SessionLoopState.partID("cc2", "carrier")
    expect(SessionLoopState.pendingCompaction([manual, assistant("s2", "cc2", "stop", true)])?.continuation).toBe(false)
  })

  test("ignored command notices do not suppress compaction recovery", () => {
    const carrier = user("cc1", [
      {
        id: SessionLoopState.partID("cc1", "carrier"),
        messageID: "cc1",
        sessionID: "ses_test",
        type: "compaction",
        auto: true,
        trigger: "proactive",
      },
    ])
    if (carrier.info.role !== "user") throw new Error("bad fixture")
    carrier.info.internal = {
      type: "compaction",
      auto: true,
      epoch: "u1",
      transaction: "cc1",
      trigger: "proactive",
      continuationID: "c1",
    }
    const summary = assistant("s1", "cc1", "stop", true)
    const notice = user("cmd", [{ ...text("cmd", "/status"), ignored: true }])
    const report = assistant("notice", "cmd", "stop")
    expect(SessionLoopState.pendingCompaction([carrier, summary, notice, report])).toMatchObject({
      finalized: false,
      continuation: true,
    })
    expect(
      SessionLoopState.pendingCompaction([carrier, summary, notice, report, user("u2", [text("u2", "new work")])]),
    ).toMatchObject({ finalized: false, continuation: false })
  })

  test("repairs the durable empty half of text and manual compaction enqueues in place", () => {
    const carrier = user("cc1", [
      {
        id: "cc1_part",
        messageID: "cc1",
        sessionID: "ses_test",
        type: "compaction",
        auto: true,
        trigger: "proactive",
      },
    ])
    if (carrier.info.role !== "user") throw new Error("bad fixture")
    carrier.info.internal = {
      type: "compaction",
      auto: true,
      epoch: "u1",
      transaction: "cc1",
      trigger: "proactive",
      continuationID: "c1",
    }
    carrier.parts[0]!.id = SessionLoopState.partID("cc1", "carrier")
    const summary = assistant("s1", "cc1", "stop", true)
    const empty = user("c1", [], "compaction")
    const interrupted = [user("u1", [text("u1", "research")]), carrier, summary, empty]
    expect(
      SessionLoopState.incomplete(JSON.parse(JSON.stringify(interrupted))).map((message) => message.info.id),
    ).toEqual(["c1"])
    expect(SessionLoopState.pendingCompaction(interrupted)).toMatchObject({ finalized: false, continuation: false })
    if (empty.info.role !== "user") throw new Error("bad fixture")
    expect(SessionLoopState.repair(empty.info)).toEqual({
      id: SessionLoopState.partID("c1", "continuation"),
      type: "text",
      text: "continue",
      synthetic: true,
      metadata: SessionLoopState.continuation("compaction"),
    })

    const complete = user(
      "c2",
      [text("c2", "Continue from the handoff", { synthetic: true, kind: "compaction" })],
      "compaction",
    )
    expect(SessionLoopState.incomplete([...interrupted.slice(0, -1), complete])).toHaveLength(0)
    const manual = user("manual", [])
    if (manual.info.role !== "user") throw new Error("bad fixture")
    manual.info.internal = {
      type: "compaction",
      auto: false,
      epoch: "manual",
      transaction: "manual",
      focus: "citations",
      handoffFile: "handoff.md",
      trigger: "manual",
    }
    expect(SessionLoopState.incomplete([manual])).toHaveLength(1)
    expect(SessionLoopState.repair(manual.info)).toEqual({
      id: SessionLoopState.partID("manual", "carrier"),
      type: "compaction",
      auto: false,
      focus: "citations",
      handoffFile: "handoff.md",
      trigger: "manual",
    })
    // Neither an unmarked empty prompt nor a user-supplied tools key is an
    // internal write gap.
    expect(SessionLoopState.incomplete([user("u2", [])])).toHaveLength(0)
    const forged = user("u3", [text("u3", "real prompt")])
    if (forged.info.role !== "user") throw new Error("bad fixture")
    forged.info.tools = { __openscience_internal_continuation_output: false }
    expect(SessionLoopState.incomplete([forged])).toHaveLength(0)
    expect(SessionLoopState.incomplete([empty, user("u4", [text("u4", "new request")])])).toHaveLength(0)
  })

  test("continuations preserve delegation and per-turn provider controls", () => {
    const source = user("u1", [text("u1", "research")])
    if (source.info.role !== "user") throw new Error("bad fixture")
    source.info.tools = { task: false, bash: false }
    source.info.delegation = false
    source.info.delegationSettings = {
      level: "off",
      autonomy: "balanced",
    }
    source.info.system = "stay local"
    source.info.variant = "careful"
    source.info.tier = "priority"
    expect(SessionLoopState.controls(source.info)).toEqual({
      tools: { task: false, bash: false },
      delegation: false,
      delegationSettings: {
        level: "off",
        autonomy: "balanced",
      },
      system: "stay local",
      variant: "careful",
      tier: "priority",
      inference: undefined,
    })
  })

  test("fails a restarted summary overflow instead of compacting it again", () => {
    const normal = assistant("a1", "u1", "compact").info
    const summary = assistant("s1", "cc1", "compact", true).info
    if (normal.role !== "assistant" || summary.role !== "assistant") throw new Error("bad fixture")
    expect(SessionLoopState.overflowRecovery({ assistant: normal, unanswered: true, attempts: 1 })).toBe("compact")
    expect(SessionLoopState.overflowRecovery({ assistant: normal, unanswered: true, attempts: 2 })).toBe("fail")
    expect(SessionLoopState.overflowRecovery({ assistant: summary, unanswered: true, attempts: 1 })).toBe("fail")
    expect(SessionLoopState.overflowRecovery({ assistant: normal, unanswered: false, attempts: 1 })).toBe("none")
  })

  test("preflight recovery is durable and capped at one attempt", () => {
    expect(SessionLoopState.preflightRecovery({ attempts: 0 })).toBe(true)
    expect(SessionLoopState.preflightRecovery({ attempts: 1 })).toBe(false)
    expect(SessionLoopState.preflightRecovery({ attempts: 2 })).toBe(false)

    const recovery = user("003", [text("003", "continue", { synthetic: true, kind: "context" })], "context")
    const reloaded = JSON.parse(JSON.stringify([user("001", [text("001", "oversized")]), recovery]))
    expect(SessionLoopState.restore(reloaded)).toMatchObject({ preflightRecoveries: 1 })
  })

  test("repairs only a preflight error that crashed before its continuation", () => {
    const source = user("001", [text("001", "run the genome pipeline")])
    const error = assistant("002", "001", "")
    if (source.info.role !== "user" || error.info.role !== "assistant") throw new Error("bad fixture")
    error.info.error = new MessageV2.ContextWindowError({ message: "request did not fit" }).toObject()
    expect(SessionLoopState.pendingPreflight([source, error])).toEqual({ user: source.info, epoch: source.info.id })

    const recovery = user("003", [text("003", "continue", { synthetic: true, kind: "context" })], "context")
    if (recovery.info.role !== "user" || recovery.info.internal?.type !== "continuation") throw new Error("bad fixture")
    recovery.info.internal.epoch = source.info.id
    recovery.info.internal.routing = "run the genome pipeline"
    expect(SessionLoopState.routing([source, error, recovery])).toBe("run the genome pipeline")
    expect(SessionLoopState.pendingPreflight([source, error, recovery])).toBeUndefined()

    const repeated = assistant("004", "001", "")
    if (repeated.info.role !== "assistant") throw new Error("bad fixture")
    repeated.info.error = error.info.error
    expect(SessionLoopState.pendingPreflight([source, error, recovery, repeated])).toBeUndefined()
    expect(
      SessionLoopState.pendingPreflight([source, error, user("005", [text("005", "new request")])]),
    ).toBeUndefined()
  })

  test("preflight recovery passes its originating error through the compaction carrier only", () => {
    const error = assistant("002", "001", "")
    const recovery = user("003", [text("003", "continue", { synthetic: true, kind: "context" })], "context")
    const carrier = user("004", [])
    if (error.info.role !== "assistant" || recovery.info.role !== "user" || carrier.info.role !== "user")
      throw new Error("bad fixture")
    error.info.error = { name: "UnknownError", data: { message: "current turn is too large" } }
    carrier.info.internal = {
      type: "compaction",
      auto: true,
      epoch: "001",
      transaction: carrier.info.id,
      trigger: "proactive",
      recovery: { type: "preflight", continuationID: recovery.info.id },
    }

    expect(SessionLoopState.terminalError({ user: recovery.info, assistant: error.info })).toBe(false)
    expect(SessionLoopState.terminalError({ user: carrier.info, assistant: error.info })).toBe(false)

    const failed = assistant("005", "001", "")
    if (failed.info.role !== "assistant") throw new Error("bad fixture")
    failed.info.error = error.info.error
    expect(SessionLoopState.terminalError({ user: carrier.info, assistant: failed.info })).toBe(true)
  })

  test("a completed preflight compaction passes only its retained originating rejection", () => {
    const rejected = assistant("002", "001", "")
    const carrier = user("004", [])
    const continuation = user("006", [], "compaction")
    if (
      rejected.info.role !== "assistant" ||
      carrier.info.role !== "user" ||
      continuation.info.role !== "user" ||
      continuation.info.internal?.type !== "continuation"
    )
      throw new Error("bad fixture")
    rejected.info.error = { name: "MessageContextWindowError", data: { message: "local preflight rejected" } }
    carrier.info.internal = {
      type: "compaction",
      auto: true,
      epoch: "001",
      transaction: carrier.info.id,
      continuationID: continuation.info.id,
      trigger: "proactive",
      recovery: { type: "preflight", continuationID: "003" },
    }
    continuation.info.internal.epoch = "001"
    const input = {
      user: continuation.info,
      assistant: rejected.info,
      messages: [carrier, assistant("005", carrier.info.id, "stop", true), rejected, continuation],
    }
    // Reloaded, filtered history can retain the rejection after the summary.
    expect(SessionLoopState.terminalError(JSON.parse(JSON.stringify(input)))).toBe(false)
    expect(SessionLoopState.terminalError({ ...input, messages: [] })).toBe(true)

    for (const patch of [
      { epoch: "other" },
      { transaction: "other" },
      { continuationID: "other" },
      { recovery: undefined },
      { recovery: { type: "preflight" as const, continuationID: "001" } },
      { recovery: { type: "preflight" as const, continuationID: "007" } },
    ]) {
      expect(
        SessionLoopState.terminalError({
          ...input,
          messages: [{ ...carrier, info: { ...carrier.info, internal: { ...carrier.info.internal, ...patch } } }],
        }),
      ).toBe(true)
    }
    for (const patch of [{ transaction: "other" }, { kind: "output" as const }])
      expect(
        SessionLoopState.terminalError({
          ...input,
          user: { ...input.user, internal: { ...continuation.info.internal, ...patch } },
        }),
      ).toBe(true)
    // A newer failure or an uncertain paid outcome never gains permission to
    // run merely because an older recovery carrier exists.
    expect(SessionLoopState.terminalError({ ...input, assistant: { ...input.assistant, id: "007" } })).toBe(true)
    expect(
      SessionLoopState.terminalError({
        ...input,
        assistant: {
          ...input.assistant,
          error: { name: "UnknownError", data: { message: "provider outcome unknown" } },
        },
      }),
    ).toBe(true)
  })

  test("recognizes pre-marker contract continuations from existing sessions", () => {
    const history = [
      user("u1", [text("u1", "research")]),
      assistant("a1", "u1", "stop"),
      user("c1", [
        text("c1", "The durable research completion contract is not satisfied yet. Finish it.", {
          synthetic: true,
        }),
      ]),
    ]
    expect(SessionLoopState.restore(history)).toMatchObject({
      contractContinuations: 1,
    })
  })

  test("restores semantic contract progress and one focused repair marker", () => {
    const progress = "a".repeat(64)
    const continuation = user("contract-progress", [
      {
        ...text("contract-progress", "Continue the contract", { synthetic: true, kind: "contract" }),
        metadata: SessionLoopState.continuation("contract", { progress, repair: true }),
      },
    ])
    if (continuation.info.role !== "user") throw new Error("bad fixture")
    continuation.info.internal = {
      type: "continuation",
      kind: "contract",
      text: "Continue the contract",
      epoch: "u1",
      transaction: continuation.info.id,
      progress,
      repair: true,
    }

    expect(SessionLoopState.contractMarker([continuation])).toEqual({ progress, repair: true })
    expect(SessionLoopState.boundary("partial", progress)).toMatchObject({
      "openscience.loop": { type: "contract-boundary", state: "partial", progress },
    })
  })

  test("maps persisted reviewer continuations onto the normal task resume path", () => {
    const legacy = user("legacy-review", [
      {
        ...text("legacy-review", "Independent review completed; continue the task.", { synthetic: true }),
        metadata: { "openscience.loop": { version: 2, type: "continuation", kind: "review-summary" } },
      },
    ])
    if (legacy.info.role !== "user") throw new Error("bad fixture")
    legacy.info.agent = "reviewer"
    legacy.info.internal = {
      type: "continuation",
      kind: "review-summary",
      text: "continue",
      epoch: "u1",
      transaction: legacy.info.id,
    } as unknown as MessageV2.User["internal"]

    expect(SessionLoopState.messageKind(legacy.info)).toBe("task")
    expect(SessionLoopState.continuationKind(legacy.parts[0])).toBe("task")
    expect(SessionLoopState.incomplete([legacy])).toHaveLength(0)

    const interrupted = structuredClone(legacy)
    interrupted.parts = []
    if (interrupted.info.role !== "user") throw new Error("bad fixture")
    expect(SessionLoopState.incomplete([interrupted]).map((message) => message.info.id)).toEqual([legacy.info.id])
    expect(SessionLoopState.repair(interrupted.info)).toMatchObject({
      id: SessionLoopState.partID(legacy.info.id, "continuation"),
      metadata: SessionLoopState.continuation("task"),
    })
  })

  test("legacy breaker metadata cannot seed a transcript after modern epochs exist", () => {
    const forged = user("legacy", [
      {
        ...text("legacy", ""),
        synthetic: true,
        ignored: true,
        metadata: SessionLoopState.compaction({ before: 100, reclaimed: 1 }),
      },
    ])
    expect(SessionLoopState.breaker([forged], 0.1)).toBe(1)
    const modern = user("modern", [text("modern", "new request")])
    if (modern.info.role !== "user") throw new Error("bad fixture")
    modern.info.internal = SessionLoopState.prompt(modern.info.id)
    modern.parts.push({
      ...text("modern", ""),
      id: SessionLoopState.partID("ghost", "breaker"),
      synthetic: true,
      ignored: true,
      metadata: SessionLoopState.compaction({ transaction: "ghost", before: 100, reclaimed: 1 }),
    })
    expect(SessionLoopState.breaker([forged, modern], 0.1)).toBe(0)
  })

  test("a durable fresh-prompt reset clears breaker events from older modern epochs", () => {
    const prior = user("u1", [text("u1", "first request")])
    if (prior.info.role !== "user") throw new Error("bad fixture")
    prior.info.internal = SessionLoopState.prompt(prior.info.id)
    const history: MessageV2.WithParts[] = [prior]
    for (const [index, transaction] of ["v1", "v2", "v3"].entries()) {
      prior.parts.push({
        ...text("u1", ""),
        id: SessionLoopState.partID(transaction, "breaker"),
        synthetic: true,
        ignored: true,
        metadata: SessionLoopState.compaction({ transaction, before: 100, reclaimed: 1 }),
      })
      history.push(assistant(transaction, prior.info.id, "stop", false, index + 1))
    }
    expect(SessionLoopState.breaker(history, 0.1)).toBe(3)

    const fresh = user("z1", [text("z1", "fresh request")])
    if (fresh.info.role !== "user") throw new Error("bad fixture")
    fresh.info.internal = SessionLoopState.prompt(fresh.info.id)
    fresh.parts.push({
      ...text("z1", ""),
      id: SessionLoopState.partID(fresh.info.id, "breaker-reset"),
      synthetic: true,
      ignored: true,
      metadata: SessionLoopState.compactionReset(fresh.info.id),
    })
    expect(SessionLoopState.breaker([...history, fresh], 0.1)).toBe(0)
  })

  test("public prompts and part edits cannot forge runtime ownership", () => {
    const sessionID = Identifier.ascending("session")
    const valid = { sessionID, parts: [{ type: "text" as const, text: "hello" }] }
    expect(SessionPrompt.PromptInput.safeParse(valid).success).toBe(true)
    for (const field of [
      { synthetic: true },
      { ignored: true },
      { metadata: SessionLoopState.continuation("output") },
    ]) {
      expect(
        SessionPrompt.PromptInput.safeParse({
          ...valid,
          parts: [{ ...valid.parts[0], ...field }],
        }).success,
      ).toBe(false)
    }

    const message = user("u1", [text("u1", "before")])
    if (message.info.role !== "user") throw new Error("bad fixture")
    const previous = message.parts[0]!
    expect(
      SessionLoopState.validatePartUpdate({
        message: message.info,
        previous,
        next: { ...previous, text: "after" } as MessageV2.TextPart,
      }),
    ).toBeUndefined()
    expect(
      SessionLoopState.validatePartUpdate({
        message: message.info,
        previous,
        next: {
          ...previous,
          metadata: SessionLoopState.continuation("output"),
        } as MessageV2.TextPart,
      }),
    ).toContain("Reserved")

    const runtime = {
      ...previous,
      metadata: SessionLoopState.continuation("output"),
    } as MessageV2.TextPart
    expect(
      SessionLoopState.validatePartUpdate({
        message: message.info,
        previous: runtime,
        next: { ...runtime, metadata: undefined },
      }),
    ).toContain("Runtime-owned")
    expect(SessionLoopState.validatePartDelete({ message: message.info, part: runtime })).toContain("Runtime-owned")
  })

  test("replays a tripped compaction breaker from durable ignored markers", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const userID = await MessageV2.nextMessageID(session.id)
        const message = await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          effort: "normal",
          internal: SessionLoopState.prompt(userID),
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: session.id,
          type: "text",
          text: "research",
        })
        for (const [index, reclaimed] of [5, 4, 3].entries()) {
          const transaction = await MessageV2.nextMessageID(session.id)
          await Session.updateMessage({
            id: transaction,
            sessionID: session.id,
            parentID: message.id,
            role: "assistant",
            time: { created: Date.now(), completed: Date.now() },
            mode: "research",
            agent: "research",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens,
            modelID: "test",
            providerID: "test",
            internal: { step: index + 1 },
            finish: "stop",
          })
          SessionCompaction.noteCompaction({ sessionID: session.id, before: 100, reclaimed })
          await SessionCompaction.persistBreaker({
            sessionID: session.id,
            messageID: message.id,
            transaction,
            before: 100,
            reclaimed,
          })
        }
        expect(SessionCompaction.breakerTripped(session.id)).toBe(true)

        // Simulate a new backend process by dropping the in-memory entry, then
        // rebuilding exclusively from storage-loaded messages.
        SessionCompaction.resetBreaker(session.id)
        expect(SessionCompaction.breakerTripped(session.id)).toBe(false)
        const stored = await Session.messages({ sessionID: session.id })
        expect(SessionCompaction.restoreBreaker(session.id, stored)).toEqual({ count: 3, tripped: true })
        expect(SessionCompaction.breakerTripped(session.id)).toBe(true)
        expect(
          stored
            .find((item) => item.info.id === message.id)
            ?.parts.filter((part) => part.type === "text" && part.ignored),
        ).toHaveLength(3)

        SessionCompaction.resetBreaker(session.id)
        const transaction = await MessageV2.nextMessageID(session.id)
        await Session.updateMessage({
          id: transaction,
          sessionID: session.id,
          parentID: message.id,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          mode: "research",
          agent: "research",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens,
          modelID: "test",
          providerID: "test",
          internal: { step: 4 },
          finish: "stop",
        })
        await SessionCompaction.persistBreaker({
          sessionID: session.id,
          messageID: message.id,
          transaction,
          reset: true,
        })
        const reset = await Session.messages({ sessionID: session.id })
        expect(SessionCompaction.restoreBreaker(session.id, reset)).toEqual({ count: 0, tripped: false })
        await Session.remove(session.id)
      },
    })
  })
})
