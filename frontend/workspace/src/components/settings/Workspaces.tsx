import { For, Show, createMemo, createResource, onCleanup, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { FolderPicker } from "@/atlas/FolderPicker"
import { confirmDialog } from "@/atlas/dialogs"
import { fileSourceName, parseFilesystemSnapshot, type FilesystemGrant } from "@/atlas/file-sources"
import { createProjectRequest, type ProjectRequest } from "@/utils/openscience-fetch"
import { NativeDirectoryPickerUnavailable } from "@/utils/native-picker"
import { resolveProjectRoute } from "@/utils/project-route"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import "./workspaces.css"

export function WorkspaceFolders(props: {
  request: ProjectRequest
  projectID: string
  directory: string
  choose?: () => Promise<string | undefined>
  confirm?: (folder: FilesystemGrant) => Promise<boolean>
  watch?: (refresh: () => void) => () => void
}) {
  const [state, set] = createStore({ path: "", access: "write" as "read" | "write", busy: false, error: "" })
  const lifetime = new AbortController()
  onCleanup(() => lifetime.abort())
  const request = async (path: string, init?: RequestInit) => {
    const response = await props.request(path, init)
    const body = await response.json()
    if (!response.ok) throw new Error(body?.data?.message || body?.message || "Folder settings could not be saved.")
    return body as unknown
  }
  const [snapshot, actions] = createResource(async () => {
    const body = await request("/project/current/filesystem")
    const value = parseFilesystemSnapshot(body, { projectID: props.projectID, directory: props.directory })
    if (!value) throw new Error("Folder settings belong to a different workspace.")
    return value
  })
  const watch = props.watch?.(() => void actions.refetch())
  if (watch) onCleanup(watch)
  const folders = () => snapshot.latest?.grants.filter((grant) => !grant.time.revoked && !grant.time.consumed) ?? []
  const mutate = async (action: () => Promise<unknown>) => {
    if (state.busy) return
    set({ busy: true, error: "" })
    await action()
      .then(
        async () => {
          if (lifetime.signal.aborted) return
          set("path", "")
          await actions.refetch()
        },
        (error) => {
          if (!lifetime.signal.aborted) set("error", error instanceof Error ? error.message : String(error))
        },
      )
      .finally(() => {
        if (!lifetime.signal.aborted) set("busy", false)
      })
  }
  const connect = (path: string, access: "read" | "write") =>
    mutate(() =>
      request("/project/current/filesystem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, access }),
      }),
    )
  const working = (workingRoot: string | null) =>
    mutate(() =>
      request("/project/current/working-root", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workingRoot }),
      }),
    )
  const disconnect = async (folder: FilesystemGrant) => {
    if (state.busy || (props.confirm && !(await props.confirm(folder))) || lifetime.signal.aborted) return
    await mutate(() => request(`/project/current/filesystem/${encodeURIComponent(folder.id)}`, { method: "DELETE" }))
  }
  const browse = async () => {
    if (!props.choose || state.busy) return
    set({ busy: true, error: "" })
    await props
      .choose()
      .then(
        (path) => {
          if (!lifetime.signal.aborted && path) set("path", path)
        },
        (error) => {
          if (!lifetime.signal.aborted) set("error", error instanceof Error ? error.message : String(error))
        },
      )
      .finally(() => {
        if (!lifetime.signal.aborted) set("busy", false)
      })
  }
  return (
    <div class="workspace-folders" aria-label="Workspace folders" aria-busy={state.busy}>
      <Show
        when={!snapshot.error}
        fallback={
          <div class="settings-alert" role="alert">
            <span>Folders could not be loaded.</span>
            <Button onClick={() => void actions.refetch()}>Retry</Button>
          </div>
        }
      >
        <Show when={snapshot.latest} fallback={<p role="status">Loading folders…</p>}>
          <div class="workspace-folders__list">
            <For
              each={folders()}
              fallback={
                <p class="workspace-folders__empty">
                  No folders connected. Add one to work with files on your computer.
                </p>
              }
            >
              {(folder) => (
                <div class="workspace-folders__item">
                  <Icon name="folder" size="normal" />
                  <div class="workspace-folders__copy">
                    <strong>{fileSourceName(folder.path)}</strong>
                    <span title={folder.path}>{folder.path}</span>
                    <Show when={snapshot.latest?.toolDirectory === folder.path}>
                      <small>Default working folder</small>
                    </Show>
                  </div>
                  <div class="workspace-folders__actions">
                    <select
                      aria-label={`Access to ${folder.path}`}
                      value={folder.access}
                      disabled={state.busy}
                      onChange={(event) => void connect(folder.path, event.currentTarget.value as "read" | "write")}
                    >
                      <option value="write">Read & write</option>
                      <option value="read">Read only</option>
                    </select>
                    <Show when={folder.access === "write" && snapshot.latest?.toolDirectory !== folder.path}>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={state.busy}
                        onClick={() => void working(folder.path)}
                        aria-label={`Use ${folder.path} by default`}
                      >
                        Use by default
                      </Button>
                    </Show>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={state.busy}
                      onClick={() => void disconnect(folder)}
                      aria-label={`Disconnect ${folder.path}`}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </div>
          <form
            class="workspace-folders__add"
            onSubmit={(event) => {
              event.preventDefault()
              if (state.path.trim()) void connect(state.path.trim(), state.access)
            }}
          >
            <label class="workspace-folders__path">
              <span>Connect a folder</span>
              <input
                aria-label="Folder path"
                placeholder="/path/to/folder"
                value={state.path}
                disabled={state.busy}
                spellcheck={false}
                autocomplete="off"
                onInput={(event) => set("path", event.currentTarget.value)}
              />
            </label>
            <div class="workspace-folders__controls">
              <select
                aria-label="New folder access"
                value={state.access}
                disabled={state.busy}
                onChange={(event) => set("access", event.currentTarget.value as "read" | "write")}
              >
                <option value="write">Read & write</option>
                <option value="read">Read only</option>
              </select>
              <Show when={props.choose}>
                <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void browse()}>
                  Browse…
                </Button>
              </Show>
              <Button type="submit" variant="primary" disabled={state.busy || !state.path.trim()}>
                Connect folder
              </Button>
            </div>
          </form>
          <Show when={folders().some((folder) => folder.access === "write")}>
            <label class="workspace-folders__default">
              <span>Default location for new conversations</span>
              <select
                aria-label="Default working folder"
                disabled={state.busy}
                value={snapshot.latest?.workingRoot ?? ""}
                onChange={(event) => void working(event.currentTarget.value || null)}
              >
                <option value="">Automatic</option>
                <For each={folders().filter((folder) => folder.access === "write")}>
                  {(folder) => (
                    <option value={folder.path}>
                      {fileSourceName(folder.path)} — {folder.path}
                    </option>
                  )}
                </For>
                <option value="scratch">Temporary scratch</option>
              </select>
            </label>
          </Show>
        </Show>
      </Show>
      <Show when={state.error}>
        <p class="workspace-folders__error" role="alert">
          {state.error}
        </p>
      </Show>
      <p class="workspace-folders__hint">
        Connected folders are shared by this project's conversations. Read only prevents edits. Disconnecting leaves
        your files in place.
      </p>
    </div>
  )
}

