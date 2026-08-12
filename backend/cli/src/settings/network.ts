import path from "path"
import fs from "fs/promises"
import { BlockList, isIP } from "net"
import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { domainToASCII } from "url"
import z from "zod"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { DataRootBarrier } from "@/global/data-root-barrier"

// Outbound domain allow-list. A catalog of curated science/package domain
// sets (each toggleable as a group) plus a validated list of custom domains.
// The store is an enforcement input, not a presentation preference: malformed
// state fails closed to the curated defaults.
export namespace Network {
  const log = Log.create({ service: "settings.network" })

  export const Group = z.object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    domains: z.array(z.string()),
  })
  export type Group = z.infer<typeof Group>

  // Curated groups wired to the package managers and built-in scientific
  // connectors OpenScience actually reaches. Parent domains intentionally
  // cover their subdomains; unrelated domains are never implied.
  export const CATALOG: Group[] = [
    {
      id: "package-management",
      label: "Package management",
      description: "Python, R, JS, Rust package indexes and source hosting.",
      domains: [
        "pypi.org",
        "pythonhosted.org",
        "npmjs.org",
        "yarnpkg.com",
        "bun.sh",
        "anaconda.org",
        "repo.anaconda.com",
        "r-project.org",
        "posit.co",
        "bioconductor.org",
        "bioconda.github.io",
        "crates.io",
        "github.com",
        "githubusercontent.com",
      ],
    },
    {
      id: "ncbi-nih",
      label: "NCBI and NIH",
      description: "PubMed, Entrez E-utilities, GEO, dbSNP, ClinVar, and NIH data services.",
      domains: ["ncbi.nlm.nih.gov", "nih.gov"],
    },
    {
      id: "genomics-biology",
      label: "Genomics and biology",
      description: "Ensembl, UCSC, EBI, gnomAD, MyGene, MyVariant, and pathway resources.",
      domains: [
        "ensembl.org",
        "ucsc.edu",
        "api.genome.ucsc.edu",
        "ebi.ac.uk",
        "gnomad.broadinstitute.org",
        "mygene.info",
        "myvariant.info",
        "webservice.thebiogrid.org",
        "rest.kegg.jp",
        "string-db.org",
        "reactome.org",
        "api.platform.opentargets.org",
        "wikipathways.org",
      ],
    },
    {
      id: "proteomics",
      label: "Proteins and structures",
      description: "UniProt, RCSB PDB, PDBe, InterPro, SIFTS, and AlphaFold services.",
      domains: ["uniprot.org", "rcsb.org", "alphafold.ebi.ac.uk", "ebi.ac.uk"],
    },
    {
      id: "literature-citations",
      label: "Literature and citations",
      description: "Preprint servers, OpenAlex, Semantic Scholar, Crossref, Europe PMC, and DOI resolution.",
      domains: [
        "arxiv.org",
        "export.arxiv.org",
        "biorxiv.org",
        "api.biorxiv.org",
        "medrxiv.org",
        "api.medrxiv.org",
        "semanticscholar.org",
        "crossref.org",
        "doi.org",
        "europepmc.org",
        "openalex.org",
      ],
    },
    {
      id: "chemistry-pharma",
      label: "Chemistry and pharmacology",
      description: "PubChem, ChEMBL, ChEBI, BindingDB, SureChEMBL, and pharmacology databases.",
      domains: ["pubchem.ncbi.nlm.nih.gov", "ebi.ac.uk", "bindingdb.org", "surechembl.org", "guidetopharmacology.org"],
    },
    {
      id: "omics-atlases",
      label: "Omics and atlases",
      description: "Expression Atlas, Human Protein Atlas, GTEx, DepMap, ArrayExpress, and cell atlases.",
      domains: ["ebi.ac.uk", "proteinatlas.org", "gtexportal.org", "depmap.org", "cellxgene.cziscience.com"],
    },
    {
      id: "clinical-regulatory",
      label: "Clinical and regulatory",
      description: "Clinical trials and public regulatory services.",
      domains: ["clinicaltrials.gov", "fda.gov", "who.int", "ema.europa.eu"],
    },
  ]

  const groupIDs = new Set(CATALOG.map((group) => group.id))

  /** Parse one custom allow-list entry. Custom entries are deliberately bare
   * DNS hostnames: no URL syntax, wildcard, port, IP literal, or local name. */
  export function canonicalDomain(input: string): string {
    if (!input || input !== input.trim() || /\s/.test(input)) throw new Error("Domain must not contain whitespace")
    if (input.includes("://") || /[\/?#@:*]/.test(input)) {
      throw new Error("Enter a bare hostname without a scheme, path, wildcard, credentials, or port")
    }
    const withoutDot = input.endsWith(".") ? input.slice(0, -1) : input
    if (!withoutDot || withoutDot.endsWith(".")) throw new Error("Invalid hostname")
    const host = domainToASCII(withoutDot).toLowerCase()
    if (!host || host.length > 253 || isIP(host)) throw new Error("IP addresses are not allowed")
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
      throw new Error("Local and loopback hostnames are not allowed")
    }
    if (!host.includes(".")) throw new Error("Enter a fully qualified hostname")
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
    if (host.split(".").some((part) => !label.test(part))) throw new Error("Invalid hostname")
    return host
  }

  export const Domain = z
    .string()
    .superRefine((value, ctx) => {
      try {
        canonicalDomain(value)
      } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid hostname" })
      }
    })
    .transform(canonicalDomain)

  export const State = z
    .object({
      // Kept as an explicit escape hatch for trusted machine-level use. New
      // installs enforce the curated allow-list by default.
      allowlistEnabled: z.boolean(),
      enabled: z.array(z.string().refine((id) => groupIDs.has(id), "Unknown network group")),
      custom: z.array(Domain),
    })
    .strict()
    .transform((state) => ({
      ...state,
      enabled: [...new Set(state.enabled)],
      custom: [...new Set(state.custom)],
    }))
  export type State = z.output<typeof State>

  const file = path.join(Global.Path.data, "settings", "network.json")
  const lock = "settings:network"

  export function defaults(): State {
    return {
      allowlistEnabled: true,
      enabled: CATALOG.map((group) => group.id),
      custom: [],
    }
  }

  function domains(state: State): string[] {
    const result = new Set<string>(state.custom)
    for (const group of CATALOG) {
      if (!state.enabled.includes(group.id)) continue
      for (const domain of group.domains) result.add(canonicalDomain(domain))
    }
    return [...result].sort()
  }

  export function domainAllowed(hostname: string, allowlist: string[]): boolean {
    let host: string
    try {
      host = canonicalDomain(hostname)
    } catch {
      return false
    }
    return allowlist.some((value) => {
      try {
        const domain = canonicalDomain(value)
        return host === domain || host.endsWith(`.${domain}`)
      } catch {
        return false
      }
    })
  }

  export async function get(): Promise<State> {
    const text = await Bun.file(file)
      .text()
      .catch(() => undefined)
    if (!text) return defaults()
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      // v1 shipped with enforcement off and only the package group selected.
      // That exact unversioned seed was a product default, not an informed
      // grant; migrate it to the fail-closed curated v2 default. Explicit v2
      // disable choices remain respected.
      if (
        raw.version === undefined &&
        raw.allowlistEnabled === false &&
        Array.isArray(raw.enabled) &&
        raw.enabled.length === 1 &&
        raw.enabled[0] === "package-management" &&
        Array.isArray(raw.custom) &&
        raw.custom.length === 0
      ) {
        const migrated = defaults()
        await persist(migrated)
        return migrated
      }
      const candidate = raw.version === 2 ? { ...raw, version: undefined } : raw
      delete candidate.version
      const parsed = State.safeParse(candidate)
      if (parsed.success) return parsed.data
      log.error("invalid network state; using enforced curated defaults", { issues: parsed.error.issues })
    } catch (error) {
      log.error("failed to parse network state; using enforced curated defaults", { error })
    }
    return defaults()
  }

  async function persist(state: State): Promise<State> {
    await using operation = await DataRootBarrier.enter(file)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify({ version: 2, ...state }, null, 2))
    return state
  }

  export async function set(input: State): Promise<State> {
    const state = State.parse(input)
    using _ = await Lock.write(lock)
    return persist(state)
  }

  // Effective flat list of allowed domains (enabled groups union custom).
  export async function allowlist(): Promise<string[]> {
    return domains(await get())
  }

  function url(raw: string): URL {
    let result: URL
    try {
      result = new URL(raw)
    } catch {
      throw new Error(`Invalid network URL: ${raw}`)
    }
    if (result.protocol !== "http:" && result.protocol !== "https:") {
      throw new Error(`Network URL must use http or https: ${raw}`)
    }
    if (result.username || result.password) throw new Error("Network URLs must not contain credentials")
    // canonicalDomain also rejects literal IPs and local/loopback names. This
    // remains mandatory even when the user disables the general allow-list.
    canonicalDomain(result.hostname)
    return result
  }

  export async function assertAllowed(raw: string): Promise<void> {
    const state = await get()
    const target = url(raw)
    if (!state.allowlistEnabled) return
    if (domainAllowed(target.hostname, domains(state))) return
    throw new Error(`Network access to ${target.hostname} is not in the configured allow-list`)
  }

  /** The hostname the allow-list would block for this URL, or undefined when
   * the URL is allowed (or enforcement is off). Invalid/local URLs always
   * throw so they cannot be smuggled through a disabled allow-list. */
  export async function blocked(raw: string): Promise<string | undefined> {
    const state = await get()
    const target = url(raw)
    const host = canonicalDomain(target.hostname)
    if (!state.allowlistEnabled) return undefined
    if (domainAllowed(host, domains(state))) return undefined
    return host
  }

  /** Add one domain to the persisted custom allow-list. The read-modify-write
   * is serialized with Settings PUTs so concurrent approvals cannot clobber
   * one another inside the backend process. */
  export async function allow(domain: string): Promise<State> {
    const host = canonicalDomain(domain)
    using _ = await Lock.write(lock)
    const state = await get()
    if (domains(state).includes(host)) return state
    return persist(State.parse({ ...state, custom: [...state.custom, host] }))
  }

  export interface FetchPolicy {
    /** Called for a blocked host. Resolving authorizes this request only; an
     * "always" permission reply separately persists through Network.allow(). */
    authorize?: (input: { host: string; url: string }) => Promise<void>
    maxRedirects?: number
    /** Dependency seam for deterministic tests. Production callers omit it
     * and use the operating system resolver. */
    resolveAddresses?: (hostname: string) => Promise<readonly string[]>
    /** Test transport seam. Production omits this and uses the pinned socket
     * transport below. */
    transport?: (target: URL, init: RequestInit, address: string) => Promise<Response>
  }

  const nonPublic = new BlockList()
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    nonPublic.addSubnet(network, prefix, "ipv4")
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32],
  ] as const) {
    nonPublic.addSubnet(network, prefix, "ipv6")
  }

  type Resolver = (hostname: string) => Promise<readonly string[]>

  async function systemResolve(hostname: string): Promise<readonly string[]> {
    return (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address)
  }

  export function addressPublic(address: string) {
    const family = isIP(address)
    if (!family) return false
    return !nonPublic.check(address, family === 4 ? "ipv4" : "ipv6")
  }

  async function assertPublicResolution(target: URL, resolveAddresses: Resolver = systemResolve) {
    let addresses: readonly string[]
    try {
      addresses = await resolveAddresses(target.hostname)
    } catch (error) {
      throw new Error(`Could not safely resolve ${target.hostname}: ${error}`)
    }
    if (!addresses.length) throw new Error(`Could not safely resolve ${target.hostname}: no addresses returned`)
    const blocked = addresses.find((address) => !addressPublic(address))
    if (blocked) throw new Error(`Network access to non-public address ${blocked} for ${target.hostname} is blocked`)
    return addresses
  }

  function redirected(status: number) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
  }

  function withoutSensitiveHeaders(headers: Headers) {
    for (const name of ["authorization", "cookie", "proxy-authorization", "referer"]) headers.delete(name)
  }

  const originalFetch = globalThis.fetch

  async function pinnedFetch(target: URL, init: RequestInit, address: string): Promise<Response> {
    const request = new Request(target, init)
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    const headers = Object.fromEntries(request.headers.entries())
    headers.host = target.host
    if (body && !request.headers.has("content-length")) headers["content-length"] = String(body.byteLength)
    const family = isIP(address)
    if (!family) throw new Error(`Resolver returned an invalid address for ${target.hostname}: ${address}`)

    return new Promise<Response>((resolve, reject) => {
      const send = target.protocol === "https:" ? httpsRequest : httpRequest
      const req = send(
        target,
        {
          method: request.method,
          headers,
          // Keep the original hostname for certificate verification/SNI while
          // returning only the validated address to the socket layer.
          servername: target.hostname,
          lookup: ((_hostname: string, options: { all?: boolean } | number, callback: (...args: unknown[]) => void) => {
            if (typeof options === "object" && options.all) {
              callback(null, [{ address, family }])
              return
            }
            callback(null, address, family)
          }) as never,
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
          incoming.once("error", reject)
          incoming.once("end", () => {
            const responseHeaders = new Headers()
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (value === undefined) continue
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
              else responseHeaders.set(name, String(value))
            }
            const status = incoming.statusCode ?? 500
            const empty = status === 101 || status === 204 || status === 205 || status === 304
            resolve(
              new Response(empty ? null : Buffer.concat(chunks), {
                status,
                statusText: incoming.statusMessage,
                headers: responseHeaders,
              }),
            )
          })
        },
      )
      req.once("error", reject)
      const abort = () => req.destroy(request.signal.reason instanceof Error ? request.signal.reason : undefined)
      if (request.signal.aborted) abort()
      else request.signal.addEventListener("abort", abort, { once: true })
      if (body) req.end(body)
      else req.end()
    })
  }

  /** Policy-aware fetch. Every redirect target is re-authorized before the
   * socket is opened; cross-origin redirects cannot carry credentials. */
  export async function fetch(raw: string, init: RequestInit = {}, policy: FetchPolicy = {}): Promise<Response> {
    let target = url(raw)
    let method = (init.method ?? "GET").toUpperCase()
    let body = init.body
    const headers = new Headers(init.headers)
    const maxRedirects = policy.maxRedirects ?? 5

    for (let redirects = 0; ; redirects++) {
      const host = await blocked(target.href)
      if (host) {
        if (!policy.authorize) {
          throw new Error(`Network access to ${host} is not in the configured allow-list`)
        }
        await policy.authorize({ host, url: target.href })
      }
      const addresses = await assertPublicResolution(target, policy.resolveAddresses)
      const requestInit: RequestInit = {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
      }
      // Unit suites replace global fetch with deterministic in-memory
      // transports. Production keeps the original function and therefore
      // always takes the address-pinned socket path.
      const transport =
        policy.transport ??
        (globalThis.fetch !== originalFetch
          ? (url: URL, options: RequestInit) => globalThis.fetch(url, options)
          : pinnedFetch)
      const response = await transport(target, requestInit, addresses[0]!)
      const location = response.headers.get("location")
      if (!redirected(response.status) || !location) return response
      if (redirects >= maxRedirects) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Too many redirects (maximum ${maxRedirects})`)
      }

      const next = url(new URL(location, target).href)
      if (next.origin !== target.origin) withoutSensitiveHeaders(headers)
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET"
        body = undefined
        headers.delete("content-length")
        headers.delete("content-type")
      }
      await response.body?.cancel().catch(() => {})
      target = next
    }
  }
}
