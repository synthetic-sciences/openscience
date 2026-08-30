import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { $ } from "bun"
import { formatPatch, structuredPatch } from "diff"
import { HTTPException } from "hono/http-exception"
import path from "path"
import fs from "fs"
import ignore from "ignore"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Ripgrep } from "./ripgrep"
import fuzzysort from "fuzzysort"
import { Global } from "../global"
import { FileWatcher } from "./watcher"
import { createSearchCache } from "./search-cache"
import { ScienceFile } from "./science"
import { ArtifactFile } from "./artifacts"
import { PublicationFile } from "./publication"
import { PublicationReview } from "./review"
import { SessionFilesystem } from "../session/filesystem"
import { Filesystem } from "../util/filesystem"
import { SafeFileIO } from "./safe-io"
import { FileTrash } from "./trash"
import { Lock } from "@/util/lock"
import { AuthoritySignal } from "@/project/authority-signal"

export namespace File {
  const log = Log.create({ service: "file" })
  const preview = 8 * 1024 * 1024

  type TestHooks = {
    afterReadAuthorization?: (target: string) => void | Promise<void>
    afterWriteAuthorization?: (target: string) => void | Promise<void>
    afterRenameAuthorization?: (source: string, target: string) => void | Promise<void>
  }

  const hooks = { value: undefined as TestHooks | undefined }

  /** Deterministic authority-race barriers for the real file broker. */
  export function testing(input: TestHooks) {
    if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("File test hooks are disabled outside tests")
    const prior = hooks.value
    hooks.value = input
    return {
      [Symbol.dispose]() {
        if (hooks.value === input) hooks.value = prior
      },
    }
  }

