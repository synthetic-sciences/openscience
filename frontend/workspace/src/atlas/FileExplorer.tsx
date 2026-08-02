import { createMemo, createResource, For, Match, onCleanup, onMount, Show, Suspense, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { useDialog } from "@synsci/ui/context/dialog"
import { Select } from "@synsci/ui/select"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePlatform } from "@/context/platform"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { FolderPicker } from "@/atlas/FolderPicker"
import { uiStore, type ContextFile } from "@/atlas/store/ui"
import { FileView } from "@/atlas/FilePreview"
import { toast } from "@/atlas/Toast"
import {
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconMoreH,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconX,
} from "@/atlas/shared/Icon"
import { normalizeStoredArtifacts, type StoredArtifact } from "@/artifacts/store"
import {
  connectedFilesystemGrants,
  containsFilePath,
  fileSourceName,
  filesystemRole,
  filesystemScope,
  findFilesystemGrant,
  normalizeFilePath,
  parseFilesystemSnapshot,
  requestedFolder,
  sessionFilesystemRoot,
  type FilesystemAccess,
  type FilesystemGrant,
  type FilesystemIdentity,
  type FilesystemScope,
  type FilesystemSnapshot,
} from "@/atlas/file-sources"
import type { ProjectRequest } from "@/utils/openscience-fetch"

interface FileNode {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
  size?: number
  mtime?: number
}

interface Source {
  root: string
  name: string
  kind: "project" | "session" | "connected"
}

interface ConnectInput {
  path: string
  access: FilesystemAccess
  scope: FilesystemScope
}

interface FilesSourceListProps {
  artifacts: StoredArtifact[]
  trash: StoredArtifact[]
  grants: FilesystemGrant[]
  projectRoot: string
  sessionReady: boolean
  busy?: boolean
  error?: string
  onOpenProject: () => void
  onOpenSession: () => void
  onOpenArtifact: (artifact: StoredArtifact) => void
  onInspectArtifact: (artifact: StoredArtifact) => void
  onRestoreArtifact: (artifact: StoredArtifact) => void
  onOpenGrant: (grant: FilesystemGrant) => void
  onRevoke: (grant: FilesystemGrant) => void
  onConnect: (input: ConnectInput) => void
  onChoose?: (kind: "folder" | "file") => Promise<string | undefined>
}

const accessOptions = [
  { value: "read" as const, label: "Read only" },
  { value: "write" as const, label: "Read & write" },
]

const scopeOptions = [
  { value: "installation" as const, label: "Every project" },
  { value: "project" as const, label: "This project" },
  { value: "session" as const, label: "This session" },
  { value: "once" as const, label: "One request" },
]

const data = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  if (!("data" in value)) return value
  return (value as { data?: unknown }).data
}

const errorMessage = (value: unknown) => {
  if (value instanceof Error) return value.message
  return String(value || "Request failed")
}

const sessionUrl = (sessionID: string, grantID?: string) => {
  const grant = grantID ? `/${encodeURIComponent(grantID)}` : ""
  return `/session/${encodeURIComponent(sessionID)}/filesystem${grant}`
}

async function json(response: Response) {
  if (response.ok) return response.json() as Promise<unknown>
  const body = await response.text()
  throw new Error(body || `Request failed (${response.status})`)
}

async function readAccess(request: ProjectRequest, identity: FilesystemIdentity): Promise<FilesystemSnapshot> {
  const value = await request(sessionUrl(identity.sessionID)).then(json)
  const snapshot = parseFilesystemSnapshot(value, identity)
  if (snapshot) return snapshot
  throw new Error("Filesystem access belongs to another session or project.")
}

