import { Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { SourceMenu } from "@/atlas/files/SourceMenu"
import { FileTable, type FileRow } from "@/atlas/files/FileTable"
import { FileTabs } from "@/atlas/files/FileTabs"
import { TrashList } from "@/atlas/files/TrashList"
import { buildSources, type PaneSource } from "@/atlas/files/sources"
import { createArtifactsResource, restoreStoredArtifact } from "@/artifacts/resource"
import type { StoredArtifact } from "@/artifacts/store"
import {
  connectedFilesystemGrants,
  parseFilesystemSnapshot,
  sessionFilesystemRoot,
  type FilesystemIdentity,
  type FilesystemSnapshot,
} from "@/atlas/file-sources"
import "@/atlas/files/FilesPane.css"

export type Transport = (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>

async function json(response: Response): Promise<unknown> {
  if (response.ok) return response.json()
  const text = await response.text()
  throw new Error(text || `Request failed (${response.status})`)
}

const errorMessage = (value: unknown) => {
  if (value instanceof Error) return value.message
  return String(value || "Request failed")
}

// FileExplorer.tsx (FileExplorer.tsx:121) keeps an equivalent readAccess as a
// private, unexported helper — it is not available from file-sources.ts, so
// it is reimplemented here against the same endpoint and the same
// parseFilesystemSnapshot guard rather than imported.
async function readAccess(transport: Transport, identity: FilesystemIdentity): Promise<FilesystemSnapshot> {
  const value = await transport(`/session/${encodeURIComponent(identity.sessionID)}/filesystem`).then(json)
  const snapshot = parseFilesystemSnapshot(value, identity)
  if (snapshot) return snapshot
  throw new Error("Filesystem access belongs to another session or project.")
}

export function FilesPane(props: { request?: Transport } = {}): JSX.Element {
  // The `request` prop is a standalone test seam (see FilesPane.test.ts) that
  // mounts with no providers at all. Key the context reads off the prop
  // itself rather than swallowing whatever throws: in production `standalone`
  // is always false, so a missing provider is a real wiring bug and throws
  // loudly instead of quietly degrading into a fake "could not be read".
  const standalone = Boolean(props.request)
  const sdk = standalone ? undefined : useSDK()
  const sync = standalone ? undefined : useSync()
  const params = standalone ? ({} as ReturnType<typeof useParams>) : useParams()
  const transport: Transport = props.request ?? sdk!.request

  const projectRoot = () => sdk?.directory || sync?.data.path.directory || sync?.project?.worktree || ""
  const projectName = () => projectRoot().split("/").filter(Boolean).at(-1) ?? "Project"
  const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)
  const identity = (): FilesystemIdentity | undefined => {
    const session = sessionID()
    if (!session || !projectRoot()) return
    return { sessionID: session, projectID: sdk?.projectID, directory: projectRoot() }
  }

  // The artifact store is project-scoped through the request headers, so it
  // needs no session identity — only the project root as a refetch key.
  const ask = (path: string, init?: RequestInit) => transport(path, init)
  const [artifacts, { refetch: refetchArtifacts }] = createArtifactsResource(ask, () => sdk?.directory ?? true)

  const [snapshot] = createResource(identity, (current) => readAccess(transport, current).catch(() => undefined))
  const sources = createMemo(() =>
    buildSources({
      projectRoot: projectRoot(),
      projectName: projectName(),
      grants: connectedFilesystemGrants(snapshot.latest),
      sessionRoot: sessionFilesystemRoot(snapshot.latest),
    }),
  )

  const [source, setSource] = createSignal<PaneSource | undefined>()
  const current = createMemo(() => source() ?? sources().find((item) => item.kind === "project") ?? sources()[0]!)
  const [path, setPath] = createSignal<string[]>([])
  const [filter, setFilter] = createSignal("")
  const [error, setError] = createSignal("")
  const [tabs, setTabs] = createSignal<string[]>([])
  const [active, setActive] = createSignal("files")
  const [busy, setBusy] = createSignal(false)

  const where = () => [current().root, ...path()].filter(Boolean).join("/")

  // A failed listing resolves to an empty list and sets `error`. It must
  // never reject: RightPane wraps this pane in <Suspense>, and reading an
  // errored resource during render reaches app.tsx's ErrorBoundary, which
  // would replace the entire workspace over one failed poll.
  const [entries] = createResource(
    () => [where(), sessionID(), current().kind] as const,
    ([target, session, kind]) => {
      // The artifacts and trash pseudo-sources always have root "" — they are
      // backed by the artifact store, not the filesystem, and the server
      // falls back an empty path to the project root (File.list(dir || root)),
      // which would silently list the project's files mislabeled as
      // artifacts. Every other kind always carries a real root once a live
      // project context exists, so gate on the source kind rather than on
      // target emptiness.
      if (kind === "artifacts" || kind === "trash") return Promise.resolve([] as FileRow[])
      const query: Record<string, string> = { path: target }
      if (session) query.sessionID = session
      return transport("/file", undefined, query)
        .then(json)
        .then((value) => {
          setError("")
          // GET /file returns a bare FileNode[] (backend/cli/src/server/routes/file.ts:158-182,
          // FileListResponses in tooling/sdk/js/src/v2/gen/types.gen.ts:7889). The {data}
          // wrapper only exists on the generated client's RequestResult, never on the body.
          if (Array.isArray(value)) return value as FileRow[]
          const data = (value as { data?: unknown }).data
          return Array.isArray(data) ? (data as FileRow[]) : []
        })
        .catch(() => {
          setError("This folder could not be read. The last listing may be out of date.")
          return [] as FileRow[]
        })
    },
  )

  const rows = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const list = entries.latest ?? []
    return query ? list.filter((row) => row.name.toLowerCase().includes(query)) : list
  })

  const trash = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const list = artifacts.latest?.trash ?? []
    return query ? list.filter((item) => item.title.toLowerCase().includes(query)) : list
  })

  const open = (name: string) => {
    if (!tabs().includes(name)) setTabs([...tabs(), name])
    setActive(name)
  }

  const restore = (artifact: StoredArtifact) => {
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

  return (
    <section class="files-pane" aria-label="Files">
      <FileTabs
        open={tabs()}
        active={active()}
        onSelect={setActive}
        onClose={(name) => {
          setTabs(tabs().filter((tab) => tab !== name))
          if (active() === name) setActive("files")
        }}
      />

      <div class="files-source-row">
        <SourceMenu
          sources={sources()}
          active={current()}
          onPick={(next) => {
            setSource(next)
            setPath([])
            setFilter("")
          }}
        />
      </div>

      <div class="files-search-row">
        <input
          class="files-search"
          type="search"
          value={filter()}
          placeholder={`Search ${current().name}`}
          aria-label={`Search ${current().name}`}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
      </div>

      <Show when={error()}>
        <div class="files-notice" role="status">
          {error()}
        </div>
      </Show>

      <Show
        when={current().kind === "trash"}
        fallback={
          <FileTable
            rows={rows()}
            depth={path().length}
            onUp={() => setPath(path().slice(0, -1))}
            onOpen={(row) => {
              if (row.type === "directory") {
                setPath([...path(), row.name])
                setFilter("")
                return
              }
              open(row.name)
            }}
          />
        }
      >
        <TrashList rows={trash()} busy={busy()} onRestore={restore} />
      </Show>
    </section>
  )
}
