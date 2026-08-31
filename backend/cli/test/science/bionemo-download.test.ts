import { describe, expect, test } from "bun:test"
import { Uint8ArrayWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import { decodeBioNemoResult, downloadBioNemoResult, readBioNemoBody } from "../../src/science/bionemo/download"
import { Network } from "../../src/settings/network"
import { tmpdir } from "../fixture/fixture"

async function zip(files: Record<string, string>) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const [name, content] of Object.entries(files))
    await writer.add(name, new TextReader(content), { useWebWorkers: false })
  return new Uint8Array(await writer.close())
}

describe("NVIDIA large-result downloads", () => {
  test("decodes JSON and NVCF ZIP payloads without writing archive paths", async () => {
    const payload = JSON.stringify({ status: "success", molecules: [{ smiles: "CCO", score: 0.7 }] })
    expect(await decodeBioNemoResult(new TextEncoder().encode(payload))).toBe(payload)
    expect(await decodeBioNemoResult(await zip({ "request-id.response": payload }))).toBe(payload)
    expect(await decodeBioNemoResult(await zip({ "result/response.json": payload }))).toBe(payload)
    expect(await decodeBioNemoResult(await zip({ "request-id.response": payload, "metadata.json": "{}" }))).toBe(
      payload,
    )
  })

  test("rejects ambiguous and unsafe archives and unbounded decompression", async () => {
    const cases: Array<Record<string, string>> = [
      { "a.response": "{}", "b.response": "{}" },
      { "a.json": "{}", "b.json": "{}" },
      { "result.pdb": "ATOM" },
      { "../payload.response": "{}" },
      { "/payload.response": "{}" },
      { "C:\\payload.response": "{}" },
    ]
    for (const files of cases) await expect(decodeBioNemoResult(await zip(files))).rejects.toThrow()
    const compressed = await zip({ "large.response": "a".repeat(100_000) })
    expect(compressed.length).toBeLessThan(1_024)
    await expect(decodeBioNemoResult(compressed, 1_024)).rejects.toThrow("capture limit")
  })

  test("bounds body reads even when content-length is absent", async () => {
    await expect(readBioNemoBody(new Response("12345"), 4)).rejects.toThrow("capture limit")
    await expect(readBioNemoBody(new Response("", { headers: { "content-length": "5" } }), 4)).rejects.toThrow(
      "capture limit",
    )
  })

  test("downloads only a public HTTPS result without forwarding credentials", async () => {
    const result = await zip({ "result.response": "{}" })
    let requests = 0
    const text = await downloadBioNemoResult("https://download.nvidia.com/result?signature=test-secret", {
      resolveAddresses: async () => ["8.8.8.8"],
      transport: async (target, init, address) => {
        requests++
        expect(target.protocol).toBe("https:")
        expect(address).toBe("8.8.8.8")
        expect(init.method).toBe("GET")
        expect(init.credentials).toBe("omit")
        expect(init.redirect).toBe("manual")
        const headers = new Headers(init.headers)
        for (const name of ["authorization", "cookie", "referer", "proxy-authorization"])
          expect(headers.has(name)).toBe(false)
        return new Response(result, { headers: { "content-type": "application/zip" } })
      },
    })
    expect(text).toBe("{}")
    expect(requests).toBe(1)
  })

  test("rejects local destinations, protocol downgrade, credentials, and further redirects", async () => {
    let requests = 0
    const policy = {
      resolveAddresses: async () => ["127.0.0.1"],
      transport: async () => {
        requests++
        return new Response("{}")
      },
    }
    for (const url of [
      null,
      "http://download.nvidia.com/result",
      "https://user:pass@download.nvidia.com/result",
      "https://127.0.0.1/result",
      "https://localhost/result",
      "https://download.nvidia.com/result",
    ])
      await expect(downloadBioNemoResult(url, policy)).rejects.toThrow()
    expect(requests).toBe(0)
    await expect(
      downloadBioNemoResult("https://download.nvidia.com/result?signature=never-log-me", {
        ...policy,
        resolveAddresses: async () => ["8.8.8.8"],
        transport: async () => {
          requests++
          return new Response(null, { status: 302, headers: { location: "http://localhost/private" } })
        },
      }),
    ).rejects.toThrow("retry this dispatch")
    expect(requests).toBe(1)
  })

  test("retains the original request identity across expired links and never resubmits a paid POST", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    const originalDownload = Network.fetch
    const { CredentialsRoutes } = await import("../../src/server/routes/settings/credentials")
    const { Instance } = await import("../../src/project/instance")
    const { ProjectTrust } = await import("../../src/project/trust")
    const { Session } = await import("../../src/session")
    const { BioNemoHosted } = await import("../../src/science/bionemo/client")
    const { Global } = await import("../../src/global")
    const response = await zip({
      "invocation.response": JSON.stringify({ status: "success", molecules: [{ smiles: "CCO", score: 0.7 }] }),
    })
    let posts = 0
    let polls = 0
    let downloads = 0
    try {
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          const current = await ProjectTrust.status(Instance.project)
          await ProjectTrust.update(Instance.project, { trusted: true, root: current.root })
        },
        fn: async () => {
          await CredentialsRoutes().request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-redirect-test-secret" } }),
          })
          const session = await Session.create({})
          globalThis.fetch = (async (_target, init) => {
            expect(init?.redirect).toBe("manual")
            if (init?.method === "POST") posts++
            else polls++
            return new Response(null, {
              status: 302,
              headers: {
                "nvcf-reqid": "nvcf-large-result-id",
                location: "https://download.nvidia.com/result?signature=never-log-this",
              },
            })
          }) as typeof fetch
          Network.fetch = async (_target, init) => {
            downloads++
            expect(new Headers(init?.headers).has("authorization")).toBe(false)
            const ledger = await Bun.file(`${Global.Path.data}/scientific-capability-hosted-dispatches.json`).text()
            expect(ledger).toContain("nvcf-large-result-id")
            expect(ledger).not.toContain("never-log-this")
            if (downloads === 1) throw new Error("https://download.nvidia.com/result?signature=never-log-this expired")
            return new Response(response, {
              headers: { "content-type": "application/zip", "x-request-id": "untrusted-download-id" },
            })
          }
          expect(await BioNemoHosted.start("genmol", session.id, { smiles: "CCO" })).toMatchObject({
            state: "unknown",
            provider_request_id: "nvcf-large-result-id",
          })
          const result = await BioNemoHosted.start("genmol", session.id, { smiles: "CCO" })
          expect(result).toHaveProperty("artifacts")
          expect(result.provider_request_id).toBe("nvcf-large-result-id")
          expect(await BioNemoHosted.start("genmol", session.id, { smiles: "CCO" })).toEqual(result)
          expect(posts).toBe(1)
          expect(polls).toBe(1)
          expect(downloads).toBe(2)
          const ledger = await Bun.file(`${Global.Path.data}/scientific-capability-hosted-dispatches.json`).text()
          expect(ledger).not.toContain("never-log-this")
          expect(ledger).not.toContain("nvapi-redirect-test-secret")

          // An initial 302 can finalize directly; its downloaded body may be
          // ordinary JSON instead of a ZIP.
          const direct = await Session.create({})
          Network.fetch = async () =>
            new Response(JSON.stringify({ status: "success", molecules: [{ smiles: "CCN", score: 0.7 }] }))
          expect(await BioNemoHosted.start("genmol", direct.id, { smiles: "CCN" })).toHaveProperty("artifacts")
          expect(posts).toBe(2)
          expect(polls).toBe(1)

          // Downloading bytes is not success: unknown payloads remain
          // unresolved, and a retry only polls the original NVIDIA identity.
          const malformed = await Session.create({})
          const invalid = await zip({ "invalid.response": "not JSON" })
          Network.fetch = async () => new Response(invalid)
          const pending = await BioNemoHosted.start("genmol", malformed.id, { smiles: "CCC" })
          expect(pending).toMatchObject({ state: "unknown", provider_request_id: "nvcf-large-result-id" })
          expect(pending).not.toHaveProperty("artifacts")
          await BioNemoHosted.start("genmol", malformed.id, { smiles: "CCC" })
          expect(posts).toBe(3)
          expect(polls).toBe(2)
        },
      })
    } finally {
      globalThis.fetch = originalFetch
      Network.fetch = originalDownload
    }
  })
})
