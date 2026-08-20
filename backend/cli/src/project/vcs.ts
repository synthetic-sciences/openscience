import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { $ } from "bun"
import z from "zod"
import { Log } from "@/util/log"
import { Instance } from "./instance"
import { FileWatcher } from "@/file/watcher"
import fs from "fs/promises"
import path from "path"

const log = Log.create({ service: "vcs" })

export namespace Vcs {
  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  const metadata = Instance.state(async () => {
    if (Instance.project.vcs !== "git") return
    const marker = path.join(Instance.worktree, ".git")
    const stat = await fs.stat(marker).catch(() => undefined)
    if (!stat) return
    const git = stat.isDirectory()
      ? marker
      : await Bun.file(marker)
          .text()
          .then((value) => value.match(/^gitdir:\s*(.+)\s*$/im)?.[1])
          .then((value) => (value ? path.resolve(path.dirname(marker), value) : undefined))
          .catch(() => undefined)
    if (!git) return
    const common = await Bun.file(path.join(git, "commondir"))
      .text()
      .then((value) => path.resolve(git, value.trim()))
      .catch(() => git)
    return fs.realpath(common).catch(() => path.resolve(common))
  })

  /** Git's shared metadata directory. Linked worktrees keep this outside the
   * checked-out tree, but sandboxed Git still needs it for status and commits. */
  export async function metadataRoot() {
    return metadata()
  }

  async function currentBranch() {
    return $`git rev-parse --abbrev-ref HEAD`
      .quiet()
      .nothrow()
      .cwd(Instance.worktree)
      .text()
      .then((x) => x.trim())
      .catch(() => undefined)
  }

  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined }
      }
      let current = await currentBranch()
      log.info("initialized", { branch: current })

      const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, async (evt) => {
        if (evt.properties.file.endsWith("HEAD")) return
        const next = await currentBranch()
        if (next !== current) {
          log.info("branch changed", { from: current, to: next })
          current = next
          Bus.publish(Event.BranchUpdated, { branch: next })
        }
      })

      return {
        branch: async () => current,
        unsubscribe,
      }
    },
    async (state) => {
      state.unsubscribe?.()
    },
  )

  export async function init() {
    return state()
  }

  export async function branch() {
    return await state().then((s) => s.branch())
  }
}
