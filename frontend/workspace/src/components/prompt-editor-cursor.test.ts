import { describe, expect, test } from "bun:test"
import { getNodeLength, isPillNode, setCursorPosition } from "./prompt-editor-cursor"

function pill(type: string, text: string) {
  const node = document.createElement("span")
  node.dataset.type = type
  node.textContent = text
  return node
}

function editor(...nodes: Node[]) {
  const root = document.createElement("div")
  root.contentEditable = "true"
  root.append(...nodes)
  document.body.append(root)
  return root
}

describe("composer cursor placement", () => {
  test("every pill kind counts as one atom", () => {
    for (const type of ["file", "agent", "conversation"]) expect(isPillNode(pill(type, "x"))).toBe(true)
    expect(isPillNode(document.createTextNode("x"))).toBe(false)
    expect(isPillNode(document.createElement("br"))).toBe(false)
    expect(getNodeLength(document.createElement("br"))).toBe(1)
    expect(getNodeLength(document.createTextNode("ab\u200Bc"))).toBe(3)
  })

  test("a leading conversation pill is stepped over, never indexed into", () => {
    // `#Some conversation what did we conclude?` restored from history at
    // position 0, then at a position inside the following text.
    const conversation = pill("conversation", "#Some conversation")
    const text = document.createTextNode(" what did we conclude?")
    const root = editor(conversation, text)
    const seen: number[] = []
    const setStart = Range.prototype.setStart
    Range.prototype.setStart = function (node, offset) {
      seen.push(offset)
      return setStart.call(this, node, offset)
    }
    try {
      setCursorPosition(root, 0)
      let selection = window.getSelection()!
      expect(selection.anchorNode).toBe(root)
      expect(selection.anchorOffset).toBe(0)

      setCursorPosition(root, conversation.textContent!.length + 5)
      selection = window.getSelection()!
      expect(selection.anchorNode).toBe(text)
      expect(selection.anchorOffset).toBe(5)
    } finally {
      Range.prototype.setStart = setStart
      root.remove()
    }
    expect(seen.every((offset) => offset >= 0)).toBe(true)
  })
})