async function grantAccess(request: ProjectRequest, identity: FilesystemIdentity, input: ConnectInput) {
  return request(sessionUrl(identity.sessionID), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(json)
}

async function revokeAccess(request: ProjectRequest, identity: FilesystemIdentity, grantID: string) {
  return request(sessionUrl(identity.sessionID, grantID), {
    method: "DELETE",
  }).then(json)
}

const sortNodes = (nodes: FileNode[]) =>
  nodes.toSorted((a, b) => {
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

const formatSize = (bytes?: number) => {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  const tier = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length)
  const value = bytes / 1024 ** tier
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[tier - 1]}`
}

const relativeTime = (mtime?: number) => {
  if (!mtime) return ""
  const minutes = Math.round((Date.now() - mtime) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(mtime).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

const description = (grant: FilesystemGrant) => {
  if (grant.access === "read") return "Files can be inspected but not changed."
  return "OpenScience can publish or change files through brokered tools; code runtimes do not gain a writable mount."
}

export function FilesSourceList(props: FilesSourceListProps): JSX.Element {
  const [form, setForm] = createStore({
    open: false,
    path: "",
    access: "read" as FilesystemAccess,
    scope: "session" as FilesystemScope,
  })

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const path = form.path.trim()
    if (!path || props.busy) return
    props.onConnect({ path, access: form.access, scope: form.scope })
  }

  const choose = async (kind: "folder" | "file") => {
    const path = await props.onChoose?.(kind)
    if (path) setForm("path", path)
  }

  return (
    <div
      class="atlas-scroll"
      aria-label="Files sources"
      role="region"
      style={{
        flex: 1,
        "min-height": 0,
        overflow: "auto",
        padding: "14px",
        display: "flex",
        "flex-direction": "column",
        gap: "14px",
        position: "relative",
        background: "var(--color-bg)",
        "font-family": FONT_SANS,
      }}
    >
      <header style={{ display: "flex", "flex-direction": "column", gap: "4px", padding: "2px 2px 4px" }}>
        <strong style={{ color: "var(--color-text)", "font-size": "15px", "font-weight": 600 }}>Browse files</strong>
        <p style={intro()}>Choose a workspace, a saved artifact, or a connected location.</p>
      </header>

      <section aria-labelledby="workspace-locations-heading" style={group()}>
        <GroupHeading id="workspace-locations-heading" title="Workspace" detail="Local and session files" />
        <button
          type="button"
          aria-label="Open project folder"
          onClick={props.onOpenProject}
          disabled={!props.projectRoot}
          style={sourceRow()}
        >
          <span style={sourceIcon()}>
            <IconFolder size={18} strokeWidth={1.5} />
          </span>
          <span style={sourceCopy()}>
            <strong style={sourceTitle()}>{fileSourceName(props.projectRoot)}</strong>
            <span style={sourceDetail()}>Project files</span>
          </span>
          <IconChevronRight size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Open session files"
          onClick={props.onOpenSession}
          disabled={!props.sessionReady}
          style={sourceRow()}
        >
          <span style={sourceIcon()}>
            <IconFolder size={18} strokeWidth={1.5} />
          </span>
          <span style={sourceCopy()}>
            <strong style={sourceTitle()}>Session workspace</strong>
            <span style={sourceDetail()}>
              {props.sessionReady ? "Scratch files and generated outputs" : "Starts with the session"}
            </span>
          </span>
          <IconChevronRight size={16} strokeWidth={1.5} />
        </button>
      </section>

      <section aria-labelledby="artifacts-heading" style={group()}>
        <GroupHeading id="artifacts-heading" title="Artifacts" detail={`${props.artifacts.length} saved locally`} />
        <Show
          when={props.artifacts.length}
          fallback={
            <p style={empty()}>
              {props.trash.length
                ? "No active artifacts. Recover a trashed artifact below or save a new version from a session file."
                : "No saved artifacts yet. Open a session file and choose Save as artifact to preserve an immutable version."}
            </p>
          }
        >
          <div role="list" aria-label="Artifacts" style={rows()}>
            <For each={props.artifacts.slice(0, 12)}>
              {(artifact) => (
                <div role="listitem" style={grantRow()}>
                  <button
                    type="button"
                    aria-label={`Open artifact ${artifact.title}`}
                    onClick={() => props.onOpenArtifact(artifact)}
                    style={grantOpen()}
                  >
                    <span style={sourceIcon()}>
                      <IconFile size={17} strokeWidth={1.5} />
                    </span>
                    <span style={sourceCopy()}>
                      <strong style={sourceTitle()}>{artifact.title}</strong>
                      <span style={sourceDetail()}>
                        {artifact.kind} · v{artifact.current.version} · {formatSize(artifact.current.size)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Open details for ${artifact.title}`}
                    title="Open artifact details"
                    onClick={() => props.onInspectArtifact(artifact)}
                    style={rowAction()}
                  >
                    <IconMoreH size={16} strokeWidth={1.6} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.trash.length}>
          <div aria-label="Artifact trash" style={trashBox()}>
            <span style={trashHead()}>
              <strong>Trash</strong>
              <span>{props.trash.length} · retained 30 days</span>
            </span>
            <For each={props.trash.slice(0, 12)}>
              {(artifact) => (
                <div style={trashRow()}>
                  <span style={sourceCopy()}>
                    <strong style={sourceTitle()}>{artifact.title}</strong>
                    <span style={sourceDetail()}>
                      {artifact.versionCount} version{artifact.versionCount === 1 ? "" : "s"} · deleted{" "}
                      {relativeTime(artifact.trashedAt)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Restore artifact ${artifact.title}`}
                    onClick={() => props.onRestoreArtifact(artifact)}
                    disabled={props.busy}
                    style={revoke()}
                  >
                    Restore
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>

      <section aria-labelledby="connected-locations-heading" style={group()}>
        <GroupHeading
          id="connected-locations-heading"
          title="Connected locations"
          detail={`${props.grants.length} active`}
        />
        <Show
          when={props.grants.length}
          fallback={<p style={empty()}>No files or folders outside this project are connected yet.</p>}
        >
          <div role="list" aria-label="Connected locations" style={rows()}>
            <For each={props.grants}>
              {(grant) => (
                <div role="listitem" style={grantRow()}>
                  <button
                    type="button"
                    aria-label={`Open connected location ${fileSourceName(grant.path)}`}
                    onClick={() => props.onOpenGrant(grant)}
                    style={grantOpen()}
                  >
                    <span style={sourceIcon()}>
                      <IconFolder size={18} strokeWidth={1.5} />
                    </span>
                    <span style={sourceCopy()}>
                      <strong style={sourceTitle()}>{fileSourceName(grant.path)}</strong>
                      <span style={badges()}>
                        <span style={badge(grant.access === "write")}>{filesystemRole(grant)}</span>
                        <span style={badge(false)}>{filesystemScope(grant)}</span>
                      </span>
                      <span style={sourceDetail()}>{description(grant)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Revoke ${filesystemRole(grant).toLowerCase()} access to ${fileSourceName(grant.path)}`}
                    onClick={() => props.onRevoke(grant)}
                    disabled={props.busy}
                    style={revoke()}
                  >
                    Revoke
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={form.open}
          fallback={
            <button
              type="button"
              aria-label="Connect another location"
              onClick={() => setForm("open", true)}
              disabled={!props.sessionReady}
              style={connect()}
            >
              <IconPlus size={15} strokeWidth={1.6} />
              Connect file or folder
            </button>
          }
        >
          <form aria-label="Connect file or folder access" onSubmit={submit} style={formOverlay()}>
            <div style={formHead()}>
              <div>
                <strong style={sourceTitle()}>Connect a file or folder</strong>
                <p style={note()}>Choose a location, what OpenScience may do there, and how long access lasts.</p>
              </div>
              <button
                type="button"
                aria-label="Cancel connecting location"
                onClick={() => setForm("open", false)}
                style={iconButton()}
              >
                <IconX size={15} strokeWidth={1.6} />
              </button>
            </div>
            <div style={field()}>
              <span>Location</span>
              <div style={pathRow()}>
                <input
                  name="path"
                  value={form.path}
                  onInput={(event) => setForm("path", event.currentTarget.value)}
                  autocomplete="off"
                  placeholder="Choose or paste a file or folder path"
                  style={{ ...input(), flex: 1, "min-width": 0 }}
                />
                <button
                  type="button"
                  aria-label="Choose folder"
                  onClick={() => void choose("folder")}
                  style={pickerButton()}
                >
                  <IconFolder size={14} strokeWidth={1.5} />
                  Folder
                </button>
                <button
                  type="button"
                  aria-label="Choose file"
                  onClick={() => void choose("file")}
                  style={pickerButton()}
                >
                  <IconFile size={14} strokeWidth={1.5} />
                  File
                </button>
              </div>
            </div>
            <div style={fieldGrid()}>
              <div style={field()}>
                <span>Access</span>
                <Select
                  aria-label="Location access"
                  options={accessOptions}
                  current={accessOptions.find((option) => option.value === form.access)}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => option && setForm("access", option.value)}
                  variant="secondary"
                  triggerStyle={selectTrigger()}
                />
              </div>
              <div style={field()}>
                <span>Available for</span>
                <Select
                  aria-label="Location access duration"
                  options={scopeOptions}
                  current={scopeOptions.find((option) => option.value === form.scope)}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => option && setForm("scope", option.value)}
                  variant="secondary"
                  triggerStyle={selectTrigger()}
                />
              </div>
            </div>
            <p style={note()}>
              Read & write includes reading. Write-only access is intentionally unavailable because edits cannot be made
              safely without first inspecting the target.
            </p>
            <Show when={props.error}>
              {(message) => (
                <p role="alert" style={alert()}>
                  {message()}
                </p>
              )}
            </Show>
            <button type="submit" disabled={!form.path.trim() || props.busy} style={primary()}>
              {props.busy ? "Requesting…" : "Request access"}
            </button>
          </form>
        </Show>
        <Show when={!props.sessionReady}>
          <p style={note()}>Start a research session before connecting an outside file or folder.</p>
        </Show>
      </section>
    </div>
  )
}