  export const Info = z
    .object({
      path: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      status: z.enum(["added", "deleted", "modified"]),
    })
    .meta({
      ref: "File",
    })

  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
      size: z.number().optional(),
      mtime: z.number().optional(),
    })
    .meta({
      ref: "FileNode",
    })
  export type Node = z.infer<typeof Node>

  export const Content = z
    .object({
      type: z.literal("text"),
      content: z.string(),
      before: z.string().optional(),
      diff: z.string().optional(),
      patch: z
        .object({
          oldFileName: z.string(),
          newFileName: z.string(),
          oldHeader: z.string().optional(),
          newHeader: z.string().optional(),
          hunks: z.array(
            z.object({
              oldStart: z.number(),
              oldLines: z.number(),
              newStart: z.number(),
              newLines: z.number(),
              lines: z.array(z.string()),
            }),
          ),
          index: z.string().optional(),
        })
        .optional(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
      size: z.number().optional(),
      truncated: z.boolean().optional(),
    })
    .meta({
      ref: "FileContent",
    })
  export type Content = z.infer<typeof Content>

  export const Rename = z.object({
    from: z.string(),
    to: z.string(),
    type: z.enum(["file", "directory"]),
  })
  export type Rename = z.infer<typeof Rename>

  async function shouldEncode(file: { type?: string }): Promise<boolean> {
    const type = file.type?.toLowerCase()
    log.info("shouldEncode", { type })
    if (!type) return false

    if (type.startsWith("text/")) return false
    if (type.includes("charset=")) return false

    const parts = type.split("/", 2)
    const top = parts[0]
    const rest = parts[1] ?? ""
    const sub = rest.split(";", 1)[0]

    const tops = ["image", "audio", "video", "font", "model", "multipart"]
    if (tops.includes(top)) return true

    const bins = [
      "zip",
      "gzip",
      "bzip",
      "compressed",
      "binary",
      "pdf",
      "msword",
      "powerpoint",
      "excel",
      "ogg",
      "exe",
      "dmg",
      "iso",
      "rar",
    ]
    if (bins.some((mark) => sub.includes(mark))) return true

    return false
  }

  export const Event = {
    Edited: BusEvent.define(
      "file.edited",
      z.object({
        file: z.string(),
      }),
    ),
  }

  const state = Instance.state(
    async () => {
      type Entry = { files: string[]; dirs: string[] }
      const isGlobalHome = Instance.directory === Global.Path.home && Instance.project.id === "global"

      const scan = async () => {
        const result: Entry = { files: [], dirs: [] }

        // Disable scanning if in root of file system.
        if (Instance.directory === path.parse(Instance.directory).root) return result

        if (isGlobalHome) {
          const dirs = new Set<string>()
          const ignore = new Set<string>()

          if (process.platform === "darwin") ignore.add("Library")
          if (process.platform === "win32") ignore.add("AppData")

          const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
          const shouldIgnore = (name: string) => name.startsWith(".") || ignore.has(name)
          const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)

          const top = await fs.promises
            .readdir(Instance.directory, { withFileTypes: true })
            .catch(() => [] as fs.Dirent[])

          for (const entry of top) {
            if (!entry.isDirectory()) continue
            if (shouldIgnore(entry.name)) continue
            dirs.add(entry.name + "/")

            const base = path.join(Instance.directory, entry.name)
            const children = await fs.promises.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
            for (const child of children) {
              if (!child.isDirectory()) continue
              if (shouldIgnoreNested(child.name)) continue
              dirs.add(entry.name + "/" + child.name + "/")
            }
          }

          result.dirs = Array.from(dirs).toSorted()
          return result
        }

        const set = new Set<string>()
        for await (const file of Ripgrep.files({ cwd: Instance.directory })) {
          result.files.push(file)
          let current = file
          while (true) {
            const dir = path.dirname(current)
            if (dir === ".") break
            if (dir === current) break
            current = dir
            if (set.has(dir)) continue
            set.add(dir)
            result.dirs.push(dir + "/")
          }
        }
        return result
      }

      const cache = createSearchCache({
        scan,
        empty: () => ({ files: [], dirs: [] }),
        maxAgeMs: 5_000,
      })
      cache.prime()

      const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, (event) => {
        if (event.properties.event === "change") return
        cache.invalidate()
      })

      return {
        files: cache.read,
        unsubscribe,
      }
    },
    async (entry) => {
      entry.unsubscribe()
    },
  )

  export function init() {
    state()
  }

  type AccessOptions = {
    sessionID?: string
  }

  type RawOptions = AccessOptions & { maxBytes?: number }

  export type RawSource = SafeFileIO.Source & {
    mimeType: string
  }

  type Authority = PublicationFile.Authority & {
    source: string
    [Symbol.dispose](): void
  }

  async function contained(file: string, access: SessionFilesystem.Access, options?: AccessOptions): Promise<string> {
    if (options?.sessionID) {
      const target = await SessionFilesystem.authorize({
        sessionID: options.sessionID,
        path: file,
        access,
      }).then((result) => result.path)
      if (FileTrash.protectedPath(target)) throw new HTTPException(403, { message: "Recovery data is protected" })
      return target
    }
    const full = path.isAbsolute(file) ? file : path.resolve(Instance.directory, file)
    const canonical = await Filesystem.canonical(full)
    if (canonical && FileTrash.protectedPath(canonical)) {
      throw new HTTPException(403, { message: "Recovery data is protected" })
    }
    if (canonical && (await Instance.containsCanonicalPath(canonical))) return canonical
    throw new HTTPException(403, { message: "Access denied: path escapes project directory" })
  }

  async function operate<T>(
    file: string,
    access: SessionFilesystem.Access,
    options: AccessOptions | undefined,
    action: (target: string) => Promise<T>,
  ) {
    if (!options?.sessionID) return action(await contained(file, access))
    const sessionID = options.sessionID
    const authorized = await SessionFilesystem.authorize({ sessionID, path: file, access })
    if (FileTrash.protectedPath(authorized.path)) {
      throw new HTTPException(403, { message: "Recovery data is protected" })
    }
    const binding = await SessionFilesystem.bindAuthorization({ sessionID, access, authorized })
    try {
      if (access === "read") await hooks.value?.afterReadAuthorization?.(authorized.path)
      return await AuthoritySignal.exclusive(async () => {
        const current = await SessionFilesystem.revalidateAuthorization(binding, {
          path: authorized.path,
          access,
        })
        if (FileTrash.protectedPath(current.path)) {
          throw new HTTPException(403, { message: "Recovery data is protected" })
        }
        return action(current.path)
      })
    } finally {
      SessionFilesystem.releaseAuthorization(binding)
    }
  }

  export async function authority(file: string, options: AccessOptions): Promise<Authority> {
    if (!options.sessionID) {
      const source = await contained(file, "read")
      const root = Filesystem.contains(Instance.directory, source) ? Instance.directory : Instance.worktree
      return {
        root,
        source,
        scan: true,
        read: (target) => contained(target, "read"),
        write: (target) => contained(target, "write"),
        [Symbol.dispose]() {},
      }
    }
    const sessionID = options.sessionID
    const result = await SessionFilesystem.authorize({
      sessionID,
      path: file,
      access: "read",
    })
    if (FileTrash.protectedPath(result.path)) throw new HTTPException(403, { message: "Recovery data is protected" })
    const binding = await SessionFilesystem.bindAuthorization({ sessionID, access: "read", authorized: result })
    const writes = new Map<string, SessionFilesystem.Authorization>()
    const pending = new Map<string, Promise<SessionFilesystem.Authorization>>()
    const state = { disposed: false }
    const dispose = () => {
      if (state.disposed) return
      state.disposed = true
      SessionFilesystem.releaseAuthorization(binding)
      for (const current of writes.values()) SessionFilesystem.releaseAuthorization(current)
      writes.clear()
    }
    const active = () => {
      if (state.disposed) {
        throw new SessionFilesystem.DeniedError({ sessionID, path: result.path, access: "read" })
      }
    }
    const grant = await SessionFilesystem.revalidateAuthorization(binding).then(
      (current) => current.grant,
      (error) => {
        dispose()
        throw error
      },
    )
    const stat = await fs.promises.stat(grant.path).catch((error) => {
      dispose()
      throw error
    })
    const scan = stat.isDirectory()
    const root = scan ? grant.path : path.dirname(result.path)
    const read = async (target: string) => {
      active()
      const absolute = path.isAbsolute(target) ? target : path.resolve(root, target)
      const current = await SessionFilesystem.revalidateAuthorization(binding, { path: absolute, access: "read" })
      if (FileTrash.protectedPath(current.path)) throw new HTTPException(403, { message: "Recovery data is protected" })
      return current.path
    }
    const write = async (target: string) => {
      active()
      const absolute = path.isAbsolute(target) ? target : path.resolve(root, target)
      const acquire = async () => {
        const existing = writes.get(absolute)
        if (existing) return existing
        const running = pending.get(absolute)
        if (running) return running
        const created = (async () => {
          const authorized = await SessionFilesystem.authorize({ sessionID, path: absolute, access: "write" })
          if (FileTrash.protectedPath(authorized.path)) {
            throw new HTTPException(403, { message: "Recovery data is protected" })
          }
          const current = await SessionFilesystem.bindAuthorization({ sessionID, access: "write", authorized })
          if (!state.disposed) {
            writes.set(absolute, current)
            return current
          }
          SessionFilesystem.releaseAuthorization(current)
          throw new SessionFilesystem.DeniedError({ sessionID, path: absolute, access: "write" })
        })()
        pending.set(absolute, created)
        return created.finally(() => {
          if (pending.get(absolute) === created) pending.delete(absolute)
        })
      }
      const current = await acquire()
      return SessionFilesystem.revalidateAuthorization(current, { path: absolute, access: "write" }).then(
        (authorized) => authorized.path,
      )
    }
    return { root, source: result.path, scan, sessionID, read, write, [Symbol.dispose]: dispose }
  }

  export async function status() {
    const project = Instance.project
    if (project.vcs !== "git") return []

    const diffOutput = await $`git -c core.quotepath=false diff --numstat HEAD`
      .cwd(Instance.directory)
      .quiet()
      .nothrow()
      .text()

    const changedFiles: Info[] = []

    if (diffOutput.trim()) {
      const lines = diffOutput.trim().split("\n")
      for (const line of lines) {
        const [added, removed, filepath] = line.split("\t")
        changedFiles.push({
          path: filepath,
          added: added === "-" ? 0 : parseInt(added, 10),
          removed: removed === "-" ? 0 : parseInt(removed, 10),
          status: "modified",
        })
      }
    }

    const untrackedOutput = await $`git -c core.quotepath=false ls-files --others --exclude-standard`
      .cwd(Instance.directory)
      .quiet()
      .nothrow()
      .text()

    if (untrackedOutput.trim()) {
      const untrackedFiles = untrackedOutput.trim().split("\n")
      for (const filepath of untrackedFiles) {
        try {
          const snapshot = await SafeFileIO.read(path.join(Instance.directory, filepath), { prefixBytes: preview })
          const lines =
            snapshot.size > snapshot.bytes.byteLength ? 0 : snapshot.bytes.toString("utf8").split("\n").length
          changedFiles.push({
            path: filepath,
            added: lines,
            removed: 0,
            status: "added",
          })
        } catch {
          continue
        }
      }
    }

    // Get deleted files
    const deletedOutput = await $`git -c core.quotepath=false diff --name-only --diff-filter=D HEAD`
      .cwd(Instance.directory)
      .quiet()
      .nothrow()
      .text()

    if (deletedOutput.trim()) {
      const deletedFiles = deletedOutput.trim().split("\n")
      for (const filepath of deletedFiles) {
        changedFiles.push({
          path: filepath,
          added: 0,
          removed: 0, // Could get original line count but would require another git command
          status: "deleted",
        })
      }
    }

    return changedFiles.map((x) => ({
      ...x,
      path: path.relative(Instance.directory, x.path),
    }))
  }

  async function readPath(file: string, full: string): Promise<Content> {
    using _ = log.time("read", { file })
    const project = Instance.project
    const mimeType = Bun.file(full).type || "application/octet-stream"
    const encode = ScienceFile.binary(file) || (await shouldEncode({ type: mimeType }))
    const snapshot = await SafeFileIO.optional(
      full,
      encode ? { maxBytes: 16 * 1024 * 1024 } : { prefixBytes: preview },
    ).catch((error: unknown) => {
      if (encode && error instanceof SafeFileIO.LimitError) return error
      throw error
    })
    if (!snapshot) throw new HTTPException(404, { message: `File not found: ${file}` })
    if (snapshot instanceof SafeFileIO.LimitError) {
      return {
        type: "text",
        content: "",
        mimeType,
        encoding: "base64",
        size: snapshot.size,
        truncated: true,
      }
    }
    const bunFile = new Blob([new Uint8Array(snapshot.bytes)], { type: mimeType })

    if (encode) {
      const buffer = await bunFile.arrayBuffer().catch(() => new ArrayBuffer(0))
      const content = Buffer.from(buffer).toString("base64")
      return { type: "text", content, mimeType, encoding: "base64", size: bunFile.size }
    }

    const truncated = snapshot.size > snapshot.bytes.byteLength
    // Keep scientific/text previews bounded. The UI treats this response as
    // read-only, so a partial preview can never overwrite the source file.
    const content = await (truncated ? bunFile.slice(0, preview) : bunFile).text().catch(() => "")
    if (truncated) {
      return {
        type: "text",
        content,
        size: snapshot.size,
        truncated: true,
      }
    }

    if (project.vcs === "git" && (await Instance.containsCanonicalPath(full))) {
      const relative = path.relative(Instance.directory, full)
      let diff = await $`git diff ${relative}`.cwd(Instance.directory).quiet().nothrow().text()
      if (!diff.trim()) diff = await $`git diff --staged ${relative}`.cwd(Instance.directory).quiet().nothrow().text()
      if (diff.trim()) {
        const original = await $`git show HEAD:${relative}`.cwd(Instance.directory).quiet().nothrow().text()
        const patch = structuredPatch(relative, relative, original, content, "old", "new", {
          context: Infinity,
          ignoreWhitespace: true,
        })
        const diff = formatPatch(patch)
        return { type: "text", content, before: original, patch, diff }
      }
    }
    return { type: "text", content }
  }

  export async function read(file: string, options?: AccessOptions): Promise<Content> {
    return operate(file, "read", options, (full) => readPath(file, full))
  }

  export async function inspect(file: string, options?: AccessOptions): Promise<ScienceFile.Inspection> {
    const full = await contained(file, "read", options)
    return ScienceFile.inspect(full, file, options)
  }

  export async function raw(file: string, options?: RawOptions): Promise<Blob> {
    return operate(file, "read", options, async (full) => {
      const snapshot = await SafeFileIO.optional(full, { maxBytes: options?.maxBytes }).catch((error: unknown) => {
        if (error instanceof SafeFileIO.LimitError) {
          throw new HTTPException(413, { message: `File exceeds the ${error.maxBytes}-byte response limit` })
        }
        throw error
      })
      if (!snapshot) throw new HTTPException(404, { message: `File not found: ${file}` })
      return new Blob([new Uint8Array(snapshot.bytes)], { type: Bun.file(full).type })
    })
  }

  export async function rawSource(file: string, options?: RawOptions): Promise<RawSource> {
    const open = async (full: string, sourceOptions?: Parameters<typeof SafeFileIO.open>[1]) => {
      const source = await SafeFileIO.open(full, { ...sourceOptions, maxBytes: options?.maxBytes }).catch(
        (error: unknown) => {
          if (error instanceof SafeFileIO.LimitError) {
            throw new HTTPException(413, { message: `File exceeds the ${error.maxBytes}-byte response limit` })
          }
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new HTTPException(404, { message: `File not found: ${file}` })
          }
          throw error
        },
      )
      return { ...source, mimeType: Bun.file(full).type || "application/octet-stream" }
    }
    if (!options?.sessionID) return open(await contained(file, "read"))
    const sessionID = options.sessionID
    const authorized = await SessionFilesystem.authorize({ sessionID, path: file, access: "read" })
    if (FileTrash.protectedPath(authorized.path)) {
      throw new HTTPException(403, { message: "Recovery data is protected" })
    }
    const binding = await SessionFilesystem.bindAuthorization({ sessionID, access: "read", authorized })
    const release = () => SessionFilesystem.releaseAuthorization(binding)
    try {
      await hooks.value?.afterReadAuthorization?.(authorized.path)
      return await AuthoritySignal.exclusive(async () => {
        const current = await SessionFilesystem.revalidateAuthorization(binding, {
          path: authorized.path,
          access: "read",
        })
        if (FileTrash.protectedPath(current.path)) {
          throw new HTTPException(403, { message: "Recovery data is protected" })
        }
        return open(current.path, {
          onClose: release,
          during: (action) =>
            AuthoritySignal.exclusive(async () => {
              await SessionFilesystem.revalidateAuthorization(binding, {
                path: current.path,
                access: "read",
              })
              return action()
            }),
        })
      })
    } catch (error) {
      release()
      throw error
    }
  }

  export async function artifacts(options?: AccessOptions): Promise<ArtifactFile.Info[]> {
    const workspace = options?.sessionID ? await SessionFilesystem.workspace(options.sessionID) : undefined
    const roots = options?.sessionID
      ? await SessionFilesystem.processReadRoots(options.sessionID)
      : [Instance.directory]
    const unique = [...new Set(roots.map((root) => path.resolve(root)))]
      .toSorted((a, b) => a.length - b.length || a.localeCompare(b))
      .filter((root, index, values) => !values.slice(0, index).some((parent) => Filesystem.contains(parent, root)))
      .slice(0, 256)
    const limits = ArtifactFile.limits()
    const scans: Array<{ root: string; items: ArtifactFile.Info[] }> = []
    const batches = Array.from({ length: Math.ceil(unique.length / 4) }, (_, index) =>
      unique.slice(index * 4, (index + 1) * 4),
    )
    for (const batch of batches) {
      scans.push(
        ...(await Promise.all(
          batch.map(async (root) => {
            const items = await fs.promises
              .lstat(root)
              .then(async (stat) => {
                if (stat.isDirectory()) return ArtifactFile.scan(root, limits)
                if (!stat.isFile()) return []
                limits.visits += 1
                if (limits.artifacts >= 5_000 || limits.visits >= 50_000) return []
                const classified = ArtifactFile.classify(path.basename(root))
                if (!classified) return []
                limits.artifacts += 1
                return [
                  {
                    name: path.basename(root),
                    path: root,
                    kind: classified.kind,
                    format: classified.format,
                    size: stat.size,
                    modified: stat.mtimeMs,
                  },
                ]
              })
              .catch((error: unknown) => {
                log.warn("artifact scan skipped an unavailable root", {
                  root,
                  error: error instanceof Error ? error.message : String(error),
                })
                return []
              })
            return { root, items }
          }),
        )),
      )
    }
    const artifacts = new Map<string, ArtifactFile.Info>()
    for (const scan of scans) {
      for (const item of scan.items) {
        const root = scan.root
        const absolute = path.isAbsolute(item.path) ? item.path : path.resolve(root, item.path)
        if (artifacts.has(absolute)) continue
        const local =
          workspace && Filesystem.contains(workspace, absolute)
            ? path.relative(workspace, absolute).replaceAll(path.sep, "/")
            : Filesystem.contains(Instance.directory, absolute)
              ? path.relative(Instance.directory, absolute).replaceAll(path.sep, "/")
              : absolute
        artifacts.set(absolute, { ...item, path: local })
      }
    }
    return [...artifacts.values()]
      .toSorted((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
      .slice(0, 5_000)
  }

  export async function provenance(file: string, options?: AccessOptions): Promise<ArtifactFile.Provenance> {
    using scope = await authority(file, options ?? {})
    if (!scope.scan) {
      return { path: scope.source, tracked: false, dirty: false, status: "local" }
    }
    return await ArtifactFile.provenance(scope.root, scope.source, file)
  }

  export async function reproducibility(): Promise<ArtifactFile.Audit> {
    return ArtifactFile.audit(Instance.directory)
  }

  export async function manifest(): Promise<ArtifactFile.Manifest> {
    return ArtifactFile.manifest(Instance.directory)
  }

  export async function publicationCapabilities(): Promise<PublicationFile.Capabilities> {
    return PublicationFile.capabilities()
  }

  export async function publication(
    input: PublicationFile.Input,
    options?: AccessOptions,
  ): Promise<PublicationFile.Result> {
    if (!options?.sessionID) return PublicationFile.render(Instance.directory, input)
    using scope = await authority(input.path, options)
    return await PublicationFile.render(scope.root, { ...input, path: scope.source }, scope)
  }

  export async function review(
    input: PublicationReview.RunInput,
    options?: AccessOptions,
  ): Promise<PublicationReview.Report> {
    if (!options?.sessionID) return PublicationReview.run(input)
    using scope = await authority(input.path, options)
    return await PublicationReview.run({ ...input, path: scope.source }, scope)
  }

  export async function reviewCurrent(
    file: string,
    options?: AccessOptions,
  ): Promise<PublicationReview.State | undefined> {
    if (!options?.sessionID) return PublicationReview.current(file)
    using scope = await authority(file, options)
    return await PublicationReview.current(scope.source, scope)
  }

  export async function reviewHistory(file: string, options?: AccessOptions): Promise<PublicationReview.Report[]> {
    if (!options?.sessionID) return PublicationReview.history(file)
    using scope = await authority(file, options)
    return await PublicationReview.history(scope.source, scope)
  }

  export async function reviewResolve(
    id: string,
    finding: string,
    input: PublicationReview.ResolveInput,
    options?: AccessOptions,
  ): Promise<PublicationReview.Report> {
    const report = await PublicationReview.get(id)
    const source = path.isAbsolute(report.path) ? report.path : path.resolve(Instance.worktree, report.path)
    if (!options?.sessionID && !(await Instance.containsCanonicalPath(source))) {
      throw new HTTPException(403, {
        message: "A session grant is required to update this connected manuscript review",
      })
    }
    if (!options?.sessionID) return PublicationReview.resolve(id, finding, input)
    using scope = await authority(source, options)
    return await PublicationReview.resolve(id, finding, input, scope)
  }

  export async function reviewFinalize(
    id: string,
    input: PublicationReview.FinalizeInput,
    options?: AccessOptions,
  ): Promise<PublicationReview.Report> {
    const report = await PublicationReview.get(id)
    const source = path.isAbsolute(report.path) ? report.path : path.resolve(Instance.worktree, report.path)
    if (!options?.sessionID && !(await Instance.containsCanonicalPath(source))) {
      throw new HTTPException(403, {
        message: "A session grant is required to finalize this connected manuscript review",
      })
    }
    if (!options?.sessionID) return PublicationReview.finalize(id, input)
    using scope = await authority(source, options)
    return await PublicationReview.finalize(id, input, scope)
  }

  export async function write(file: string, content: string, options?: AccessOptions): Promise<Content> {
    using _ = log.time("write", { file })
    const mutate = async (full: string) => {
      const approved = await SafeFileIO.optional(full)
      await SafeFileIO.write(full, content, approved)
      return { full, exists: !!approved, content: await readPath(file, full) }
    }
    const result = await (async () => {
      if (!options?.sessionID) return mutate(await contained(file, "write"))
      const sessionID = options.sessionID
      const authorized = await SessionFilesystem.authorize({ sessionID, path: file, access: "write" })
      if (FileTrash.protectedPath(authorized.path)) {
        throw new HTTPException(403, { message: "Recovery data is protected" })
      }
      const binding = await SessionFilesystem.bindAuthorization({ sessionID, access: "write", authorized })
      try {
        await hooks.value?.afterWriteAuthorization?.(authorized.path)
        return await AuthoritySignal.exclusive(async () => {
          const current = await SessionFilesystem.revalidateAuthorization(binding, {
            path: authorized.path,
            access: "write",
          })
          if (FileTrash.protectedPath(current.path)) {
            throw new HTTPException(403, { message: "Recovery data is protected" })
          }
          return mutate(current.path)
        })
      } finally {
        SessionFilesystem.releaseAuthorization(binding)
      }
    })()
    await Bus.publish(File.Event.Edited, {
      file: result.full,
    })
    await Bus.publish(FileWatcher.Event.Updated, {
      file: result.full,
      event: result.exists ? "change" : "add",
    })
    return result.content
  }

  export async function rename(input: { from: string; to: string; sessionID: string }): Promise<Rename> {
    const result = await (async () => {
      const source = await SessionFilesystem.authorize({
        sessionID: input.sessionID,
        path: input.from,
        access: "write",
      })
      const sourceBinding = await SessionFilesystem.bindAuthorization({
        sessionID: input.sessionID,
        access: "write",
        authorized: source,
      })
      if (source.path === Instance.directory || source.path === source.grant.path) {
        SessionFilesystem.releaseAuthorization(sourceBinding)
        throw new HTTPException(409, { message: "The workspace root cannot be renamed" })
      }
      if (FileTrash.protectedPath(source.path)) {
        SessionFilesystem.releaseAuthorization(sourceBinding)
        throw new HTTPException(403, { message: "Recovery data is protected" })
      }
      const target = await SessionFilesystem.revalidateAuthorization(sourceBinding, {
        path: input.to,
        access: "write",
      })
        .then(
          (current) => ({ current, binding: sourceBinding }),
          async (error) => {
            if (!SessionFilesystem.DeniedError.isInstance(error)) throw error
            const authorized = await SessionFilesystem.authorize({
              sessionID: input.sessionID,
              path: input.to,
              access: "write",
            })
            const binding = await SessionFilesystem.bindAuthorization({
              sessionID: input.sessionID,
              access: "write",
              authorized,
            })
            return { current: authorized, binding }
          },
        )
        .catch((error) => {
          SessionFilesystem.releaseAuthorization(sourceBinding)
          throw error
        })
      try {
        if (source.path === Instance.directory || source.path === source.grant.path) {
          throw new HTTPException(409, { message: "The workspace root cannot be renamed" })
        }
        if (FileTrash.protectedPath(source.path) || FileTrash.protectedPath(target.current.path)) {
          throw new HTTPException(403, { message: "Recovery data is protected" })
        }
        if (source.grant.path !== target.current.grant.path) {
          throw new HTTPException(409, { message: "Files cannot be renamed across workspace sources" })
        }
        const expected = await SafeFileIO.inspect(source.path)
        if (expected.type === "directory" && source.path !== target.current.path) {
          if (Filesystem.contains(source.path, target.current.path)) {
            throw new HTTPException(409, { message: "A folder cannot be moved inside itself" })
          }
        }
        await hooks.value?.afterRenameAuthorization?.(source.path, target.current.path)

        using _ = await Lock.write(`file-rename:${Instance.project.id}`)
        return await AuthoritySignal.exclusive(async () => {
          const currentSource = await SessionFilesystem.revalidateAuthorization(sourceBinding, {
            path: source.path,
            access: "write",
          })
          const currentTarget = await SessionFilesystem.revalidateAuthorization(target.binding, {
            path: target.current.path,
            access: "write",
          })
          if (currentSource.path === Instance.directory || currentSource.path === currentSource.grant.path) {
            throw new HTTPException(409, { message: "The workspace root cannot be renamed" })
          }
          if (FileTrash.protectedPath(currentSource.path) || FileTrash.protectedPath(currentTarget.path)) {
            throw new HTTPException(403, { message: "Recovery data is protected" })
          }
          if (currentSource.grant.path !== currentTarget.grant.path) {
            throw new HTTPException(409, { message: "Files cannot be renamed across workspace sources" })
          }
          if (currentSource.path === currentTarget.path) {
            const current = await SafeFileIO.inspect(currentSource.path)
            if (current.dev !== expected.dev || current.ino !== expected.ino || current.type !== expected.type) {
              throw new HTTPException(409, { message: "The source changed before it could be renamed" })
            }
            return Rename.parse({ from: currentSource.path, to: currentTarget.path, type: current.type })
          }
          if (expected.type === "directory" && Filesystem.contains(currentSource.path, currentTarget.path)) {
            throw new HTTPException(409, { message: "A folder cannot be moved inside itself" })
          }
          await SafeFileIO.rename(currentSource.path, currentTarget.path, expected).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.errno === 17 || error.code === "EEXIST" || error.code === "ENOTEMPTY") {
                throw new HTTPException(409, { message: `Refusing to overwrite ${currentTarget.path}` })
              }
              if (error.errno === 18 || error.code === "EXDEV") {
                throw new HTTPException(409, { message: "Files cannot be renamed across filesystems" })
              }
              if (error.errno === 2 || error.code === "ENOENT") {
                throw new HTTPException(400, { message: "The source or destination folder no longer exists" })
              }
              throw error
            },
          )
          return Rename.parse({ from: currentSource.path, to: currentTarget.path, type: expected.type })
        })
      } finally {
        if (target.binding !== sourceBinding) SessionFilesystem.releaseAuthorization(target.binding)
        SessionFilesystem.releaseAuthorization(sourceBinding)
      }
    })()
    if (result.from !== result.to) {
      await Promise.all([
        Bus.publish(FileWatcher.Event.Updated, { file: result.from, event: "unlink" }),
        Bus.publish(FileWatcher.Event.Updated, { file: result.to, event: "add" }),
      ])
    }
    return result
  }

  export async function list(dir?: string, options?: AccessOptions) {
    const exclude = [".git", ".DS_Store", FileTrash.FOLDER]
    const project = Instance.project
    let ignored = (_: string) => false
    if (project.vcs === "git") {
      const ig = ignore()
      const gitignore = Bun.file(path.join(Instance.worktree, ".gitignore"))
      if (await gitignore.exists()) {
        ig.add(await gitignore.text())
      }
      const ignoreFile = Bun.file(path.join(Instance.worktree, ".ignore"))
      if (await ignoreFile.exists()) {
        ig.add(await ignoreFile.text())
      }
      ignored = ig.ignores.bind(ig)
    }
    const root = options?.sessionID ? await SessionFilesystem.workspace(options.sessionID) : Instance.directory
    const resolved = await contained(dir || root, "read", options)
    const local = Filesystem.contains(root, resolved)

    const nodes: Node[] = []
    const entries: fs.Dirent[] = await fs.promises
      .readdir(resolved, { withFileTypes: true })
      .catch((err: NodeJS.ErrnoException) => {
        // Surface permission errors as 403 with a TCC-aware message so the
        // SPA can show "grant Full Disk Access" instead of "0 entries".
        // macOS blocks Desktop/Documents/Downloads listings for any process
        // that doesn't have FDA, and node returns EACCES/EPERM in that case.
        if (err?.code === "EACCES" || err?.code === "EPERM") {
          const macHint =
            process.platform === "darwin"
              ? " — grant Full Disk Access to the openscience binary in System Settings → Privacy & Security"
              : ""
          throw new HTTPException(403, {
            message: `permission denied reading ${resolved}${macHint}`,
          })
        }
        if (err?.code === "ENOENT") {
          throw new HTTPException(404, { message: `path not found: ${resolved}` })
        }
        // Unknown error: log and degrade to empty so the request still
        // completes — preserves the prior behaviour for benign cases.
        log.warn("file.list readdir failed", { resolved, error: String(err?.message ?? err) })
        return [] as fs.Dirent[]
      })
    for (const entry of entries) {
      if (exclude.includes(entry.name)) continue
      const fullPath = path.join(resolved, entry.name)
      const relativePath = path.relative(root, fullPath)
      const nodePath = local ? relativePath : fullPath
      const type = entry.isDirectory() ? "directory" : "file"
      // Stat each entry for the file-explorer size / modified columns. Failures
      // (broken symlink, races) degrade to undefined rather than dropping the row.
      const stat = await fs.promises.stat(fullPath).catch(() => undefined)
      nodes.push({
        name: entry.name,
        path: nodePath,
        absolute: fullPath,
        type,
        ignored: local ? ignored(type === "directory" ? relativePath + "/" : relativePath) : false,
        size: stat && type === "file" ? stat.size : undefined,
        mtime: stat ? Math.round(stat.mtimeMs) : undefined,
      })
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    const query = input.query.trim()
    const limit = input.limit ?? 100
    const kind = input.type ?? (input.dirs === false ? "file" : "all")
    log.info("search", { query, kind })

    const result = await state().then((x) => x.files())

    const hidden = (item: string) => {
      const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
      return normalized.split("/").some((p) => p.startsWith(".") && p.length > 1)
    }
    const preferHidden = query.startsWith(".") || query.includes("/.")
    const sortHiddenLast = (items: string[]) => {
      if (preferHidden) return items
      const visible: string[] = []
      const hiddenItems: string[] = []
      for (const item of items) {
        const isHidden = hidden(item)
        if (isHidden) hiddenItems.push(item)
        if (!isHidden) visible.push(item)
      }
      return [...visible, ...hiddenItems]
    }
    if (!query) {
      if (kind === "file") return result.files.slice(0, limit)
      return sortHiddenLast(result.dirs.toSorted()).slice(0, limit)
    }

    const items =
      kind === "file" ? result.files : kind === "directory" ? result.dirs : [...result.files, ...result.dirs]

    const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
    const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((r) => r.target)
    const output = kind === "directory" ? sortHiddenLast(sorted).slice(0, limit) : sorted

    log.info("search", { query, kind, results: output.length })
    return output
  }

  const referenceScanLimit = 50_000

  function relativeReference(value: string) {
    const input = value.trim().replaceAll("\\", "/")
    if (!input || input.length > 4_096 || input.startsWith("/") || /^[A-Za-z]:\//.test(input)) return
    const parts = input.split("/").filter((part) => part && part !== ".")
    if (!parts.length || parts.some((part) => part === ".." || part.includes("\0"))) return
    return parts.join("/")
  }

  /**
   * Resolve a chat-authored relative file reference across the exact roots the
   * active session may read. Managed projects intentionally keep their durable
   * directory separate from user-connected source folders, so joining every
   * relative link to Instance.directory alone cannot open those source files.
   *
   * Explicit relative paths are checked directly. A bare filename gets a
   * bounded recursive lookup. Both modes fail closed when multiple authorized
   * files match, and the eventual read still re-authorizes the returned path so
   * revocation wins between resolution and I/O.
   */
  export async function resolveReference(reference: string, options: { sessionID: string }) {
    const requested = relativeReference(reference)
    if (!requested) return

    // Preview is brokered I/O, not a native process. Exact session-owned tool
    // output grants are intentionally absent from processReadRoots(), but their
    // owner must still be able to open a trajectory's output-file link.
    const grants = await SessionFilesystem.list(options.sessionID)
    const rawRoots = grants
      .filter((grant) => grant.scope !== "once" && !grant.time.consumed && !grant.time.revoked)
      .map((grant) => grant.path)
    const roots: Array<{ path: string; type: "file" | "directory" }> = []
    for (const raw of rawRoots) {
      const canonical = await Filesystem.canonical(raw)
      if (!canonical || FileTrash.protectedPath(canonical)) continue
      const type = await fs.promises.stat(canonical).then(
        (stat) => (stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined),
        () => undefined,
      )
      if (!type || roots.some((root) => root.path === canonical)) continue
      roots.push({ path: canonical, type })
    }

    const matches = new Set<string>()
    const add = async (candidate: string, root: string) => {
      const canonical = await Filesystem.canonical(candidate)
      if (!canonical || !Filesystem.contains(root, canonical) || FileTrash.protectedPath(canonical)) return
      const regular = await fs.promises.stat(canonical).then(
        (stat) => stat.isFile(),
        () => false,
      )
      if (!regular) return
      if (!(await SessionFilesystem.allows({ sessionID: options.sessionID, path: canonical, access: "read" }))) return
      matches.add(canonical)
    }

    const nested = requested.includes("/")
    if (nested) {
      for (const root of roots) {
        if (root.type === "file") continue
        await add(path.resolve(root.path, ...requested.split("/")), root.path)
        if (matches.size > 1) return
      }
      return matches.size === 1 ? matches.values().next().value : undefined
    }

    let scanned = 0
    let complete = true
    for (const root of roots) {
      if (root.type === "file") {
        if (path.basename(root.path) === requested) await add(root.path, root.path)
        if (matches.size > 1) return
        continue
      }
      for await (const file of Ripgrep.files({ cwd: root.path })) {
        scanned += 1
        if (scanned > referenceScanLimit) {
          complete = false
          break
        }
        if (path.basename(file) !== requested) continue
        await add(path.resolve(root.path, file), root.path)
        if (matches.size > 1) return
      }
      if (!complete) break
    }
    return complete && matches.size === 1 ? matches.values().next().value : undefined
  }
}
