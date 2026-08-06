import { describe, expect, test } from "bun:test"
import { REMOTE_PREVIEW_LIMIT, remotePreview } from "./remote-preview"

describe("remote file previews", () => {
  test("previews the formats a viewer can actually render", () => {
    expect(remotePreview("notes.md")).toBe("text")
    expect(remotePreview("metrics.json")).toBe("text")
    expect(remotePreview("train.py")).toBe("text")
    expect(remotePreview("results.csv")).toBe("text")
    expect(remotePreview("fit.png")).toBe("image")
    expect(remotePreview("paper.pdf")).toBe("pdf")
  })

  // An allowlist, so an unfamiliar format downloads instead of being guessed at.
  test("refuses anything not named", () => {
    expect(remotePreview("model.safetensors")).toBeUndefined()
    expect(remotePreview("weights.ckpt")).toBeUndefined()
    expect(remotePreview("data.h5ad")).toBeUndefined()
    expect(remotePreview("archive.tar.gz")).toBeUndefined()
    expect(remotePreview("mystery")).toBeUndefined()
  })

  // Volume files are fetched whole -- the route has no range support -- so the
  // cap is what stops a preview pulling a checkpoint out of the cloud.
  test("refuses a file too large to pull down for a look", () => {
    expect(remotePreview("huge.json", REMOTE_PREVIEW_LIMIT + 1)).toBeUndefined()
    expect(remotePreview("big.png", 500 * 1024 * 1024)).toBeUndefined()
    expect(remotePreview("fine.json", REMOTE_PREVIEW_LIMIT)).toBe("text")
  })

  // A listing may omit size; refusing then would refuse a 2 KB README.
  test("treats an unknown size as previewable", () => {
    expect(remotePreview("README.md", undefined)).toBe("text")
  })

  test("is case-insensitive about the extension", () => {
    expect(remotePreview("NOTES.MD")).toBe("text")
    expect(remotePreview("Figure.PNG")).toBe("image")
  })
})
