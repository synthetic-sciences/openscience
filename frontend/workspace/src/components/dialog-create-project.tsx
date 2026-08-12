import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { Dialog } from "@synsci/ui/dialog"
import { IconFolder, IconFolderAdd, IconPlus, IconX } from "@/atlas/shared/Icon"
import { For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import "./dialog-create-project.css"

export interface ProjectCreateInput {
  name: string
  sources: Array<{ path: string; access: "write" }>
}

export function DialogCreateProject(props: {
  name?: string
  sources?: string[]
  onDraft?: (name: string) => void
  onChooseSources: () => void
  onRemoveSource?: (path: string) => void
  onCreate: (input: ProjectCreateInput) => Promise<void>
}): JSX.Element {
  const dialog = useDialog()
  const [state, setState] = createStore({
    name: props.name ?? "",
    busy: false,
    error: "",
  })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.busy) return
    const name = state.name.trim()
    if (!name) {
      setState("error", "Enter a project name.")
      return
    }

    setState({ busy: true, error: "" })
    await props
      .onCreate({
        name,
        sources: (props.sources ?? []).map((path) => ({ path, access: "write" })),
      })
      .then(
        () => dialog.close(),
        (error) => setState("error", error instanceof Error ? error.message : String(error)),
      )
    setState("busy", false)
  }

  return (
    <Dialog
      title="Create project"
      description="Name the workspace and optionally connect folders that belong to this research."
      class="project-create-dialog"
      fit
      transition
    >
      <form class="project-create" onSubmit={submit}>
        <div class="project-create__body">
          <label class="project-create__field">
            <span class="project-create__label">Project name</span>
            <span data-focus-frame class="project-create__input-frame">
              <span class="project-create__input-icon" aria-hidden="true">
                <IconFolder size={16} strokeWidth={1.5} />
              </span>
              <input
                autofocus
                required
                name="name"
                value={state.name}
                disabled={state.busy}
                maxlength={100}
                autocomplete="off"
                placeholder="Project name"
                aria-invalid={state.error ? "true" : undefined}
                aria-describedby={state.error ? "project-create-error" : undefined}
                class="project-create__input"
                onInput={(event) => {
                  const name = event.currentTarget.value
                  setState({ name, error: "" })
                  props.onDraft?.(name)
                }}
              />
            </span>
          </label>

          <section class="project-create__sources" aria-labelledby="source-folders-heading">
            <div class="project-create__section-heading">
              <h2 id="source-folders-heading">Source folders</h2>
              <p>Optional. OpenScience can read and edit connected folders from this project.</p>
            </div>

            <Show
              when={(props.sources ?? []).length > 0}
              fallback={
                <button
                  type="button"
                  class="project-create__source-empty"
                  disabled={state.busy}
                  onClick={props.onChooseSources}
                >
                  <span class="project-create__source-icon" aria-hidden="true">
                    <IconFolderAdd size={17} strokeWidth={1.55} />
                  </span>
                  <span class="project-create__source-empty-copy">
                    <strong>Add source folders</strong>
                    <span>Connect up to 10 folders to this workspace</span>
                  </span>
                </button>
              }
            >
              <div class="project-create__source-list">
                <For each={props.sources ?? []}>
                  {(path) => (
                    <div class="project-create__source-row">
                      <span class="project-create__source-row-icon" aria-hidden="true">
                        <IconFolder size={15} strokeWidth={1.5} />
                      </span>
                      <span class="project-create__source-copy">
                        <strong>{path.split("/").filter(Boolean).at(-1) ?? path}</strong>
                        <span title={path}>{path}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove source folder ${path}`}
                        title="Remove source folder"
                        class="project-create__remove-source"
                        onClick={() => props.onRemoveSource?.(path)}
                      >
                        <IconX size={14} strokeWidth={1.6} />
                      </button>
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="project-create__add-more"
                  disabled={state.busy || (props.sources ?? []).length >= 10}
                  onClick={props.onChooseSources}
                >
                  <IconPlus size={13} strokeWidth={1.7} />
                  Add another folder
                </button>
              </div>
            </Show>

            <Show when={state.error}>
              <p id="project-create-error" role="alert" class="project-create__error">
                {state.error}
              </p>
            </Show>
          </section>
        </div>

        <div class="project-create__footer">
          <Button type="button" size="large" variant="ghost" disabled={state.busy} onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" size="large" variant="primary" disabled={state.busy || !state.name.trim()}>
            {state.busy ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
