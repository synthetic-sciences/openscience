import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { detectBiologicalFormat, parseBiologicalFile } from "./biological"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("biological format detection", () => {
  test.each([
    ["FASTQ", "fastq"],
    ["fq", "fastq"],
    ["vcf", "vcf"],
    ["bed", "bed"],
    ["gff3", "gff"],
    ["gtf", "gtf"],
    ["sam", "sam"],
    ["mzML", "mzml"],
    ["mzxml", "mzml"],
  ])("detects %s as %s", (extension, format) => {
    expect(detectBiologicalFormat(extension)).toBe(format as ReturnType<typeof detectBiologicalFormat>)
  })

  test("leaves unrelated text files alone", () => {
    expect(detectBiologicalFormat("txt")).toBeUndefined()
  })
})

describe("FASTQ inspection", () => {
  test("computes read, base, GC, N, and quality summaries", () => {
    const result = parseBiologicalFile(
      "fastq",
      ["@read_1 lane=1", "ACGT", "+", "IIII", "@read_2", "GGNN", "+", "!!55", ""].join("\n"),
    )

    expect(result.format).toBe("fastq")
    if (result.format !== "fastq") throw new Error("wrong parser")
    expect(result.reads).toBe(2)
    expect(result.bases).toBe(8)
    expect(result.gc).toBe(50)
    expect(result.n).toBe(25)
    expect(result.meanLength).toBe(4)
    expect(result.meanQuality).toBe(25)
    expect(result.q30).toBe(50)
    expect(result.records[0]).toMatchObject({ id: "read_1", length: 4, gc: 50, quality: 40 })
    expect(result.cycles.slice(0, 4)).toEqual([20, 20, 30, 30])
  })

  test("reports malformed records without discarding valid reads", () => {
    const result = parseBiologicalFile("fastq", "@good\nAC\n+\nII\n@broken\nAC\nnot-plus\nII\n")
    if (result.format !== "fastq") throw new Error("wrong parser")
    expect(result.reads).toBe(1)
    expect(result.invalid).toBe(1)
  })
})

describe("VCF inspection", () => {
  test("summarizes samples, filters, chromosomes, and variant classes", () => {
    const result = parseBiologicalFile(
      "vcf",
      [
        "##fileformat=VCFv4.3",
        "##reference=GRCh38",
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tcase\tcontrol",
        "chr1\t10\trs1\tA\tG\t60\tPASS\tDP=20\tGT\t0/1\t0/0",
        "chr1\t20\t.\tA\tAT\t42\tPASS\tDP=12\tGT\t0/1\t0/0",
        "chr2\t30\t.\tAT\tA\t.\tLowQual\tDP=4\tGT\t1/1\t0/1",
        "chr2\t40\t.\tA\t<DEL>\t12\tPASS\tEND=50\tGT\t0/1\t0/0",
      ].join("\n"),
    )

    expect(result.format).toBe("vcf")
    if (result.format !== "vcf") throw new Error("wrong parser")
    expect(result.fileformat).toBe("VCFv4.3")
    expect(result.reference).toBe("GRCh38")
    expect(result.samples).toEqual(["case", "control"])
    expect(result.variants).toBe(4)
    expect(result.passed).toBe(3)
    expect(result.types).toEqual({ snv: 1, insertion: 1, deletion: 1, symbolic: 1, other: 0 })
    expect(result.chromosomes).toEqual([
      { name: "chr1", count: 2 },
      { name: "chr2", count: 2 },
    ])
    expect(result.records[0]).toMatchObject({ chrom: "chr1", pos: 10, type: "snv", depth: 20 })
  })
})

describe("interval inspection", () => {
  test("parses BED spans and chromosome coverage", () => {
    const result = parseBiologicalFile(
      "bed",
      ["track name=peaks", "chr1\t10\t20\tpeak-a\t100\t+", "chr1\t30\t45\tpeak-b\t50\t-", "chr2\t5\t8"].join("\n"),
    )

    expect(result.format).toBe("bed")
    if (result.format !== "bed") throw new Error("wrong parser")
    expect(result.features).toBe(3)
    expect(result.totalSpan).toBe(28)
    expect(result.meanSpan).toBeCloseTo(9.33, 1)
    expect(result.chromosomes).toEqual([
      { name: "chr1", count: 2 },
      { name: "chr2", count: 1 },
    ])
    expect(result.records[0]).toMatchObject({ name: "peak-a", strand: "+", span: 10 })
  })

  test("parses GFF feature types and attributes", () => {
    const result = parseBiologicalFile(
      "gff",
      [
        "##gff-version 3",
        "chr1\tsrc\tgene\t1\t100\t.\t+\t.\tID=gene1;Name=TP53",
        "chr1\tsrc\texon\t1\t20\t.\t+\t.\tParent=gene1",
      ].join("\n"),
    )

    expect(result.format).toBe("gff")
    if (result.format !== "gff") throw new Error("wrong parser")
    expect(result.features).toBe(2)
    expect(result.types).toEqual([
      { name: "gene", count: 1 },
      { name: "exon", count: 1 },
    ])
    expect(result.records[0]).toMatchObject({ type: "gene", name: "TP53", span: 100 })
  })
})

