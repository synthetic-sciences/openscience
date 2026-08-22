import { describe, expect, test } from "bun:test"
import type { StoredArtifactVersion } from "@/artifacts/store"
import {
  loadStoredArtifactPreview,
  requestStoredArtifact,
  STORED_ARTIFACT_PREVIEW_LIMIT,
  STORED_PDF_PREVIEW_LIMIT,
  type ArtifactTransport,
} from "./bytes"

const version = (over: Partial<StoredArtifactVersion> = {}): StoredArtifactVersion => ({
  id: "ver_1",
  artifactID: "art_1",
  version: 1,
  filename: "notes.txt",
  mimeType: "text/plain",
  size: 5,
  sha256: "abc",
  sessionID: "ses_1",
  sourcePath: "/captured/notes.txt",
  captureQuality: "exact",
  createdAt: 0,
  ...over,
})

describe("stored artifact bytes", () => {
  test("loads text, image, and PDF previews through the injected authenticated transport", async () => {
    const calls: Array<{ path: string; query?: Record<string, string> }> = []
    const request: ArtifactTransport = async (path, unused, query) => {
      calls.push({ path, query })
      if (query?.versionID === "ver_image")
        return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }))
      if (query?.versionID === "ver_pdf") return new Response(new Uint8Array([37, 80, 68, 70]))
      return new Response("hello")
    }

    const text = await loadStoredArtifactPreview(request, "art/with spaces", version())
    const image = await loadStoredArtifactPreview(
      request,
      "art/with spaces",
      version({ id: "ver_image", filename: "plot.png", mimeType: "image/png", size: 4 }),
    )
    const pdf = await loadStoredArtifactPreview(
      request,
      "art/with spaces",
      version({ id: "ver_pdf", filename: "paper.pdf", mimeType: "application/pdf", size: 4 }),
    )

    expect(text).toEqual({ kind: "text", data: "hello" })
    expect(image?.kind).toBe("image")
    if (image?.kind === "image") expect(image.data).toStartWith("data:image/png;base64,")
    expect(pdf?.kind).toBe("pdf")
    if (pdf?.kind === "pdf") expect([...pdf.data]).toEqual([37, 80, 68, 70])
    expect(calls).toEqual([
      { path: "/file/artifact-store/art%2Fwith%20spaces/raw", query: { versionID: "ver_1" } },
      { path: "/file/artifact-store/art%2Fwith%20spaces/raw", query: { versionID: "ver_image" } },
      { path: "/file/artifact-store/art%2Fwith%20spaces/raw", query: { versionID: "ver_pdf" } },
    ])
  })

  test("does not request a preview that would exceed the in-memory limit", async () => {
    let calls = 0
    const request: ArtifactTransport = async () => {
      calls += 1
      return new Response("never")
    }

    const preview = await loadStoredArtifactPreview(
      request,
      "art_1",
      version({ filename: "huge.png", mimeType: "image/png", size: STORED_ARTIFACT_PREVIEW_LIMIT + 1 }),
    )

    expect(preview).toBeUndefined()
    expect(calls).toBe(0)

    const pdf = await loadStoredArtifactPreview(
      request,
      "art_1",
      version({ filename: "huge.pdf", mimeType: "application/pdf", size: STORED_PDF_PREVIEW_LIMIT + 1 }),
    )
    expect(pdf).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("allows submission-sized PDFs up to the dedicated 64 MB preview cap", async () => {
    const request: ArtifactTransport = async () => new Response(Uint8Array.from([37, 80, 68, 70]))
    const preview = await loadStoredArtifactPreview(
      request,
      "art_1",
      version({
        filename: "paper.pdf",
        mimeType: "application/pdf",
        size: STORED_ARTIFACT_PREVIEW_LIMIT + 1,
      }),
    )

    expect(preview?.kind).toBe("pdf")
  })

  test("rejects a transport body that exceeds the metadata-backed browser cap", async () => {
    const request: ArtifactTransport = async () =>
      new Response("small", { headers: { "Content-Length": String(STORED_ARTIFACT_PREVIEW_LIMIT + 1) } })

    await expect(loadStoredArtifactPreview(request, "art_1", version({ size: 5 }))).rejects.toThrow("browser limit")
  })

  test("threads cancellation through the authenticated artifact transport", async () => {
    const controller = new AbortController()
    const signals: Array<AbortSignal | null | undefined> = []
    const request: ArtifactTransport = async (path, init) => {
      signals.push(init?.signal)
      return new Response("hello")
    }

    await loadStoredArtifactPreview(request, "art_1", version(), controller.signal)
    expect(signals).toEqual([controller.signal])
  })

  test("surfaces response errors and requests downloads explicitly", async () => {
    const failed: ArtifactTransport = async () => new Response("session expired", { status: 401 })
    await expect(requestStoredArtifact(failed, "art_1", "ver_1")).rejects.toThrow("session expired")

    const calls: Array<{ path: string; query?: Record<string, string> }> = []
    const request: ArtifactTransport = async (path, unused, query) => {
      calls.push({ path, query })
      return new Response("exact bytes")
    }
    await requestStoredArtifact(request, "art_1", "ver_2", true)

    expect(calls).toEqual([
      {
        path: "/file/artifact-store/art_1/raw",
        query: { versionID: "ver_2", download: "true" },
      },
    ])
  })
})
