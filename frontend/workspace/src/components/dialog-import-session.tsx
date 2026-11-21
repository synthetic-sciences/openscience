import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { Dialog } from "@synsci/ui/dialog"
import { IconFolder, IconSearch } from "@/atlas/shared/Icon"
import { For, Match, Show, Switch, createResource, createSignal, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import "./dialog-import-session.css"

export type ImportSource = "claude" | "codex"
export type FolderAccess = "write" | "read" | "none"

export interface ImportSessionInfo {
  source: ImportSource
  id: string
  path: string
  cwd?: string
  title?: string
  firstMessage?: string
  created: number
  modified: number
}

export interface ImportFolder {
  path?: string
  exists: boolean
  connected?: "read" | "write"
}

export interface ImportResult {
  sessionID: string
  outcome: "created" | "updated" | "copied" | "unchanged"
  reason?: "continued" | "rewound"
  folderMissing?: boolean
}

/** The server calls the dialog needs, injected so the dialog stays testable. */
export interface ImportApi {
  list: (source: ImportSource) => Promise<ImportSessionInfo[]>
  folder: (source: ImportSource, id: string) => Promise<ImportFolder>
  run: (source: ImportSource, id: string, access: FolderAccess) => Promise<ImportResult>
}

const SOURCES: Array<{ id: ImportSource; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
]

const NOTES: Record<string, string> = {
  "copied:continued": "Your earlier import has been continued in OpenScience, so this is a separate copy.",
  "copied:rewound": "The conversation was rewound or edited since the last import, so this is a separate copy.",
  unchanged: "Nothing new to import; the existing session is up to date.",
}

const ACCESS: Array<{ value: FolderAccess; label: string }> = [
  { value: "write", label: "Read and write" },
  { value: "read", label: "Read only" },
  { value: "none", label: "Don't connect" },
]

function noteFor(result: ImportResult) {
  return NOTES[result.outcome === "copied" ? `copied:${result.reason}` : result.outcome]
}

function when(value: number) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export function DialogImportSession(props: {
  api: ImportApi
  onImported: (result: ImportResult) => void
}): JSX.Element {
  const dialog = useDialog()
  const [source, setSource] = createSignal<ImportSource>("claude")
  const [query, setQuery] = createSignal("")
  const [sessions] = createResource(source, (value) => props.api.list(value))
  const [state, setState] = createStore<{
    busy: boolean
    error: string
    picked?: ImportSessionInfo
    folder?: string
    access: FolderAccess
    result?: ImportResult
  }>({ busy: false, error: "", access: "write" })

  const visible = () => {
    const needle = query().trim().toLowerCase()
    const all = sessions() ?? []
    if (!needle) return all
    return all.filter((item) =>
      [item.cwd, item.title, item.firstMessage].some((field) => field?.toLowerCase().includes(needle)),
    )
  }

  const finish = (result: ImportResult) => {
    props.onImported(result)
    dialog.close()
  }

  const run = async (picked: ImportSessionInfo, access: FolderAccess) => {
    setState({ busy: true, error: "" })
    try {
      const result = await props.api.run(picked.source, picked.id, access)
      if (noteFor(result)) setState({ result, busy: false })
      else finish(result)
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const pick = async (picked: ImportSessionInfo) => {
    if (state.busy) return
    setState({ busy: true, error: "", picked })
    try {
      const folder = await props.api.folder(picked.source, picked.id)
      // Ask only when there is a folder to connect that is not connected yet.
      if (folder.exists && folder.path && !folder.connected) {
        setState({ busy: false, folder: folder.path, access: "write" })
        return
      }
      await run(picked, folder.connected ? "read" : "none")
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <Dialog
      title="Import a conversation"
      description="Continue a Claude Code or Codex conversation in OpenScience."
      class="import-session-dialog"
      fit
      transition
    >
      <div class="import-session">
        <Switch>
          <Match when={state.result}>
            {(result) => (
              <div class="import-session__note">
                <p role="status">{noteFor(result())}</p>
                <div class="import-session__footer">
                  <Button type="button" size="large" variant="primary" onClick={() => finish(result())}>
                    Open session
                  </Button>
                </div>
              </div>
            )}
          </Match>
          <Match when={state.folder && state.picked}>
            <form
              class="import-session__folder"
              onSubmit={(event) => {
                event.preventDefault()
                if (state.picked) void run(state.picked, state.access)
              }}
            >
              <p>This conversation worked in {state.folder}. Connect it to this project?</p>
              <div class="import-session__choices" role="radiogroup">
                <For each={ACCESS}>
                  {(option) => (
                    <label class="import-session__choice">
                      <input
                        type="radio"
                        name="folder-access"
                        value={option.value}
                        checked={state.access === option.value}
                        disabled={state.busy}
                        onChange={() => setState("access", option.value)}
                      />
                      <span>{option.label}</span>
                    </label>
                  )}
                </For>
              </div>
              <Show when={state.error}>
                <p role="alert" class="import-session__error">
                  {state.error}
                </p>
              </Show>
              <div class="import-session__footer">
                <Button
                  type="button"
                  size="large"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => setState({ folder: undefined, picked: undefined })}
                >
                  Back
                </Button>
                <Button type="submit" size="large" variant="primary" disabled={state.busy}>
                  {state.busy ? "Importing…" : "Import"}
                </Button>
              </div>
            </form>
          </Match>
          <Match when={true}>
            <div class="import-session__tabs" role="tablist">
              <For each={SOURCES}>
                {(item) => (
                  <button
                    type="button"
                    role="tab"
                    class="import-session__tab"
                    aria-selected={source() === item.id}
                    onClick={() => setSource(item.id)}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </div>
            <label data-focus-frame class="import-session__search">
              <IconSearch size={14} strokeWidth={1.5} />
              <input
                name="search"
                autocomplete="off"
                placeholder="Search by folder or message"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <div class="import-session__list" role="list">
              <Show when={!sessions.loading} fallback={<p class="import-session__empty">Loading…</p>}>
                <Show
                  when={visible().length > 0}
                  fallback={<p class="import-session__empty">No conversations found.</p>}
                >
                  <For each={visible()}>
                    {(item) => (
                      <button
                        type="button"
                        role="listitem"
                        class="import-session__row"
                        disabled={state.busy}
                        onClick={() => void pick(item)}
                      >
                        <strong>{item.title ?? item.firstMessage ?? item.id}</strong>
                        <span class="import-session__meta">
                          <IconFolder size={12} strokeWidth={1.5} />
                          <span title={item.cwd}>{item.cwd ?? "Unknown folder"}</span>
                          <span>{when(item.modified)}</span>
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
            <Show when={state.error}>
              <p role="alert" class="import-session__error">
                {state.error}
              </p>
            </Show>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
