import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, expect } from "./fixtures"
import { openConnectedFile } from "./utils"

test("inspects and searches genomics and sequencing files", async ({ page, sdk, openSession }) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openscience-bio-e2e-")))
  writeFileSync(
    path.join(directory, "cohort.vcf"),
    [
      "##fileformat=VCFv4.3",
      "##reference=GRCh38",
      "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tcase\tcontrol",
      "chr1\t10\trs1\tA\tG\t60\tPASS\tDP=20\tGT\t0/1\t0/0",
      "chr1\t20\t.\tA\tAT\t42\tPASS\tDP=12\tGT\t0/1\t0/0",
      "chr2\t30\t.\tAT\tA\t.\tLowQual\tDP=4\tGT\t1/1\t0/1",
    ].join("\n"),
  )
  writeFileSync(
    path.join(directory, "reads.fastq"),
    ["@read_1", "ACGT", "+", "IIII", "@read_2", "GGNN", "+", "!!55", ""].join("\n"),
  )

  try {
    const sessionID = await openSession()
    await sdk.session.filesystem.grant({ sessionID, path: directory, access: "read", scope: "session" })

    await openConnectedFile(page, directory, "cohort.vcf")
    const vcf = page.locator('[data-component="scientific-data"][data-format="vcf"]')
    await expect(vcf).toBeVisible()
    await expect(vcf.getByText("3 variants", { exact: true })).toBeVisible()
    await expect(vcf.getByText("Variant classes", { exact: true })).toBeVisible()
    await expect(vcf.getByText("GRCh38", { exact: true })).toBeVisible()

    await vcf.getByRole("button", { name: "Records", exact: true }).click()
    await expect(vcf.getByText("chr1:10", { exact: true })).toBeVisible()
    await vcf.getByLabel("Filter scientific records").fill("LowQual")
    await expect(vcf.getByText("chr2:30", { exact: true })).toBeVisible()
    await expect(vcf.getByText("chr1:10", { exact: true })).toHaveCount(0)

    await openConnectedFile(page, directory, "reads.fastq")
    const fastq = page.locator('[data-component="scientific-data"][data-format="fastq"]')
    await expect(fastq).toBeVisible()
    await expect(fastq.getByText("2 reads", { exact: true })).toBeVisible()
    await expect(fastq.getByText("Per-cycle base quality", { exact: true })).toBeVisible()
    await expect(fastq.getByText("Q25", { exact: true }).first()).toBeVisible()
    await expect(fastq.getByText("50% bases ≥ Q30", { exact: true })).toBeVisible()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