export function FileExplorer(): JSX.Element {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const platform = usePlatform()
  const dialog = useDialog()
  const [view, setView] = createStore({
    source: undefined as Source | undefined,
    cwd: "",
    filter: "",
    refresh: 0,
    busy: false,
    error: undefined as string | undefined,
  })

  const projectRoot = () => sdk.directory || sync.data.path.directory || sync.project?.worktree || ""
  const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)
  const identity = (): FilesystemIdentity | undefined => {
    const session = sessionID()
    if (!session || !projectRoot()) return
    return { sessionID: session, projectID: sdk.projectID, directory: projectRoot() }
  }

  const [snapshot, { refetch: refetchSnapshot }] = createResource(identity, (current) =>
    readAccess(sdk.request, current),
  )
  const sessionRoot = createMemo(() => sessionFilesystemRoot(snapshot.latest))
  const [artifacts, { refetch: refetchArtifacts }] = createResource(
    () => sdk.directory,
    () =>
      Promise.all(
        (["active", "trash"] as const).map((state) =>
          sdk
            .request(`/file/artifact-store?state=${state}`)
            .then(async (response) => {
              if (!response.ok) throw new Error(`Artifact store unavailable (${response.status})`)
              return normalizeStoredArtifacts(await response.json())
            })
            .catch(() => []),
        ),
      ).then(([active, trash]) => ({ active, trash })),
  )
  onMount(() => {
    const refresh = () => void refetchArtifacts()
    window.addEventListener("openscience:artifacts-changed", refresh)
    onCleanup(() => window.removeEventListener("openscience:artifacts-changed", refresh))
  })
  const [entries] = createResource(
    () => {
      if (!view.source || !view.cwd) return
      return [projectRoot(), view.cwd, sessionID(), view.refresh] as const
    },
    ([, path, session]) => {
      const input = { path, sessionID: session }
      return sdk.client.file.list(input).then((response) => {
        const value = data(response)
        return Array.isArray(value) ? (value as FileNode[]) : []
      })
    },
  )

  const grants = createMemo(() => connectedFilesystemGrants(snapshot.latest))
  const filtered = createMemo(() => {
    const query = view.filter.trim().toLowerCase()
    const rows = sortNodes(entries.latest ?? [])
    if (!query) return rows
    return rows.filter((node) => node.name.toLowerCase().includes(query))
  })
  const atRoot = createMemo(() => {
    if (!view.source) return true
    return normalizeFilePath(view.cwd) === normalizeFilePath(view.source.root)
  })
  const crumbs = createMemo(() => {
    if (!view.source) return []
    const root = normalizeFilePath(view.source.root)
    const path = normalizeFilePath(view.cwd)
    if (!containsFilePath(root, path)) return []
    return path.slice(root.length).split("/").filter(Boolean)
  })

  const open = (source: Source) => {
    setView({ source, cwd: source.root, filter: "", error: undefined })
  }
  const choose = async (kind: "folder" | "file") => {
    const picker = kind === "folder" ? platform.openDirectoryPickerDialog : platform.openFilePickerDialog
    if (picker) {
      const result = await picker({ title: kind === "folder" ? "Connect a folder" : "Connect a file" })
      if (Array.isArray(result)) return result[0]
      return result ?? undefined
    }

    return new Promise<string | undefined>((resolve) => {
      const selection = { path: undefined as string | undefined, settled: false }
      const finish = (path?: string) => {
        if (selection.settled) return
        selection.settled = true
        resolve(path)
      }
      dialog.show(
        () => (
          <FolderPicker
            kind={kind}
            title={kind === "folder" ? "Connect a folder" : "Connect a file"}
            onSelect={(result) => {
              selection.path = Array.isArray(result) ? result[0] : (result ?? undefined)
            }}
          />
        ),
        {
          onClose: () => finish(selection.path),
          lite: true,
        },
      )
    })
  }
  const close = () => setView({ source: undefined, cwd: "", filter: "", error: undefined })
  const up = () => {
    if (!view.source || atRoot()) return
    const path = normalizeFilePath(view.cwd)
    const index = path.lastIndexOf("/")
    const parent = index <= 0 ? view.source.root : path.slice(0, index)
    setView({ cwd: containsFilePath(view.source.root, parent) ? parent : view.source.root, filter: "" })
  }
  const onNode = (node: FileNode) => {
    if (node.type === "directory") {
      if (!view.source || !containsFilePath(view.source.root, node.absolute)) return
      setView({ cwd: node.absolute, filter: "" })
      return
    }
    const path = view.source?.kind === "connected" ? node.absolute : node.path
    uiStore.openFile(projectRoot(), path)
  }
  const connect = (input: ConnectInput) => {
    const current = identity()
    if (!current || view.busy) return
    setView({ busy: true, error: undefined })
    grantAccess(sdk.request, current, input)
      .then(() => refetchSnapshot())
      .then(() => {
        setView({ busy: false, error: undefined })
        toast.success("location connected", `${filesystemRole(input)} · ${filesystemScope(input)}`)
      })
      .catch((error) => setView({ busy: false, error: errorMessage(error) }))
  }
  const revoke = (grant: FilesystemGrant) => {
    const current = identity()
    if (!current || view.busy) return
    setView({ busy: true, error: undefined })
    revokeAccess(sdk.request, current, grant.id)
      .then(() => refetchSnapshot())
      .then(() => {
        setView({ busy: false, error: undefined })
        toast.success("location access revoked", fileSourceName(grant.path))
      })
      .catch((error) => setView({ busy: false, error: errorMessage(error) }))
  }
  const restore = (artifact: StoredArtifact) => {
    if (view.busy) return
    setView({ busy: true, error: undefined })
    sdk
      .request(`/file/artifact-store/${encodeURIComponent(artifact.id)}/restore`, { method: "POST" })
      .then(json)
      .then(() => refetchArtifacts())
      .then(() => {
        setView({ busy: false, error: undefined })
        toast.success("artifact restored", artifact.title)
      })
      .catch((error) => setView({ busy: false, error: errorMessage(error) }))
  }
  const openGrant = (grant: FilesystemGrant) => {
    const input = { path: grant.path, sessionID: sessionID() }
    sdk.client.file.list(input).then(
      (response) => {
        const value = data(response)
        if (Array.isArray(value)) {
          open({ root: grant.path, name: fileSourceName(grant.path), kind: "connected" })
          return
        }
        uiStore.openFile(projectRoot(), grant.path)
      },
      () => uiStore.openFile(projectRoot(), grant.path),
    )
  }

  return (
    <Switch>
      <Match when={view.source}>
        {(source) => (
          <div
            aria-label={`${source().name} files`}
            role="region"
            style={{
              flex: 1,
              "min-height": 0,
              display: "flex",
              "flex-direction": "column",
              background: "var(--color-bg-subtle)",
              "font-family": FONT_SANS,
            }}
          >
            <div role="group" aria-label="Source navigation" style={toolbar()}>
              <button type="button" aria-label="Back to file sources" onClick={close} style={iconButton()}>
                <IconChevronLeft size={16} strokeWidth={1.6} />
              </button>
              <button
                type="button"
                aria-label="Go to parent folder"
                disabled={atRoot()}
                onClick={up}
                style={iconButton(atRoot())}
              >
                <IconArrowUp size={16} strokeWidth={1.6} />
              </button>
              <div style={{ flex: 1, "min-width": 0 }}>
                <strong style={sourceTitle()}>{source().name}</strong>
                <div aria-label="Current folder" style={crumbStyle()}>
                  <span>{source().name}</span>
                  <For each={crumbs()}>
                    {(crumb) => (
                      <>
                        <span aria-hidden="true">/</span>
                        <span>{crumb}</span>
                      </>
                    )}
                  </For>
                </div>
              </div>
              <button
                type="button"
                aria-label="Refresh source"
                onClick={() => setView("refresh", view.refresh + 1)}
                style={iconButton()}
              >
                <IconRefresh size={15} strokeWidth={1.6} />
              </button>
            </div>
            <label style={search()}>
              <IconSearch size={15} strokeWidth={1.5} />
              <span class="sr-only">Filter files</span>
              <input
                aria-label="Filter files"
                value={view.filter}
                onInput={(event) => setView("filter", event.currentTarget.value)}
                placeholder="Filter this source"
                style={searchInput()}
              />
              <span aria-live="polite" style={count()}>
                {filtered().length} items
              </span>
            </label>
            <div
              class="atlas-scroll"
              aria-busy={entries.loading}
              style={{ flex: 1, "min-height": 0, overflow: "auto", padding: "8px 12px 16px" }}
            >
              <Suspense fallback={<p style={empty()}>Loading files…</p>}>
                <Show
                  when={!entries.error}
                  fallback={
                    <p role="alert" style={alert()}>
                      {errorMessage(entries.error)}
                    </p>
                  }
                >
                  <Show when={filtered().length} fallback={<p style={empty()}>This source is empty.</p>}>
                    <div role="list" aria-label="Files in source" style={fileList()}>
                      <For each={filtered()}>
                        {(node) => (
                          <button
                            type="button"
                            role="listitem"
                            aria-label={`${node.type === "directory" ? "Open folder" : "Open file"} ${node.name}`}
                            onClick={() => onNode(node)}
                            style={fileRow(node.ignored)}
                          >
                            <span style={sourceIcon()}>
                              <Show
                                when={node.type === "directory"}
                                fallback={<IconFile size={17} strokeWidth={1.5} />}
                              >
                                <IconFolder size={18} strokeWidth={1.5} />
                              </Show>
                            </span>
                            <span style={sourceCopy()}>
                              <strong style={sourceTitle()}>{node.name}</strong>
                              <span style={sourceDetail()}>
                                {node.type === "directory"
                                  ? "Folder"
                                  : [formatSize(node.size), relativeTime(node.mtime)].filter(Boolean).join(" · ")}
                              </span>
                            </span>
                            <Show when={node.type === "directory"}>
                              <IconChevronRight size={16} strokeWidth={1.5} />
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Suspense>
            </div>
          </div>
        )}
      </Match>
      <Match when={!view.source}>
        <FilesSourceList
          artifacts={artifacts.latest?.active ?? []}
          trash={artifacts.latest?.trash ?? []}
          grants={grants()}
          projectRoot={projectRoot()}
          sessionReady={Boolean(snapshot.latest)}
          busy={view.busy}
          error={view.error ?? (snapshot.error ? errorMessage(snapshot.error) : undefined)}
          onOpenProject={() => {
            const root = projectRoot()
            if (!root) return
            open({ root, name: fileSourceName(root), kind: "project" })
          }}
          onOpenSession={() => {
            const root = sessionRoot()
            if (!root) return
            open({ root, name: "Session files", kind: "session" })
          }}
          onOpenArtifact={uiStore.openSaved}
          onInspectArtifact={uiStore.openSaved}
          onRestoreArtifact={restore}
          onOpenGrant={openGrant}
          onRevoke={revoke}
          onConnect={connect}
          onChoose={choose}
        />
      </Match>
    </Switch>
  )
}

export function ExternalFileAccess(props: { file: ContextFile; active: boolean; onClose: () => void }): JSX.Element {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const [state, setState] = createStore({
    access: "read" as FilesystemAccess,
    scope: "session" as FilesystemScope,
    busy: false,
    error: undefined as string | undefined,
  })
  const projectRoot = () => sdk.directory || sync.data.path.directory || sync.project?.worktree || ""
  const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)
  const identity = (): FilesystemIdentity | undefined => {
    const session = sessionID()
    if (!session || !projectRoot()) return
    return { sessionID: session, projectID: sdk.projectID, directory: projectRoot() }
  }
  const [snapshot, { refetch }] = createResource(identity, (current) => readAccess(sdk.request, current))
  const grant = createMemo(() => findFilesystemGrant(snapshot.latest, props.file.path, "read"))
  const request = () => {
    const current = identity()
    if (!current || state.busy) return
    setState({ busy: true, error: undefined })
    grantAccess(sdk.request, current, {
      path: requestedFolder(props.file.path),
      access: state.access,
      scope: state.scope,
    })
      .then(() => refetch())
      .then(() => setState({ busy: false, error: undefined }))
      .catch((error) => setState({ busy: false, error: errorMessage(error) }))
  }

  return (
    <Switch>
      <Match when={grant()}>
        {(current) => (
          <FileView
            directory={projectRoot()}
            path={props.file.path}
            subtitle={`Connected folder · ${fileSourceName(current().path)}`}
            active={props.active}
            writable={current().access === "write"}
            onClose={props.onClose}
          />
        )}
      </Match>
      <Match when={!grant()}>
        <div
          role="region"
          aria-label="File access required"
          style={{
            flex: 1,
            "min-height": 0,
            padding: "28px",
            display: "flex",
            "flex-direction": "column",
            "justify-content": "center",
            gap: "16px",
            background: "var(--color-bg-subtle)",
            "font-family": FONT_SANS,
          }}
        >
          <span style={requestIcon()}>
            <IconFolder size={24} strokeWidth={1.4} />
          </span>
          <div>
            <h2 style={requestTitle()}>Connect a folder to open {props.file.name}</h2>
            <p style={requestCopy()}>
              This file is outside the session files. OpenScience will not silently change the project root or read it
              without an approved folder grant.
            </p>
          </div>
          <Show
            when={sessionID()}
            fallback={
              <p role="status" style={alert()}>
                Start a research session to request access.
              </p>
            }
          >
            <div style={fieldGrid()}>
              <div style={field()}>
                <span>Access</span>
                <Select
                  aria-label="External file access"
                  options={accessOptions}
                  current={accessOptions.find((option) => option.value === state.access)}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => option && setState("access", option.value)}
                  variant="secondary"
                  triggerStyle={selectTrigger()}
                />
              </div>
              <div style={field()}>
                <span>Available for</span>
                <Select
                  aria-label="External file access duration"
                  options={scopeOptions}
                  current={scopeOptions.find((option) => option.value === state.scope)}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => option && setState("scope", option.value)}
                  variant="secondary"
                  triggerStyle={selectTrigger()}
                />
              </div>
            </div>
            <Show when={state.error ?? (snapshot.error ? errorMessage(snapshot.error) : undefined)}>
              {(message) => (
                <p role="alert" style={alert()}>
                  {message()}
                </p>
              )}
            </Show>
            <button type="button" onClick={request} disabled={state.busy} style={primary()}>
              {state.busy ? "Requesting…" : "Request access"}
            </button>
          </Show>
          <button type="button" onClick={props.onClose} style={secondary()}>
            Back to file sources
          </button>
        </div>
      </Match>
    </Switch>
  )
}