const Workspaces: Component = () => {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  const params = useParams()
  const [state, set] = createStore({ project: "" })
  const projects = () => sync.data.project.filter((project) => !project.time.archived)
  const selected = createMemo(
    () =>
      projects().find(
        (project) => project.id === (state.project || resolveProjectRoute(params.dir, projects())?.projectID),
      ) ?? projects()[0],
  )
  const choose = async () => {
    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform
        .openDirectoryPickerDialog({ title: "Connect a folder", serverUrl: sdk.url })
        .catch((error) => {
          if (error instanceof NativeDirectoryPickerUnavailable) return undefined
          throw error
        })
      if (result !== undefined) return Array.isArray(result) ? result[0] : (result ?? undefined)
    }
    return new Promise<string | undefined>((resolve) =>
      dialog.show(
        () => (
          <FolderPicker
            kind="folder"
            title="Connect a folder"
            onSelect={(value) => resolve(Array.isArray(value) ? value[0] : (value ?? undefined))}
          />
        ),
        () => resolve(undefined),
      ),
    )
  }
  return (
    <PanelScroll>
      <PanelHeader title="Workspaces" description="Choose where each project works and which folders it can access." />
      <PanelBody>
        <Show
          when={selected()}
          fallback={<p class="settings-card-empty">Create a project to connect its folders.</p>}
          keyed
        >
          {(project) => {
            const request = createProjectRequest({
              baseUrl: () => sdk.url,
              projectID: () => project.id,
              directory: () => project.worktree,
              fetch: () => platform.fetch ?? fetch,
            })
            return (
              <>
                <label class="workspace-project">
                  <span>Project</span>
                  <select
                    aria-label="Project workspace"
                    value={project.id}
                    onChange={(event) => set("project", event.currentTarget.value)}
                  >
                    <For each={projects()}>
                      {(item) => <option value={item.id}>{item.name || "Untitled project"}</option>}
                    </For>
                  </select>
                </label>
                <Section
                  title="Folders"
                  description="Work with your existing files from the first message. Choose a default folder here, or override it for a conversation from the composer."
                >
                  <WorkspaceFolders
                    request={request}
                    projectID={project.id}
                    directory={project.worktree}
                    choose={choose}
                    watch={(refresh) =>
                      sdk.event.on(project.worktree, (event) => {
                        if (event.type === "session.filesystem.changed" || event.type === "project.updated") refresh()
                      })
                    }
                    confirm={(folder) =>
                      confirmDialog(dialog, {
                        title: `Disconnect ${fileSourceName(folder.path)}?`,
                        message:
                          "This project will lose access to the folder. Affected running tools will stop. Your files will stay where they are.",
                        confirmLabel: "Disconnect folder",
                        danger: true,
                      })
                    }
                  />
                </Section>
              </>
            )
          }}
        </Show>
      </PanelBody>
    </PanelScroll>
  )
}

export default Workspaces
