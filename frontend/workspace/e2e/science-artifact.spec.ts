import { readFileSync } from "node:fs"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { createSdk } from "./utils"

test.skip(
  process.env.OPENSCIENCE_E2E_FAKE_MODEL !== "1",
  "requires the deterministic model supplied by test:e2e:local (or the E2E CI harness)",
)

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nH0AAAAASUVORK5CYII="

const ONE_PAGE_PDF = readFileSync(
  new URL(
    "../../../backend/cli/skills/writing/ml-paper-writing/templates/icml2026/icml_numpapers.pdf",
    import.meta.url,
  ),
).toString("base64")

const INLINE_PDB = [
  "HEADER    E2E ALANINE",
  "ATOM      1  N   ALA A   1      11.104  13.207   9.503  1.00 20.00           N",
  "ATOM      2  CA  ALA A   1      12.560  13.347   9.310  1.00 20.00           C",
  "ATOM      3  C   ALA A   1      13.090  12.063   8.667  1.00 20.00           C",
  "ATOM      4  O   ALA A   1      12.411  11.037   8.747  1.00 20.00           O",
  "TER",
  "END",
].join("\n")

type Sdk = ReturnType<typeof createSdk>

interface ArtifactFixture {
  kind: string
  data: unknown
  tool?: string
  title?: string
}

interface BrowserFixture {
  page: Page
  sdk: Sdk
  gotoSession: (sessionID?: string) => Promise<void>
}

async function seedArtifact(sdk: Sdk, fixture: ArtifactFixture) {
  const created = await sdk.session
    .create({ title: `science artifact ${fixture.kind} ${Date.now()}` })
    .then((result) => result.data)
  if (!created?.id) throw new Error("Session create did not return an id")
  const sessionID = created.id

  const reply = await sdk.session
    .prompt({
      sessionID,
      model: { providerID: "e2e", modelID: "echo" },
      parts: [{ type: "text", text: `seed ${fixture.kind} artifact` }],
    })
    .then((result) => result.data)

  const source = reply?.parts.find((part) => part.type === "text")
  if (!reply?.info.id || !source) throw new Error("Deterministic model did not return an assistant text part")

  const now = Date.now()
  await sdk.part.update({
    sessionID,
    messageID: reply.info.id,
    partID: source.id,
    part: {
      id: source.id,
      sessionID,
      messageID: reply.info.id,
      type: "tool",
      callID: `call_science_${fixture.kind.replace(/[^a-z0-9]/gi, "_")}_${now}`,
      tool: fixture.tool ?? "__artifact__",
      state: {
        status: "completed",
        input: {},
        output: `${fixture.kind} fixture ready`,
        title: fixture.title ?? `${fixture.kind} fixture`,
        metadata: {
          title: fixture.title ?? `${fixture.kind} fixture`,
          artifact: { kind: fixture.kind, data: fixture.data },
        },
        time: { start: now, end: now },
      },
    },
  })

  const stored = await sdk.session.messages({ sessionID, limit: 50 }).then((result) => result.data ?? [])
  const storedPart = stored.flatMap((message) => message.parts).find((part) => part.id === source.id)
  expect(storedPart?.type).toBe("tool")
  if (storedPart?.type !== "tool") throw new Error("Updated tool part was not persisted")
  expect(storedPart.tool).toBe(fixture.tool ?? "__artifact__")
  expect(storedPart.state.metadata).toMatchObject({ artifact: { kind: fixture.kind } })

  return sessionID
}

async function withArtifact(
  browser: BrowserFixture,
  fixture: ArtifactFixture,
  verify: (artifact: Locator) => Promise<void>,
) {
  const sessionID = await seedArtifact(browser.sdk, fixture)
  try {
    await browser.gotoSession(sessionID)
    await expect(browser.page).toHaveURL(new RegExp(`/session/${sessionID}$`))

    const steps = browser.page.locator('[data-slot="session-turn-collapsible-trigger-content"]')
    await expect(steps).toBeVisible()
    await steps.click()

    const artifact = browser.page.locator(`[data-component="science-artifact"][data-kind="${fixture.kind}"]`)
    await expect(artifact).toBeVisible()
    await verify(artifact)
  } finally {
    await browser.sdk.session.delete({ sessionID }).catch(() => undefined)
  }
}

