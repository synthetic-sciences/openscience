import { Show, type JSX } from "solid-js"
import { IconActivity, IconCpu, IconFile, IconFolderTree, IconLayoutGrid, IconTerminal } from "@/atlas/shared/Icon"

export type SessionContext = "files" | "terminal" | "canvas" | "kernels" | "trace" | "artifact"

export function CompactContextActions(props: {
  context: SessionContext
  contextOpen: boolean
  atlas: boolean
  trace?: boolean
  onContext: (context: SessionContext) => void
}): JSX.Element {
  return (
    <div class="workspace-header__context-actions" style={{ display: "contents" }}>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "files" && props.contextOpen}
        onClick={() => props.onContext("files")}
      >
        <IconFolderTree size={13} strokeWidth={1.5} />
        Files
      </button>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "terminal" && props.contextOpen}
        onClick={() => props.onContext("terminal")}
      >
        <IconTerminal size={13} strokeWidth={1.5} />
        Terminal
      </button>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "kernels" && props.contextOpen}
        onClick={() => props.onContext("kernels")}
      >
        <IconCpu size={13} strokeWidth={1.5} />
        Compute
      </button>
      <Show when={props.trace}>
        <button
          type="button"
          role="menuitem"
          aria-pressed={props.context === "trace" && props.contextOpen}
          onClick={() => props.onContext("trace")}
        >
          <IconActivity size={13} strokeWidth={1.5} />
          Trace
        </button>
      </Show>
      <Show when={props.atlas}>
        <button
          type="button"
          role="menuitem"
          aria-pressed={props.context === "canvas" && props.contextOpen}
          onClick={() => props.onContext("canvas")}
        >
          <IconLayoutGrid size={13} strokeWidth={1.5} />
          Atlas
        </button>
      </Show>
    </div>
  )
}

export function SidebarAction(props: {
  class?: string
  label: string
  detail: string
  ariaLabel: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      class={`session-sidebar__action${props.class ? ` ${props.class}` : ""}`}
      aria-label={props.ariaLabel}
      aria-pressed={props.active === undefined ? undefined : props.active}
      data-selected={props.active ? "true" : undefined}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      <span class="session-sidebar__action-icon" aria-hidden="true">
        {props.children}
      </span>
      <span class="session-sidebar__action-copy">
        <strong>{props.label}</strong>
        <span>{props.detail}</span>
      </span>
      <Show when={props.shortcut}>
        <kbd aria-hidden="true">{props.shortcut}</kbd>
      </Show>
    </button>
  )
}

export function SessionSidebarActions(props: {
  context: SessionContext
  contextOpen: boolean
  artifact: boolean
  atlas: boolean
  trace?: boolean
  onContext: (context: SessionContext) => void
}): JSX.Element {
  return (
    <div class="session-sidebar__context-actions" style={{ display: "contents" }}>
      <div class="session-sidebar__action-list">
        <SidebarAction
          label="Files"
          detail="Project files"
          ariaLabel="Open project files"
          active={props.context === "files" && props.contextOpen}
          onClick={(_event?: Event) => props.onContext("files")}
        >
          <IconFolderTree size={15} strokeWidth={1.5} />
        </SidebarAction>
        <SidebarAction
          label="Terminal"
          detail="Project shell"
          ariaLabel="Open project terminal"
          shortcut="⌃`"
          active={props.context === "terminal" && props.contextOpen}
          onClick={(_event?: Event) => props.onContext("terminal")}
        >
          <IconTerminal size={15} strokeWidth={1.5} />
        </SidebarAction>
        <Show when={props.atlas}>
          <SidebarAction
            label="Atlas"
            detail="Research map"
            ariaLabel="Open Atlas"
            active={props.context === "canvas" && props.contextOpen}
            onClick={(_event?: Event) => props.onContext("canvas")}
          >
            <IconLayoutGrid size={15} strokeWidth={1.5} />
          </SidebarAction>
        </Show>
        <SidebarAction
          label="Compute"
          detail="Project kernels"
          ariaLabel="Open project compute"
          active={props.context === "kernels" && props.contextOpen}
          onClick={(_event?: Event) => props.onContext("kernels")}
        >
          <IconCpu size={15} strokeWidth={1.5} />
        </SidebarAction>
        <Show when={props.trace}>
          <SidebarAction
            label="Trace"
            detail="Time, cost, trust"
            ariaLabel="Open session trace"
            active={props.context === "trace" && props.contextOpen}
            onClick={(_event?: Event) => props.onContext("trace")}
          >
            <IconActivity size={15} strokeWidth={1.5} />
          </SidebarAction>
        </Show>
        <Show when={props.artifact}>
          <SidebarAction
            label="Details"
            detail="Active file"
            ariaLabel="Open file details"
            active={props.context === "artifact" && props.contextOpen}
            onClick={(_event?: Event) => props.onContext("artifact")}
          >
            <IconFile size={15} strokeWidth={1.5} />
          </SidebarAction>
        </Show>
      </div>
    </div>
  )
}
