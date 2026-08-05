import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { useDialog } from "@synsci/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { SourceMenu } from "@/atlas/files/SourceMenu"
import { FileTable, type FileRow } from "@/atlas/files/FileTable"
import { FileTabs } from "@/atlas/files/FileTabs"
import { TrashList } from "@/atlas/files/TrashList"
import { buildSources, type PaneSource } from "@/atlas/files/sources"
import { createArtifactsResource, restoreStoredArtifact } from "@/artifacts/resource"
import type { StoredArtifact } from "@/artifacts/store"
import { FileView } from "@/atlas/FilePreview"
import { FolderPicker } from "@/atlas/FolderPicker"
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

export type Transport = (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>

/** An open tab: the name the strip shows, and the handle FileView reads. */
export interface PaneFile {
  name: string
  path: string
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

const SCOPE: Array<{ value: FilesystemScope; label: string }> = [
  { value: "once", label: "One request" },
  { value: "session", label: "This session" },
  { value: "project", label: "This project" },
  { value: "installation", label: "Every project" },
]

// Read versus write is a security boundary, not a preference, so the pane
// says what each one actually authorises at the moment of choosing.
const accessNote = (access: FilesystemAccess) => {
  if (access === "read") return "Files can be inspected but not changed."
  return "OpenScience can publish or change files through brokered tools; code runtimes do not gain a writable mount."
}

async function grantAccess(transport: Transport, identity: FilesystemIdentity, input: ConnectInput) {
  return transport(`/session/${encodeURIComponent(identity.sessionID)}/filesystem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(json)
}

async function revokeAccess(transport: Transport, identity: FilesystemIdentity, grantID: string) {
  const url = `/session/${encodeURIComponent(identity.sessionID)}/filesystem/${encodeURIComponent(grantID)}`
  return transport(url, { method: "DELETE" }).then(json)
}

export function FilesPane(
  props: {
    request?: Transport
    session?: string
    directory?: string
    view?: (file: PaneFile) => JSX.Element
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

  const [snapshot, { refetch: refetchSnapshot }] = createResource(identity, (current) =>
    readAccess(transport, current).catch(() => undefined),
  )
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
  const [tabs, setTabs] = createSignal<PaneFile[]>([])
  const [active, setActive] = createSignal("files")
  const [busy, setBusy] = createSignal(false)
  const [connect, setConnect] = createStore({
    open: false,
    path: "",
    access: "read" as FilesystemAccess,
    scope: "session" as FilesystemScope,
  })

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
      if (kind === "artifacts" || kind === "trash") {
        // No listing is attempted, so the previous listing's failure no longer
        // describes anything on screen — leaving it up puts "this folder could
        // not be read" over a perfectly good trash list.
        setError("")
        return Promise.resolve([] as FileRow[])
      }
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

  // Tabs are keyed by name because that is what the strip shows. Re-opening a
  // name from a different folder re-points the existing tab rather than
  // stacking a second, indistinguishable one.
  const open = (row: FileRow) => {
    const file = { name: row.name, path: row.path ?? [where(), row.name].filter(Boolean).join("/") }
    const known = tabs().some((tab) => tab.name === file.name)
    setTabs(known ? tabs().map((tab) => (tab.name === file.name ? file : tab)) : [...tabs(), file])
    setActive(file.name)
  }

  const closeTab = (name: string) => {
    setTabs(tabs().filter((tab) => tab.name !== name))
    if (active() === name) setActive("files")
  }

  const selected = createMemo(() => tabs().find((tab) => tab.name === active()))

  // The picker walks the real filesystem and hands back an absolute path. It
  // needs the dialog host, so outside a provider the typed path stays the
  // only route in — which is also what keeps this form testable.
  const browse = () => {
    dialog?.show(
      () => (
        <FolderPicker
          kind="folder"
          title="Connect a folder"
          onSelect={(result) => {
            const picked = Array.isArray(result) ? result[0] : result
            if (picked) setConnect("path", picked)
          }}
        />
      ),
      { lite: true },
    )
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
        setConnect({ open: false, path: "", access: "read", scope: "session" })
      })
      .catch((cause) => {
        setBusy(false)
        setError(errorMessage(cause))
      })
  }

  // A grant is a durable, possibly installation-wide, possibly writable hole
  // in the filesystem boundary. Minting one from the pane without a way to
  // take it back is a one-way door, so revoking lives next to the source it
  // revokes.
  const revoke = (target: PaneSource) => {
    const current = identity()
    if (!current || busy()) return
    setBusy(true)
    revokeAccess(transport, current, target.id)
      .then(() => refetchSnapshot())
      .then(() => {
        // The revoked source is gone from the next snapshot; if it was the
        // one being browsed, fall back to the default rather than listing a
        // folder the session no longer has access to.
        if (source()?.id === target.id) setSource(undefined)
        setPath([])
        setBusy(false)
        setError("")
      })
      .catch((cause) => {
        setBusy(false)
        setError(errorMessage(cause))
      })
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

  const browser = () => (
    <>
      <div class="files-source-row">
        <SourceMenu
          sources={sources()}
          active={current()}
          onPick={(next) => {
            setSource(next)
            setPath([])
            setFilter("")
            // The notice describes the source being left, not the one arriving.
            setError("")
          }}
          onRevoke={revoke}
          onAdd={() => setConnect({ open: true, path: "", access: "read", scope: "session" })}
        />
      </div>

      <Show when={connect.open}>
        <form class="files-connect" aria-label="Connect a folder" onSubmit={submit}>
          <div class="files-connect__row">
            <input
              class="files-search"
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
            <label class="files-connect__field">
              <span>Available for</span>
              <select
                aria-label="Folder access duration"
                data-connect-scope
                value={connect.scope}
                onChange={(event) => setConnect("scope", event.currentTarget.value as FilesystemScope)}
              >
                <For each={SCOPE}>{(option) => <option value={option.value}>{option.label}</option>}</For>
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
              open(row)
            }}
          />
        }
      >
        <TrashList rows={trash()} busy={busy()} onRestore={restore} />
      </Show>
    </>
  )

  return (
    <section class="files-pane" aria-label="Files">
      <FileTabs open={tabs().map((tab) => tab.name)} active={active()} onSelect={setActive} onClose={closeTab} />

      <Show when={selected()} keyed fallback={browser()}>
        {(file) =>
          // FileView reads the SDK, sync and router contexts, so a standalone
          // mount cannot render it; `view` lets that harness substitute a stub
          // exactly as `request` substitutes the transport. Production never
          // passes it and always gets the real viewer.
          props.view?.(file) ?? (
            <FileView
              directory={projectRoot()}
              path={file.path}
              subtitle={current().name}
              active
              writable={current().readonly ? false : undefined}
              onClose={() => closeTab(file.name)}
            />
          )
        }
      </Show>
    </section>
  )
}