test("notebook artifact metadata renders through the science fallback", async ({ page, sdk, gotoSession }) => {
  await withArtifact(
    { page, sdk, gotoSession },
    {
      kind: "image",
      data: { images: [ONE_PIXEL_PNG] },
      tool: "notebook",
      title: "Notebook output",
    },
    async (artifact) => {
      await expect(page.locator('[data-component="tool-part-wrapper"]').filter({ hasText: "notebook" })).toBeVisible()
      const image = artifact.getByRole("img", { name: "artifact", exact: true })
      await expect(image).toBeVisible()
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1)
    },
  )
})

test("renders an inline 2D chemical structure without network access", async ({ page, sdk, gotoSession }) => {
  const workerResponse =
    process.env.OPENSCIENCE_E2E_PACKAGED === "1"
      ? page.waitForResponse((response) => /\/assets\/rdkit\.worker-[^/]+\.js$/.test(new URL(response.url()).pathname))
      : undefined

  await withArtifact(
    { page, sdk, gotoSession },
    { kind: "chem-2d", data: { smiles: "CC(=O)Oc1ccccc1C(=O)O", width: 360, height: 220 } },
    async (artifact) => {
      const molecule = artifact.locator('[data-component="chem-2d"]')
      await expect(molecule.locator("svg")).toBeVisible({ timeout: 30_000 })
      await expect(molecule.getByText(/Could not render molecule/)).toHaveCount(0)
    },
  )

  if (workerResponse) {
    const workerPolicy = (await workerResponse).headers()["content-security-policy"]
    expect(workerPolicy).toContain("default-src 'none'")
    expect(workerPolicy).toContain("script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'")

    const appPolicy = await page.evaluate(async () => {
      const response = await fetch(window.location.pathname, { method: "HEAD" })
      return response.headers.get("content-security-policy")
    })
    expect(appPolicy).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(appPolicy).not.toContain("'unsafe-eval'")
  }
})

test("renders a deterministic nucleotide sequence", async ({ page, sdk, gotoSession }) => {
  await withArtifact(
    { page, sdk, gotoSession },
    {
      kind: "sequence",
      data: { id: "e2e-dna", sequence: "ACGTACGTACGT", type: "dna", perRow: 12 },
    },
    async (artifact) => {
      await expect(artifact.locator('[data-slot="sequence-header"]')).toContainText("e2e-dna · 12 nt · nucleotide")
      await expect(artifact.locator('[data-slot="sequence-residues"]')).toHaveText("ACGTACGTACGT")
      await expect(artifact.locator('[data-slot="sequence-sample-badge"]')).toHaveCount(0)
    },
  )
})

test("renders a deterministic multiple-sequence alignment", async ({ page, sdk, gotoSession }) => {
  await withArtifact(
    { page, sdk, gotoSession },
    {
      kind: "msa",
      data: {
        sequences: [
          { id: "reference", seq: "ACGTACGTACGT" },
          { id: "sample-a", seq: "ACGTAC-TACGT" },
          { id: "sample-b", seq: "ACGTACGTAC-T" },
        ],
      },
    },
    async (artifact) => {
      await expect(artifact.locator('[data-slot="msa-header"]')).toContainText("3 seqs × 12 cols · nucleotide")
      await expect(artifact.locator('[data-slot="msa-gutter"] [title]')).toHaveCount(3)
      const canvas = artifact.locator('[data-slot="msa-grid"] canvas')
      await expect(canvas).toBeVisible()
      await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width * node.height)).toBeGreaterThan(0)
    },
  )
})

