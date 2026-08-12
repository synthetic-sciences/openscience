import { createMemo, For, Show, type JSX } from "solid-js"
import { IconArchive, IconCopy, IconDownload, IconFile, IconX } from "@/atlas/shared/Icon"
import { artifactControl, toolbarControls, type FileDescription } from "./file-viewer"

export interface FileToolbarProps {
  name: string
  location?: string
  description: FileDescription
  source: boolean
  sourceLabel?: string
  dirty: boolean
  saving: boolean
  writable?: boolean
  disabled?: boolean
  artifact?: boolean
  archiving?: boolean
  onPreview: () => void
  onSource: () => void
  onDiscard: () => void
  onSave: () => void
  onArtifact?: () => void
  onCopy: () => void
  onDownload: () => void
  onClose?: () => void
}

export function FileToolbar(props: FileToolbarProps): JSX.Element {
  const controls = createMemo(() =>
    toolbarControls({
      description: props.description,
      source: props.source,
      dirty: props.dirty,
      saving: props.saving,
    }),
  )
  const views = createMemo(() => controls().filter((control) => control.id === "preview" || control.id === "source"))
  const artifact = createMemo(() =>
    artifactControl({ session: props.artifact === true, busy: props.archiving === true, dirty: props.dirty }),
  )
  const changes = createMemo(() =>
    props.writable === false ? [] : controls().filter((control) => control.id === "discard" || control.id === "save"),
  )
  const action = (id: ReturnType<typeof toolbarControls>[number]["id"]) => {
    if (id === "preview") return props.onPreview()
    if (id === "source") return props.onSource()
    if (id === "discard") return props.onDiscard()
    if (id === "save") return props.onSave()
    if (id === "copy") return props.onCopy()
    return props.onDownload()
  }

  return (
    <header class="atlas-file-toolbar" data-slot="file-toolbar">
      <div class="atlas-file-identity">
        <IconFile size={15} strokeWidth={1.45} />
        <div class="atlas-file-heading">
          <div class="atlas-file-name" title={props.name}>
            {props.name}
          </div>
          <div class="atlas-file-meta">
            <span class="atlas-file-type">{props.description.label}</span>
            <Show when={props.location}>
              <span class="atlas-file-meta-separator" aria-hidden="true">
                ·
              </span>
              <span class="atlas-file-location" title={props.location}>
                {props.location}
              </span>
            </Show>
          </div>
        </div>
      </div>

      <div class="atlas-file-controls">
        <Show when={views().length > 0}>
          <div class="atlas-file-modes" role="tablist" aria-label="File view">
            <For each={views()}>
              {(control) => {
                const label = () => (control.id === "source" ? (props.sourceLabel ?? control.label) : control.label)
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-label={label()}
                    aria-selected={control.active === true}
                    class="atlas-file-mode"
                    classList={{ "is-active": control.active === true }}
                    disabled={props.disabled}
                    onClick={() => action(control.id)}
                  >
                    {label()}
                  </button>
                )
              }}
            </For>
          </div>
        </Show>

        <Show when={changes().length > 0}>
          <div class="atlas-file-changes">
            <For each={changes()}>
              {(control) => (
                <button
                  type="button"
                  class="atlas-file-button"
                  classList={{ "is-primary": control.id === "save" }}
                  aria-label={control.id === "save" ? "Save changes" : "Discard changes"}
                  disabled={props.disabled || control.disabled}
                  onClick={() => action(control.id)}
                >
                  {control.label}
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={artifact()}>
          {(control) => (
            <button
              type="button"
              class="atlas-file-action"
              aria-label={control().label}
              title={control().label}
              disabled={props.disabled || control().disabled}
              onClick={() => props.onArtifact?.()}
            >
              <IconArchive size={14} strokeWidth={1.5} />
              <span>{control().label}</span>
            </button>
          )}
        </Show>
        <Show when={controls().some((control) => control.id === "copy")}>
          <button
            type="button"
            class="atlas-file-action"
            aria-label="Copy contents"
            disabled={props.disabled}
            onClick={props.onCopy}
          >
            <IconCopy size={14} strokeWidth={1.5} />
            <span>Copy</span>
          </button>
        </Show>
        <Show when={controls().some((control) => control.id === "download")}>
          <button
            type="button"
            class="atlas-file-action"
            aria-label="Download file"
            disabled={props.disabled}
            onClick={props.onDownload}
          >
            <IconDownload size={14} strokeWidth={1.5} />
            <span>Download</span>
          </button>
        </Show>
        <Show when={props.onClose}>
          <button type="button" class="atlas-file-close" aria-label="Close file" onClick={() => props.onClose?.()}>
            <IconX size={16} strokeWidth={1.55} />
          </button>
        </Show>
      </div>
    </header>
  )
}
