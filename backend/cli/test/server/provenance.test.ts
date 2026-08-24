import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { ProvenanceRoutes } from "../../src/server/routes/provenance"
import { ProvenanceEnvelope } from "../../src/science/provenance/envelope"
import { Provenance } from "../../src/science/provenance/store"
import { tmpdir } from "../fixture/fixture"

describe("/provenance routes", () => {
  test("lists project and session scoped execution history for Activity", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Provenance.recordOwned({ projectID: Instance.project.id, directory: Instance.directory }, {
          id: "run_activity_route",
          kind: "run",
          label: "Python execution",
          tool: "python",
          sessionID: "ses_activity",
          status: "ok",
          provenance: ProvenanceEnvelope.create({
            kind: "kernel",
            projectID: Instance.project.id,
            sessionID: "ses_activity",
            runID: "run_activity_route",
            code: "1 + 1",
            kernel: { id: "kernel-activity", language: "python", incarnation: 1 },
            status: "succeeded",
            outputs: [],
            createdAt: 1_000,
            startedAt: 1_000,
            completedAt: 1_010,
          }),
        } as Parameters<typeof Provenance.record>[0])
        const response = await ProvenanceRoutes().request("/executions?sessionID=ses_activity")
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject([
          {
            id: "run_activity_route",
            session_id: "ses_activity",
            sequence: 1,
            language: "python",
            status: "succeeded",
          },
        ])
      },
    })
  })

  test("records, reads historical reviews, traces, and exports a project audit graph", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = ProvenanceRoutes()
        const source = await app.request("/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "source",
            label: "Trial registry record",
            meta: { doi: "10.1000/example" },
          }),
        })
        expect(source.status).toBe(200)
        const sourceNode = (await source.json()) as { id: string }

        const claim = await app.request("/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "claim",
            label: "Treatment improves response",
            derived_from: sourceNode.id,
          }),
        })
        expect(claim.status).toBe(200)
        const claimNode = (await claim.json()) as { id: string }

        const scope = { projectID: Instance.project.id, directory: Instance.directory }
        const historical = await Provenance.recordOwned(scope, {
          kind: "claim",
          label: "historical review: verified",
          meta: {
            review: true,
            target: claimNode.id,
            verdict: "supports",
            claim: "Treatment improves response",
            issue: "verified",
            severity: "info",
            evidence: sourceNode.id,
          },
        })
        await Provenance.linkOwned(scope, { from: historical.id, to: claimNode.id, relation: "supports" })

        const reviews = await app.request("/reviews")
        expect(reviews.status).toBe(200)
        expect(await reviews.json()).toMatchObject([{ finding: { id: historical.id }, target: claimNode.id }])

        const reviewWrite = await app.request("/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target: claimNode.id,
            claim: "Treatment improves response",
            issue: "verified",
            severity: "info",
            evidence: sourceNode.id,
            verdict: "supports",
          }),
        })
        expect(reviewWrite.status).toBe(404)
        const resolutionWrite = await app.request(`/reviews/${historical.id}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: "user", reason: "not writable" }),
        })
        expect(resolutionWrite.status).toBe(404)

        const graph = await app.request("/")
        const result = (await graph.json()) as {
          nodes: Array<{ id: string; kind: string }>
          edges: Array<{ from: string; to: string; relation: string }>
          summary: {
            total: number
            edges: number
            kinds: Record<string, number>
            reviews: Record<string, number>
          }
        }
        expect(result.summary).toMatchObject({
          total: 3,
          edges: 2,
          kinds: { source: 1, claim: 2 },
          reviews: { supports: 1, refutes: 0 },
        })
        expect(result.edges).toContainEqual({
          from: claimNode.id,
          to: sourceNode.id,
          relation: "derived-from",
        })

        const lineage = await app.request(`/${claimNode.id}`)
        expect(lineage.status).toBe(200)
        expect(((await lineage.json()) as { nodes: unknown[] }).nodes).toHaveLength(3)

        const audit = await app.request("/export")
        expect(audit.status).toBe(200)
        expect(audit.headers.get("content-disposition")).toContain("openscience-provenance-audit.json")
        expect(await audit.json()).toMatchObject({
          project_id: Instance.project.id,
          project: Instance.project.id,
          metadata: { root: tmp.path },
        })
      },
    })
  })

  test("rejects links to missing nodes", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await ProvenanceRoutes().request("/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "claim",
            label: "Unsupported claim",
            derived_from: "missing-node",
          }),
        })
        expect(response.status).toBe(400)
      },
    })
  })

  test("generic writes reject reserved metadata and review-only relations", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = ProvenanceRoutes()
        for (const key of ["review", "resolution"] as const) {
          const response = await app.request("/nodes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "claim", label: `Forged ${key}`, meta: { [key]: true } }),
          })
          expect(response.status).toBe(400)
        }

        const source = await app.request("/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "source", label: "Source" }),
        })
        const id = ((await source.json()) as { id: string }).id
        for (const relation of ["supports", "refutes"]) {
          const response = await app.request("/nodes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "claim", label: "Forged edge", derived_from: id, relation }),
          })
          expect(response.status).toBe(400)
        }
      },
    })
  })

  test("does not expose or link provenance across project boundaries", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const source = await Instance.provide({
      directory: first.path,
      fn: async () => {
        const response = await ProvenanceRoutes().request("/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "source", label: "Private first-project source" }),
        })
        return (await response.json()) as { id: string }
      },
    })

    await Instance.provide({
      directory: second.path,
      fn: async () => {
        const graph = await ProvenanceRoutes().request("/")
        expect(((await graph.json()) as { nodes: unknown[] }).nodes).toHaveLength(0)

        const link = await ProvenanceRoutes().request("/nodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "claim",
            label: "Cross-project claim",
            derived_from: source.id,
          }),
        })
        expect(link.status).toBe(400)
      },
    })
  })

  test("shares project-owned provenance between a main worktree and linked sandbox", async () => {
    await using tmp = await tmpdir({ git: true })
    const sandbox = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-provenance-worktree`)
    const branch = `provenance-${crypto.randomUUID()}`
    await Bun.$`git worktree add ${sandbox} -b ${branch}`.cwd(tmp.path).quiet()
    try {
      const root = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const response = await ProvenanceRoutes().request("/nodes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "source",
              label: "Main worktree source",
              meta: { projectID: "attempted-override" },
            }),
          })
          const node = (await response.json()) as { id: string; meta: Record<string, unknown> }
          return { node, projectID: Instance.project.id }
        },
      })
      expect(root.node.meta).toMatchObject({
        projectID: root.projectID,
        directory: tmp.path,
      })

      const linked = await Instance.provide({
        directory: sandbox,
        fn: async () => {
          expect(Instance.project.id).toBe(root.projectID)
          const before = (await (await ProvenanceRoutes().request("/")).json()) as {
            nodes: Array<{ id: string }>
          }
          expect(before.nodes.map((node) => node.id)).toContain(root.node.id)
          const response = await ProvenanceRoutes().request("/nodes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "claim", label: "Linked worktree claim", derived_from: root.node.id }),
          })
          expect(response.status).toBe(200)
          return (await response.json()) as { id: string }
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const graph = (await (await ProvenanceRoutes().request("/")).json()) as {
            nodes: Array<{ id: string }>
            edges: Array<{ from: string; to: string }>
          }
          expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([root.node.id, linked.id]))
          expect(graph.edges).toContainEqual(
            expect.objectContaining({
              from: linked.id,
              to: root.node.id,
            }),
          )
        },
      })
    } finally {
      await Bun.$`git worktree remove --force ${sandbox}`.cwd(tmp.path).quiet()
    }
  })
})
