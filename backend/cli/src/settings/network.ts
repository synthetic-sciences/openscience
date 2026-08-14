import path from "path"
import fs from "fs/promises"
import { BlockList, isIP } from "net"
import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import { domainToASCII } from "url"
import z from "zod"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { FileLease } from "@/util/file-lease"

// Outbound domain allow-list. A catalog of curated science/package domain
// sets (each toggleable as a group) plus a validated list of custom domains.
// The store is an enforcement input, not a presentation preference: missing
// state gets install defaults, while malformed persisted state denies all.
export namespace Network {
  const log = Log.create({ service: "settings.network" })
  const fetchedURL = new WeakMap<Response, string>()

  /** Final authorized URL after redirects. Response.url is empty for the
   * address-pinned transport, so callers use this for auditable metadata. */
  export function finalURL(response: Response) {
    return fetchedURL.get(response) ?? response.url
  }

  /** Raised before an HTTP response can be buffered past a caller-declared
   * limit. Callers such as Web fetch use the response metadata to explain
   * whether the model should paginate an API or download a file instead. */
  export class ResponseTooLargeError extends Error {
    readonly limitBytes: number
    readonly declaredBytes?: number
    readonly receivedBytes?: number
    readonly contentType?: string
    readonly contentDisposition?: string

    constructor(input: {
      limitBytes: number
      declaredBytes?: number
      receivedBytes?: number
      contentType?: string
      contentDisposition?: string
    }) {
      const observed = input.declaredBytes ?? input.receivedBytes
      super(`Response too large (${observed ?? "unknown"} bytes exceeds ${input.limitBytes} byte limit)`)
      this.name = "ResponseTooLargeError"
      this.limitBytes = input.limitBytes
      this.declaredBytes = input.declaredBytes
      this.receivedBytes = input.receivedBytes
      this.contentType = input.contentType
      this.contentDisposition = input.contentDisposition
    }
  }

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
  // Keep the cross-process lease outside the relocatable data root. Holding an
  // in-root FileLease operation and then entering the barrier again to publish
  // can deadlock with a relocation intent that lands between those two steps.
  const mutationLease = path.join(Global.Path.config, "network-settings.lock")
  const version = 2
  const legacyClinicalGroup = "clinical-pharma"
  const legacyClinicalCustom = "go.drugbank.com"

  const UnversionedState = z
    .object({
      allowlistEnabled: z.boolean(),
      enabled: z.array(z.string()),
      custom: z.array(Domain),
    })
    .strict()

  type StoredState =
    | { kind: "current"; state: State }
    | { kind: "migrate"; state: State }
    | { kind: "invalid"; reason: unknown }

  type StoredFile = { kind: "missing" } | { kind: "found"; text: string } | { kind: "unreadable"; error: unknown }

  export function defaults(): State {
    return {
      allowlistEnabled: true,
      enabled: CATALOG.map((group) => group.id),
      custom: [],
    }
  }

