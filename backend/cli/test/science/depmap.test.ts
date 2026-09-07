import { beforeEach, expect, test } from "bun:test"
import { depmap } from "../../src/science/connectors/omics/depmap"
import { clearCache, withHttpTestPolicy } from "../../src/science/connectors/http"

// Four records from the official public metadata CSV retrieved 2026-09-07.
// https://depmap.org/portal/api/no-captcha/download/files
// Includes a quoted release, an external public URL and withheld portal URLs.
const catalogue = await Bun.file(new URL("fixtures/depmap-catalog.csv", import.meta.url)).text()
const endpoint = "https://depmap.org/portal/api/no-captcha/download/files"
const resolveAddresses = async () => ["93.184.216.34"]
beforeEach(clearCache)

test("recorded DepMap CSV supports search/fetch with existing file-name IDs and honest missing URLs", async () => {
  const requests: string[] = []
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async (url, options) => {
        requests.push(url.href)
        expect(new Headers(options?.headers).get("Accept")).toBe("text/csv")
        return new Response(catalogue, { headers: { "Content-Type": "text/csv" } })
      },
    },
    async () => {
      const hits = await depmap.search("CRISPR", { limit: 2 })
      expect(hits.map((hit) => hit.id)).toEqual(["CRISPRScreenMap.csv", "CRISPRGeneEffect.csv"])
      expect(hits[1]).toMatchObject({
        title: "CRISPRGeneEffect.csv (DepMap Public 26Q1)",
        url: "https://depmap.org/portal/download/all/",
        extra: { releaseDate: "2026-04-01", md5Hash: "e4f75f92348388459c91401d20a9724e" },
      })
      expect(hits[1]!.extra?.downloadUrl).toBeUndefined()
      const record = await depmap.fetch(hits[1]!.id)
      expect(record).toMatchObject({ fileName: hits[1]!.id, releaseName: "DepMap Public 26Q1" })
      expect(record).toEqual(hits[1]!.extra)
      const quoted = await depmap.search("Sanger CRISPR (Project Score, CERES)")
      expect(quoted[0]).toMatchObject({
        id: "gene_effect.csv",
        url: "https://ndownloader.figshare.com/files/16623881",
        extra: { releaseName: "Sanger CRISPR (Project Score, CERES)" },
      })
      expect(await depmap.fetch("https://ndownloader.figshare.com/files/16623881")).toEqual(quoted[0]!.extra)
      expect(await depmap.search("not-in-this-metadata-catalog")).toEqual([])
      expect(await depmap.fetch("not-in-this-metadata-catalog")).toEqual({
        id: "not-in-this-metadata-catalog",
        found: false,
      })
      expect(requests).toEqual([endpoint])
    },
  )
})

test("quoted CSV fields preserve escaped quotes, commas and newlines", async () => {
  await withHttpTestPolicy(
    {
      resolveAddresses,
      transport: async () =>
        new Response(
          '\uFEFFrelease,release_date,filename\r\n"Release ""quoted"", one\ntwo",2026-01-01,measurements.csv\r\n',
        ),
    },
    async () => {
      const hits = await depmap.search("quoted")
      expect(hits).toHaveLength(1)
      expect(hits[0]!.extra?.releaseName).toBe('Release "quoted", one\ntwo')
      expect(await depmap.fetch(hits[0]!.id)).toEqual(hits[0]!.extra)
    },
  )
})

test.each([
  "<html>Verify you are human</html>",
  '{"table":[]}',
  "error,message\r\nlimit,unavailable\r\n",
  "release,release_date,filename\r\nrelease,2026-01-01\r\n",
  'release,release_date,filename\r\n"unterminated,2026-01-01,file.csv',
  'release,release_date,filename\r\n"closed"garbage,2026-01-01,file.csv',
  "release,release_date,filename\r\nrelease,2026-01-01,\r\n",
])("invalid DepMap response remains an error and is never cached: %s", async (body) => {
  let calls = 0
  await withHttpTestPolicy(
    { resolveAddresses, transport: async () => new Response(++calls === 1 ? body : catalogue) },
    async () => {
      await expect(depmap.search("CRISPR")).rejects.toThrow()
      expect(await depmap.search("CRISPR")).toHaveLength(3)
      expect(calls).toBe(2)
    },
  )
})
