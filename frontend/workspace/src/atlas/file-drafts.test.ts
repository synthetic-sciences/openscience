import { beforeEach, describe, expect, test } from "bun:test"
import {
  discardFileDraft,
  discardAllFileDrafts,
  guardUnsavedFileDrafts,
  hasUnsavedFileDrafts,
  recoverFileDraft,
  recoverFileDraftState,
  rememberFileDraft,
} from "./file-drafts"

const directory = "/projects/alpha"
const path = "notes.md"

beforeEach(discardAllFileDrafts)

describe("file draft retention", () => {
  test("preserves the original base and revision across a changed read", () => {
    rememberFileDraft(directory, path, "my changes", "original", undefined, undefined, "rev-a", "https://one")
    expect(
      recoverFileDraftState(directory, path, "new disk contents", undefined, undefined, "rev-b", "https://one"),
    ).toEqual({ draft: "my changes", saved: "original", revision: "rev-a" })
  })

  test("isolates matching paths on different servers and discards only the selected server", () => {
    rememberFileDraft(directory, path, "server one edit", "original", undefined, undefined, "rev-a", "https://one")
    rememberFileDraft(directory, path, "server two edit", "original", undefined, undefined, "rev-b", "https://two")
    discardFileDraft(directory, path, undefined, undefined, "https://one")
    expect(recoverFileDraft(directory, path, "disk one", undefined, undefined, "https://one")).toBe("disk one")
    expect(recoverFileDraft(directory, path, "disk two", undefined, undefined, "https://two")).toBe("server two edit")
  })

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

  test("isolates same-named scratch drafts by originating session", () => {
    rememberFileDraft(directory, path, "session A edit", "saved A", "session", "ses_a")
    rememberFileDraft(directory, path, "session B edit", "saved B", "session", "ses_b")
    expect(recoverFileDraft(directory, path, "saved A", "session", "ses_a")).toBe("session A edit")
    expect(recoverFileDraft(directory, path, "saved B", "session", "ses_b")).toBe("session B edit")
    expect(recoverFileDraft(directory, path, "saved C", "session", "ses_c")).toBe("saved C")
    discardFileDraft(directory, path, "session", "ses_a")
    expect(recoverFileDraft(directory, path, "saved A", "session", "ses_a")).toBe("saved A")
    expect(recoverFileDraft(directory, path, "saved B", "session", "ses_b")).toBe("session B edit")
  })

  test("discards an auto-resolved basename by its tab identity without touching another session or project draft", () => {
    // The read may resolve report.md to /connected/reports/report.md; draft
    // ownership stays with the clicked basename, exactly as the tab records it.
    rememberFileDraft(directory, "report.md", "connected edit", "disk", "auto", "ses_a")
    rememberFileDraft(directory, "report.md", "other session edit", "disk", "auto", "ses_b")
    rememberFileDraft(directory, "report.md", "project edit", "disk")
    discardFileDraft(directory, "report.md", "auto", "ses_a")
    expect(recoverFileDraft(directory, "report.md", "disk", "auto", "ses_a")).toBe("disk")
    expect(recoverFileDraft(directory, "report.md", "disk", "auto", "ses_b")).toBe("other session edit")
    expect(recoverFileDraft(directory, "report.md", "disk")).toBe("project edit")
  })

  test("uses the same project draft for relative links and absolute read paths", () => {
    rememberFileDraft(directory, path, "project edit", "saved")
    expect(recoverFileDraft(directory, `${directory}/${path}`, "saved")).toBe("project edit")
    discardFileDraft(directory, `${directory}/${path}`)
    expect(recoverFileDraft(directory, path, "saved")).toBe("saved")
  })

  test("blocks a browser unload while an unsaved draft exists", () => {
    rememberFileDraft(directory, path, "edited", "saved")
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent

    guardUnsavedFileDrafts(event)

    expect(event.defaultPrevented).toBe(true)
  })
})