function GroupHeading(props: { id: string; title: string; detail: string }): JSX.Element {
  return (
    <div style={heading()}>
      <h2 id={props.id} style={groupTitle()}>
        {props.title}
      </h2>
      <span style={groupDetail()}>{props.detail}</span>
    </div>
  )
}

const intro = (): JSX.CSSProperties => ({
  margin: 0,
  padding: "2px 2px 0",
  color: "var(--color-text-muted)",
  "font-size": "12.5px",
  "line-height": 1.55,
})

const group = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  "border-top": "1px solid var(--color-border-subtle)",
  "padding-top": "15px",
})

const heading = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "baseline",
  "justify-content": "space-between",
  gap: "12px",
  padding: "0 2px",
})

const groupTitle = (): JSX.CSSProperties => ({
  margin: 0,
  color: "var(--color-text)",
  "font-size": "13px",
  "font-weight": 650,
})

const groupDetail = (): JSX.CSSProperties => ({
  color: "var(--color-text-faint)",
  "font-size": "11.5px",
  "text-align": "right",
})

const rows = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
})

const sourceRow = (): JSX.CSSProperties => ({
  width: "100%",
  border: "1px solid var(--color-border)",
  "border-radius": "6px",
  background: "var(--color-bg-subtle)",
  color: "var(--color-text)",
  padding: "9px 10px",
  display: "flex",
  "align-items": "center",
  gap: "10px",
  cursor: "pointer",
  "text-align": "left",
  outline: "2px solid transparent",
  "outline-offset": "2px",
})

