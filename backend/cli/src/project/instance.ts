import { Log } from "@/util/log"
import { Context } from "../util/context"
import { Project } from "./project"
import { State } from "./state"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { Filesystem } from "@/util/filesystem"
import { Startup } from "@/util/startup"

interface Context {
  directory: string
  worktree: string
  project: Project.Info
}
const context = Context.create<Context>("instance")
const cache = new Map<string, Promise<Context>>()

const disposal = {
  all: undefined as Promise<void> | undefined,
}

/**
 * Register the instance for a directory. Concurrent requests join the cached
 * promise; the creator additionally waits, when the bootstrap fails, until the
 * runtimes that bootstrap registered are torn down and the entry is gone.
 */
async function register(
  directory: string,
  input: { directory: string; projectID?: string; init?: () => Promise<unknown> },
) {
  // Validate before new registration, not before accessing a live context:
  // internal revocation/disposal must still stop resources after a root is
  // deleted or unmounted. Public routes validate selectors independently.
  await Project.assertDirectory(input.directory)
  const selected = input.projectID ? await Project.resolve(input.projectID, directory) : undefined
  const raced = cache.get(directory)
  if (raced) return raced
  Log.Default.info("creating instance", { directory })
  Startup.instance(directory === Project.canonicalize(process.cwd()) ? "cwd" : "project")
  const boot = { ctx: undefined as Context | undefined }
  const existing = iife(async () => {
    // A selected parent already owns the cwd. Resolving a non-git child
    // must not register another project before checking that authority.
    const { project, sandbox } = selected
      ? { project: selected.project, sandbox: selected.worktree }
      : await Project.fromDirectory(directory)
    const ctx = { directory, worktree: sandbox, project }
    boot.ctx = ctx
    await context.provide(ctx, async () => {
      await input.init?.()
    })
    return ctx
  })
  cache.set(directory, existing)
  return existing.catch(async (error) => {
    // A bootstrap that fails must not leave the runtimes it registered behind:
    // its warmup timer or authority poller would later call Instance.provide
    // for a directory the server has no instance for and mint a bare
    // instance, one that never ran InstanceBootstrap yet would serve every
    // later request. Tear them down only once `existing` has rejected: a
    // runtime already inside Instance.provide for this directory waits on
    // that promise while its disposer waits on the runtime. The rejected
    // entry stays cached meanwhile so no request mints a fresh instance into
    // runtimes still being torn down.
    if (boot.ctx) {
      await context
        .provide(boot.ctx, () => State.dispose(directory))
        .catch((cause) =>
          Log.Default.error("failed to dispose the runtimes of a failed bootstrap", { directory, cause }),
        )
    }
    if (cache.get(directory) === existing) cache.delete(directory)
    throw error
  })
}

export const Instance = {
  async provide<R>(input: {
    directory: string
    projectID?: string
    init?: () => Promise<any>
    fn: () => R
  }): Promise<R> {
    // Canonicalize so spelling variants of the same folder (trailing slash, `.`,
    // symlinks) resolve to one live instance and one project id.
    const directory = Project.canonicalize(input.directory)
    const ctx = await (cache.get(directory) ?? register(directory, input))
    if (input.projectID && ctx.project.id !== input.projectID) {
      throw new Project.MismatchError({ projectID: input.projectID, directory })
    }
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  /** Whether an instance, live or still initialising, is registered for the directory. */
  has(directory: string) {
    return cache.has(Project.canonicalize(directory))
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string) {
    if (Filesystem.contains(Instance.directory, filepath)) return true
    // Guard against a filesystem-root worktree ("/") matching ANY absolute path,
    // which would defeat external_directory permissions. Since folder-scoped
    // loading, non-git projects set worktree = the opened directory (not "/"), so
    // this only trips for a project literally opened at the fs root.
    if (Instance.worktree === "/") return false
    return Filesystem.contains(Instance.worktree, filepath)
  },
  async containsCanonicalPath(filepath: string) {
    if (await Filesystem.containsCanonical(Instance.directory, filepath)) return true
    if (Instance.worktree === "/") return false
    return Filesystem.containsCanonical(Instance.worktree, filepath)
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    return State.create(() => Instance.directory, init, dispose)
  },
  /** Run `fn` inside every live project instance without creating any. An
   * instance still bootstrapping is awaited; a failed bootstrap is skipped. */
  async each(fn: () => unknown) {
    for (const [key, value] of [...cache.entries()]) {
      if (cache.get(key) !== value) continue
      const ctx = await value.catch(() => undefined)
      if (!ctx) continue
      await context.provide(ctx, async () => {
        await fn()
      })
    }
  },
  async dispose(options: { strict?: boolean } = {}) {
    Log.Default.info("disposing instance", { directory: Instance.directory })
    await State.dispose(Instance.directory, options)
    cache.delete(Instance.directory)
    GlobalBus.emit("event", {
      directory: Instance.directory,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory: Instance.directory,
        },
      },
    })
  },
  async disposeAll(options: { strict?: boolean } = {}) {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      const failures: unknown[] = []
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context
          .provide(ctx, async () => {
            await Instance.dispose(options)
          })
          .catch((error) => failures.push(error))
      }
      if (failures.length) {
        throw new AggregateError(failures, "One or more OpenScience project instances could not be disposed")
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
