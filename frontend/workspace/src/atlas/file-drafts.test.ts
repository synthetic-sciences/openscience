import { beforeEach, describe, expect, test } from "bun:test"
import {
  discardFileDraft,
  discardAllFileDrafts,
  guardUnsavedFileDrafts,
  hasUnsavedFileDrafts,
  recoverFileDraft,
  rememberFileDraft,
} from "./file-drafts"

const directory = "/projects/alpha"
const path = "notes.md"

beforeEach(discardAllFileDrafts)

describe("file draft retention", () => {
  test("restores an unsaved project draft after its view remounts", () => {
    rememberFileDraft(directory, path, "edited locally", "saved on disk")

    expect(recoverFileDraft(directory, path, "saved on disk")).toBe("edited locally")
    expect(hasUnsavedFileDrafts()).toBe(true)

    discardFileDraft(directory, path)
    expect(recoverFileDraft(directory, path, "new disk value")).toBe("new disk value")
  })

  test("keeps clean files out of the draft cache", () => {
    rememberFileDraft(directory, path, "same", "same")

    expect(hasUnsavedFileDrafts()).toBe(false)
  })

  test("blocks a browser unload while an unsaved draft exists", () => {
    rememberFileDraft(directory, path, "edited", "saved")
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent

    guardUnsavedFileDrafts(event)

    expect(event.defaultPrevented).toBe(true)
  })
})
