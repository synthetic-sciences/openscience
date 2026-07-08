import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { SessionPrompt } from "./prompt"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import path from "node:path"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  // Fraction of the usable context budget at which auto-compaction fires. 0.75
  // matches Claude Code / opencode: ~25% headroom so the NEXT turn (plus its
  // output) can't blow the hard limit before compaction runs. Overridable via
  // config.compaction.threshold.
  export const DEFAULT_THRESHOLD = 0.75

  // Assumed context window when a provider reports 0 (local / OpenAI-compatible
  // / Codex). Matches the existing unknown-model fallback at provider.ts:770.
  // Overridable via config.compaction.fallbackContext — a small local model
  // (e.g. an 8k Ollama build reporting context 0) should lower it, or proactive
  // compaction never fires until far past its real window.
  export const FALLBACK_CONTEXT = 128_000

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context || config.compaction?.fallbackContext || FALLBACK_CONTEXT
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const cap = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    // Never reserve more than half the window for output. On a small model (or a
    // small fallbackContext like the 8k the config text recommends) the 32k default
    // output cap exceeds the whole context, so `context - output` goes negative and
    // `count > usable*threshold` is true for ANY count — compacting every single turn.
    const output = Math.min(cap, Math.floor(context / 2))
    const usable = input.model.limit.input || context - output
    const threshold = config.compaction?.threshold ?? DEFAULT_THRESHOLD
    return count > usable * threshold
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill", "artifact"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        // Preserve RLM state blocks — they carry planner progress
        if (part.type === "text" && part.text.includes("<rlm_state>")) continue
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
    focus?: string
    handoffFile?: string
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
      busyStatus: "compacting",
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    // The summary IS a handoff: it becomes the ONLY context the resumed (or a fresh)
    // agent has. It must be self-contained enough to CONTINUE from without re-reading
    // files or re-deriving state — otherwise the agent burns its whole fresh window
    // catching up and immediately overflows again. A concrete "Next Move" and inline
    // verified results are what let it act instead of re-exploring.
    const defaultPrompt = `Write a self-contained handoff so another agent can continue this work WITHOUT re-reading the files or re-deriving state. This handoff is the ONLY context that agent will have — capture everything needed to act, and nothing more.

Output exactly this Markdown structure, keeping every section (write "(none)" when a section is empty). Preserve exact file paths, commands, identifiers, error strings, and numeric results verbatim. Use terse bullets, not prose.

## Objective
- [what the user is ultimately trying to accomplish, in 1-2 sentences]

## Constraints & Decisions
- [rules/preferences that must hold, decisions made and WHY, key assumptions — the things a fresh agent would otherwise get wrong]

## Work State
### Done (verified)
- [completed & verified work with the concrete result, so it need not be re-checked]
### In progress
- [what is partially done and exactly where it stands]
### Blocked / open
- [blockers, failing checks, unresolved questions]

## Next Move
1. [the exact next action to take right now]
2. [the action after that, if known]

## Key Files & Artifacts
- [path — what it holds and why it matters; read it ONLY if the Next Move needs it]

Do not mention that context was compacted or that you are summarizing. Do not ask questions.`
    const focusLine = input.focus?.trim()
      ? `\n\nThe next session will focus on: ${input.focus.trim()}. Tailor the summary toward that.`
      : ""
    const promptText = compacting.prompt ?? [defaultPrompt + focusLine, ...compacting.context].join("\n\n")
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...MessageV2.toModelMessages(input.messages, model),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    // The summarization request itself exceeded the context window — no summary
    // was produced. Surface it so the caller fails the turn instead of
    // re-attempting a compaction that can never succeed.
    if (result === "overflow") return "overflow"

    // Persist the handoff to disk so a fresh agent/process can pick up from a single
    // curated file instead of re-reading the whole project (and /compact leaves a
    // durable checkpoint). Written to the project root as handoff.md unless a path was
    // given via /handoff. Best-effort — a write failure never blocks the compaction.
    if (result === "continue") {
      const summaryText = (await MessageV2.parts(msg.id))
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim()
      if (summaryText) {
        // Confine the write to the worktree: a /handoff path is user/agent-supplied
        // and must not escape it via an absolute path or "..". Anything that would
        // land outside falls back to the default handoff.md at the project root.
        const root = path.resolve(Instance.worktree)
        const resolved = path.resolve(root, input.handoffFile?.trim() || "handoff.md")
        const target = resolved.startsWith(root + path.sep) ? resolved : path.join(root, "handoff.md")
        await Bun.write(target, summaryText + "\n").catch((e) =>
          log.warn("failed to write handoff file", { target, error: e instanceof Error ? e.message : String(e) }),
        )
      }
    }

    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: userMessage.agent,
        model: userMessage.model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue from the 'Next Move' in the handoff above. Trust it as an accurate record — do not re-read files or re-verify completed work unless the immediate step actually requires it.",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
      focus: z.string().optional(),
      handoffFile: z.string().optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        focus: input.focus,
        handoffFile: input.handoffFile,
      })
    },
  )
}
