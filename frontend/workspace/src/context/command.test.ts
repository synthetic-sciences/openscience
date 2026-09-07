import { describe, expect, test } from "bun:test"
import { matchKeybind, parseKeybind } from "./command"

function key(input: { key: string; code?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean }) {
  return {
    key: input.key,
    code: input.code ?? "",
    ctrlKey: input.ctrl ?? false,
    shiftKey: input.shift ?? false,
    metaKey: input.meta ?? false,
    altKey: input.alt ?? false,
  } as KeyboardEvent
}

describe("matchKeybind", () => {
  test("matches the shifted backtick by physical key, not the layout-shifted symbol", () => {
    const binding = parseKeybind("ctrl+shift+`")
    expect(matchKeybind(binding, key({ key: "~", code: "Backquote", ctrl: true, shift: true }))).toBe(true)
    expect(matchKeybind(binding, key({ key: "`", code: "Backquote", ctrl: true, shift: true }))).toBe(true)
    expect(matchKeybind(binding, key({ key: "`", code: "Backquote", ctrl: true }))).toBe(false)
  })

  test("keeps the unshifted backtick binding and unrelated keys apart", () => {
    const toggle = parseKeybind("ctrl+`")
    expect(matchKeybind(toggle, key({ key: "`", code: "Backquote", ctrl: true }))).toBe(true)
    expect(matchKeybind(toggle, key({ key: "~", code: "Backquote", ctrl: true, shift: true }))).toBe(false)
    expect(matchKeybind(toggle, key({ key: "k", code: "KeyK", ctrl: true }))).toBe(false)
  })
})
