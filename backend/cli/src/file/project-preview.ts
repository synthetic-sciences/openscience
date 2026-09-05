import path from "node:path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { ManagedProject } from "@/project/managed"
import { Session } from "@/session"
import { SessionFilesystem } from "@/session/filesystem"
import { Storage } from "@/storage/storage"
import { Filesystem } from "@/util/filesystem"
import { FileTrash } from "./trash"

/** Human preview authority for this managed project's durable files. This is
 * deliberately not a session grant: tools and child processes keep their
 * existing scratch/connected-folder boundaries. Recheck at every read, not
 * just when resolving a chat link. */
export namespace ProjectPreview {
  export async function resolve(file: string, sessionID: string) {
    const session = await Session.get(sessionID)
    const root = await Filesystem.canonical(Instance.directory)
    if (
      !root ||
      root !== path.resolve(Instance.directory) ||
      session.directory !== Instance.directory ||
      session.projectID !== Instance.project.id
    )
      return
    const marker = await Storage.read<unknown>(["managed_project", Instance.project.id])
      .then(ManagedProject.Info.parse)
      .catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
    if (!marker || marker.projectID !== session.projectID) return
    const parent = await Filesystem.canonical(path.join(Global.Path.data, "projects"))
    if (
      path.dirname(root) !== parent ||
      root !== path.resolve(marker.directory) ||
      root !== path.resolve(Instance.project.worktree)
    )
      return
    const target = await Filesystem.canonical(path.resolve(root, file))
    if (!target || !Filesystem.contains(root, target) || FileTrash.protectedPath(target)) return
    return target
  }

  export async function authorize(file: string, sessionID?: string) {
    const target = sessionID ? await resolve(file, sessionID) : undefined
    if (target) return target
    throw new SessionFilesystem.DeniedError({ sessionID: sessionID ?? "", path: file, access: "read" })
  }
}
