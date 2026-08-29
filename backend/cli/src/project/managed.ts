import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { Storage } from "@/storage/storage"
import { FileLease } from "@/util/file-lease"
import { Project } from "./project"

export namespace ManagedProject {
  export const Info = z.object({
    version: z.literal(1),
    projectID: z.string().startsWith("prj_"),
    directory: z.string(),
    time: z.object({
      created: z.number(),
    }),
  })
  export type Info = z.infer<typeof Info>

  const OperationBase = z.object({
    version: z.literal(1),
    operationID: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  export const Operation = z.discriminatedUnion("state", [
    OperationBase.extend({
      state: z.literal("pending"),
      time: z.object({
        created: z.number(),
      }),
    }),
    OperationBase.extend({
      state: z.literal("complete"),
      projectID: z.string().startsWith("prj_"),
      project: Project.Info,
      time: z.object({
        created: z.number(),
        completed: z.number(),
      }),
    }),
  ])
  export type Operation = z.infer<typeof Operation>

  export type IdempotentCreateResult =
    | { status: "created" | "replayed"; project: Project.Info }
    | { status: "conflict" }

  function operationDigest(operationID: string) {
    return crypto.createHash("sha256").update(`managed-project-operation\0${operationID}`).digest("hex")
  }

  function operationDirectory(operationID: string) {
    return path.join(Global.Path.data, "projects", operationDigest(operationID))
  }

  function operationKey(operationID: string) {
    return ["managed_project_operation", operationID]
  }

  async function readOperation(operationID: string) {
    return Storage.read<unknown>(operationKey(operationID))
      .then(Operation.parse)
      .catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
  }

  async function rollback(directory: string) {
    const canonical = Project.canonicalize(directory)
    const projects = await Storage.list(["project"])
    const managed = await Storage.list(["managed_project"])
    const projectIDs = await Promise.all(
      projects.map(async (key) => {
        const project = await Storage.read<Project.Info>(key).catch(() => undefined)
        if (!project) return
        if (Project.canonicalize(project.worktree) !== canonical) return
        return key.at(-1)
      }),
    )
    const markerIDs = await Promise.all(
      managed.map(async (key) => {
        const marker = await Storage.read<unknown>(key)
          .then(Info.safeParse)
          .catch(() => undefined)
        if (!marker?.success) return
        if (Project.canonicalize(marker.data.directory) !== canonical) return
        return key.at(-1)
      }),
    )
    const ids = [...new Set([...projectIDs, ...markerIDs].filter((id): id is string => !!id))]
    const cleanup = await Promise.allSettled([
      ...ids.map((id) => Storage.remove(["managed_project", id])),
      ...ids.map((id) => Storage.remove(["project", id])),
      ...ids.map((id) => Storage.remove(["project_filesystem", id])),
      fs.rm(directory, { recursive: true, force: true }),
    ])
    const failures = cleanup.filter((result) => result.status === "rejected")
    if (failures.length === 0) return
    throw new AggregateError(
      failures.map((result) => result.reason),
      `Failed to roll back managed project ${directory}`,
    )
  }

  async function createAt(name: string, directory: string, checkpoint?: (project: Project.Info) => Promise<void>) {
    const parent = path.join(Global.Path.data, "projects")
    await fs.mkdir(parent, { recursive: true })
    return fs
      .mkdir(directory)
      .then(async () => {
        const created = await Project.fromDirectory(directory)
        const project = await Project.update({
          projectID: created.project.id,
          name,
        })
        await checkpoint?.(project)
        await Storage.write<Info>(["managed_project", project.id], {
          version: 1,
          projectID: project.id,
          directory: await fs.realpath(directory),
          time: {
            created: Date.now(),
          },
        })
        return project
      })
      .catch(async (error) => {
        const cleanup = await rollback(directory).catch((failure) => failure)
        if (cleanup instanceof Error) throw new AggregateError([error, cleanup], "Managed project creation failed")
        throw error
      })
  }

  export async function create(name: string, checkpoint?: (project: Project.Info) => Promise<void>) {
    return createAt(name, path.join(Global.Path.data, "projects", crypto.randomUUID()), checkpoint)
  }

  /**
   * Bind one client operation to one exact request and one managed project.
   *
   * The durable intent is written before any project state and the project root
   * is derived from the opaque operation id. A retry after a lost response
   * therefore returns the original project; a retry after a crash before the
   * receipt was committed first removes the incomplete exact root and resumes
   * without leaving a second project behind.
   */
  export async function createIdempotent(input: {
    operationID: string
    fingerprint: string
    name: string
    checkpoint?: (project: Project.Info) => Promise<void>
  }): Promise<IdempotentCreateResult> {
    const operationID = OperationBase.shape.operationID.parse(input.operationID)
    const fingerprint = OperationBase.shape.fingerprint.parse(input.fingerprint)
    const digest = operationDigest(operationID)
    await using lease = await FileLease.acquire(
      path.join(Global.Path.data, "managed-project-leases", `${digest}.lock`),
      60_000,
    )
    return await lease.during(async () => {
      const current = await readOperation(operationID)
      if (current && current.fingerprint !== fingerprint) return { status: "conflict" }

      if (current?.state === "complete") {
        await Project.resolve(current.projectID, operationDirectory(operationID))
        return { status: "replayed", project: current.project }
      }

      const createdAt = current?.time.created ?? Date.now()
      await Storage.write<Operation>(operationKey(operationID), {
        version: 1,
        operationID,
        fingerprint,
        state: "pending",
        time: { created: createdAt },
      })

      const directory = operationDirectory(operationID)
      // A pending intent can only precede a response. Recover its exact root,
      // including records left by a process killed between the project marker
      // and the completion receipt, before retrying the same operation.
      await rollback(directory)
      const project = await createAt(input.name, directory, input.checkpoint)
      try {
        await Storage.write<Operation>(operationKey(operationID), {
          version: 1,
          operationID,
          fingerprint,
          state: "complete",
          projectID: project.id,
          project,
          time: {
            created: createdAt,
            completed: Date.now(),
          },
        })
      } catch (error) {
        await rollback(directory).catch((cleanup) => {
          throw new AggregateError([error, cleanup], "Managed project receipt could not be committed")
        })
        throw error
      }
      return { status: "created", project }
    })
  }
}
