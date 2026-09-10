import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import type { OpenScienceClient } from "@synsci/sdk/v2/client"
import "./working-folder.css"

/** "scratch" pins the session's temporary directory; a path pins a connected
 * folder; undefined leaves the server's automatic choice in place. */
export type WorkingRootChoice = "scratch" | string | undefined

type Root = { path: string; name: string }

function basename(value: string) {
  const trimmed = value.replace(/[\\/]+$/u, "")
  return trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed
}

/**
 * Where the agent's relative paths land for this conversation. Shown only when
 * the project has a connected read/write folder, since scratch is the only
 * option otherwise. For a session that does not exist yet the choice is kept
 * locally and sent with the create call.
 */
export const WorkingFolderChip: Component<{
  client: OpenScienceClient
  sessionID?: string
  pending: WorkingRootChoice
  onPending: (choice: WorkingRootChoice) => void
  disabled?: boolean
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  let details: HTMLDetailsElement | undefined

  const [state, actions] = createResource(
    () => ({ sessionID: props.sessionID, open: open() }),
    async (input) => {
      if (input.sessionID) {
        const snapshot = await props.client.session.filesystem.list({ sessionID: input.sessionID }).then((x) => x.data)
        if (!snapshot) return undefined
        const roots = snapshot.grants
          .filter(
            (grant) =>
              (grant.source === "api" || grant.source === "permission") &&
              grant.scope !== "once" &&
              grant.access === "write" &&
              !grant.time.revoked &&
              !grant.time.consumed,
          )
          .toSorted((left, right) => right.time.created - left.time.created)
          .map((grant): Root => ({ path: grant.path, name: basename(grant.path) }))
        return {
          roots,
          scratch: snapshot.workspace.scratchRoot,
          current: snapshot.toolDirectory,
          pinned: snapshot.workingRoot,
        }
      }
      const grants = await props.client.project.workingRoots().then((x) => x.data ?? [])
      const roots = grants.map((grant): Root => ({ path: grant.path, name: basename(grant.path) }))
      const automatic = roots[0]?.path
      const current = props.pending === "scratch" ? undefined : (props.pending ?? automatic)
      return { roots, scratch: undefined, current, pinned: props.pending }
    },
  )

  const roots = () => state.latest?.roots ?? []
  const current = () => state.latest?.current
  const inScratch = createMemo(() => {
    const value = state.latest
    if (!value) return false
    if (value.scratch) return value.current === value.scratch
    return value.current === undefined
  })
  const label = () => (inScratch() ? "Scratch" : basename(current() ?? "") || "Folder")

  const choose = async (choice: WorkingRootChoice) => {
    if (props.sessionID) {
      await props.client.session.filesystem
        .workingRoot({ sessionID: props.sessionID, workingRoot: choice ?? null })
        .catch(() => undefined)
    } else {
      props.onPending(choice)
    }
    details?.removeAttribute("open")
    setOpen(false)
    actions.refetch()
  }

  return (
    <Show when={roots().length > 0}>
      <details
        ref={(element) => (details = element)}
        class="working-folder"
        onToggle={(event) => setOpen(event.currentTarget.open)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          details?.removeAttribute("open")
          details?.querySelector("summary")?.focus()
        }}
      >
        <summary aria-label={`Working in ${label()}`} aria-disabled={props.disabled ? "true" : undefined}>
          <Icon name="folder" size="small" />
          <span class="working-folder__label">{label()}</span>
          <Icon name="chevron-down" size="small" />
        </summary>
        <div class="working-folder__menu" role="group" aria-label="Working folder">
          <p class="working-folder__hint">Where this conversation's files go.</p>
          <For each={roots()}>
            {(root) => {
              const active = () => !inScratch() && current() === root.path
              return (
                <button
                  type="button"
                  class="working-folder__option"
                  role="menuitemradio"
                  aria-checked={active()}
                  disabled={props.disabled}
                  onClick={() => void choose(root.path)}
                >
                  <span class="working-folder__option-copy">
                    <strong>{root.name}</strong>
                    <small title={root.path}>{root.path}</small>
                  </span>
                  <Show when={active()}>
                    <Icon name="check" size="small" />
                  </Show>
                </button>
              )
            }}
          </For>
          <button
            type="button"
            class="working-folder__option"
            role="menuitemradio"
            aria-checked={inScratch()}
            disabled={props.disabled}
            onClick={() => void choose("scratch")}
          >
            <span class="working-folder__option-copy">
              <strong>Scratch</strong>
              <small>Temporary, only this conversation</small>
            </span>
            <Show when={inScratch()}>
              <Icon name="check" size="small" />
            </Show>
          </button>
        </div>
      </details>
    </Show>
  )
}
