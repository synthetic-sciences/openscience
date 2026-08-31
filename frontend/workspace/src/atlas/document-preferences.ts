export type DocumentPreferences = {
  size: number
  font: "sans" | "serif"
  width: "readable" | "full"
}

export const documentDefaults: DocumentPreferences = { size: 15, font: "sans", width: "readable" }
export const documentPreferencesKey = "openscience:document-reading:v1"
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

export function normalizeDocumentPreferences(value: unknown): DocumentPreferences {
  const input = value && typeof value === "object" ? (value as Partial<DocumentPreferences>) : {}
  return {
    size: [13, 15, 17, 19].includes(input.size ?? 0) ? input.size! : documentDefaults.size,
    font: input.font === "serif" ? "serif" : "sans",
    width: input.width === "full" ? "full" : "readable",
  }
}

export function readDocumentPreferences(given?: Storage): DocumentPreferences {
  try {
    const storage = given ?? globalThis.localStorage
    return normalizeDocumentPreferences(JSON.parse(storage?.getItem(documentPreferencesKey) ?? "null"))
  } catch {
    return { ...documentDefaults }
  }
}

export function writeDocumentPreferences(value: DocumentPreferences, given?: Storage) {
  try {
    const storage = given ?? globalThis.localStorage
    storage?.setItem(documentPreferencesKey, JSON.stringify(normalizeDocumentPreferences(value)))
  } catch {
    // Reading controls still work when this device cannot persist preferences.
  }
}
