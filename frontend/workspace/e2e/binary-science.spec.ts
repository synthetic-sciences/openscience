import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "./fixtures"
import { openConnectedFile } from "./utils"

test("inspects and streams scientific binary containers", async ({ page, sdk, openSession }) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-binary-e2e-")))
  writeFileSync(
    path.join(directory, "cells.h5ad"),
    Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  )
  writeFileSync(path.join(directory, "sample.cram"), Uint8Array.from([0x43, 0x52, 0x41, 0x4d, 3, 1, 0, 0]))
  writeFileSync(path.join(directory, "sample.cram.crai"), "index")

  try {
    const sessionID = await openSession()
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "read", scope: "session" })

    await openConnectedFile(page, directory, "cells.h5ad")
    const h5ad = page.locator('[data-component="binary-science"][data-format="h5ad"]')
    await expect(h5ad).toBeVisible()
    await expect(h5ad.getByText("Signature valid", { exact: true })).toBeVisible()
    await expect(h5ad.getByText("H5AD container detected", { exact: true })).toBeVisible()
    await expect(h5ad.getByText("python -m pip install h5py anndata", { exact: true })).toBeVisible()

    const download = page.waitForEvent("download")
    await page.getByRole("button", { name: "Download file", exact: true }).click()
    expect((await download).suggestedFilename()).toBe("cells.h5ad")

    await openConnectedFile(page, directory, "sample.cram")
    const cram = page.locator('[data-component="binary-science"][data-format="cram"]')
    await expect(cram).toBeVisible()
    // Opened from a connected folder, the detected index reports its absolute
    // path, which ends with the sidecar filename.
    await expect(cram.getByText(/sample\.cram\.crai$/)).toBeVisible()
    await expect(cram.getByText("CRAM container detected", { exact: true })).toBeVisible()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("renders an H5AD embedding with categorical cell labels", async ({ page, sdk, openSession }) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-h5ad-embedding-e2e-")))
  writeFileSync(
    path.join(directory, "atlas.h5ad"),
    Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  )

  await page.route("**/file/inspect?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        format: "h5ad",
        name: "atlas.h5ad",
        size: 12,
        modified: Date.now(),
        signature: true,
        tool: { name: "h5py", available: true, detail: "inspected locally" },
        details: {
          summary: {
            matrix: [4, 3],
            observations: 4,
            variables: 3,
            embeddings: ["X_umap"],
          },
          groups: ["obs", "var", "obsm"],
          datasets: [{ path: "obsm/X_umap", shape: [4, 2], dtype: "float32", bytes: 32 }],
          embedding: {
            name: "X_umap",
            label: "cell_type",
            total: 4,
            points: [
              { x: -2, y: 1, label: "T cell" },
              { x: -1, y: 2, label: "T cell" },
              { x: 2, y: -1, label: "B cell" },
              { x: 3, y: -2, label: "B cell" },
            ],
          },
        },
      }),
    })
  })

  try {
    const sessionID = await openSession()
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "read", scope: "session" })
    await openConnectedFile(page, directory, "atlas.h5ad")

    const h5ad = page.locator('[data-component="binary-science"][data-format="h5ad"]')
    await expect(h5ad.getByText("Embedding preview", { exact: true })).toBeVisible()
    await expect(h5ad.getByRole("img", { name: "X_umap embedding scatter plot" })).toBeVisible()
    await expect(h5ad.getByText("T cell", { exact: true })).toBeVisible()
    await expect(h5ad.getByText("B cell", { exact: true })).toBeVisible()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
