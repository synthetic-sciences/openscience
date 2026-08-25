import { basicSetup } from "codemirror"
import { EditorState, Compartment } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { python } from "@codemirror/lang-python"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { html } from "@codemirror/lang-html"
import { css } from "@codemirror/lang-css"
import { markdown } from "@codemirror/lang-markdown"

const language = (name: string) => {
  if (name === "python") return python()
  if (["javascript", "typescript", "jsx", "tsx"].includes(name))
    return javascript({ typescript: name.includes("typescript") || name === "tsx", jsx: name.includes("x") })
  if (name === "json") return json()
  if (name === "html" || name === "xml") return html()
  if (name === "css" || name === "scss") return css()
  if (name === "markdown") return markdown()
}

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--color-surface-solid)", color: "var(--color-text)" },
  ".cm-scroller": { fontFamily: "var(--font-code)", fontSize: "13px", lineHeight: "1.65" },
  ".cm-content": { padding: "14px 0 48px", caretColor: "var(--color-text)" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg)",
    color: "var(--color-text-faint)",
    borderRight: "1px solid var(--color-border)",
    paddingTop: "14px",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--color-bg-subtle)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 20%, transparent) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--color-text)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-bg-subtle)", borderColor: "var(--color-border)" },
  "&.cm-focused": { outline: "none" },
})

export function mountCodeEditor(input: {
  parent: HTMLElement
  value: string
  language: string
  readOnly: boolean
  wrap: boolean
  onChange: (value: string) => void
  onSave?: () => void
}) {
  const editable = new Compartment()
  const wrapping = new Compartment()
  const lang = language(input.language)
  const view = new EditorView({
    parent: input.parent,
    state: EditorState.create({
      doc: input.value,
      extensions: [
        basicSetup,
        theme,
        ...(lang ? [lang] : []),
        editable.of(EditorView.editable.of(!input.readOnly)),
        wrapping.of(input.wrap ? EditorView.lineWrapping : []),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              input.onSave?.()
              return true
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) input.onChange(update.state.doc.toString())
        }),
      ],
    }),
  })

  return {
    setValue(value: string) {
      if (value === view.state.doc.toString()) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    },
    setReadOnly(value: boolean) {
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!value)) })
    },
    setWrap(value: boolean) {
      view.dispatch({ effects: wrapping.reconfigure(value ? EditorView.lineWrapping : []) })
    },
    destroy: () => view.destroy(),
  }
}
