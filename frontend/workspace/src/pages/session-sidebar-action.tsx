import { Show, type JSX } from "solid-js"
import { IconCpu, IconFile, IconFolder, IconTerminal } from "@/atlas/shared/Icon"
import { preloadTerminal } from "@/components/terminal"
import "./session-sidebar.css"

export type SessionContext = "files" | "terminal" | "canvas" | "kernels" | "trace" | "artifact"

export function CompactContextActions(props: {
  context: SessionContext
  contextOpen: boolean
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
        <IconFolder size={16} strokeWidth={1.5} />
        Files
      </button>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "terminal" && props.contextOpen}
        onPointerEnter={preloadTerminal}
        onFocus={preloadTerminal}
        onClick={() => props.onContext("terminal")}
      >
        <IconTerminal size={16} strokeWidth={1.5} />
        Terminal
      </button>
      <button
        type="button"
        role="menuitem"
        aria-pressed={props.context === "kernels" && props.contextOpen}
        onClick={() => props.onContext("kernels")}
      >
        <IconCpu size={16} strokeWidth={1.5} />
        Compute
      </button>
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
  onWarm?: () => void
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      class={`session-sidebar__action${props.class ? ` ${props.class}` : ""}`}
      aria-label={props.ariaLabel}
      data-tooltip={props.label}
      aria-pressed={props.active === undefined ? undefined : props.active}
      data-selected={props.active ? "true" : undefined}
      disabled={props.disabled}
      onPointerEnter={() => props.onWarm?.()}
      onFocus={() => props.onWarm?.()}
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
  onContext: (context: SessionContext) => void
}): JSX.Element {
  return (
    <div class="session-sidebar__context-actions">
      <div class="session-sidebar__group-label" aria-hidden="true">
        Workspace
      </div>
      <div class="session-sidebar__action-list">
        <SidebarAction
          label="Files"
          detail="Project files"
          ariaLabel="Open project files"
          active={props.context === "files" && props.contextOpen}
          onClick={(_event?: Event) => props.onContext("files")}
        >
          <IconFolder size={16} strokeWidth={1.5} />
        </SidebarAction>
        <SidebarAction
          label="Terminal"
          detail="Project shell"
          ariaLabel="Open project terminal"
          shortcut="⌃`"
          active={props.context === "terminal" && props.contextOpen}
          onWarm={preloadTerminal}
          onClick={(_event?: Event) => props.onContext("terminal")}
        >
          <IconTerminal size={16} strokeWidth={1.5} />
        </SidebarAction>
        <SidebarAction
          label="Compute"
          detail="Runtimes and jobs"
          ariaLabel="Open project compute"
          active={props.context === "kernels" && props.contextOpen}
          onClick={(_event?: Event) => props.onContext("kernels")}
        >
          <IconCpu size={16} strokeWidth={1.5} />
        </SidebarAction>
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
