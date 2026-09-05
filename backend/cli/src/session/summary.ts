import { Provider } from "@/provider/provider"

import { fn } from "@synsci/util/fn"
import z from "zod"
import { Session } from "."

import { MessageV2 } from "./message-v2"
import { Identifier } from "@/id/id"
import { Snapshot } from "@/snapshot"

import { Log } from "@/util/log"
import path from "path"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Bus } from "@/bus"

import { LLM } from "./llm"
import { Agent } from "@/agent/agent"

export namespace SessionSummary {
  const log = Log.create({ service: "session.summary" })

  function unquoteGitPath(input: string) {
    if (!input.startsWith('"')) return input
    if (!input.endsWith('"')) return input
    const body = input.slice(1, -1)
    const bytes: number[] = []

    for (let i = 0; i < body.length; i++) {
      const char = body[i]!
      if (char !== "\\") {
        bytes.push(char.charCodeAt(0))
        continue
      }

      const next = body[i + 1]
      if (!next) {
        bytes.push("\\".charCodeAt(0))
        continue
      }

      if (next >= "0" && next <= "7") {
        const chunk = body.slice(i + 1, i + 4)
        const match = chunk.match(/^[0-7]{1,3}/)
        if (!match) {
          bytes.push(next.charCodeAt(0))
          i++
          continue
        }
        bytes.push(parseInt(match[0], 8))
        i += match[0].length
        continue
      }

      const escaped =
        next === "n"
          ? "\n"
          : next === "r"
            ? "\r"
            : next === "t"
              ? "\t"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next === "v"
                    ? "\v"
                    : next === "\\" || next === '"'
                      ? next
                      : undefined

      bytes.push((escaped ?? next).charCodeAt(0))
      i++
    }

    return Buffer.from(bytes).toString()
  }

  export const summarize = fn(
    z.object({
      sessionID: z.string(),
      messageID: z.string(),
    }),
    async (input) => {
      const all = await Session.messages({ sessionID: input.sessionID }).catch((error) => {
        if (error instanceof Storage.NotFoundError) return
        throw error
      })
      if (!all) return
      const message = all.find((item) => item.info.id === input.messageID)
      if (!message || message.info.role !== "user") {
        log.warn("skipping summary for missing user message", input)
        return
      }

      const results = await Promise.allSettled([
        summarizeSession({ sessionID: input.sessionID, messages: all }),
        summarizeMessage({ message, messages: all }),
      ])
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      if (!failure) return

      const sessionExists = await Session.get(input.sessionID)
        .then(() => true)
        .catch((error) => {
          if (error instanceof Storage.NotFoundError) return false
          throw error
        })
      if (sessionExists) throw failure.reason
      log.warn("skipping summary for deleted session", input)
    },
  )