  function denied(): State {
    return {
      allowlistEnabled: true,
      enabled: [],
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

  async function readStoredFile(): Promise<StoredFile> {
    try {
      return { kind: "found", text: await fs.readFile(file, "utf8") }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
      return { kind: "unreadable", error }
    }
  }

  function decodeStoredState(text: string): StoredState {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return { kind: "invalid", reason: error }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { kind: "invalid", reason: "Network state must be an object" }
    }

    const record = raw as Record<string, unknown>
    if (record.version === version) {
      const { version: _, ...candidate } = record
      const parsed = State.safeParse(candidate)
      return parsed.success ? { kind: "current", state: parsed.data } : { kind: "invalid", reason: parsed.error.issues }
    }
    if (record.version !== undefined) {
      return { kind: "invalid", reason: `Unsupported network state version: ${String(record.version)}` }
    }

    // The original unversioned install seed was a product default rather than
    // an informed grant. Preserve its existing v2 migration to curated defaults.
    if (
      record.allowlistEnabled === false &&
      Array.isArray(record.enabled) &&
      record.enabled.length === 1 &&
      record.enabled[0] === "package-management" &&
      Array.isArray(record.custom) &&
      record.custom.length === 0
    ) {
      return { kind: "migrate", state: defaults() }
    }

    const legacy = UnversionedState.safeParse(record)
    if (!legacy.success) return { kind: "invalid", reason: legacy.error.issues }
    const unknown = legacy.data.enabled.filter((id) => id !== legacyClinicalGroup && !groupIDs.has(id))
    if (unknown.length) return { kind: "invalid", reason: `Unknown network groups: ${unknown.join(", ")}` }

    const hadLegacyClinical = legacy.data.enabled.includes(legacyClinicalGroup)
    const migrated = State.safeParse({
      allowlistEnabled: legacy.data.allowlistEnabled,
      enabled: legacy.data.enabled.map((id) => (id === legacyClinicalGroup ? "clinical-regulatory" : id)),
      // The new clinical-regulatory group preserves every legacy clinical
      // domain except DrugBank. Add only that hostname instead of enabling the
      // much broader chemistry-pharma group.
      custom: hadLegacyClinical ? [...legacy.data.custom, legacyClinicalCustom] : legacy.data.custom,
    })
    return migrated.success
      ? { kind: "migrate", state: migrated.data }
      : { kind: "invalid", reason: migrated.error.issues }
  }

  function invalidState(reason: unknown): State {
    log.error("invalid persisted network state; denying all outbound domains", { reason })
    return denied()
  }

  type EffectiveState = { kind: "resolved"; state: State } | { kind: "migrate"; state: State }

  async function effectiveState(): Promise<EffectiveState> {
    const stored = await readStoredFile()
    if (stored.kind === "missing") return { kind: "resolved", state: defaults() }
    if (stored.kind === "unreadable") return { kind: "resolved", state: invalidState(stored.error) }
    const decoded = decodeStoredState(stored.text)
    if (decoded.kind === "current") return { kind: "resolved", state: decoded.state }
    if (decoded.kind === "invalid") return { kind: "resolved", state: invalidState(decoded.reason) }
    return decoded
  }

  async function mutation<T>(action: () => Promise<T>): Promise<T> {
    return DataRootBarrier.during(file, async () => {
      using _ = await Lock.write(lock)
      await using lease = await FileLease.acquire(mutationLease)
      return await lease.during(action)
    })
  }

  async function effectiveStateUnderMutation(): Promise<State> {
    const current = await effectiveState()
    return current.kind === "migrate" ? persist(current.state) : current.state
  }

  export async function get(): Promise<State> {
    const current = await effectiveState()
    if (current.kind === "resolved") return current.state
    // Re-read after both the process-local lock and stable cross-process lease.
    // A set/allow from another process may have replaced the legacy state while
    // this caller waited and must never be overwritten by a stale migration.
    return mutation(effectiveStateUnderMutation)
  }

  async function persist(state: State): Promise<State> {
    await using operation = await DataRootBarrier.enter(file)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, "wx", 0o600)
      await handle
        .writeFile(JSON.stringify({ version, ...state }, null, 2), "utf8")
        .then(() => handle.sync())
        .finally(() => handle.close())
      await fs.rename(temporary, file)
      // The file sync makes its contents durable; syncing the parent also
      // makes the rename durable where the platform supports directory fsync.
      const directory = await fs.open(path.dirname(file), "r").catch(() => undefined)
      await directory?.sync().catch(() => undefined)
      await directory?.close().catch(() => undefined)
      return state
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  export async function set(input: State): Promise<State> {
    const state = State.parse(input)
    return mutation(() => persist(state))
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
    return mutation(async () => {
      const state = await effectiveStateUnderMutation()
      if (domains(state).includes(host)) return state
      return persist(State.parse({ ...state, custom: [...state.custom, host] }))
    })
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
    /** Stop reading the response once this many bytes have been received.
     * The production pinned transport enforces the limit while streaming so a
     * large attachment is never buffered in full. */
    maxResponseBytes?: number
    /** Return a streaming body after headers arrive. Used by brokered file
     * downloads so large responses never occupy process memory. Redirects are
     * still handled and re-authorized by this function before it returns. */
    streamResponse?: boolean
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

  async function pinnedFetch(
    target: URL,
    init: RequestInit,
    address: string,
    maxResponseBytes?: number,
    streamResponse = false,
  ): Promise<Response> {
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
          const contentType = Array.isArray(incoming.headers["content-type"])
            ? incoming.headers["content-type"][0]
            : incoming.headers["content-type"]
          const contentDisposition = Array.isArray(incoming.headers["content-disposition"])
            ? incoming.headers["content-disposition"][0]
            : incoming.headers["content-disposition"]
          const declared = Number.parseInt(String(incoming.headers["content-length"] ?? ""), 10)
          if (maxResponseBytes !== undefined && Number.isFinite(declared) && declared > maxResponseBytes) {
            const error = new ResponseTooLargeError({
              limitBytes: maxResponseBytes,
              declaredBytes: declared,
              contentType,
              contentDisposition,
            })
            incoming.destroy()
            req.destroy()
            reject(error)
            return
          }

          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value === undefined) continue
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
            else responseHeaders.set(name, String(value))
          }
          const status = incoming.statusCode ?? 500
          const empty = status === 101 || status === 204 || status === 205 || status === 304
          if (streamResponse) {
            resolve(
              new Response(empty ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>), {
                status,
                statusText: incoming.statusMessage,
                headers: responseHeaders,
              }),
            )
            return
          }

          const chunks: Buffer[] = []
          let received = 0
          let rejected = false
          incoming.on("data", (chunk) => {
            if (rejected) return
            const buffer = Buffer.from(chunk)
            received += buffer.byteLength
            if (maxResponseBytes !== undefined && received > maxResponseBytes) {
              rejected = true
              const error = new ResponseTooLargeError({
                limitBytes: maxResponseBytes,
                receivedBytes: received,
                contentType,
                contentDisposition,
              })
              incoming.destroy()
              req.destroy()
              reject(error)
              return
            }
            chunks.push(buffer)
          })
          incoming.once("error", reject)
          incoming.once("end", () => {
            if (rejected) return
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
          : (url: URL, options: RequestInit, address: string) =>
              pinnedFetch(url, options, address, policy.maxResponseBytes, policy.streamResponse))
      const response = await transport(target, requestInit, addresses[0]!)
      if (policy.maxResponseBytes !== undefined) {
        const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10)
        if (Number.isFinite(declared) && declared > policy.maxResponseBytes) {
          await response.body?.cancel().catch(() => {})
          throw new ResponseTooLargeError({
            limitBytes: policy.maxResponseBytes,
            declaredBytes: declared,
            contentType: response.headers.get("content-type") ?? undefined,
            contentDisposition: response.headers.get("content-disposition") ?? undefined,
          })
        }
      }
      const location = response.headers.get("location")
      if (!redirected(response.status) || !location) {
        fetchedURL.set(response, target.href)
        return response
      }
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
