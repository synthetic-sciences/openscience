import { createMemo, createResource, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Button } from "@synsci/ui/button"
import { Select } from "@synsci/ui/select"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { ContextFile } from "@/atlas/store/ui"
import { FileView } from "@/atlas/FilePreview"
import { IconFolder } from "@/atlas/shared/Icon"
import {
  fileSourceName,
  findFilesystemGrant,
  parseFilesystemSnapshot,
  requestedFolder,
  type FilesystemAccess,
  type FilesystemIdentity,
  type FilesystemScope,
  type FilesystemSnapshot,
} from "@/atlas/file-sources"
import type { ProjectRequest } from "@/utils/openscience-fetch"
import "./FileExplorer.css"

interface ConnectInput {
  path: string
  access: FilesystemAccess
  scope: FilesystemScope
}

const accessOptions = [
  { value: "read" as const, label: "Read only" },
  { value: "write" as const, label: "Read & write" },
]

const errorMessage = (value: unknown) => {
  if (value instanceof Error) return value.message
  return String(value || "Request failed")
}

const sessionUrl = (sessionID: string) => `/session/${encodeURIComponent(sessionID)}/filesystem`

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

export function ExternalFileAccess(props: { file: ContextFile; active: boolean; onClose: () => void }): JSX.Element {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const [state, setState] = createStore({
    access: "read" as FilesystemAccess,
    busy: false,
    error: undefined as string | undefined,
  })
  const projectRoot = () =>
    props.file.directory || sdk.directory || sync.data.path.directory || sync.project?.worktree || ""
  const sessionID = () => props.file.sessionID ?? (params.id && params.id !== "new" ? params.id : undefined)
  const identity = (): FilesystemIdentity | undefined => {
    const session = sessionID()
    if (!session || !projectRoot()) return
    return { sessionID: session, projectID: sdk.projectID, directory: projectRoot() }
  }
  const [snapshot, { refetch }] = createResource(identity, (current) => readAccess(sdk.request, current))
  const grant = createMemo(() => {
    const current = identity()
    if (!current) return
    // Resources retain their previous value during navigation. That value is
    // usable only for the exact project and originating session of this tab.
    return findFilesystemGrant(parseFilesystemSnapshot(snapshot.latest, current), props.file.path, "read")
  })
  const request = () => {
    const current = identity()
    if (!current || state.busy) return
    setState({ busy: true, error: undefined })
    grantAccess(sdk.request, current, {
      path: requestedFolder(props.file.path),
      access: state.access,
      scope: "project",
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
            sessionID={sessionID()}
            subtitle={`Connected folder · ${fileSourceName(current().path)}`}
            active={props.active}
            writable={current().access === "write"}
            onClose={props.onClose}
          />
        )}
      </Match>
      <Match when={!grant()}>
        <div class="external-file-access" role="region" aria-label="File access required">
          <div class="external-file-access__content">
            <span class="external-file-access__icon" aria-hidden="true">
              <IconFolder size={22} strokeWidth={1.35} />
            </span>
            <div class="external-file-access__copy">
              <h2>Connect a folder</h2>
              <p>
                <strong>{props.file.name}</strong> is outside this project. Choose the access OpenScience needs; the
                folder will stay connected to this project until you remove it.
              </p>
            </div>
            <Show
              when={sessionID()}
              fallback={
                <p class="external-file-access__notice" role="status">
                  Start a research session before connecting an external folder.
                </p>
              }
            >
              <label class="external-file-access__field">
                <span>Folder access</span>
                <Select
                  aria-label="External file access"
                  options={accessOptions}
                  current={accessOptions.find((option) => option.value === state.access)}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => option && setState("access", option.value)}
                  variant="secondary"
                  triggerVariant="settings"
                />
                <small>
                  {state.access === "write"
                    ? "OpenScience can read, create, and update files in this folder."
                    : "OpenScience can inspect files but cannot change them."}
                </small>
              </label>
              <Show when={state.error ?? (snapshot.error ? errorMessage(snapshot.error) : undefined)}>
                {(message) => (
                  <p class="external-file-access__notice" data-tone="critical" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
            </Show>
            <div class="external-file-access__actions">
              <Button type="button" variant="ghost" size="large" onClick={props.onClose}>
                Back to files
              </Button>
              <Show when={sessionID()}>
                <Button type="button" variant="primary" size="large" onClick={request} disabled={state.busy}>
                  {state.busy ? "Connecting…" : "Connect folder"}
                </Button>
              </Show>
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  )
}
