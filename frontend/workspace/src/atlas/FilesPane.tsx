import { Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { SourceMenu } from "@/atlas/files/SourceMenu"
import { FileTable, type FileRow } from "@/atlas/files/FileTable"
import { FileTabs } from "@/atlas/files/FileTabs"
import { buildSources, type PaneSource } from "@/atlas/files/sources"
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

// useSDK/useSync/useParams throw outside their providers. Production always
// mounts this pane inside them, but the `request` prop is a standalone test
// seam (see FilesPane.test.ts) that mounts with none — so every context read
// here must degrade to undefined instead of taking the whole render down.
function optional<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

export function FilesPane(props: { request?: Transport } = {}): JSX.Element {
  const sdk = optional(useSDK)
  const sync = optional(useSync)
  const params = optional(useParams) ?? {}
  const transport: Transport = props.request ?? sdk?.request ?? (async () => new Response(null, { status: 503 }))

  const projectRoot = () => sdk?.directory || sync?.data.path.directory || sync?.project?.worktree || ""
  const projectName = () => projectRoot().split("/").filter(Boolean).at(-1) ?? "Project"
  const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)
  const identity = (): FilesystemIdentity | undefined => {
    const session = sessionID()
    if (!session || !projectRoot()) return
    return { sessionID: session, projectID: sdk?.projectID, directory: projectRoot() }
  }

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

  const where = () => [current().root, ...path()].filter(Boolean).join("/")

  // A failed listing resolves to an empty list and sets `error`. It must
  // never reject: RightPane wraps this pane in <Suspense>, and reading an
  // errored resource during render reaches app.tsx's ErrorBoundary, which
  // would replace the entire workspace over one failed poll.
  const [entries] = createResource(
    () => [where(), sessionID()] as const,
    ([target, session]) => {
      const query: Record<string, string> = { path: target }
      if (session) query.sessionID = session
      return transport("/file", undefined, query)
        .then(json)
        .then((value) => {
          setError("")
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

  const open = (name: string) => {
    if (!tabs().includes(name)) setTabs([...tabs(), name])
    setActive(name)
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
    </section>
  )
}
