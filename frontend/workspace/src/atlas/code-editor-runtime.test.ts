import { expect, test } from "bun:test"
import { mountCodeEditor } from "./code-editor-runtime"

for (const language of ["python", "typescript", "json", "html", "css", "markdown"]) {
  test(`composes ${language} extensions with the editor state and reconfigures them`, () => {
    const parent = document.createElement("div")
    document.body.append(parent)
    const changes: string[] = []
    const editor = mountCodeEditor({
      parent,
      label: "Source",
      value: "original",
      language,
      readOnly: false,
      wrap: false,
      onChange: (value) => changes.push(value),
    })
    try {
      editor.setValue("updated")
      editor.setWrap(true)
      editor.setReadOnly(true)
      expect(changes).toEqual(["updated"])
      expect(parent.querySelector(".cm-content")?.textContent).toBe("updated")
      expect(parent.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false")
    } finally {
      editor.destroy()
      parent.remove()
    }
  })
}
