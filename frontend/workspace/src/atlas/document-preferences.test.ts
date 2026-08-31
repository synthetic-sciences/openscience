import { describe, expect, test } from "bun:test"
import {
  documentDefaults,
  documentPreferencesKey,
  normalizeDocumentPreferences,
  readDocumentPreferences,
  writeDocumentPreferences,
} from "./document-preferences"

describe("document reading preferences", () => {
  test("accepts only supported presentation options", () => {
    expect(normalizeDocumentPreferences({ size: 19, font: "serif", width: "full" })).toEqual({
      size: 19,
      font: "serif",
      width: "full",
    })
    for (const input of [undefined, null, [], "serif", { size: -1, font: "url(x)", width: "999px" }]) {
      expect(normalizeDocumentPreferences(input)).toEqual(documentDefaults)
    }
    expect(normalizeDocumentPreferences({ size: "19" })).toEqual(documentDefaults)
  })

  test("persists only its own device preference, never file contents", () => {
    const values = new Map([["other-setting", "preserved"]])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    writeDocumentPreferences({ size: 17, font: "serif", width: "full" }, storage)
    expect(readDocumentPreferences(storage)).toEqual({ size: 17, font: "serif", width: "full" })
    expect(values.size).toBe(2)
    expect(values.get("other-setting")).toBe("preserved")
    expect([...values.keys()]).toContain(documentPreferencesKey)
  })

  test("malformed or unavailable storage never prevents reading", () => {
    expect(readDocumentPreferences({ getItem: () => "{", setItem: () => {} })).toEqual(documentDefaults)
    const unavailable = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    expect(readDocumentPreferences(unavailable)).toEqual(documentDefaults)
    expect(() => writeDocumentPreferences(documentDefaults, unavailable)).not.toThrow()
  })
})