const sourceIcon = (): JSX.CSSProperties => ({
  width: "30px",
  height: "30px",
  "border-radius": "6px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  color: "var(--color-text-muted)",
  background: "var(--color-surface-solid)",
  "flex-shrink": 0,
})

const sourceCopy = (): JSX.CSSProperties => ({
  flex: 1,
  "min-width": 0,
  display: "flex",
  "flex-direction": "column",
  gap: "3px",
})

const sourceTitle = (): JSX.CSSProperties => ({
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
  color: "var(--color-text)",
  "font-size": "12.5px",
  "font-weight": 600,
})

const sourceDetail = (): JSX.CSSProperties => ({
  color: "var(--color-text-faint)",
  "font-size": "11.5px",
  "line-height": 1.4,
})

const empty = (): JSX.CSSProperties => ({
  margin: 0,
  padding: "11px 12px",
  border: "1px solid var(--color-border-subtle)",
  "border-radius": "6px",
  background: "var(--color-bg-subtle)",
  color: "var(--color-text-faint)",
  "font-size": "12px",
  "line-height": 1.5,
})

const note = (): JSX.CSSProperties => ({
  margin: 0,
  color: "var(--color-text-faint)",
  "font-size": "11.5px",
  "line-height": 1.45,
})

const grantRow = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "stretch",
  border: "1px solid var(--color-border)",
  "border-radius": "6px",
  background: "var(--color-bg-subtle)",
  overflow: "hidden",
})