describe("SAM inspection", () => {
  test("summarizes references, mapping state, flags, and MAPQ", () => {
    const result = parseBiologicalFile(
      "sam",
      [
        "@HD\tVN:1.6\tSO:coordinate",
        "@SQ\tSN:chr1\tLN:248956422",
        "r1\t0\tchr1\t10\t60\t4M\t*\t0\t0\tACGT\tIIII",
        "r2\t4\t*\t0\t0\t*\t*\t0\t0\tNNNN\t!!!!",
        "r3\t256\tchr1\t20\t20\t4M\t*\t0\t0\tTGCA\tIIII",
      ].join("\n"),
    )

    expect(result.format).toBe("sam")
    if (result.format !== "sam") throw new Error("wrong parser")
    expect(result.alignments).toBe(3)
    expect(result.mapped).toBe(2)
    expect(result.unmapped).toBe(1)
    expect(result.secondary).toBe(1)
    expect(result.meanMapq).toBe(40)
    expect(result.references).toEqual([{ name: "chr1", length: 248956422 }])
  })
})

describe("mzML inspection", () => {
  test("extracts run metadata and spectrum level inventory", () => {
    const result = parseBiologicalFile(
      "mzml",
      `<?xml version="1.0"?>
      <mzML>
        <run id="sample-01">
          <spectrumList count="3">
            <spectrum id="scan=1"><cvParam accession="MS:1000511" name="ms level" value="1"/><cvParam accession="MS:1000016" name="scan start time" value="0.5" unitName="minute"/></spectrum>
            <spectrum id="scan=2"><cvParam accession="MS:1000511" name="ms level" value="2"/><cvParam accession="MS:1000016" name="scan start time" value="0.8" unitName="minute"/></spectrum>
            <spectrum id="scan=3"><cvParam accession="MS:1000511" name="ms level" value="2"/></spectrum>
          </spectrumList>
          <chromatogramList count="2"/>
        </run>
      </mzML>`,
    )

    expect(result.format).toBe("mzml")
    if (result.format !== "mzml") throw new Error("wrong parser")
    expect(result.run).toBe("sample-01")
    expect(result.spectra).toBe(3)
    expect(result.chromatograms).toBe(2)
    expect(result.levels).toEqual([
      { name: "MS1", count: 1 },
      { name: "MS2", count: 2 },
    ])
    expect(result.times).toEqual([0.5, 0.8])
  })
})

describe("scientific data workbench integration", () => {
  test("routes biological formats into the shared file preview", () => {
    const preview = read("../../atlas/FilePreview.tsx")
    const view = read("./ScientificDataView.tsx")

    expect(preview).toContain('import { ScientificDataView } from "@/science/formats/ScientificDataView"')
    expect(preview).toContain('kind() === "scientific-data"')
    expect(preview).toContain("<ScientificDataView")
    expect(view).toContain('data-component="scientific-data"')
    expect(view).toContain("Per-cycle base quality")
    expect(view).toContain("Variant classes")
    expect(view).toContain("Spectrum inventory")
  })

  test("keeps scientific controls readable without changing scientific acronyms", () => {
    const view = read("./ScientificDataView.tsx")

    expect(view).toContain('const CONTROL_FONT_SIZE = "12px"')
    expect(view).toContain('const HELPER_FONT_SIZE = "11.5px"')
    expect(view).toContain('const TABLE_FONT_SIZE = "12px"')
    expect(view).not.toMatch(/"font-size": "(?:8|9|10|11)px"/)
    expect(view).not.toContain("FONT_MONO")
    expect(view).toMatch(/>\s*Overview\s*</)
    expect(view).toMatch(/>\s*Records\s*</)
    expect(view).toContain('placeholder="Filter records…"')
    expect(view).toContain("{sentence(column)}")
    expect(view).toContain('label="GC"')
    expect(view).toContain('"REF", "ALT"')
    expect(view).toContain('"MAPQ", "CIGAR"')
  })
})
