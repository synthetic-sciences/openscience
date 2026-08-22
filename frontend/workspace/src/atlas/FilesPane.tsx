import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { useDialog } from "@synsci/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { SourceMenu } from "@/atlas/files/SourceMenu"
import { ArtifactGrid } from "@/atlas/files/ArtifactGrid"
import { FileTable, type FileRow } from "@/atlas/files/FileTable"
import { TrashList, type TrashedFile } from "@/atlas/files/TrashList"
import { buildSources, type PaneSource } from "@/atlas/files/sources"
import { readSource, writeSource } from "@/atlas/files/last-source"
import { RemoteFileView, type RemoteFile } from "@/atlas/files/RemoteFileView"
import { remotePreview } from "@/atlas/files/remote-preview"
import { downloadBlob, requestStoredArtifact } from "@/artifacts/bytes"
import { createArtifactsResource, restoreStoredArtifact } from "@/artifacts/resource"
import type { StoredArtifact } from "@/artifacts/store"
import { uiStore } from "@/atlas/store/ui"
import { FolderPicker } from "@/atlas/FolderPicker"
import { IconChevronRight, IconFolder, IconSearch, IconX } from "@/atlas/shared/Icon"
import {
  connectedFilesystemGrants,
  parseFilesystemSnapshot,
  sessionFilesystemRoot,
  type FilesystemAccess,
  type FilesystemIdentity,
  type FilesystemScope,
  type FilesystemSnapshot,
} from "@/atlas/file-sources"
import "@/atlas/files/FilesPane.css"
import { NativeDirectoryPickerUnavailable } from "@/utils/native-picker"
import { confirmDialog, promptDialog } from "@/atlas/dialogs"

export type Transport = (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>

/** The durable location handed to the inspector's single work-tab owner. */
export interface PaneFile {
  name: string
  path: string
  /**
   * Provenance for integration callbacks. The work-tab owner receives the
   * stable path, so it never reinterprets a file through the browser's later
   * source selection.
   */
  source: string
  readonly?: boolean
}

async function json(response: Response): Promise<unknown> {
  if (response.ok) return response.json()
  const text = await response.text()
  throw new Error(text || `Request failed (${response.status})`)
}

const errorMessage = (value: unknown) => {
  if (value instanceof Error) return value.message
  return String(value || "Request failed")
}

/**
 * One line a person can act on.
 *
 * A failure from the compute routes arrives as a JSON envelope wrapping a
 * multi-kilobyte Python traceback, and putting that in the pane buries the
 * screen in stack frames. Unwrap what we can, keep the first line, and cap it.
 */
const concise = (value: unknown) => {
  const raw = errorMessage(value)
  const unwrapped = (() => {
    try {
      const parsed = JSON.parse(raw) as { data?: { message?: string }; message?: string; error?: string }
      return parsed.data?.message ?? parsed.message ?? parsed.error ?? raw
    } catch {
      return raw
    }
  })()
  const line = unwrapped
    .split("\n")[0]!
    .replace(/^Error:\s*/, "")
    .trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

const normalizeTrash = (value: unknown): TrashedFile[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    if (
      typeof row.id !== "string" ||
      typeof row.filename !== "string" ||
      typeof row.originalPath !== "string" ||
      (row.kind !== "file" && row.kind !== "directory") ||
      typeof row.trashedAt !== "number" ||
      typeof row.expiresAt !== "number"
    )
      return []
    return [
      {
        id: row.id,
        filename: row.filename,
        originalPath: row.originalPath,
        kind: row.kind,
        trashedAt: row.trashedAt,
        expiresAt: row.expiresAt,
      },
    ]
  })
}

// FileExplorer.tsx:57-77 keeps equivalent readAccess/grantAccess/revokeAccess
// helpers, but they are private, unexported, and typed against ProjectRequest
// (which carries a .url this pane's injected transport does not). They are
// reimplemented here against the same endpoints and the same
// parseFilesystemSnapshot guard rather than imported. Folding the pair into
// file-sources.ts is the obvious follow-up.
async function readAccess(transport: Transport, identity: FilesystemIdentity): Promise<FilesystemSnapshot> {
  const value = await transport(`/session/${encodeURIComponent(identity.sessionID)}/filesystem`).then(json)
  const snapshot = parseFilesystemSnapshot(value, identity)
  if (snapshot) return snapshot
  throw new Error("Filesystem access belongs to another session or project.")
}

interface ConnectInput {
  path: string
  access: FilesystemAccess
  scope: FilesystemScope
}

const ACCESS: Array<{ value: FilesystemAccess; label: string }> = [
  { value: "read", label: "Read only" },
  { value: "write", label: "Read & write" },
]

// Read versus write is a security boundary, not a preference, so the pane
// says what each one actually authorises at the moment of choosing.
const accessNote = (access: FilesystemAccess) => {
  if (access === "read") return "Files can be inspected but not changed."
  return "Approved tools and sandboxed runtimes can read and write files in this folder."
}