const trashBox = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
  padding: "10px",
  border: "1px solid var(--color-border-subtle)",
  "border-radius": "10px",
  background: "var(--color-bg)",
})

const trashHead = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "8px",
  color: "var(--color-text-muted)",
  "font-size": "11px",
})

const trashRow = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "stretch",
  "min-height": "42px",
  padding: "0 0 0 8px",
  border: "1px solid var(--color-border-subtle)",
  "border-radius": "8px",
  background: "var(--color-bg-subtle)",
  overflow: "hidden",
})

const grantOpen = (): JSX.CSSProperties => ({
  all: "unset",
  flex: 1,
  "min-width": 0,
  padding: "10px",
  display: "flex",
  "align-items": "center",
  gap: "10px",
  cursor: "pointer",
  outline: "2px solid transparent",
  "outline-offset": "-2px",
})

const badges = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-wrap": "wrap",
  gap: "5px",
})

const badge = (publish: boolean): JSX.CSSProperties => ({
  width: "fit-content",
  padding: "2px 6px",
  "border-radius": "4px",
  border: `1px solid ${publish ? "var(--color-accent)" : "var(--color-border)"}`,
  color: publish ? "var(--color-accent)" : "var(--color-text-muted)",
  "font-family": FONT_MONO,
  "font-size": "10.5px",
})

