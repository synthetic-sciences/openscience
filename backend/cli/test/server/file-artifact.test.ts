import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { FileRoutes } from "../../src/server/routes/file"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

interface Saved {
  id: string
  title: string
  kind: string
  currentVersionID: string
  versionCount: number
  state: "active" | "trash"
  trashedAt?: number
  current: {
    id: string
    version: number
    size: number
    sha256: string
    mimeType: string
    sourcePath: string
  }
}

const sessions = new Set<string>()

afterEach(async () => {
  await ArtifactStore.reset()
  sessions.clear()
})

function save(body: Record<string, unknown>) {
  return FileRoutes().request("/file/artifact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function createSession() {
  const info = await Session.create({})
  sessions.add(info.id)
  return { info, workspace: await SessionFilesystem.workspace(info.id) }
}

describe("/file/artifact", () => {
  test("registers a text file as a durable immutable artifact version", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info, workspace } = await createSession()
        await Bun.write(path.join(workspace, "results", "summary.md"), "# Findings\n\nSignal detected.\n")

        const response = await save({ path: "results/summary.md", sessionID: info.id })
        expect(response.status).toBe(200)
        const saved = (await response.json()) as Saved
        expect(saved).toMatchObject({
          title: "summary.md",
          kind: "report",
          versionCount: 1,
          current: {
            version: 1,
            sourcePath: "results/summary.md",
          },
        })
        expect(saved.currentVersionID).toBe(saved.current.id)
        expect(saved.current.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(ArtifactStore.reviewTargetID(saved.current.id, saved.current.sha256)).toBe(
          `artifact-version:${saved.current.id}:${saved.current.sha256.slice(0, 16)}`,
        )

        const detail = await ArtifactStore.get(Instance.project.id, saved.id)
        expect(detail).toMatchObject({
          id: saved.id,
          versionCount: 1,
          versions: [
            {
              id: saved.current.id,
              artifactID: saved.id,
              sessionID: info.id,
              version: 1,
              captureQuality: "declared",
            },
          ],
        })
        expect(await (await ArtifactStore.read(Instance.project.id, saved.id))?.content.text()).toBe(
          "# Findings\n\nSignal detected.\n",
        )

        const list = await FileRoutes().request("/file/artifact-store")
        expect(list.status).toBe(200)
        expect((await list.json()) as Saved[]).toHaveLength(1)

        const detailResponse = await FileRoutes().request(`/file/artifact-store/${saved.id}`)
        expect(detailResponse.status).toBe(200)
        expect(await detailResponse.json()).toMatchObject({
          id: saved.id,
          versions: [{ id: saved.currentVersionID, version: 1 }],
        })

        const raw = await FileRoutes().request(
          `/file/artifact-store/${saved.id}/raw?versionID=${saved.currentVersionID}`,
        )
        expect(raw.status).toBe(200)
        expect(raw.headers.get("content-disposition")).toStartWith("inline;")
        expect(raw.headers.get("etag")).toBe(`"sha256:${saved.current.sha256}"`)
        expect(await raw.text()).toBe("# Findings\n\nSignal detected.\n")
      },
    })
  })

  test("stores binary files byte-for-byte without base64 expansion", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info, workspace } = await createSession()
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01])
        await Bun.write(path.join(workspace, "figures", "plot.png"), bytes)

        const response = await save({ path: "figures/plot.png", sessionID: info.id, summary: "Final plot" })
        expect(response.status).toBe(200)
        const saved = (await response.json()) as Saved
        expect(saved).toMatchObject({
          title: "Final plot",
          kind: "figure",
          current: {
            version: 1,
            size: bytes.byteLength,
            sourcePath: "figures/plot.png",
          },
        })
        const stored = await ArtifactStore.read(Instance.project.id, saved.id, saved.currentVersionID)
        expect(Buffer.from((await stored?.content.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(bytes)
      },
    })
  })

  test("rejects paths outside the project with a 4xx", async () => {
    await using tmp = await tmpdir({ git: true })
    const outside = path.join(os.tmpdir(), `openscience-artifact-outside-${Math.random().toString(36).slice(2)}.txt`)
    await Bun.write(outside, "not yours")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info } = await createSession()
        const response = await save({ path: outside, sessionID: info.id })
        expect(response.status).toBe(403)
      },
    })
    await fs.rm(outside, { force: true })
  })

  test("streams files larger than the old 5 MB ceiling", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info, workspace } = await createSession()
        await Bun.write(path.join(workspace, "data.csv"), Buffer.alloc(6 * 1024 * 1024, 97))
        const response = await save({ path: "data.csv", sessionID: info.id })
        expect(response.status).toBe(200)
        const saved = (await response.json()) as Saved
        expect(saved.current.size).toBe(6 * 1024 * 1024)
      },
    })
  })

  test("rejects sparse files over the 1 GiB version limit before copying", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info, workspace } = await createSession()
        await fs.writeFile(path.join(workspace, "oversized.bin"), "")
        await fs.truncate(path.join(workspace, "oversized.bin"), ArtifactStore.MAX_VERSION_BYTES + 1)
        const response = await save({ path: "oversized.bin", sessionID: info.id })
        expect(response.status).toBe(413)
      },
    })
  })

  test("saving the same source creates a new immutable version and reuses identical blobs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info, workspace } = await createSession()
        const source = path.join(workspace, "result.csv")
        await Bun.write(source, "group,value\nA,1\n")

        const first = (await (await save({ path: "result.csv", sessionID: info.id })).json()) as Saved
        const second = (await (await save({ path: "result.csv", sessionID: info.id })).json()) as Saved

        expect(second.id).toBe(first.id)
        expect(second.current.version).toBe(2)
        expect(second.versionCount).toBe(2)
        expect(second.current.sha256).toBe(first.current.sha256)
        const detail = await ArtifactStore.get(Instance.project.id, first.id)
        expect(detail?.versions.map((version) => version.version)).toEqual([2, 1])

        await fs.rm(source)
        expect(
          await (await ArtifactStore.read(Instance.project.id, first.id, first.currentVersionID))?.content.text(),
        ).toBe("group,value\nA,1\n")
      },
    })
  })

  test("serializes concurrent saves without overwriting either version", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info, workspace } = await createSession()
        await Bun.write(path.join(workspace, "parallel.txt"), "same immutable bytes")

        const responses = await Promise.all([
          save({ path: "parallel.txt", sessionID: info.id }),
          save({ path: "parallel.txt", sessionID: info.id }),
        ])
        expect(responses.map((response) => response.status)).toEqual([200, 200])
        const records = (await Promise.all(responses.map((response) => response.json()))) as Saved[]
        expect(new Set(records.map((record) => record.id)).size).toBe(1)

        const detail = await ArtifactStore.get(Instance.project.id, records[0]!.id)
        expect(detail?.versions.map((version) => version.version)).toEqual([2, 1])
        expect(new Set(detail?.versions.map((version) => version.id)).size).toBe(2)
        expect(new Set(detail?.versions.map((version) => version.sha256)).size).toBe(1)
      },
    })
  })

  test("rejects same-size blob corruption and repairs it from a known-good save", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info, workspace } = await createSession()
        const content = "immutable research bytes"
        await Bun.write(path.join(workspace, "integrity.txt"), content)
        const saved = (await (await save({ path: "integrity.txt", sessionID: info.id })).json()) as Saved
        const sha = saved.current.sha256
        const blob = path.join(Global.Path.data, "artifact-store", "blobs", sha.slice(0, 2), sha.slice(2, 4), sha)
        await Bun.write(blob, "corrupted research bytes")
        expect(Buffer.byteLength("corrupted research bytes")).toBe(Buffer.byteLength(content))
        expect(await ArtifactStore.read(Instance.project.id, saved.id)).toBeUndefined()

        const repaired = (await (await save({ path: "integrity.txt", sessionID: info.id })).json()) as Saved
        expect(repaired.id).toBe(saved.id)
        expect(repaired.current.version).toBe(2)
        expect(await (await ArtifactStore.read(Instance.project.id, repaired.id))?.content.text()).toBe(content)
        expect(
          await (await ArtifactStore.read(Instance.project.id, repaired.id, saved.currentVersionID))?.content.text(),
        ).toBe(content)
      },
    })
  })

  test("renames, trashes, restores, and expires artifacts without changing immutable bytes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info, workspace } = await createSession()
        await Bun.write(path.join(workspace, "review.md"), "immutable review bytes")
        const saved = (await (await save({ path: "review.md", sessionID: info.id })).json()) as Saved

        const renamed = await FileRoutes().request(`/file/artifact-store/${saved.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Reviewed result" }),
        })
        expect(renamed.status).toBe(200)
        expect(await renamed.json()).toMatchObject({
          id: saved.id,
          title: "Reviewed result",
          currentVersionID: saved.currentVersionID,
        })

        const removed = await FileRoutes().request(`/file/artifact-store/${saved.id}`, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(await removed.json()).toMatchObject({ id: saved.id, state: "trash" })
        expect((await (await FileRoutes().request("/file/artifact-store")).json()) as Saved[]).toHaveLength(0)
        const trash = (await (await FileRoutes().request("/file/artifact-store?state=trash")).json()) as Saved[]
        expect(trash).toHaveLength(1)
        expect(trash[0]).toMatchObject({ id: saved.id, title: "Reviewed result", state: "trash" })
        expect(trash[0]?.trashedAt).toBeNumber()
        expect(
          await (await ArtifactStore.read(Instance.project.id, saved.id, saved.currentVersionID))?.content.text(),
        ).toBe("immutable review bytes")

        const restored = await FileRoutes().request(`/file/artifact-store/${saved.id}/restore`, { method: "POST" })
        expect(restored.status).toBe(200)
        expect(await restored.json()).toMatchObject({ id: saved.id, state: "active" })
        expect((await (await FileRoutes().request("/file/artifact-store")).json()) as Saved[]).toHaveLength(1)

        const expired = Date.now() - ArtifactStore.TRASH_RETENTION_MS - 1
        expect(await ArtifactStore.trash(Instance.project.id, saved.id, expired)).toMatchObject({ state: "trash" })
        expect(await ArtifactStore.sweep(Date.now())).toBe(1)
        expect(await ArtifactStore.get(Instance.project.id, saved.id)).toBeUndefined()
        expect(await ArtifactStore.read(Instance.project.id, saved.id, saved.currentVersionID)).toBeUndefined()
      },
    })
  })

  test("returns 404 for a missing file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { info } = await createSession()
        const response = await save({ path: "missing/nothing.md", sessionID: info.id })
        expect(response.status).toBe(404)
      },
    })
  })
})
