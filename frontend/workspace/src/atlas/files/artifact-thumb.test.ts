import { describe, expect, test } from "bun:test"
import { PREVIEW_LIMIT, extension, thumbKind, thumbLanguage } from "./artifact-thumb"
import { STORED_ARTIFACT_PREVIEW_LIMIT } from "@/artifacts/bytes"
import type { StoredArtifactVersion } from "@/artifacts/store"

const version = (over: Partial<StoredArtifactVersion>): StoredArtifactVersion => ({
  id: "ver_1",
  artifactID: "art_1",
  version: 1,
  filename: "train.py",
  mimeType: "application/octet-stream",
  size: 104,
  sha256: "abc",
  sessionID: "ses_1",
  sourcePath: "/tmp/train.py",
  captureQuality: "exact",
  createdAt: 0,
  ...over,
})

describe("artifact thumbnails", () => {
  // The real store records both train.py and iris_classification.py as
  // application/octet-stream. Dispatching on MIME type alone renders every
  // Python artifact as a binary chip.
  test("lets the extension win over a generic byte stream", () => {
    expect(thumbKind(version({ filename: "train.py" }))).toBe("text")
    expect(thumbKind(version({ filename: "model.safetensors" }))).toBe("binary")
  })

  test("dispatches on MIME type when it says something", () => {
    expect(thumbKind(version({ filename: "fit.png", mimeType: "image/png" }))).toBe("image")
    expect(thumbKind(version({ filename: "notes.md", mimeType: "text/markdown" }))).toBe("text")
    expect(thumbKind(version({ filename: "jobs.json", mimeType: "application/json;charset=utf-8" }))).toBe("text")
    expect(thumbKind(version({ filename: "paper.pdf", mimeType: "application/pdf" }))).toBe("binary")
  })

  test("bounds both text and in-memory image previews", () => {
    expect(thumbKind(version({ filename: "big.md", mimeType: "text/markdown", size: PREVIEW_LIMIT + 1 }))).toBe(
      "binary",
    )
    expect(thumbKind(version({ filename: "plot.png", mimeType: "image/png", size: 5_000_000 }))).toBe("image")
    expect(
      thumbKind({
        ...version({ filename: "huge.png", mimeType: "image/png" }),
        size: STORED_ARTIFACT_PREVIEW_LIMIT + 1,
      }),
    ).toBe("binary")
  })

  test("maps a filename to a shiki grammar, defaulting to plain text", () => {
    expect(thumbLanguage("train.py")).toBe("python")
    expect(thumbLanguage("jobs.json")).toBe("json")
    expect(thumbLanguage("notes.md")).toBe("markdown")
    expect(thumbLanguage("mystery")).toBe("text")
    expect(extension("archive.tar.gz")).toBe("gz")
    expect(extension(".gitignore")).toBe("")
  })
})