const revoke = (): JSX.CSSProperties => ({
  border: 0,
  "border-left": "1px solid var(--color-border)",
  background: "transparent",
  color: "var(--color-text-muted)",
  padding: "0 12px",
  cursor: "pointer",
  "font-size": "11.5px",
})

const rowAction = (): JSX.CSSProperties => ({
  border: 0,
  "border-left": "1px solid var(--color-border)",
  background: "transparent",
  color: "var(--color-text-muted)",
  padding: "0 12px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  cursor: "pointer",
  "flex-shrink": 0,
})

const connect = (): JSX.CSSProperties => ({
  border: "1px solid var(--color-border)",
  "border-radius": "6px",
  background: "var(--color-bg-subtle)",
  color: "var(--color-text-muted)",
  "min-height": "38px",
  display: "flex",
  "align-items": "center",
  "justify-content": "flex-start",
  gap: "6px",
  padding: "0 11px",
  cursor: "pointer",
  "font-size": "12px",
})

const formCard = (): JSX.CSSProperties => ({
  padding: "12px",
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  border: "1px solid var(--color-border)",
  "border-radius": "8px",
  background: "var(--color-bg-subtle)",
})

const formOverlay = (): JSX.CSSProperties => ({
  ...formCard(),
  position: "absolute",
  inset: "12px",
  "z-index": 8,
  overflow: "auto",
  "align-self": "stretch",
  "justify-content": "flex-start",
  background: "var(--color-bg-elevated)",
  "box-shadow": "0 18px 42px color-mix(in srgb, var(--color-bg) 38%, transparent)",
})

const formHead = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "flex-start",
  "justify-content": "space-between",
  gap: "12px",
})

