import { createSignal, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import { ProjectWorkspaceFrame } from "./ProjectWorkspaceFrame"

export function mountProjectWorkspaceLifecycle(host: HTMLElement) {
  const [session, setSession] = createSignal("session-a")
  const lifecycle = { mounts: 0, cleanups: 0 }

  const Surface = (props: { name: "terminal" | "file" }) => {
    onMount(() => lifecycle.mounts++)
    onCleanup(() => lifecycle.cleanups++)
    return <section data-surface={props.name}>{props.name}</section>
  }

  const dispose = render(
    () => (
      <ProjectWorkspaceFrame
        inspector={
          <aside data-inspector="project">
            <Surface name="terminal" />
            <Surface name="file" />
          </aside>
        }
      >
        <span data-chat-session>Chat {session()}</span>
      </ProjectWorkspaceFrame>
    ),
    host,
  )

  return {
    setSession,
    dispose,
    lifecycle: () => ({ ...lifecycle }),
  }
}
