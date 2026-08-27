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
        label: props.label ?? "Code editor",
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

  createEffect(() => {
    const value = props.value
    editor?.setValue(value)
  })
  createEffect(() => {
    const readOnly = props.readOnly === true
    editor?.setReadOnly(readOnly)
  })
  createEffect(() => {
    const wrap = props.wrap === true
    editor?.setWrap(wrap)
  })

  return (
    <div ref={host} class="atlas-code-editor" role="region" aria-label={`${props.label ?? "Code editor"} editor`} />
  )
}
