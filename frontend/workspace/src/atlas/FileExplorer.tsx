import { createMemo, createResource, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Select } from "@synsci/ui/select"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { FONT_SANS } from "@/styles/tokens"
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
            Back to Files
          </button>
        </div>
      </Match>
    </Switch>
  )
}

const field = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "5px",
  color: "var(--color-text-muted)",
  "font-size": "11.5px",
})

const fieldGrid = (): JSX.CSSProperties => ({
  display: "grid",
  "grid-template-columns": "minmax(0, 1fr)",
  gap: "8px",
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