const field = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "5px",
  color: "var(--color-text-muted)",
  "font-size": "11.5px",
})

const fieldGrid = (): JSX.CSSProperties => ({
  display: "grid",
  "grid-template-columns": "minmax(0, 1fr) minmax(0, 1fr)",
  gap: "8px",
})

const input = (): JSX.CSSProperties => ({
  width: "100%",
  "box-sizing": "border-box",
  "min-height": "36px",
  border: "1px solid var(--color-border)",
  "border-radius": "6px",
  background: "var(--color-surface-solid)",
  color: "var(--color-text)",
  padding: "7px 9px",
  "font-family": FONT_SANS,
  "font-size": "12px",
  outline: "2px solid transparent",
  "outline-offset": "1px",
})

const pathRow = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "stretch",
  gap: "6px",
  "min-width": 0,
})

const pickerButton = (): JSX.CSSProperties => ({
  border: "1px solid var(--color-border)",
  "border-radius": "6px",
  background: "var(--color-surface-solid)",
  color: "var(--color-text-muted)",
  padding: "0 9px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  gap: "5px",
  cursor: "pointer",
  "font-size": "11.5px",
  "flex-shrink": 0,
})

const selectTrigger = (): JSX.CSSProperties => ({
  width: "100%",
  "min-height": "36px",
  "justify-content": "space-between",
  "border-radius": "6px",
})

const primary = (): JSX.CSSProperties => ({
  border: "1px solid var(--color-text)",
  "border-radius": "8px",
  background: "var(--color-text)",
  color: "var(--color-bg)",
  "min-height": "36px",
  padding: "0 12px",
  cursor: "pointer",
  "font-size": "12px",
  "font-weight": 600,
})

const secondary = (): JSX.CSSProperties => ({
  border: "1px solid var(--color-border)",
  "border-radius": "8px",
  background: "transparent",
  color: "var(--color-text-muted)",
  "min-height": "36px",
  padding: "0 12px",
  cursor: "pointer",
  "font-size": "12px",
})

const alert = (): JSX.CSSProperties => ({
  margin: 0,
  padding: "9px 10px",
  "border-radius": "8px",
  background: "var(--color-error-subtle, var(--color-bg-subtle))",
  color: "var(--color-error, var(--color-text))",
  "font-size": "11.5px",
  "line-height": 1.45,
})

const iconButton = (disabled = false): JSX.CSSProperties => ({
  width: "34px",
  height: "34px",
  padding: 0,
  border: "1px solid var(--color-border)",
  "border-radius": "8px",
  background: "var(--color-surface-solid)",
  color: disabled ? "var(--color-text-faint)" : "var(--color-text-muted)",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  cursor: disabled ? "default" : "pointer",
  "flex-shrink": 0,
})

const toolbar = (): JSX.CSSProperties => ({
  "min-height": "56px",
  padding: "9px 12px",
  display: "flex",
  "align-items": "center",
  gap: "8px",
  "border-bottom": "1px solid var(--color-border)",
  background: "var(--color-surface-solid)",
})

const crumbStyle = (): JSX.CSSProperties => ({
  display: "flex",
  gap: "4px",
  overflow: "hidden",
  color: "var(--color-text-faint)",
  "font-size": "11px",
  "white-space": "nowrap",
})

const search = (): JSX.CSSProperties => ({
  "min-height": "42px",
  margin: "10px 12px 2px",
  padding: "0 10px",
  border: "1px solid var(--color-border)",
  "border-radius": "9px",
  background: "var(--color-surface-solid)",
  color: "var(--color-text-faint)",
  display: "flex",
  "align-items": "center",
  gap: "8px",
})

const searchInput = (): JSX.CSSProperties => ({
  all: "unset",
  flex: 1,
  "min-width": 0,
  color: "var(--color-text)",
  "font-size": "12.5px",
})

const count = (): JSX.CSSProperties => ({
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "11px",
})

const fileList = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
})

const fileRow = (ignored: boolean): JSX.CSSProperties => ({
  width: "100%",
  border: "1px solid transparent",
  "border-radius": "8px",
  background: "transparent",
  color: "var(--color-text)",
  opacity: ignored ? 0.58 : 1,
  padding: "7px 8px",
  display: "flex",
  "align-items": "center",
  gap: "9px",
  cursor: "pointer",
  "text-align": "left",
  outline: "2px solid transparent",
  "outline-offset": "1px",
})

const requestIcon = (): JSX.CSSProperties => ({
  width: "48px",
  height: "48px",
  "border-radius": "12px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  color: "var(--color-text-muted)",
  background: "var(--color-surface-solid)",
  border: "1px solid var(--color-border)",
})

const requestTitle = (): JSX.CSSProperties => ({
  margin: 0,
  color: "var(--color-text)",
  "font-size": "17px",
  "line-height": 1.3,
})

const requestCopy = (): JSX.CSSProperties => ({
  margin: "8px 0 0",
  color: "var(--color-text-muted)",
  "font-size": "12.5px",
  "line-height": 1.55,
})
