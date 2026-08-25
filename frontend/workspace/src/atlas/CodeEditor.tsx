import { createEffect, onCleanup, onMount, type JSX } from "solid-js"

export function CodeEditor(props: {
  value: string
  language: string
  readOnly?: boolean
  wrap?: boolean
  onChange?: (value: string) => void
  onSave?: () => void
  label?: string
}): JSX.Element {
  let host!: HTMLDivElement
  let editor:
    | {
        setValue(value: string): void
        setReadOnly(value: boolean): void
        setWrap(value: boolean): void
        destroy(): void
      }
    | undefined

  onMount(() => {
    let live = true
    void import("./code-editor-runtime").then(({ mountCodeEditor }) => {
      if (!live) return
      editor = mountCodeEditor({
        parent: host,
        value: props.value,
        language: props.language,
        readOnly: props.readOnly === true,
        wrap: props.wrap === true,
        onChange: (value) => props.onChange?.(value),
        onSave: props.onSave,
      })
    })
    onCleanup(() => {
      live = false
      editor?.destroy()
    })
  })

  createEffect(() => editor?.setValue(props.value))
  createEffect(() => editor?.setReadOnly(props.readOnly === true))
  createEffect(() => editor?.setWrap(props.wrap === true))

  return <div ref={host} class="atlas-code-editor" role="region" aria-label={props.label ?? "Code editor"} />
}
