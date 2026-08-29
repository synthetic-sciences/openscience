import z from "zod"
import { Identifier } from "../id/id"
import { Snapshot } from "../snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "../util/log"
import { splitWhen } from "remeda"
import { Storage } from "../storage/storage"
import { Bus } from "../bus"
import { SessionPrompt } from "./prompt"
import { SessionSummary } from "./summary"
import { Lock } from "../util/lock"
import { Instance } from "../project/instance"

export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })
  const tails = new Map<string, Promise<unknown>>()
  const active = new Map<string, Map<string, Promise<unknown>>>()

  export const RevertInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message"),
    partID: Identifier.schema("part").optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  export const RevertResult = z.object({
    status: z.enum(["reverted", "unchanged"]),
    session: z.lazy(() => Session.Info),
    turns: z.number().int().nonnegative(),
    files: z.string().array(),
    filesystem: Snapshot.RevertResult,
  })
  export type RevertResult = z.infer<typeof RevertResult>

  export class UnavailableError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "SessionRevertUnavailableError"
    }
  }

  export class TransactionError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "SessionRevertTransactionError"
    }
  }

  function serialize<T>(sessionID: string, key: string, fn: () => Promise<T>): Promise<T> {
    const running = active.get(sessionID)?.get(key)
    if (running) return running as Promise<T>

    const previous = tails.get(sessionID) ?? Promise.resolve()
    const promise = previous.catch(() => undefined).then(fn)
    const settled = promise.then(
      () => undefined,
      () => undefined,
    )
    tails.set(sessionID, settled)
    const byKey = active.get(sessionID) ?? new Map<string, Promise<unknown>>()
    byKey.set(key, promise)
    active.set(sessionID, byKey)
    void settled.finally(() => {
      if (tails.get(sessionID) === settled) tails.delete(sessionID)
      if (byKey.get(key) === promise) byKey.delete(key)
      if (byKey.size === 0) active.delete(sessionID)
    })
    return promise
  }

  function complete(result: Snapshot.RevertResult) {
    return result.status !== "partial" && result.errors.length === 0 && result.skipped.length === 0
  }

  function failureMessage(action: string, result: Snapshot.RevertResult, rollback?: Snapshot.RevertResult) {
    const issue = (result.errors[0]?.message ?? "one or more paths could not be restored").replace(/[.\s]+$/, "")
    const recovery =
      rollback && !complete(rollback) ? " Automatic recovery was also incomplete; inspect the project files." : ""
    return `${action} was not completed: ${issue}.${recovery}`
  }

  export function revert(input: RevertInput): Promise<RevertResult> {
    return serialize(input.sessionID, `revert:${input.messageID}:${input.partID ?? ""}`, () => revertTransaction(input))
  }

  async function revertTransaction(input: RevertInput): Promise<RevertResult> {
    using _ = await Lock.write(`session-revert:${Instance.project.id}`)
    SessionPrompt.assertNotBusy(input.sessionID)
    const all = await Session.messages({ sessionID: input.sessionID })
    let lastUser: MessageV2.User | undefined
    const session = await Session.get(input.sessionID)

    if (
      session.revert?.messageID === input.messageID &&
      (session.revert.partID ?? undefined) === (input.partID ?? undefined)
    ) {
      return {
        status: "unchanged",
        session,
        turns: session.revert.turns ?? 0,
        files: session.revert.files ?? [],
        filesystem: { status: "noop", restored: [], removed: [], skipped: [], errors: [] },
      }
    }

    let revert: Session.Info["revert"]
    const patches: Snapshot.Patch[] = []
    for (const msg of all) {
      if (msg.info.role === "user") lastUser = msg.info
      const remaining = []
      for (const part of msg.parts) {
        if (revert) {
          if (part.type === "patch") {
            patches.push(part)
          }
          continue
        }

        if (!revert) {
          if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            // if no useful parts left in message, same as reverting whole message
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            revert = {
              messageID: !partID && lastUser ? lastUser.id : msg.info.id,
              partID,
            }
          }
          remaining.push(part)
        }
      }
    }

    if (!revert) throw new TransactionError("The selected message no longer exists in this session.")

    const rangeMessages = all.filter((msg) => msg.info.id >= revert!.messageID)
    const turns = rangeMessages.filter((msg) => msg.info.role === "user").length
    let rollbackSnapshot: string | undefined
    let redoSnapshot = session.revert?.snapshot
    let filesystem: Snapshot.RevertResult = {
      status: "noop",
      restored: [],
      removed: [],
      skipped: [],
      errors: [],
    }

    // A conversation-only undo has no filesystem side effects to protect and
    // must remain available in blank/non-Git projects. File-bearing turns keep
    // the full snapshot transaction below; this branch only skips Git when no
    // patch part exists in the reverted range.
    if (patches.length > 0) {
      const availability = await Snapshot.availability()
      if (!availability.available) throw new UnavailableError(availability.reason)
      rollbackSnapshot = await Snapshot.capture()
      if (!rollbackSnapshot) throw new UnavailableError("Undo could not capture the current project state.")
      redoSnapshot ??= rollbackSnapshot
      filesystem = await Snapshot.revert(patches)
      if (!complete(filesystem)) {
        const rollback = await Snapshot.restore(rollbackSnapshot)
        throw new TransactionError(failureMessage("Undo", filesystem, rollback))
      }
      revert.snapshot = redoSnapshot
    }

    const files = [...new Set([...filesystem.restored, ...filesystem.removed])].toSorted()
    revert.turns = turns
    revert.files = files

    const previousDiff = await Storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).catch(
      () => undefined,
    )
    try {
      if (redoSnapshot) revert.diff = await Snapshot.diff(redoSnapshot)
      const diffs = await SessionSummary.computeDiff({ messages: rangeMessages })
      await Storage.write(["session_diff", input.sessionID], diffs)
      Bus.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: diffs,
      })
      const updated = await Session.update(input.sessionID, (draft) => {
        draft.revert = revert
        draft.summary = {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        }
      })
      return { status: "reverted", session: updated, turns, files, filesystem }
    } catch (error) {
      const rollback = rollbackSnapshot
        ? await Snapshot.restore(rollbackSnapshot)
        : ({ status: "noop", restored: [], removed: [], skipped: [], errors: [] } satisfies Snapshot.RevertResult)
      const recovered = await (
        previousDiff
          ? Storage.write(["session_diff", input.sessionID], previousDiff)
          : Storage.remove(["session_diff", input.sessionID])
      ).then(
        () => true,
        () => false,
      )
      if (recovered) {
        Bus.publish(Session.Event.Diff, {
          sessionID: input.sessionID,
          diff: previousDiff ?? [],
        })
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new TransactionError(
        `${message}${complete(rollback) ? "" : " Automatic file recovery was incomplete."}${
          recovered ? "" : " The previous session diff could not be restored."
        }`,
      )
    }
  }

  export function unrevert(input: { sessionID: string }) {
    return serialize(input.sessionID, "unrevert", () => unrevertTransaction(input))
  }

  async function unrevertTransaction(input: { sessionID: string }) {
    log.info("unreverting", input)
    using _ = await Lock.write(`session-revert:${Instance.project.id}`)
    SessionPrompt.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session
    if (!session.revert.files) {
      throw new UnavailableError("This undo predates scoped file recovery, so Restore cannot replay it safely.")
    }
    const files = session.revert.files
    if (files.length === 0) {
      try {
        return await Session.update(input.sessionID, (draft) => {
          draft.revert = undefined
        })
      } catch (error) {
        throw new TransactionError(error instanceof Error ? error.message : String(error))
      }
    }
    if (!session.revert.snapshot) {
      throw new UnavailableError("This undo has no recovery snapshot, so the original files cannot be restored safely.")
    }
    const rollbackSnapshot = await Snapshot.capture()
    if (!rollbackSnapshot) throw new UnavailableError("Restore could not capture the current project state.")
    const filesystem = await Snapshot.restore(session.revert.snapshot, files)
    if (!complete(filesystem)) {
      const rollback = await Snapshot.restore(rollbackSnapshot, files)
      throw new TransactionError(failureMessage("Restore", filesystem, rollback))
    }
    try {
      return await Session.update(input.sessionID, (draft) => {
        draft.revert = undefined
      })
    } catch (error) {
      const rollback = await Snapshot.restore(rollbackSnapshot, files)
      const message = error instanceof Error ? error.message : String(error)
      throw new TransactionError(`${message}${complete(rollback) ? "" : " Automatic file recovery was incomplete."}`)
    }
  }

  export function cleanup(session: Session.Info) {
    if (!session.revert) return Promise.resolve()
    return serialize(session.id, `cleanup:${session.revert.messageID}:${session.revert.partID ?? ""}`, () =>
      cleanupTransaction(session),
    )
  }

  async function cleanupTransaction(session: Session.Info) {
    if (!session.revert) return
    const sessionID = session.id
    let msgs = await Session.messages({ sessionID })
    const messageID = session.revert.messageID
    const [preserve, remove] = splitWhen(msgs, (x) => x.info.id === messageID)
    msgs = preserve
    for (const msg of remove) {
      await Storage.remove(["message", sessionID, msg.info.id])
      await Bus.publish(MessageV2.Event.Removed, { sessionID: sessionID, messageID: msg.info.id })
    }
    if (remove.length > 0) MessageV2.invalidateLastID(sessionID)
    const last = preserve.at(-1)
    if (session.revert.partID && last) {
      const partID = session.revert.partID
      const [preserveParts, removeParts] = splitWhen(last.parts, (x) => x.id === partID)
      last.parts = preserveParts
      for (const part of removeParts) {
        await Storage.remove(["part", last.info.id, part.id])
        await Bus.publish(MessageV2.Event.PartRemoved, {
          sessionID: sessionID,
          messageID: last.info.id,
          partID: part.id,
        })
      }
    }
    await Session.update(sessionID, (draft) => {
      draft.revert = undefined
    })
  }
}