  async function summarizeSession(input: { sessionID: string; messages: MessageV2.WithParts[] }) {
    const files = new Set(
      input.messages
        .flatMap((x) => x.parts)
        .filter((x) => x.type === "patch")
        .flatMap((x) => x.files)
        .map((x) => path.relative(Instance.worktree, x).replaceAll("\\", "/")),
    )
    const diffs = await computeDiff({ messages: input.messages }).then((x) =>
      x.filter((x) => {
        return files.has(x.file)
      }),
    )
    await Session.update(input.sessionID, (draft) => {
      draft.summary = {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      }
    })
    await Storage.write(["session_diff", input.sessionID], diffs)
    Bus.publish(Session.Event.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  async function summarizeMessage(input: { message: MessageV2.WithParts; messages: MessageV2.WithParts[] }) {
    const messages = input.messages.filter(
      (m) =>
        m.info.id === input.message.info.id ||
        (m.info.role === "assistant" && m.info.parentID === input.message.info.id),
    )
    const msgWithParts = input.message
    let userMsg = msgWithParts.info as MessageV2.User
    const diffs = await computeDiff({ messages })
    const updated = await updateUserMessage(userMsg, (draft) => {
      draft.summary = {
        ...draft.summary,
        diffs,
      }
    })
    if (!updated) return
    userMsg = updated

    const textPart = msgWithParts.parts.find((p) => p.type === "text" && !p.synthetic) as MessageV2.TextPart
    if (!textPart || userMsg.summary?.title) return
    const pending = titles.pending.get(userMsg.id)
    if (pending) return pending
    const last = titles.attempts.get(userMsg.id)
    if (last && Date.now() - last.at < TITLE_COOLDOWN_MS) return
    const attempt = last?.count ?? 0
    titles.attempts.set(userMsg.id, { at: Date.now(), count: attempt + 1 })
    const run = titleMessage({ user: userMsg, text: textPart.text, diffs, attempt }).finally(() =>
      titles.pending.delete(userMsg.id),
    )
    titles.pending.set(userMsg.id, run)
    return run
  }

  // The managed proxy seals a streamed idempotency key the moment the upstream
  // stream starts, so re-sending an identical title request can only collect
  // 409s. Keep one title request per message in flight, allow one attempt per
  // message per cooldown window, and bound each attempt so a stalled stream is
  // abandoned instead of pinning the summary forever.
  const TITLE_COOLDOWN_MS = 10 * 60 * 1_000
  const TITLE_TIMEOUT_MS = 45_000
  const titles = {
    pending: new Map<string, Promise<void>>(),
    attempts: new Map<string, { at: number; count: number }>(),
  }

  async function titleMessage(input: {
    user: MessageV2.User
    text: string
    diffs: Snapshot.FileDiff[]
    attempt: number
  }) {
    const agent = await Agent.get("title")
    if (!agent) return
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : ((await Provider.getSmallModel(input.user.model.providerID)) ??
        (await Provider.getModel(input.user.model.providerID, input.user.model.modelID)))
    const context = {
      sessionID: input.user.sessionID,
      messageID: input.attempt ? `summary:${input.user.id}:${input.attempt}` : `summary:${input.user.id}`,
      attempt: input.attempt,
    }
    const result = await Provider.withRequestContext(context, async () => {
      const stream = await LLM.stream({
        agent,
        // Title generation is an isolated internal call over the visible user
        // text. Replaying the source turn's custom/child system guidance here
        // can conflict with the title agent and needlessly duplicate context.
        user: { ...input.user, system: undefined },
        tools: {},
        model,
        small: true,
        messages: [
          {
            role: "user" as const,
            content: `
              The following is the text to summarize:
              <text>
              ${input.text}
              </text>
            `,
          },
        ],
        abort: AbortSignal.timeout(TITLE_TIMEOUT_MS),
        sessionID: input.user.sessionID,
        system: [],
        retries: 0,
      })
      return stream.text
    })
    log.info("title", { title: result })
    await updateUserMessage(input.user, (draft) => {
      draft.summary = {
        ...draft.summary,
        diffs: draft.summary?.diffs ?? input.diffs,
        title: result,
      }
    })
  }

  async function updateUserMessage(message: MessageV2.User, editor: (draft: MessageV2.User) => void) {
    try {
      const updated = await Storage.update<MessageV2.User>(["message", message.sessionID, message.id], editor)
      Bus.publish(MessageV2.Event.Updated, { info: updated })
      return updated
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) throw error
      log.warn("skipping summary update for removed user message", {
        sessionID: message.sessionID,
        messageID: message.id,
      })
      return undefined
    }
  }

  export const diff = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      await Session.assertDirectory(input.sessionID)
      const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).catch(() => [])
      const next = diffs.map((item) => {
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return {
          ...item,
          file,
        }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) Storage.write(["session_diff", input.sessionID], next).catch(() => {})
      return next
    },
  )

  export async function computeDiff(input: { messages: MessageV2.WithParts[] }) {
    let from: string | undefined
    let to: string | undefined

    // scan assistant messages to find earliest from and latest to
    // snapshot
    for (const item of input.messages) {
      if (!from) {
        for (const part of item.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from = part.snapshot
            break
          }
        }
      }

      for (const part of item.parts) {
        if (part.type === "step-finish" && part.snapshot) {
          to = part.snapshot
          break
        }
      }
    }

    if (from && to) return Snapshot.diffFull(from, to)
    return []
  }
}