async function grantAccess(transport: Transport, identity: FilesystemIdentity, input: ConnectInput) {
  return transport(`/session/${encodeURIComponent(identity.sessionID)}/filesystem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(json)
}

/** Rename lives in a dialog because a 150px card is not a text field. */
function RenameArtifact(props: {
  artifact: StoredArtifact
  onSubmit: (title: string) => Promise<unknown>
  onClose: () => void
}): JSX.Element {
  const [title, setTitle] = createSignal(props.artifact.title)

  return (
    <form
      class="files-connect"
      data-artifact-rename
      onSubmit={(event) => {
        event.preventDefault()
        void props.onSubmit(title()).then(() => props.onClose())
      }}
    >
      <label class="files-connect__field">
        <span>Result name</span>
        <input
          data-rename-input
          value={title()}
          autofocus
          maxlength={200}
          aria-label="Result name"
          onInput={(event) => setTitle(event.currentTarget.value)}
        />
      </label>
      <div class="files-connect__row files-connect__row--end">
        <button type="button" class="files-connect__cancel" onClick={() => props.onClose()}>
          Cancel
        </button>
        <button type="submit" class="files-connect__submit" disabled={!title().trim()}>
          Rename
        </button>
      </div>
    </form>
  )
}

export function FilesPane(
  props: {
    request?: Transport
    session?: string
    directory?: string
    /** Test/integration seam. Production delegates to uiStore.openFile. */
    onOpenFile?: (file: PaneFile) => void
    /** Builds an absolute URL for the legacy remote-volume download surface. */
    url?: (path: string, query: Record<string, string>) => string
    onOpenArtifact?: (artifact: StoredArtifact) => void
    /** Bounded test/integration seam. Production downloads authenticated bytes. */
    onDownload?: (name: string, blob: Blob) => void
    onRenameArtifact?: (artifact: StoredArtifact, submit: (title: string) => Promise<unknown>) => void
    onRenameFile?: (file: FileRow, submit: (name: string) => Promise<unknown>) => void
    onTrashFile?: (file: FileRow, submit: () => Promise<unknown>) => void
    onPurgeFile?: (file: TrashedFile, submit: () => Promise<unknown>) => void
  } = {},
): JSX.Element {
  // The `request` prop is a standalone test seam (see FilesPane.test.ts) that
  // mounts with no providers at all. Key the context reads off the prop
  // itself rather than swallowing whatever throws: in production `standalone`
  // is always false, so a missing provider is a real wiring bug and throws
  // loudly instead of quietly degrading into a fake "could not be read".
  // `session` and `directory` complete that seam: with no router or SDK there
  // is no session id or project root to read, and without both the grant
  // snapshot never loads. Production passes neither.
  const standalone = Boolean(props.request)
  const sdk = standalone ? undefined : useSDK()
  const sync = standalone ? undefined : useSync()
  const params = standalone ? ({} as ReturnType<typeof useParams>) : useParams()
  const dialog = standalone ? undefined : useDialog()
  const platform = standalone ? undefined : usePlatform()
  const server = standalone ? undefined : useServer()
  const transport: Transport = props.request ?? sdk!.request

  const projectRoot = () =>
    props.directory ?? (sdk?.directory || sync?.data.path.directory || sync?.project?.worktree || "")
  const projectName = () => projectRoot().split("/").filter(Boolean).at(-1) ?? "Project"
  const sessionID = () => props.session ?? (params.id && params.id !== "new" ? params.id : undefined)
  const identity = (): FilesystemIdentity | undefined => {
    const session = sessionID()
    if (!session || !projectRoot()) return
    return { sessionID: session, projectID: sdk?.projectID, directory: projectRoot() }
  }

  // A grant is minted against a session, and the landing route (/:dir/session)
  // reaches this pane before one exists. The connect form is still worth
  // opening there — it says what it needs — but the button that cannot work
  // must say so rather than swallow the click.
  const blocked = () => {
    if (!sessionID())
      return "Send a message first: a folder is connected to a session, and this one has not started yet."
    if (!projectRoot()) return "Open a project first: a folder is connected to the project you are working in."
    return ""
  }

  // The artifact store is project-scoped through the request headers, so it
  // needs no session identity — only the project root as a refetch key.
  const ask = (path: string, init?: RequestInit) => transport(path, init)
  const [artifacts, { refetch: refetchArtifacts }] = createArtifactsResource(ask, () => sdk?.directory ?? true)
  const [trashError, setTrashError] = createSignal("")
  const [deleted, { refetch: refetchDeleted }] = createResource(
    () => projectRoot() || true,
    () =>
      transport("/file/trash")
        .then(json)
        .then((value) => {
          setTrashError("")
          return normalizeTrash(value)
        })
        .catch((value) => {
          setTrashError(concise(value))
          return [] as TrashedFile[]
        }),
  )

  const [snapshot, { refetch: refetchSnapshot }] = createResource(identity, (current) =>
    readAccess(transport, current).catch(() => undefined),
  )
  const filesystemChanged = sdk?.event.on("session.filesystem.changed", (event) => {
    if (event.properties.sessionID !== sessionID()) return
    void refetchSnapshot()
  })
  if (filesystemChanged) onCleanup(filesystemChanged)
  // Whether Modal is offered at all. Asking costs a settings read, so it waits
  // until someone opens the picker looking for a source; the Volumes themselves
  // are not listed until that source is actually entered.
  //
  // Every open re-asks rather than latching the first answer: a provider
  // disabled in Settings has to disappear, and opening the picker is exactly
  // when the answer has to be current.
  //
  // A signal fed by an effect, deliberately not a resource. Reading a resource
  // from the render tree increments the nearest <Suspense> counter, and this
  // pane renders inside RightPane's -- the same trap that once blanked the whole
  // pane while a thumbnail loaded.
  const [opened, setOpened] = createSignal(0)
  const [modalReady, setModalReady] = createSignal(false)
  createEffect(() => {
    if (opened() === 0) return
    let live = true
    onCleanup(() => (live = false))
    void transport("/settings/compute")
      .then(json)
      .then((value) => {
        const providers =
          (value as { providers?: Array<{ id: string; connected: boolean; enabled: boolean }> }).providers ?? []
        const modal = providers.find((provider) => provider.id === "modal")
        return Boolean(modal?.connected && modal.enabled)
      })
      .catch(() => false)
      .then((ready) => live && setModalReady(ready))
  })

  const sources = createMemo(() =>
    buildSources({
      projectRoot: projectRoot(),
      projectName: projectName(),
      grants: connectedFilesystemGrants(snapshot.latest),
      sessionRoot: sessionFilesystemRoot(snapshot.latest),
      modal: modalReady(),
    }),
  )

  // The pick is remembered by id, not by the object that was clicked.
  // `sources()` rebuilds on every snapshot refetch and every project change, so
  // a captured object goes stale twice over: it keeps the root it was built
  // with (a project switch would keep listing the old project), and it stops
  // matching the rows the menu renders, which compare the active source by
  // identity for their ✓ and aria-checked.
  const [picked, setPicked] = createSignal<string | undefined>(readSource())

  /** Picking a source is also how the pane remembers where to open next time. */
  const choose = (id: string | undefined) => {
    setPicked(id)
    writeSource(id)
  }

  // Artifacts lead: they are what a session produces, and a remembered pick only
  // wins while it still names a source that exists — a grant that was revoked, or
  // a project that was closed, falls back rather than showing nothing.
  const current = createMemo(
    () =>
      sources().find((item) => item.id === picked()) ??
      sources().find((item) => item.kind === "artifacts") ??
      sources().find((item) => item.kind === "project") ??
      sources()[0]!,
  )
  const [path, setPath] = createSignal<string[]>([])
  const [filter, setFilter] = createSignal("")
  const [error, setError] = createSignal("")
  const [listingError, setListingError] = createSignal("")
  // Local/project/connected files are owned by RightPane's persisted work-tab
  // strip. Modal Volume bytes cannot be represented by a local ContextFile, so
  // they use one focused preview with an explicit return control instead of a
  // second, competing tab system.
  const [remoteOpen, setRemoteOpen] = createSignal<RemoteFile>()
  const [busy, setBusy] = createSignal(false)
  const [connect, setConnect] = createStore({
    open: false,
    path: "",
    access: "read" as FilesystemAccess,
    scope: "project" as FilesystemScope,
  })

  const where = () => [current().root, ...path()].filter(Boolean).join("/")

  // A failed listing resolves to an empty list and sets `error`. It must
  // never reject: RightPane wraps this pane in <Suspense>, and reading an
  // errored resource during render reaches app.tsx's ErrorBoundary, which
  // would replace the entire workspace over one failed poll.
  // A tuple literal is a fresh array on every read and createResource compares
  // its source with ===, so the listing refetched on every unrelated rebuild of
  // `sources()` — a grant snapshot arriving re-listed a folder that had not
  // moved. Compare the parts instead.
  // The source id joins the key so that switching between two Modal Volumes,
  // which share a kind and an empty root, actually re-lists.
  const key = createMemo(() => [where(), sessionID(), current().kind, current().id] as const, undefined, {
    equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3],
  })
  const [entries, { refetch: refetchEntries }] = createResource(key, ([target, session, kind, id]) => {
    // The artifacts and trash pseudo-sources always have root "" — they are
    // backed by the artifact store, not the filesystem, and the server
    // falls back an empty path to the project root (File.list(dir || root)),
    // which would silently list the project's files mislabeled as
    // artifacts. Every other kind always carries a real root once a live
    // project context exists, so gate on the source kind rather than on
    // target emptiness.
    if (kind === "artifacts" || kind === "trash") {
      // No listing is attempted, so the previous listing's failure no longer
      // describes anything on screen — leaving it up puts "this folder could
      // not be read" over a perfectly good trash list.
      setError("")
      setListingError("")
      return Promise.resolve([] as FileRow[])
    }
    // A Volume is not on this machine: it lists over Modal's API, and its
    // entries carry a path relative to the volume root rather than to any
    // directory on disk.
    if (kind === "modal") {
      // The first level inside Modal is the Volume list; everything below it is
      // a path inside whichever Volume was entered.
      const [volume, ...rest] = target.split("/").filter(Boolean)
      if (!volume) {
        return transport("/settings/compute/modal/volumes")
          .then(json)
          .then((value) => {
            setListingError("")
            if (!Array.isArray(value)) return [] as FileRow[]
            // Volumes are folders here: entering one lists it.
            return (value as Array<{ name: string }>).map((item) => ({
              name: item.name,
              type: "directory" as const,
            }))
          })
          .catch((value) => {
            setListingError(`Modal Volumes could not be listed. ${concise(value)}`)
            return [] as FileRow[]
          })
      }
      return transport(`/settings/compute/modal/volumes/${encodeURIComponent(volume)}/files`, undefined, {
        path: `/${rest.join("/")}`,
      })
        .then(json)
        .then((value) => {
          setListingError("")
          if (!Array.isArray(value)) return [] as FileRow[]
          return (value as Array<{ path: string; type: string; size: number }>).map((entry) => ({
            name: entry.path.split("/").filter(Boolean).at(-1) ?? entry.path,
            type: entry.type === "directory" ? ("directory" as const) : ("file" as const),
            size: entry.size,
            path: entry.path,
          }))
        })
        .catch((value) => {
          setListingError(`${volume} could not be read. ${concise(value)}`)
          return [] as FileRow[]
        })
    }
    const query: Record<string, string> = { path: target }
    if (session) query.sessionID = session
    return transport("/file", undefined, query)
      .then(json)
      .then((value) => {
        setListingError("")
        // GET /file returns a bare FileNode[] (backend/cli/src/server/routes/file.ts:158-182,
        // FileListResponses in tooling/sdk/js/src/v2/gen/types.gen.ts:7889). The {data}
        // wrapper only exists on the generated client's RequestResult, never on the body.
        if (Array.isArray(value)) return value as FileRow[]
        const data = (value as { data?: unknown }).data
        return Array.isArray(data) ? (data as FileRow[]) : []
      })
      .catch(() => {
        setListingError("This folder could not be read. The last listing may be out of date.")
        return [] as FileRow[]
      })
  })

  const sourceLoading = createMemo(() => {
    const kind = current().kind
    if (kind === "artifacts") return artifacts.loading
    if (kind === "trash") return artifacts.loading || deleted.loading
    return entries.loading
  })

  const sourceError = createMemo(() => {
    const kind = current().kind
    if (kind === "artifacts") {
      const message = artifacts.latest?.errors.active
      return message ? `Results could not be loaded. ${message}` : ""
    }
    if (kind === "trash") {
      const message = artifacts.latest?.errors.trash ?? trashError()
      return message ? `Trash could not be loaded. ${message}` : ""
    }
    return listingError()
  })

  const retrySource = () => {
    const kind = current().kind
    if (kind === "artifacts" || kind === "trash") {
      void refetchArtifacts()
      if (kind === "trash") void refetchDeleted()
      return
    }
    setListingError("")
    void refetchEntries()
  }

  const rows = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const list = entries.latest ?? []
    return query ? list.filter((row) => row.name.toLowerCase().includes(query)) : list
  })

  const artifactTrash = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const list = artifacts.latest?.trash ?? []
    return query ? list.filter((item) => item.title.toLowerCase().includes(query)) : list
  })

  const fileTrash = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const list = deleted.latest ?? []
    return query ? list.filter((item) => item.filename.toLowerCase().includes(query)) : list
  })

  // The grid takes artifacts whole. Projecting them into FileRow threw away the
  // MIME type, the session and the version count — everything that makes an
  // artifact different from a file in a folder.
  const stored = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const list = artifacts.latest?.active ?? []
    return query ? list.filter((item) => item.title.toLowerCase().includes(query)) : list
  })

  const filterCopy = createMemo(() => {
    if (current().kind === "artifacts") return "Search artifacts"
    if (current().kind === "trash") return "Search trash"
    return "Filter this folder"
  })

  /**
   * The source picker answers "where?"; this line answers "what kind of place
   * is this?" without turning the compact toolbar into a storage manual. Keep
   * every claim inside the contracts the pane can actually observe.
   */
  const sourceContext = createMemo(() => {
    const source = current()
    // The artifact catalog and Trash already explain their retention model in
    // their own first content row. Repeating it here would add a third label
    // for the same concept directly above that row.
    if (source.kind === "artifacts" || source.kind === "trash") return
    if (source.kind === "session")
      return {
        label: "Session workspace",
        copy: "Scratch files for this session.",
        badge: "Scratch",
      }
    if (source.kind === "modal")
      return {
        label: "Remote files",
        copy: "Browse and download from configured Modal Volumes.",
        badge: "Read only",
      }
    if (source.kind === "connected")
      return source.readonly
        ? {
            label: "Connected folder",
            copy: "Files can be inspected without changing the folder.",
            badge: "Read only",
          }
        : {
            label: "Connected folder",
            copy: "Approved tools and sandboxed runtimes can read and write files here.",
            badge: "Read & write",
          }
    return {
      label: "Project files",
      copy: "Working files in this project's folder.",
      badge: "This computer",
    }
  })

  // Session titles label the grid's groups. They live in the sync store, which
  // a standalone mount has no access to, so the map is simply empty there and
  // groupBySession falls back to abbreviated ids.
  const titles = createMemo(() => {
    const sessions = sync?.data.session ?? []
    return new Map(sessions.filter((item) => item.title).map((item) => [item.id, item.title]))
  })

  // An artifact's bytes are addressed by id and version, never by the source
  // path they were captured from — that file keeps changing after capture.
  // The authenticated request transport is mandatory: a raw browser URL does
  // not carry the desktop client's auth headers.
  const readArtifact = (artifact: StoredArtifact) =>
    requestStoredArtifact(transport, artifact.id, artifact.current.id).then((response) => response.blob())

  const downloadArtifact = (artifact: StoredArtifact) => {
    if (busy()) return
    setBusy(true)
    return requestStoredArtifact(transport, artifact.id, artifact.current.id, true)
      .then((response) => response.blob())
      .then((blob) => {
        if (props.onDownload) return props.onDownload(artifact.current.filename, blob)
        downloadBlob(artifact.current.filename, blob)
      })
      .then(() => setError(""))
      .catch((value) => setError(`${artifact.current.filename} could not be downloaded. ${concise(value)}`))
      .finally(() => setBusy(false))
  }

  const openArtifact = (artifact: StoredArtifact) => {
    if (props.onOpenArtifact) return props.onOpenArtifact(artifact)
    uiStore.openSaved(artifact)
  }

  const trashArtifact = async (artifact: StoredArtifact) => {
    setBusy(true)
    return transport(`/file/artifact-store/${encodeURIComponent(artifact.id)}`, { method: "DELETE" })
      .then(json)
      .then(() => {
        // The store's own listeners refresh every other artifact surface too,
        // so the grid does not have to know who else is showing this artifact.
        window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
        return refetchArtifacts()
      })
      .catch((value) => setError(errorMessage(value)))
      .finally(() => setBusy(false))
  }

  const renameArtifact = (artifact: StoredArtifact) => {
    const submit = async (title: string) => {
      const next = title.trim()
      if (!next || next === artifact.title) return
      setBusy(true)
      return transport(`/file/artifact-store/${encodeURIComponent(artifact.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      })
        .then(json)
        .then(() => {
          window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
          return refetchArtifacts()
        })
        .catch((value) => setError(errorMessage(value)))
        .finally(() => setBusy(false))
    }
    if (props.onRenameArtifact) return props.onRenameArtifact(artifact, submit)
    dialog?.show(() => <RenameArtifact artifact={artifact} onSubmit={submit} onClose={() => dialog.close()} />)
  }

  /**
   * A Volume file has no path on this machine, so there is nothing for a tab to
   * read: the pane downloads it instead, which is what the surface this replaced
   * did. The seam exists because a standalone mount has no document to click
   * through and no object URLs to revoke.
   */
  const remoteBytes = async (file: RemoteFile) => {
    const response = await transport(
      `/settings/compute/modal/volumes/${encodeURIComponent(file.volume)}/file`,
      undefined,
      { path: `/${file.path.replace(/^\/+/, "")}` },
    )
    if (!response.ok) throw new Error((await response.text()) || `Could not read ${file.name} (${response.status})`)
    return response.blob()
  }

  const downloadRemote = async (row: FileRow) => {
    const volume = path()[0]
    if (!volume) return
    // Leading slash on purpose. The route resolves the containing directory with
    // path.posix.dirname (routes/settings/compute.ts), and dirname("hello.txt")
    // is ".", which Modal answers with NOT_FOUND -- so a file at a Volume's root
    // could not be downloaded at all. "/hello.txt" gives dirname "/", the root.
    const target = `/${(row.path ?? row.name).replace(/^\/+/, "")}`
    const route = `/settings/compute/modal/volumes/${encodeURIComponent(volume)}/file`
    if (!props.onDownload) {
      const build = props.url ?? sdk?.request.url
      try {
        if (!build) throw new Error("A direct download URL is unavailable.")
        const anchor = document.createElement("a")
        anchor.href = build(route, { path: target })
        anchor.download = row.name
        anchor.hidden = true
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        setError("")
      } catch (value) {
        setError(`${row.name} could not be downloaded. ${concise(value)}`)
      }
      return
    }
    setBusy(true)
    return transport(route, undefined, { path: target })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || `Download failed (${response.status})`)
        const blob = await response.blob()
        props.onDownload?.(row.name, blob)
      })
      .catch((value) => setError(`${row.name} could not be downloaded. ${concise(value)}`))
      .finally(() => setBusy(false))
  }

  const open = (row: FileRow) => {
    const from = current()
    // A session's relative FileNode.path is relative to its isolated scratch
    // root, even when the picker is browsing the project or a connected
    // folder. Preserve the API's canonical handle so the preview and Details
    // requests do not accidentally read an empty same-named scratch path.
    const target = filePath(row)
    const file: PaneFile = {
      name: row.name,
      path: target,
      source: from.name,
      readonly: from.readonly,
    }
    if (props.onOpenFile) return props.onOpenFile(file)
    uiStore.openFile(projectRoot(), file.path)
  }

  const filePath = (row: FileRow) => row.absolute ?? row.path ?? [where(), row.name].filter(Boolean).join("/")

  const mutable = createMemo(() => {
    const kind = current().kind
    return Boolean(
      sessionID() && !current().readonly && (kind === "project" || kind === "session" || kind === "connected"),
    )
  })

  const renameFile = (row: FileRow) => {
    const submit = async (name: string) => {
      const next = name.trim()
      if (!next || next === row.name) return
      if (next === "." || next === ".." || /[\\/\u0000]/u.test(next)) {
        setError("A file name cannot contain a path separator.")
        return
      }
      const session = sessionID()
      if (!session) return setError("Start a session before renaming workspace files.")
      const target = [current().root, ...path(), next].filter(Boolean).join("/")
      setBusy(true)
      return transport("/file/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: filePath(row), to: target, sessionID: session }),
      })
        .then(json)
        .then(() => refetchEntries())
        .then(() => setError(""))
        .catch((value) => setError(`${row.name} could not be renamed. ${concise(value)}`))
        .finally(() => setBusy(false))
    }
    if (props.onRenameFile) return props.onRenameFile(row, submit)
    if (!dialog) return
    void promptDialog(dialog, {
      title: `Rename ${row.type === "directory" ? "folder" : "file"}`,
      message: "Enter a new name. Existing files will never be replaced.",
      initial: row.name,
      confirmLabel: "Rename",
    }).then((name) => (name === null ? undefined : submit(name)))
  }

  const trashFile = (row: FileRow) => {
    const submit = async () => {
      const session = sessionID()
      if (!session) return setError("Start a session before changing workspace files.")
      setBusy(true)
      return transport("/file/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath(row), sessionID: session }),
      })
        .then(json)
        .then(() => Promise.all([refetchEntries(), refetchDeleted()]))
        .then(() => setError(""))
        .catch((value) => setError(`${row.name} could not be moved to Trash. ${concise(value)}`))
        .finally(() => setBusy(false))
    }
    if (props.onTrashFile) return props.onTrashFile(row, submit)
    if (!dialog) return
    void confirmDialog(dialog, {
      title: `Move ${row.name} to Trash?`,
      message: "You can restore it from Files for 30 days.",
      confirmLabel: "Move to Trash",
      danger: true,
    }).then((confirmed) => (confirmed ? submit() : undefined))
  }

  const openRemote = (remote: RemoteFile) => setRemoteOpen(remote)

  // The picker walks the real filesystem and hands back an absolute path. It
  // needs the dialog host, so outside a provider the typed path stays the
  // only route in — which is also what keeps this form testable.
  const browse = async () => {
    if (platform?.openDirectoryPickerDialog && server?.isLocal()) {
      const result = await platform
        .openDirectoryPickerDialog({ title: "Connect a folder", serverUrl: sdk?.url })
        .catch((error) => {
          if (!(error instanceof NativeDirectoryPickerUnavailable)) {
            setError(`The system folder picker could not open. ${concise(error)}`)
          }
          return undefined
        })
      if (result !== undefined) {
        const picked = Array.isArray(result) ? result[0] : result
        if (picked) setConnect("path", picked)
        return
      }
    }
    dialog?.show(() => (
      <FolderPicker
        kind="folder"
        title="Connect a folder"
        onSelect={(result) => {
          const picked = Array.isArray(result) ? result[0] : result
          if (picked) setConnect("path", picked)
        }}
      />
    ))
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const current = identity()
    const path = connect.path.trim()
    if (!path || busy()) return
    // The submit button is disabled for this case, but a form still submits on
    // Enter in the path field, so the reason is surfaced rather than dropped.
    if (!current) {
      setError(blocked() || "This folder could not be connected.")
      return
    }
    setBusy(true)
    grantAccess(transport, current, { path, access: connect.access, scope: connect.scope })
      .then(() => refetchSnapshot())
      .then(() => {
        setBusy(false)
        setError("")
        setConnect({ open: false, path: "", access: "read", scope: "project" })
      })
      .catch((cause) => {
        setBusy(false)
        setError(errorMessage(cause))
      })
  }

  const restoreArtifact = (artifact: StoredArtifact) => {
    if (busy()) return
    setBusy(true)
    restoreStoredArtifact(ask, artifact.id)
      .then(() => refetchArtifacts())
      .then(() => {
        setBusy(false)
        setError("")
      })
      .catch((cause) => {
        setBusy(false)
        setError(errorMessage(cause))
      })
  }

  const restoreFile = (file: TrashedFile) => {
    const session = sessionID()
    if (!session || busy()) return
    setBusy(true)
    transport(`/file/trash/${encodeURIComponent(file.id)}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: session }),
    })
      .then(json)
      .then(() => Promise.all([refetchDeleted(), refetchEntries()]))
      .then(() => setError(""))
      .catch((value) => setError(`${file.filename} could not be restored. ${concise(value)}`))
      .finally(() => setBusy(false))
  }

  const purgeFile = (file: TrashedFile) => {
    const submit = async () => {
      const session = sessionID()
      if (!session) return setError("Start a session before changing workspace files.")
      setBusy(true)
      return transport(`/file/trash/${encodeURIComponent(file.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionID: session }),
      })
        .then(json)
        .then(() => refetchDeleted())
        .then(() => setError(""))
        .catch((value) => setError(`${file.filename} could not be deleted. ${concise(value)}`))
        .finally(() => setBusy(false))
    }
    if (props.onPurgeFile) return props.onPurgeFile(file, submit)
    if (!dialog) return
    void confirmDialog(dialog, {
      title: `Delete ${file.filename} permanently?`,
      message: "This cannot be undone.",
      confirmLabel: "Delete permanently",
      danger: true,
    }).then((confirmed) => (confirmed ? submit() : undefined))
  }

  const browser = () => (
    <div class="files-browser" data-files-browser data-source-kind={current().kind}>
      <header class="files-browser__header">
        <div class="files-browser__toolbar">
          <SourceMenu
            sources={sources()}
            active={current()}
            onOpen={() => {
              setOpened(opened() + 1)
              // Grants may be added by another surface or process. The picker
              // is the point at which that inventory must be current even if
              // an SSE reconnect caused the change event to be missed.
              if (identity()) void refetchSnapshot()
            }}
            onPick={(next) => {
              choose(next.id)
              setPath([])
              setFilter("")
              // The notice describes the source being left, not the one arriving.
              setError("")
              setListingError("")
            }}
            onAdd={() => setConnect({ open: true, path: "", access: "read", scope: "project" })}
          />

          <div class="files-search" role="search">
            <span class="files-search__icon" aria-hidden="true">
              <IconSearch size={14} strokeWidth={1.5} />
            </span>
            <input
              class="files-search__input"
              type="search"
              value={filter()}
              placeholder={filterCopy()}
              aria-label={filterCopy()}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
            <Show when={filter()}>
              <button
                type="button"
                class="files-search__clear"
                data-search-clear
                aria-label="Clear file search"
                onClick={() => setFilter("")}
              >
                <IconX size={12} strokeWidth={1.6} />
              </button>
            </Show>
          </div>
        </div>

        <Show
          when={path().length > 0}
          fallback={
            <Show when={sourceContext()} keyed>
              {(context) => (
                <div
                  class="files-source-context"
                  data-source-context
                  data-source-kind={current().kind}
                  aria-label={`${context.label}. ${context.copy}`}
                >
                  <span class="files-source-context__label">{context.label}</span>
                  <span class="files-source-context__divider" aria-hidden="true" />
                  <span class="files-source-context__copy">{context.copy}</span>
                  <span class="files-source-context__badge">{context.badge}</span>
                </div>
              )}
            </Show>
          }
        >
          <nav class="files-path" aria-label="Current folder">
            <button
              type="button"
              class="files-path__root"
              data-path-root
              aria-label={`Open the root of ${current().name}`}
              title={`Open the root of ${current().name}`}
              onClick={() => {
                setPath([])
                setFilter("")
              }}
            >
              <IconFolder size={14} strokeWidth={1.45} />
            </button>
            <For each={path()}>
              {(part, index) => {
                const last = () => index() === path().length - 1
                return (
                  <>
                    <span class="files-path__separator" aria-hidden="true">
                      <IconChevronRight size={12} strokeWidth={1.5} />
                    </span>
                    <button
                      type="button"
                      class="files-path__crumb"
                      data-path-crumb={index()}
                      aria-current={last() ? "page" : undefined}
                      disabled={last()}
                      title={part}
                      onClick={() => {
                        setPath(path().slice(0, index() + 1))
                        setFilter("")
                      }}
                    >
                      {part}
                    </button>
                  </>
                )
              }}
            </For>
          </nav>
        </Show>
      </header>

      <Show when={connect.open}>
        <form class="files-connect" aria-label="Connect a folder" onSubmit={submit}>
          <div class="files-connect__heading">
            <span>
              <strong>Connect a folder</strong>
              <small>Add another location to this session.</small>
            </span>
            <button
              type="button"
              class="files-connect__dismiss"
              aria-label="Close folder connection form"
              onClick={() => setConnect("open", false)}
            >
              <IconX size={13} strokeWidth={1.6} />
            </button>
          </div>
          <div class="files-connect__row">
            <input
              class="files-connect__path"
              value={connect.path}
              aria-label="Folder path"
              placeholder="/home/you/data"
              spellcheck={false}
              onInput={(event) => setConnect("path", event.currentTarget.value)}
            />
            <Show when={dialog}>
              <button type="button" class="files-connect__browse" data-connect-browse onClick={browse}>
                Browse…
              </button>
            </Show>
          </div>

          <div class="files-connect__row">
            <label class="files-connect__field">
              <span>Access</span>
              <select
                aria-label="Folder access"
                data-connect-access
                value={connect.access}
                onChange={(event) => setConnect("access", event.currentTarget.value as FilesystemAccess)}
              >
                <For each={ACCESS}>{(option) => <option value={option.value}>{option.label}</option>}</For>
              </select>
            </label>
          </div>

          <p class="files-connect__note" data-connect-note>
            {accessNote(connect.access)}
          </p>

          <Show when={blocked()}>
            <p class="files-connect__note files-connect__note--blocked" data-connect-blocked>
              {blocked()}
            </p>
          </Show>

          <div class="files-connect__row files-connect__row--end">
            <button type="button" class="files-connect__cancel" onClick={() => setConnect("open", false)}>
              Cancel
            </button>
            <button
              type="submit"
              class="files-connect__submit"
              data-connect-submit
              title={blocked() || undefined}
              disabled={!connect.path.trim() || busy() || Boolean(blocked())}
            >
              {busy() ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </Show>

      {/* A Volume listing spawns a Modal process and takes seconds. Without this
          the pane looks frozen, and the rows still on screen describe the folder
          being left -- which is how clicking a second one asked for a folder
          inside a folder that was never opened. */}
      <Show when={sourceLoading()}>
        <div class="files-loading" role="status" data-files-loading>
          <span class="files-loading__spark" aria-hidden="true" />
          Loading {current().name}…
        </div>
      </Show>

      <Show when={error()}>
        <div class="files-notice" role="alert">
          {error()}
        </div>
      </Show>

      <Show when={!sourceLoading() && sourceError()}>
        <div class="files-notice files-notice--error" role="alert" data-files-error>
          <span>{sourceError()}</span>
          <button type="button" class="files-notice__retry" onClick={retrySource}>
            Retry
          </button>
        </div>
      </Show>

      {/* One surface per source kind. A Switch says that outright; the nested
          Show whose fallback re-tested the same condition left a reader to
          derive the exclusivity. */}
      <Switch>
        <Match when={current().kind === "trash"}>
          <TrashList
            rows={artifactTrash()}
            files={fileTrash()}
            busy={busy()}
            filtered={Boolean(filter().trim())}
            loading={sourceLoading()}
            unavailable={Boolean(sourceError())}
            onRestore={restoreArtifact}
            onRestoreFile={restoreFile}
            onPurgeFile={purgeFile}
          />
        </Match>

        <Match when={current().kind === "artifacts"}>
          <ArtifactGrid
            artifacts={stored()}
            titles={titles()}
            currentSession={sessionID()}
            filtered={Boolean(filter().trim())}
            loading={sourceLoading()}
            unavailable={Boolean(sourceError())}
            read={readArtifact}
            onOpen={openArtifact}
            onDownload={(artifact) => void downloadArtifact(artifact)}
            onRename={renameArtifact}
            onTrash={(artifact) => void trashArtifact(artifact)}
          />
        </Match>

        <Match when={true}>
          <FileTable
            rows={rows()}
            depth={path().length}
            busy={sourceLoading()}
            mutable={mutable()}
            filtered={Boolean(filter().trim())}
            loading={sourceLoading()}
            unavailable={Boolean(sourceError())}
            onRename={renameFile}
            onTrash={trashFile}
            onUp={() => {
              setPath(path().slice(0, -1))
              // Symmetric with descending: a query typed for the folder being
              // left does not describe the one being returned to, and leaving
              // it applied reports the parent as empty.
              setFilter("")
            }}
            onOpen={(row) => {
              if (row.type === "directory") {
                setPath([...path(), row.name])
                setFilter("")
                return
              }
              // Nothing local to open: a Volume file is previewed from its
              // bytes when it is a format worth showing, and downloaded when it
              // is not.
              if (current().kind === "modal") {
                const volume = path()[0]
                if (!volume) return
                if (!remotePreview(row.name, row.size)) return void downloadRemote(row)
                return openRemote({ name: row.name, path: row.path ?? row.name, volume, size: row.size })
              }
              open(row)
            }}
          />
        </Match>
      </Switch>
    </div>
  )

  return (
    <section class="files-pane" aria-label="Files">
      <Show when={remoteOpen()} keyed fallback={browser()}>
        {(file) => (
          <RemoteFileView
            file={file}
            read={remoteBytes}
            onDownload={(remote) => void downloadRemote({ name: remote.name, type: "file", path: remote.path })}
            onClose={() => setRemoteOpen()}
          />
        )}
      </Show>
    </section>
  )
}
