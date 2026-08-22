import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { FileRoutes } from "../../src/server/routes/file"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Provenance } from "../../src/science/provenance/store"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

describe("/file research routes", () => {
  test("returns a project audit and downloadable integrity manifest", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "results.csv"), "metric,value\naccuracy,0.9\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const audit = await FileRoutes().request("/file/reproducibility")
        expect(audit.status).toBe(200)
        expect(((await audit.json()) as { checks: unknown[] }).checks.length).toBeGreaterThan(5)

        const manifest = await FileRoutes().request("/file/manifest")
        expect(manifest.status).toBe(200)
        expect(manifest.headers.get("content-disposition")).toContain("openscience-artifact-manifest.json")
        expect(((await manifest.json()) as { artifacts: unknown[] }).artifacts).toHaveLength(1)
      },
    })
  })

  test("exports a Markdown report through the publication API", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "report.md"), "# Auditable result\n\nA concise result.\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capabilities = await FileRoutes().request("/file/publication/capabilities")
        expect(capabilities.status).toBe(200)
        const support = (await capabilities.json()) as { formats: { html: boolean } }
        expect(support.formats.html).toBe(true)
        const response = await FileRoutes().request("/file/publication", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "report.md", format: "html" }),
        })
        expect(response.status).toBe(200)
        expect(((await response.json()) as { path: string }).path).toMatch(/^exports\/report-.+\.html$/)
      },
    })
  })

  test("runs, resolves, finalizes, and detects stale publication reviews", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "README.md"), "# Review API fixture\n")
        await Bun.write(path.join(directory, "uv.lock"), "version = 1\n")
        await Bun.write(path.join(directory, "pyproject.toml"), '[project]\nname = "review-api"\n')
        await Bun.write(path.join(directory, "report.md"), "# Result\n\nPrior evidence is unresolved [@missing2024].\n")
        await Bun.$`git add README.md uv.lock pyproject.toml report.md`.cwd(directory).quiet()
        await Bun.$`git -c user.name=OpenScience -c user.email=test@openscience.local commit -m "review API fixture"`
          .cwd(directory)
          .quiet()
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await FileRoutes().request("/file/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "report.md", actor: "Aayam Bansal" }),
        })
        expect(created.status).toBe(200)
        const report = (await created.json()) as {
          id: string
          status: string
          findings: Array<{ id: string; severity: string; status: string }>
        }
        expect(report.status).toBe("blocked")

        const current = await FileRoutes().request("/file/reviews?path=report.md")
        expect(current.status).toBe(200)
        expect(await current.json()).toMatchObject({ id: report.id, stale: false })

        const blocked = await FileRoutes().request(`/file/reviews/${report.id}/finalize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: "Aayam Bansal" }),
        })
        expect(blocked.status).toBe(409)

        for (const finding of report.findings.filter((item) => item.severity === "blocking")) {
          const resolved = await FileRoutes().request(`/file/reviews/${report.id}/findings/${finding.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "overridden",
              actor: "Aayam Bansal",
              reason: "Accepted for the internal preview with an explicit audit record.",
            }),
          })
          expect(resolved.status).toBe(200)
        }

        const finalized = await FileRoutes().request(`/file/reviews/${report.id}/finalize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: "Aayam Bansal" }),
        })
        expect(finalized.status).toBe(200)
        expect(await finalized.json()).toMatchObject({
          id: report.id,
          finalized: { actor: "Aayam Bansal" },
        })

        await Bun.write(path.join(tmp.path, "report.md"), "# Changed result\n")
        expect(await (await FileRoutes().request("/file/reviews?path=report.md")).json()).toMatchObject({
          id: report.id,
          stale: true,
        })
        const history = await FileRoutes().request("/file/reviews/history?path=report.md")
        expect(history.status).toBe(200)
        expect((await history.json()) as unknown[]).toHaveLength(1)
      },
    })
  })

  test("reviews connected manuscripts with read authority and requires write authority only for export", async () => {
    await using external = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "README.md"), "# Connected manuscript fixture\n")
        await Bun.write(path.join(directory, "uv.lock"), "version = 1\n")
        await Bun.write(path.join(directory, "pyproject.toml"), '[project]\nname = "connected-review"\n')
        await Bun.write(path.join(directory, "figure.png"), Uint8Array.from([1, 2, 3]))
        await Bun.write(
          path.join(directory, "paper.md"),
          "# Connected result\n\nAll structural checks pass.\n\n![Evidence](figure.png)\n",
        )
        await Bun.$`git add README.md uv.lock pyproject.toml figure.png paper.md`.cwd(directory).quiet()
        await Bun.$`git -c user.name=OpenScience -c user.email=test@openscience.local commit -m "connected paper"`
          .cwd(directory)
          .quiet()
      },
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }
        await SessionFilesystem.grant({
          sessionID: session.id,
          path: external.path,
          access: "read",
          scope: "session",
        })
        await Provenance.record({
          kind: "artifact",
          label: "Connected evidence figure",
          artifactType: "figure",
          path: path.join(external.path, "figure.png"),
          meta: { directory: tmp.path },
        } as Parameters<typeof Provenance.record>[0])
        const sessionQuery = new URLSearchParams({ sessionID: session.id })
        const sourceQuery = new URLSearchParams({ path: path.join(external.path, "paper.md"), sessionID: session.id })

        const created = await FileRoutes().request(`/file/reviews?${sessionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: path.join(external.path, "paper.md"), actor: "Connected reviewer" }),
        })
        expect(created.status).toBe(200)
        const report = (await created.json()) as { id: string; path: string; findings: Array<{ title: string }> }
        expect(report.path).toBe(path.join(external.path, "paper.md"))
        expect(report.findings.some((finding) => finding.title.includes("has no recorded provenance"))).toBe(false)

        const current = await FileRoutes().request(`/file/reviews?${sourceQuery}`)
        expect(current.status).toBe(200)
        expect(await current.json()).toMatchObject({ id: report.id, stale: false })
        const history = await FileRoutes().request(`/file/reviews/history?${sourceQuery}`)
        expect(history.status).toBe(200)
        expect((await history.json()) as unknown[]).toHaveLength(1)

        const finalized = await FileRoutes().request(`/file/reviews/${report.id}/finalize?${sessionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: "Connected reviewer" }),
        })
        expect(finalized.status).toBe(200)

        const denied = await FileRoutes().request(`/file/publication?${sessionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: path.join(external.path, "paper.md"),
            format: "html",
            readiness: "reviewed",
            review_id: report.id,
          }),
        })
        expect(denied.status).toBe(403)
        expect(await Bun.file(path.join(external.path, "exports")).exists()).toBe(false)

        await SessionFilesystem.grant({
          sessionID: session.id,
          path: external.path,
          access: "write",
          scope: "session",
        })
        const exported = await FileRoutes().request(`/file/publication?${sessionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: path.join(external.path, "paper.md"),
            format: "html",
            readiness: "reviewed",
            review_id: report.id,
          }),
        })
        expect(exported.status).toBe(200)
        const publication = (await exported.json()) as { path: string; review_id: string }
        expect(publication.path).toStartWith(path.join(external.path, "exports"))
        expect(publication.review_id).toBe(report.id)
        expect(await Bun.file(publication.path).exists()).toBe(true)

        const rawQuery = new URLSearchParams({ path: publication.path, sessionID: session.id })
        const download = await FileRoutes().request(`/file/raw?${rawQuery}`)
        expect(download.status).toBe(200)
        expect(await download.text()).toContain("Connected result")
      },
    })
  })

  test("keeps an exact manuscript grant narrow until a broader read grant is added", async () => {
    await using external = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "paper.md"), "# Exact grant\n\nPrior work [@known2026].\n")
        await Bun.write(path.join(directory, "references.bib"), "@article{known2026, title={Private sibling}}\n")
        await Bun.write(path.join(directory, "private.csv"), "secret\n")
      },
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }
        const paper = path.join(external.path, "paper.md")
        await SessionFilesystem.grant({
          sessionID: session.id,
          path: paper,
          access: "read",
          scope: "session",
        })
        const sessionQuery = new URLSearchParams({ sessionID: session.id })

        const artifacts = await FileRoutes().request(`/file/artifacts?${sessionQuery}`)
        expect(artifacts.status).toBe(200)
        const paths = ((await artifacts.json()) as Array<{ path: string }>).map((item) => item.path)
        expect(paths).toContain(paper)
        expect(paths).not.toContain(path.join(external.path, "private.csv"))

        const created = await FileRoutes().request(`/file/reviews?${sessionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: paper, actor: "Exact-file reviewer" }),
        })
        expect(created.status).toBe(200)
        const report = (await created.json()) as { id: string; findings: Array<{ id: string; title: string }> }
        expect(report.findings.some((finding) => finding.title.includes("@known2026 is unresolved"))).toBe(true)

        const other = await Session.create({})
        await using otherCleanup = { [Symbol.asyncDispose]: () => Session.remove(other.id) }
        const finding = report.findings[0]!
        const body = JSON.stringify({
          status: "overridden",
          actor: "Exact-file reviewer",
          reason: "Testing source-authorized review metadata.",
        })
        const unscoped = await FileRoutes().request(`/file/reviews/${report.id}/findings/${finding.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body,
        })
        expect(unscoped.status).toBe(403)
        const denied = await FileRoutes().request(
          `/file/reviews/${report.id}/findings/${finding.id}?${new URLSearchParams({ sessionID: other.id })}`,
          { method: "PATCH", headers: { "Content-Type": "application/json" }, body },
        )
        expect(denied.status).toBe(403)
        const resolved = await FileRoutes().request(
          `/file/reviews/${report.id}/findings/${finding.id}?${sessionQuery}`,
          { method: "PATCH", headers: { "Content-Type": "application/json" }, body },
        )
        expect(resolved.status).toBe(200)

        await SessionFilesystem.grant({
          sessionID: session.id,
          path: external.path,
          access: "read",
          scope: "project",
        })
        const bounded = await FileRoutes().request(`/file/reviews?${sessionQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: paper, actor: "Narrow-grant reviewer" }),
        })
        expect(bounded.status).toBe(200)
        const boundedReport = (await bounded.json()) as { findings: Array<{ title: string }> }
        expect(boundedReport.findings.some((item) => item.title.includes("@known2026 is unresolved"))).toBe(false)
      },
    })
  })

  test("versions, resolves, edits, and tombstones durable artifact annotations", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "results.csv"), "metric,value\naccuracy,0.9\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await FileRoutes().request("/file/annotations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: "results.csv",
            body: "Verify this value against the held-out split.",
            anchor: { kind: "text", startLine: 2, endLine: 2, quote: "accuracy,0.9" },
          }),
        })
        expect(created.status).toBe(200)
        const note = (await created.json()) as {
          id: string
          status: string
          anchor: { kind: string }
          artifactHash: string
          version: number
          revisions: Array<{ event: string }>
        }
        expect(note.id).toStartWith("ann_")
        expect(note.status).toBe("open")
        expect(note.anchor.kind).toBe("text")
        expect(note.artifactHash).toMatch(/^[a-f0-9]{64}$/)
        expect(note.version).toBe(1)
        expect(note.revisions.map((item) => item.event)).toEqual(["created"])

        const listed = await FileRoutes().request("/file/annotations?path=results.csv")
        expect(listed.status).toBe(200)
        expect((await listed.json()) as unknown[]).toHaveLength(1)

        const resolved = await FileRoutes().request(`/file/annotations/${note.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "resolved" }),
        })
        expect(resolved.status).toBe(200)
        const resolvedNote = (await resolved.json()) as {
          status: string
          version: number
          revisions: Array<{ event: string }>
        }
        expect(resolvedNote.status).toBe("resolved")
        expect(resolvedNote.version).toBe(2)
        expect(resolvedNote.revisions.map((item) => item.event)).toEqual(["created", "resolved"])

        const edited = await FileRoutes().request(`/file/annotations/${note.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: "Verified against the held-out split." }),
        })
        expect(edited.status).toBe(200)
        const editedNote = (await edited.json()) as {
          version: number
          messages: Array<{ body: string }>
          revisions: Array<{ event: string }>
        }
        expect(editedNote.version).toBe(3)
        expect(editedNote.messages[0]?.body).toBe("Verified against the held-out split.")
        expect(editedNote.revisions.at(-1)?.event).toBe("edited")

        const removed = await FileRoutes().request(`/file/annotations/${note.id}`, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(await removed.json()).toMatchObject({ deleted: true, version: 4 })
        expect(await (await FileRoutes().request("/file/annotations?path=results.csv")).json()).toEqual([])

        const history = await FileRoutes().request(`/file/annotations/${note.id}/history`)
        expect(history.status).toBe(200)
        const tombstone = (await history.json()) as {
          deletedAt: number
          version: number
          revisions: Array<{ version: number; event: string }>
        }
        expect(tombstone.deletedAt).toBeNumber()
        expect(tombstone.version).toBe(4)
        expect(tombstone.revisions).toEqual([
          expect.objectContaining({ version: 1, event: "created" }),
          expect.objectContaining({ version: 2, event: "resolved" }),
          expect.objectContaining({ version: 3, event: "edited" }),
          expect.objectContaining({ version: 4, event: "deleted" }),
        ])
      },
    })
  })

  test("upgrades legacy annotations without losing their review thread", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "legacy.csv"), "metric,value\naccuracy,0.9\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = "ann_legacy_review"
        await Storage.write(["artifact_annotation", Instance.project.id, id], {
          id,
          projectID: Instance.project.id,
          path: "legacy.csv",
          anchor: { kind: "artifact", label: "legacy.csv" },
          messages: [{ id: "msg_legacy", body: "Preserve this note.", author: "You", createdAt: 1 }],
          status: "open",
          createdAt: 1,
          updatedAt: 1,
        })

        const listed = await FileRoutes().request("/file/annotations?path=legacy.csv")
        expect(listed.status).toBe(200)
        const notes = (await listed.json()) as Array<{
          id: string
          artifactHash: string
          version: number
          revisions: Array<{ event: string }>
        }>
        expect(notes).toHaveLength(1)
        expect(notes[0]).toMatchObject({ id, version: 1 })
        expect(notes[0]?.artifactHash).toMatch(/^[a-f0-9]{64}$/)
        expect(notes[0]?.revisions.map((item) => item.event)).toEqual(["created"])
      },
    })
  })
})
