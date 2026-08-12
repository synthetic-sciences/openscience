import type { JSX, ParentProps } from "solid-js"
import "./ProjectWorkspaceFrame.css"

/**
 * Project-owned split boundary. Conversation routes may change beneath the
 * main slot, while the inspector sibling keeps one mounted owner for the life
 * of the project route.
 */
export function ProjectWorkspaceFrame(props: ParentProps<{ inspector: JSX.Element }>): JSX.Element {
  return (
    <div class="project-workspace-frame">
      <div class="project-workspace-frame__route">{props.children}</div>
      {props.inspector}
    </div>
  )
}