test("typesets deterministic LaTeX with the packaged KaTeX chunk", async ({ page, sdk, gotoSession }) => {
  await withArtifact(
    { page, sdk, gotoSession },
    { kind: "latex", data: { tex: "E = mc^2", displayMode: true } },
    async (artifact) => {
      await expect(artifact.locator('[data-component="science-latex"] .katex')).toBeVisible()
      await expect(artifact.locator('[data-slot="latex-header"]')).toContainText("LaTeX · display")
      await expect(artifact.locator('[data-slot="latex-error"]')).toHaveCount(0)
    },
  )
})

test("renders an inline protein structure without RCSB access", async ({ page, sdk, gotoSession }) => {
  await withArtifact(
    { page, sdk, gotoSession },
    { kind: "protein-structure", data: { pdb: INLINE_PDB } },
    async (artifact) => {
      const structure = artifact.locator('[data-component="mol-structure"]')
      await expect(structure.getByText("Loading 3D structure…")).toBeHidden({ timeout: 30_000 })
      await expect(structure.getByText(/Could not render structure/)).toHaveCount(0)
      const canvas = structure.locator("canvas").first()
      await expect(canvas).toBeVisible()
      await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width * node.height)).toBeGreaterThan(0)
    },
  )
})

test("rasterizes an inline one-page PDF", async ({ page, sdk, gotoSession }) => {
  await withArtifact(
    { page, sdk, gotoSession },
    { kind: "pdf", data: { base64: ONE_PAGE_PDF, scale: 0.6, maxPages: 1 } },
    async (artifact) => {
      await expect(artifact.locator('[data-slot="pdf-header"]')).toContainText("1 page", { timeout: 30_000 })
      await expect(artifact.locator('[data-slot="pdf-error"]')).toHaveCount(0)
      const canvas = artifact.locator('[data-slot="pdf-pages"] canvas')
      await expect(canvas).toBeVisible()
      await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width * node.height)).toBeGreaterThan(0)
    },
  )
})

test("renders a self-origin genome reference and BED track", async ({ page, sdk, gotoSession }) => {
  const fasta = `>chrE2E\n${"ACGT".repeat(250)}\n`
  const requests = { fasta: 0, index: 0, bed: 0 }

  await page.route("**/e2e-fixtures/reference.fa", async (route) => {
    requests.fasta++
    await route.fulfill({ contentType: "text/plain", body: fasta })
  })
  await page.route("**/e2e-fixtures/reference.fa.fai", async (route) => {
    requests.index++
    await route.fulfill({ contentType: "text/plain", body: "chrE2E\t1000\t8\t1000\t1001\n" })
  })
  await page.route("**/e2e-fixtures/features.bed", async (route) => {
    requests.bed++
    await route.fulfill({
      contentType: "text/plain",
      body: "chrE2E\t24\t64\tfeature-a\nchrE2E\t120\t180\tfeature-b\n",
    })
  })

  await withArtifact(
    { page, sdk, gotoSession },
    {
      kind: "genome-track",
      data: {
        reference: {
          id: "e2e-reference",
          name: "E2E reference",
          fastaURL: "/e2e-fixtures/reference.fa",
          indexURL: "/e2e-fixtures/reference.fa.fai",
        },
        locus: "chrE2E:1-200",
        tracks: [
          {
            name: "E2E features",
            type: "annotation",
            format: "bed",
            url: "/e2e-fixtures/features.bed",
            displayMode: "EXPANDED",
          },
        ],
      },
    },
    async (artifact) => {
      const genome = artifact.locator('[data-component="science-genome-track"]')
      await expect(genome.locator(".igv-navbar")).toBeVisible({ timeout: 30_000 })
      await expect(genome.locator(".igv-viewport").first()).toBeVisible()
      await expect(genome.getByText("E2E features", { exact: true }).first()).toBeVisible()
      await expect(genome.locator('[data-slot="genome-track-error"]')).toHaveCount(0)
      expect(requests.fasta).toBeGreaterThan(0)
      expect(requests.index).toBeGreaterThan(0)
      expect(requests.bed).toBeGreaterThan(0)
    },
  )
})
