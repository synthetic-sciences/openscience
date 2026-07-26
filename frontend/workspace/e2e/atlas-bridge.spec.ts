import type { APIRequestContext, Locator } from "@playwright/test"
import { test, expect } from "./fixtures"
import { serverUrl } from "./utils"

interface AtlasGraphNode {
  node_id: string
  title?: string | null
  parent_ids?: string[]
  child_ids?: string[]
}

interface AtlasGraphTree {
  nodes?: AtlasGraphNode[]
}

interface ConnectedGraph {
  graph: AtlasGraphNode
  tree: AtlasGraphTree & { nodes: AtlasGraphNode[] }
}

async function findConnectedGraph(
  request: APIRequestContext,
  graphs: AtlasGraphNode[],
): Promise<ConnectedGraph | undefined> {
  for (const graph of graphs) {
    const response = await request.get(`${serverUrl}/api/atlas/graphs/${encodeURIComponent(graph.node_id)}/tree`)
    if (!response.ok()) continue

    const tree = (await response.json()) as AtlasGraphTree
    if (!Array.isArray(tree.nodes) || tree.nodes.length < 2) continue
    const ids = new Set(tree.nodes.map((node) => node.node_id))
    const connected = tree.nodes.some((node) => (node.parent_ids ?? []).some((parent) => ids.has(parent)))
    if (connected) return { graph, tree: { ...tree, nodes: tree.nodes } }
  }
}

async function readTransform(layer: Locator) {
  return layer.evaluate((element: SVGGElement) => {
    const matrix = element.transform.baseVal.consolidate()?.matrix
    if (!matrix) throw new Error("Atlas graph layer has no SVG transform")
    return { scale: matrix.a, x: matrix.e, y: matrix.f }
  })
}

test("Atlas canvas distinguishes a connected graph from an unavailable bridge", async ({ page, gotoSession }) => {
  const response = await page.request.get(`${serverUrl}/api/atlas/graphs`)
  const graphBody = response.ok() ? ((await response.json()) as { nodes?: AtlasGraphNode[] }) : undefined
  const connected = graphBody ? await findConnectedGraph(page.request, graphBody.nodes ?? []) : undefined

  if (connected) {
    // This packaged fixture belongs to a temporary QA folder rather than the
    // worktree opened by gotoSession(). Override only the read-only folder
    // resolution request so AtlasCanvas selects the real graph/tree below.
    await page.route(/\/api\/atlas\/project\?/, async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ project_id: connected.graph.node_id }),
      })
    })
  }

  await gotoSession()

  const atlasTab = page.getByRole("tab", { name: "atlas", exact: true })
  await atlasTab.click()
  await expect(atlasTab).toHaveAttribute("aria-selected", "true")

  if (response.ok()) {
    const body = graphBody!
    expect(Array.isArray(body.nodes)).toBe(true)
    if (process.env.OPENSCIENCE_E2E_ATLAS_REQUIRED === "1") expect(body.nodes!.length).toBeGreaterThan(0)
    await expect(page.getByRole("alert")).toHaveCount(0)
    await expect(page.getByText("atlas is unavailable", { exact: true })).toHaveCount(0)

    if (process.env.OPENSCIENCE_E2E_ATLAS_REQUIRED === "1") expect(connected).toBeDefined()
    if (!connected) return

    const graphNodes = page.locator("svg g[data-node-id]")
    await expect(graphNodes).toHaveCount(connected.tree.nodes.length)
    const graphLayer = graphNodes.first().locator("xpath=..")
    const canvas = graphLayer.locator("xpath=..")
    await expect(graphLayer.locator(":scope > line")).not.toHaveCount(0)

    // Orbit layout calls fit() once its force simulation settles. Waiting for
    // the non-identity transform avoids racing that final automatic fit.
    await expect
      .poll(
        async () => {
          const transform = await readTransform(graphLayer)
          return Math.abs(transform.scale - 1) + Math.abs(transform.x) + Math.abs(transform.y)
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0.01)
    const fitted = await readTransform(graphLayer)

    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, -120)
    await expect.poll(async () => (await readTransform(graphLayer)).scale).toBeGreaterThan(fitted.scale)

    await page.getByRole("button", { name: "fit to view" }).click()
    await expect.poll(() => readTransform(graphLayer)).toEqual(fitted)

    const node = graphNodes.filter({ has: page.locator("circle") }).first()
    const nodeID = await node.getAttribute("data-node-id")
    const nodeTitle = connected.tree.nodes.find((candidate) => candidate.node_id === nodeID)?.title
    await node.locator("circle").first().click()

    const detail = page.locator('.atlas-fade-in:has(button[title="close"])')
    await expect(detail).toBeVisible()
    if (nodeTitle) await expect(detail).toContainText(nodeTitle)
    await detail.locator('button[title="close"]').click()
    await expect(detail).toHaveCount(0)
    return
  }

  expect([401, 502]).toContain(response.status())
  const body = (await response.json()) as { detail?: string }
  expect(body.detail).toBeTruthy()
  await expect(page.getByRole("alert")).toContainText("atlas is unavailable")
  await expect(page.getByRole("alert")).toContainText(body.detail!)
})
