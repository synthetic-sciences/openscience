import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { Dialog } from "@synsci/ui/dialog"
import { IconFolder, IconPlus, IconX } from "@/atlas/shared/Icon"
import { For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"

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
    <Dialog title="Create project" class="project-create-dialog" fit transition>
      <form class="flex flex-col" onSubmit={submit}>
        <div class="flex flex-col gap-5 px-6 pb-6">
          <label class="flex flex-col gap-2">
            <span class="text-13-medium text-text-strong">Project name</span>
            <span
              data-focus-frame
              class="flex h-11 items-center overflow-hidden rounded-[8px] border border-border-weak-base bg-surface-base transition focus-within:border-[var(--focus-lit-ring)] focus-within:shadow-[var(--focus-lit)]"
            >
              <span class="flex h-full w-11 flex-none items-center justify-center border-r border-border-weak-base text-text-weak">
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
                class="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-14-regular text-text-strong outline-none placeholder:text-text-weaker"
                onInput={(event) => {
                  const name = event.currentTarget.value
                  setState({ name, error: "" })
                  props.onDraft?.(name)
                }}
              />
            </span>
          </label>

          <section class="flex flex-col gap-2" aria-labelledby="source-folders-heading">
            <div>
              <h2 id="source-folders-heading" class="m-0 text-13-medium text-text-strong">
                Source folders
              </h2>
              <p class="m-0 mt-0.5 text-12-regular text-text-weak">
                Available across this project with read and write access.
              </p>
            </div>

            <Show
              when={(props.sources ?? []).length > 0}
              fallback={
                <button
                  type="button"
                  class="flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-[8px] border border-border-weak-base bg-surface-raised-base/60 px-5 text-center text-text-base transition-colors hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
                  disabled={state.busy}
                  onClick={props.onChooseSources}
                >
                  <span class="flex h-9 w-9 items-center justify-center rounded-[7px] bg-surface-base text-text-weak">
                    <IconPlus size={15} strokeWidth={1.7} />
                  </span>
                  <span class="text-14-medium text-text-strong">Add source folders</span>
                  <span class="text-12-regular text-text-weak">Choose folders OpenScience can read and edit</span>
                </button>
              }
            >
              <div class="overflow-hidden rounded-[8px] border border-border-weak-base bg-surface-base">
                <For each={props.sources ?? []}>
                  {(path) => (
                    <div class="flex min-h-12 items-center gap-3 border-b border-border-weak-base px-3 last:border-b-0">
                      <span class="flex h-8 w-8 flex-none items-center justify-center rounded-[6px] bg-surface-raised-base text-text-weak">
                        <IconFolder size={15} strokeWidth={1.5} />
                      </span>
                      <span class="min-w-0 flex-1">
                        <strong class="block truncate text-13-medium text-text-strong">
                          {path.split("/").filter(Boolean).at(-1) ?? path}
                        </strong>
                        <span class="block truncate text-11-regular text-text-weaker" title={path}>
                          Read & write · this project
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove source folder ${path}`}
                        title="Remove source folder"
                        class="flex h-8 w-8 flex-none items-center justify-center rounded-[6px] text-text-weaker transition-colors hover:bg-surface-raised-base hover:text-text-strong"
                        onClick={() => props.onRemoveSource?.(path)}
                      >
                        <IconX size={14} strokeWidth={1.6} />
                      </button>
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="flex min-h-10 w-full items-center justify-center gap-2 border-t border-border-weak-base bg-transparent text-12-medium text-text-base transition-colors hover:bg-surface-raised-base"
                  disabled={state.busy || (props.sources ?? []).length >= 10}
                  onClick={props.onChooseSources}
                >
                  <IconPlus size={13} strokeWidth={1.7} />
                  Add another folder
                </button>
              </div>
            </Show>

            <Show when={state.error}>
              <p role="alert" class="m-0 text-12-regular text-text-danger">
                {state.error}
              </p>
            </Show>
          </section>
        </div>

        <div class="flex items-center justify-end gap-2 border-t border-border-weak-base px-6 py-4">
          <Button type="button" variant="ghost" disabled={state.busy} onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={state.busy || !state.name.trim()}>
            {state.busy ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
