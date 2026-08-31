import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { OpenScience } from "@/openscience"
import { resolveCredentialFields } from "@/server/routes/settings/credentials"
import { SessionFilesystem } from "@/session/filesystem"
import {
  BioNemoHostedDispatch,
  BioNemoHostedPending,
  BioNemoHostedPreview,
  BioNemoHostedResult,
  type BioNemoDispatchRecord,
} from "./dispatch"
import { BioNemoCapabilityID, parseBioNemoInput, parseBioNemoOutput, type BioNemoCapabilityID as ID } from "./schema"
import { retryAfterMilliseconds } from "./polling"
import { decodeBioNemoResult, downloadBioNemoResult, readBioNemoBody } from "./download"

const TERMS = "https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA_API_Trial_Service_Terms.pdf"
// Current NVCF async result contract:
// https://docs.api.nvidia.com/cloud-functions/reference/getfunctioninvocationresult
const STATUS_ENDPOINT_TEMPLATE = "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}"
const STATUS_HOST = "api.nvcf.nvidia.com"
const REDIRECT = new Set([301, 302, 303, 307, 308])
const PENDING = new Set(["accepted", "pending", "queued", "running", "in-progress", "in_progress", "processing"])
const SUCCESS = new Set(["fulfilled", "completed", "complete", "succeeded", "success", "done"])
const FAILURE = new Set([
  "failed",
  "failure",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "rejected",
  "timed-out",
  "timed_out",
  "timeout",
])
const POLL_ATTEMPTS_PER_START = 3
const specs = {
  boltz2: {
    endpoint: "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict",
    apiSchemaVersion: "api-schema-1.5.0",
    docs: "https://docs.api.nvidia.com/nim/reference/mit-boltz2-infer",
  },
  diffdock: {
    endpoint: "https://health.api.nvidia.com/v1/molecular-docking/diffdock/generate",
    apiSchemaVersion: "api-schema-2.3.0",
    docs: "https://docs.api.nvidia.com/nim/reference/mit-diffdock-infer",
  },
  evo2: {
    endpoint: "https://health.api.nvidia.com/v1/biology/arc/evo2-40b/generate",
    apiSchemaVersion: "api-schema-1.0.0",
    docs: "https://docs.api.nvidia.com/nim/reference/arc-evo2-40b-infer",
  },
  genmol: {
    endpoint: "https://health.api.nvidia.com/v1/biology/nvidia/genmol/generate",
    apiSchemaVersion: "api-schema-1.0.0",
    docs: "https://docs.api.nvidia.com/nim/reference/nvidia-genmol-infer",
  },
  molmim: {
    endpoint: "https://health.api.nvidia.com/v1/biology/nvidia/molmim/generate",
    apiSchemaVersion: "api-schema-0.0.1",
    docs: "https://docs.api.nvidia.com/nim/reference/nvidia-molmim-infer",
  },
  "msa-search": {
    endpoint: "https://health.api.nvidia.com/v1/biology/colabfold/msa-search/predict",
    apiSchemaVersion: "api-schema-1.2.0",
    docs: "https://docs.api.nvidia.com/nim/reference/colabfold-msa-search-infer",
  },
  openfold2: {
    endpoint: "https://health.api.nvidia.com/v1/biology/openfold/openfold2/predict-structure-from-msa-and-template",
    apiSchemaVersion: "api-schema-2.1.0",
    docs: "https://docs.api.nvidia.com/nim/reference/openfold-openfold2-infer",
  },
  openfold3: {
    endpoint: "https://health.api.nvidia.com/v1/biology/openfold/openfold3/predict",
    apiSchemaVersion: "api-schema-1.0.0",
    docs: "https://docs.api.nvidia.com/nim/reference/openfold-openfold3-infer",
  },
  proteinmpnn: {
    endpoint: "https://health.api.nvidia.com/v1/biology/ipd/proteinmpnn/predict",
    apiSchemaVersion: "api-schema-1.1.0",
    docs: "https://docs.api.nvidia.com/nim/reference/ipd-proteinmpnn-infer",
  },
  rfdiffusion: {
    endpoint: "https://health.api.nvidia.com/v1/biology/ipd/rfdiffusion/generate",
    apiSchemaVersion: "api-schema-2.3.0",
    docs: "https://docs.api.nvidia.com/nim/reference/ipd-rfdiffusion-infer",
  },
} as const

function cleanString(value: string, secret: string) {
  return OpenScience.redactSecrets(value.replaceAll(secret, "[REDACTED]"))
}

function scrubExact(value: unknown, secret: string): unknown {
  const state = { nodes: 0 }
  const visit = (item: unknown, depth: number): unknown => {
    state.nodes++
    if (depth > 128 || state.nodes > 100_000) return "[REDACTED: response subtree exceeded scrub limit]"
    if (typeof item === "string") return cleanString(item, secret)
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
    if (!item || typeof item !== "object") return item
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, entry]) => [
        cleanString(key, secret),
        visit(entry, depth + 1),
      ]),
    )
  }
  return OpenScience.redactSensitive(visit(value, 0))
}

function artifacts(value: unknown) {
  const output: Array<{ extension: string; content: string }> = []
  const queue: Array<{ item: unknown; depth: number }> = [{ item: value, depth: 0 }]
  let visited = 0
  while (queue.length && output.length < 16 && visited < 100_000) {
    const { item, depth } = queue.shift()!
    visited++
    if (depth > 128) continue
    if (typeof item === "string" && item.length <= 10 * 1024 * 1024) {
      const normalized = item.trimStart()
      if (/^(ATOM  |HETATM|HEADER)/m.test(normalized)) output.push({ extension: "pdb", content: item })
      else if (/^data_/m.test(normalized) || normalized.includes("_atom_site."))
        output.push({ extension: "cif", content: item })
      else if (normalized.includes("$$$$")) output.push({ extension: "sdf", content: item })
      else if (normalized.startsWith(">")) output.push({ extension: "fasta", content: item })
      else if (normalized.startsWith("# STOCKHOLM")) output.push({ extension: "sto", content: item })
      continue
    }
    if (Array.isArray(item)) {
      for (const entry of item) queue.push({ item: entry, depth: depth + 1 })
      continue
    }
    if (item && typeof item === "object")
      for (const entry of Object.values(item)) queue.push({ item: entry, depth: depth + 1 })
  }
  return output
}

function normalizeStatus(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized || undefined
}

function sanitizeProviderRequestID(value: string | undefined, secret: string) {
  if (!value) return undefined
  const redacted = cleanString(value, secret).trim()
  return /^[A-Za-z0-9._:-]{1,200}$/.test(redacted) ? redacted : undefined
}

function requestIDFromBody(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  for (const key of ["requestId", "request_id", "nvcf_request_id", "id"]) {
    const candidate = (value as Record<string, unknown>)[key]
    if (typeof candidate === "string") return candidate
  }
  return undefined
}

function statusFromBody(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  for (const key of ["status", "state", "nvcf_status"]) {
    const candidate = (value as Record<string, unknown>)[key]
    if (typeof candidate === "string") return normalizeStatus(candidate)
  }
  return undefined
}

function acceptanceEnvelope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (!keys.length) return false
  const allowed = new Set([
    "requestId",
    "request_id",
    "nvcf_request_id",
    "id",
    "status",
    "state",
    "nvcf_status",
    "message",
  ])
  return keys.every((key) => allowed.has(key))
}

function providerHandledFailure(id: ID, value: unknown) {
  if (id !== "openfold2" || !value || typeof value !== "object" || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>).of2_nim_handled_error_message
  if (typeof candidate !== "string") return undefined
  const message = candidate.trim()
  if (!message || message === "no-handled-error") return undefined
  return `NVIDIA openfold2 reported a handled terminal error: ${message.slice(0, 2_000)}`
}

function summarizeEgress(id: ID, payload: Record<string, unknown>) {
  const kinds = new Set<string>(
    {
      boltz2: ["biomolecular complex"],
      diffdock: ["protein structure", "ligand representation"],
      evo2: ["DNA sequence"],
      genmol: ["molecule representation"],
      molmim: ["molecule representation"],
      "msa-search": ["protein sequence"],
      openfold2: ["protein sequence"],
      openfold3: ["biomolecular complex"],
      proteinmpnn: ["protein structure"],
      rfdiffusion: ["protein design input"],
    }[id],
  )
  const values = {
    sequences: [] as string[],
    structures: [] as string[],
    alignments: [] as string[],
    ligands: [] as string[],
    asset_references: [] as string[],
    instructions: [] as string[],
  }
  const scalarParameters: Array<{ name: string; value: string | number | boolean }> = []
  const structureFields = new Set(["protein", "input_pdb", "structure", "templates"])
  const alignmentFields = new Set(["alignment", "query", "hit_sequence"])
  const ligandFields = new Set(["ligand", "smiles", "smi", "ccd_codes"])
  const instructionFields = new Set([
    "contigs",
    "hotspot_res",
    "pssm_jsonl",
    "fixed_positions_jsonl",
    "omit_AA_jsonl",
    "bias_AA_jsonl",
    "bias_by_res_jsonl",
    "tied_positions_jsonl",
  ])
  const safeEnumFields = new Set([
    "algorithm",
    "ligand_file_type",
    "molecule_type",
    "output_format",
    "property_name",
    "scoring",
    "search_type",
    "type",
  ])
  const addScalar = (path: string[], value: string | number | boolean) => {
    if (scalarParameters.length >= 24) return
    const name = path
      .filter((part) => !/^\d+$/u.test(part))
      .slice(-2)
      .join(".")
      .slice(0, 128)
    if (!name) return
    scalarParameters.push({ name, value })
  }
  const walk = (value: unknown, path: string[]) => {
    const field = [...path].reverse().find((part) => !/^\d+$/u.test(part)) ?? ""
    if (typeof value === "string") {
      if (field === "sequence") {
        values.sequences.push(value)
        kinds.add("biological sequence")
      } else if (field.endsWith("_asset")) {
        values.asset_references.push(value)
        kinds.add("provider asset reference")
      } else if (alignmentFields.has(field)) {
        values.alignments.push(value)
        kinds.add("MSA or alignment")
      } else if (structureFields.has(field)) {
        values.structures.push(value)
        kinds.add("structure or template text")
      } else if (ligandFields.has(field) || (field === "ccd" && path.includes("ligands"))) {
        values.ligands.push(value)
        kinds.add("ligand representation")
      } else if (instructionFields.has(field) || (field === "ccd" && path.includes("modifications"))) {
        values.instructions.push(value)
        kinds.add("design constraint")
      } else if (safeEnumFields.has(field)) addScalar(path, value)
      return
    }
    if (typeof value === "number" || typeof value === "boolean") {
      addScalar(path, value)
      return
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, [...path, String(index)])
      return
    }
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, [...path, key])
  }
  walk(payload, [])

  const bucket = (entries: string[]) => {
    if (!entries.length) return undefined
    const digest = crypto.createHash("sha256")
    let totalBytes = 0
    for (const entry of entries) {
      const bytes = Buffer.byteLength(entry)
      totalBytes += bytes
      digest.update(`${bytes}:`).update(entry)
    }
    return { count: entries.length, total_bytes: totalBytes, sha256: digest.digest("hex") }
  }
  const sequences = bucket(values.sequences)
  return {
    input_kinds: [...kinds].sort(),
    sequences: sequences ? { ...sequences, lengths: values.sequences.map((sequence) => sequence.length) } : undefined,
    structures: bucket(values.structures),
    alignments: bucket(values.alignments),
    ligands: bucket(values.ligands),
    asset_references: bucket(values.asset_references),
    instructions: bucket(values.instructions),
    scalar_parameters: scalarParameters,
  }
}

function prepare(id: ID, raw: unknown) {
  const selected = specs[BioNemoCapabilityID.parse(id)]
  const payload = parseBioNemoInput(id, raw)
  const bodyText = JSON.stringify(payload)
  const request_sha256 = crypto.createHash("sha256").update(bodyText).digest("hex")
  const payload_bytes = Buffer.byteLength(bodyText)
  const egress_summary = summarizeEgress(id, payload)
  const approvalFields = {
    provider: "nvidia",
    endpoint: selected.endpoint,
    status_endpoint_template: STATUS_ENDPOINT_TEMPLATE,
    status_host: STATUS_HOST,
    request_sha256,
    terms_url: TERMS,
    payload_bytes,
    egress_summary,
  }
  const approval_sha256 = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        ...approvalFields,
        api_schema_version: selected.apiSchemaVersion,
      }),
    )
    .digest("hex")
  const legacyApprovalSha256 = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        provider: approvalFields.provider,
        endpoint: approvalFields.endpoint,
        status_endpoint_template: approvalFields.status_endpoint_template,
        status_host: approvalFields.status_host,
        model_version: selected.apiSchemaVersion,
        request_sha256: approvalFields.request_sha256,
        terms_url: approvalFields.terms_url,
        payload_bytes: approvalFields.payload_bytes,
      }),
    )
    .digest("hex")
  return {
    selected,
    bodyText,
    legacyApprovalSha256,
    preview: BioNemoHostedPreview.parse({
      capability: id,
      provider: "nvidia",
      configured: false,
      method: "POST",
      endpoint: selected.endpoint,
      status_endpoint_template: STATUS_ENDPOINT_TEMPLATE,
      status_host: STATUS_HOST,
      api_schema_version: selected.apiSchemaVersion,
      request_sha256,
      approval_sha256,
      payload_bytes,
      egress_summary,
      payload,
      terms_url: TERMS,
      warning:
        "NVIDIA trial-service terms apply. This exact request may incur NVIDIA charges. Do not submit regulated or restricted data unless your NVIDIA agreement permits it.",
      dispatched: false,
    }),
  }
}

type Captured = {
  parsed?: unknown
  safeText: string
  lifecycle?: string
  providerRequestID?: string
  captureError?: string
}

async function capture(response: Response, secret: string): Promise<Captured> {
  const fromHeader = sanitizeProviderRequestID(BioNemoHostedDispatch.providerRequestID(response.headers), secret)
  let text: string
  try {
    if (response.status === 302) {
      await response.body?.cancel().catch(() => {})
      text = await downloadBioNemoResult(response.headers.get("location"))
    } else {
      text = await decodeBioNemoResult(await readBioNemoBody(response))
    }
  } catch (error) {
    return {
      safeText: "",
      providerRequestID: fromHeader,
      lifecycle: normalizeStatus(response.headers.get("nvcf-status")),
      captureError: cleanString(error instanceof Error ? error.message : String(error), secret),
    }
  }
  const safeText = cleanString(text, secret)
  let parsed: unknown
  if (text.trim()) {
    try {
      parsed = scrubExact(JSON.parse(text), secret)
    } catch {
      return {
        safeText,
        providerRequestID: fromHeader,
        lifecycle: normalizeStatus(response.headers.get("nvcf-status")),
        captureError: "NVIDIA returned a non-JSON response",
      }
    }
  }
  const providerRequestID = fromHeader ?? sanitizeProviderRequestID(requestIDFromBody(parsed), secret)
  return {
    parsed,
    safeText,
    providerRequestID,
    lifecycle: normalizeStatus(response.headers.get("nvcf-status")) ?? statusFromBody(parsed),
  }
}

function statusEndpoint(providerRequestID: string) {
  return STATUS_ENDPOINT_TEMPLATE.replace("{requestId}", encodeURIComponent(providerRequestID))
}

function pendingResult(preview: BioNemoHostedPreview, record: BioNemoDispatchRecord) {
  if (!record.provider_request_id) throw new Error(`Dispatch ${record.dispatch_id} has no safe NVIDIA status identity`)
  return BioNemoHostedPending.parse({
    dispatch_id: record.dispatch_id,
    capability: preview.capability,
    provider: "nvidia",
    endpoint: preview.endpoint,
    status_endpoint: statusEndpoint(record.provider_request_id),
    api_schema_version: preview.api_schema_version,
    request_sha256: preview.request_sha256,
    approval_sha256: preview.approval_sha256,
    state: record.status === "pending" ? "pending" : "unknown",
    pollable: true,
    poll_attempts: record.poll_attempts ?? 0,
    provider_request_id: record.provider_request_id,
    next: `NVIDIA has not returned a terminal result. Retry start with the identical approved payload to reconcile dispatch ${record.dispatch_id}; OpenScience will poll status and will not send another POST.`,
  })
}

async function wait(milliseconds: number) {
  if (milliseconds <= 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function finalize(input: {
  id: ID
  sessionID: string
  preview: BioNemoHostedPreview
  parsed: Record<string, unknown>
  providerRequestID?: string
  startedAt: string
  httpStatus: number
  dispatchID: string
}) {
  const relative = path.join("scientific-capabilities", `${input.id}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`)
  const root = path.join(await SessionFilesystem.workspace(input.sessionID), relative)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const files = [path.join(root, "response.json")]
  await Bun.write(files[0], JSON.stringify(input.parsed, null, 2), { mode: 0o600 })
  for (const [index, item] of artifacts(input.parsed).entries()) {
    const target = path.join(root, `artifact-${index + 1}.${item.extension}`)
    await Bun.write(target, item.content, { mode: 0o600 })
    files.push(target)
  }
  const completed = BioNemoHostedResult.parse({
    dispatch_id: input.dispatchID,
    capability: input.id,
    provider: "nvidia",
    endpoint: input.preview.endpoint,
    api_schema_version: input.preview.api_schema_version,
    request_sha256: input.preview.request_sha256,
    approval_sha256: input.preview.approval_sha256,
    payload_bytes: input.preview.payload_bytes,
    started_at: input.startedAt,
    completed_at: new Date().toISOString(),
    root: relative.split(path.sep).join("/"),
    artifacts: await Promise.all(
      files.map(async (file) => ({
        path: path.relative(root, file).split(path.sep).join("/"),
        size: (await fs.stat(file)).size,
        sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex"),
        mime: file.endsWith(".json")
          ? "application/json"
          : file.endsWith(".pdb")
            ? "chemical/x-pdb"
            : file.endsWith(".cif")
              ? "chemical/x-mmcif"
              : file.endsWith(".sdf")
                ? "chemical/x-mdl-sdfile"
                : "text/plain",
      })),
    ),
    provider_request_id: input.providerRequestID,
  })
  await BioNemoHostedDispatch.succeed({
    preview: input.preview,
    sessionID: input.sessionID,
    result: completed,
    http_status: input.httpStatus,
    provider_request_id: input.providerRequestID,
  })
  return completed
}

async function setUnresolved(input: {
  preview: BioNemoHostedPreview
  sessionID: string
  dispatchID: string
  message: string
  httpStatus?: number
  providerRequestID?: string
  secret: string
}) {
  const message = cleanString(input.message, input.secret)
  if (input.providerRequestID) {
    const record = await BioNemoHostedDispatch.pending({
      preview: input.preview,
      sessionID: input.sessionID,
      status: "unknown",
      provider_request_id: input.providerRequestID,
      http_status: input.httpStatus,
      error: message,
    })
    return pendingResult(input.preview, record)
  }
  await BioNemoHostedDispatch.fail({
    preview: input.preview,
    sessionID: input.sessionID,
    status: "unknown",
    error: message,
    http_status: input.httpStatus,
  })
  throw new Error(
    `${message} Dispatch ${input.dispatchID} has no safe NVIDIA status identity and will not be resent automatically.`,
  )
}

async function reconcile(input: {
  id: ID
  sessionID: string
  preview: BioNemoHostedPreview
  record: BioNemoDispatchRecord
  secret: string
}) {
  const providerRequestID = input.record.provider_request_id
  if (!providerRequestID)
    throw new Error(
      `OpenScience previously recorded this exact hosted ${input.id} request but has no safe NVIDIA status identity. Dispatch ${input.record.dispatch_id} is ${input.record.status} and will not be resent automatically.`,
    )
  const endpoint = statusEndpoint(providerRequestID)
  let record = input.record
  let delay = 0
  for (let attempt = 0; attempt < POLL_ATTEMPTS_PER_START; attempt++) {
    await wait(delay)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${input.secret}` },
        redirect: "manual",
        signal: AbortSignal.timeout(2 * 60 * 1000),
      })
    } catch (error) {
      record = await BioNemoHostedDispatch.pending({
        preview: input.preview,
        sessionID: input.sessionID,
        status: "unknown",
        provider_request_id: providerRequestID,
        error: cleanString(error instanceof Error ? error.message : String(error), input.secret),
        polled: true,
      })
      return pendingResult(input.preview, record)
    }
    const captured = await capture(response, input.secret)
    if (response.redirected || (REDIRECT.has(response.status) && (response.status !== 302 || captured.captureError))) {
      record = await BioNemoHostedDispatch.pending({
        preview: input.preview,
        sessionID: input.sessionID,
        status: "unknown",
        provider_request_id: providerRequestID,
        http_status: response.status,
        error: captured.captureError ?? "Refused redirect from the NVIDIA NVCF status endpoint",
        polled: true,
      })
      return pendingResult(input.preview, record)
    }
    if (captured.lifecycle && FAILURE.has(captured.lifecycle)) {
      const message = cleanString(
        `NVIDIA ${input.id} reported terminal status ${captured.lifecycle}: ${captured.safeText.slice(0, 2_000)}`,
        input.secret,
      )
      await BioNemoHostedDispatch.fail({
        preview: input.preview,
        sessionID: input.sessionID,
        status: "failed",
        error: message,
        http_status: response.status,
        provider_request_id: providerRequestID,
      })
      throw new Error(message)
    }
    const handledFailure = providerHandledFailure(input.id, captured.parsed)
    if (handledFailure) {
      const message = cleanString(handledFailure, input.secret)
      await BioNemoHostedDispatch.fail({
        preview: input.preview,
        sessionID: input.sessionID,
        status: "failed",
        error: message,
        http_status: response.status,
        provider_request_id: providerRequestID,
      })
      throw new Error(message)
    }
    if ((response.status === 200 || response.status === 302) && !captured.captureError) {
      const parsed = BioNemoOutputsSafe.parse(input.id, captured.parsed)
      if (parsed && (!captured.lifecycle || SUCCESS.has(captured.lifecycle))) {
        try {
          return await finalize({
            id: input.id,
            sessionID: input.sessionID,
            preview: input.preview,
            parsed,
            providerRequestID,
            startedAt: input.record.created_at,
            httpStatus: response.status,
            dispatchID: input.record.dispatch_id,
          })
        } catch (error) {
          record = await BioNemoHostedDispatch.pending({
            preview: input.preview,
            sessionID: input.sessionID,
            status: "unknown",
            provider_request_id: providerRequestID,
            http_status: response.status,
            error: cleanString(error instanceof Error ? error.message : String(error), input.secret),
            polled: true,
          })
          return pendingResult(input.preview, record)
        }
      }
    }
    if (response.status === 401 || response.status === 403) {
      record = await BioNemoHostedDispatch.pending({
        preview: input.preview,
        sessionID: input.sessionID,
        status: "unknown",
        provider_request_id: providerRequestID,
        http_status: response.status,
        error: cleanString(
          `NVIDIA status authorization returned HTTP ${response.status}; refresh the NVIDIA credential and retry this exact dispatch`,
          input.secret,
        ),
        polled: true,
      })
      return pendingResult(input.preview, record)
    }
    const state =
      response.status === 202 || (captured.lifecycle && PENDING.has(captured.lifecycle)) ? "pending" : "unknown"
    const reason = captured.captureError
      ? captured.captureError
      : response.status === 202
        ? "NVIDIA has accepted the request and is still processing it"
        : response.status === 200 && acceptanceEnvelope(captured.parsed)
          ? "NVIDIA returned a non-terminal status envelope"
          : `NVIDIA status polling returned non-terminal HTTP ${response.status}`
    record = await BioNemoHostedDispatch.pending({
      preview: input.preview,
      sessionID: input.sessionID,
      status: state,
      provider_request_id: providerRequestID,
      http_status: response.status,
      error: cleanString(reason, input.secret),
      polled: true,
    })
    delay = retryAfterMilliseconds(response.headers, attempt)
  }
  return pendingResult(input.preview, record)
}

const BioNemoOutputsSafe = {
  parse(id: ID, value: unknown) {
    try {
      return parseBioNemoOutput(id, value)
    } catch {
      return undefined
    }
  },
}

export namespace BioNemoHosted {
  export function spec(id: ID) {
    return specs[BioNemoCapabilityID.parse(id)]
  }

  export async function doctor(id: ID) {
    const selected = spec(id)
    const fields = await resolveCredentialFields("nvidia").catch(() => undefined)
    return {
      capability: id,
      provider: "nvidia",
      configured: Boolean(fields?.api_key?.trim()),
      endpoint: selected.endpoint,
      status_endpoint_template: STATUS_ENDPOINT_TEMPLATE,
      api_schema_version: selected.apiSchemaVersion,
      docs_url: selected.docs,
      terms_url: TERMS,
      state: fields?.api_key?.trim() ? "configured" : "setup_needed",
      live_request_sent: false,
    }
  }

  export async function plan(id: ID, raw: unknown) {
    const built = prepare(id, raw)
    const fields = await resolveCredentialFields("nvidia").catch(() => undefined)
    const secret = fields?.api_key?.trim()
    return BioNemoHostedPreview.parse({
      ...built.preview,
      configured: Boolean(secret),
      payload: secret ? scrubExact(built.preview.payload, secret) : built.preview.payload,
    })
  }

  export async function start(id: ID, sessionID: string, raw: unknown) {
    const built = prepare(id, raw)
    const { selected, bodyText, preview, legacyApprovalSha256 } = built
    const fields = await resolveCredentialFields("nvidia")
    const secret = fields?.api_key?.trim()
    if (!secret) throw new Error(`NVIDIA NIM credential is not configured for ${id}`)
    let dispatch = await BioNemoHostedDispatch.begin({ preview, sessionID, legacyApprovalSha256 })
    if (dispatch.existing?.status === "retryable") {
      const retryNotBefore = dispatch.existing.retry_not_before
        ? Date.parse(dispatch.existing.retry_not_before)
        : Date.now()
      const remaining = Number.isFinite(retryNotBefore) ? Math.min(2_000, Math.max(0, retryNotBefore - Date.now())) : 0
      await wait(remaining)
      const claimed = await BioNemoHostedDispatch.claimRetry({ preview, sessionID })
      if (claimed.created) dispatch = { existing: undefined, created: claimed.created }
      else dispatch = { existing: claimed.existing, created: dispatch.created }
    }
    if (dispatch.existing?.status === "succeeded" && dispatch.existing.result)
      return BioNemoHostedResult.parse({
        ...dispatch.existing.result,
        dispatch_id: dispatch.existing.result.dispatch_id ?? dispatch.existing.dispatch_id,
      })
    if (dispatch.existing?.status === "failed")
      throw new Error(
        dispatch.existing.error ??
          `NVIDIA ${id} dispatch ${dispatch.existing.dispatch_id} failed and will not be resent automatically.`,
      )
    if (dispatch.existing?.status === "pending" || dispatch.existing?.status === "unknown")
      return reconcile({ id, sessionID, preview, record: dispatch.existing, secret })
    if (dispatch.existing?.status === "retryable")
      throw new Error(
        dispatch.existing.error ??
          `NVIDIA ${id} retry is not ready yet. Start it again with a new one-time approval; OpenScience will send at most one POST.`,
      )

    const startedAt = new Date().toISOString()
    let response: Response
    try {
      response = await fetch(selected.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "nvcf-poll-seconds": "300",
        },
        body: bodyText,
        redirect: "manual",
        signal: AbortSignal.timeout(10 * 60 * 1000),
      })
    } catch (error) {
      await BioNemoHostedDispatch.fail({
        preview,
        sessionID,
        status: "unknown",
        error: cleanString(error instanceof Error ? error.message : String(error), secret),
      })
      throw new Error(
        `${cleanString(error instanceof Error ? error.message : String(error), secret)} Dispatch ${dispatch.created.dispatch_id} has unknown provider state and will not be resent automatically.`,
      )
    }

    // Record the original NVIDIA identity before downloading a large result.
    // An interrupted/expired download can then reconcile without another POST.
    const redirectedID =
      response.status === 302
        ? sanitizeProviderRequestID(BioNemoHostedDispatch.providerRequestID(response.headers), secret)
        : undefined
    if (redirectedID)
      await BioNemoHostedDispatch.pending({
        preview,
        sessionID,
        status: "unknown",
        provider_request_id: redirectedID,
        http_status: response.status,
      })
    const captured = await capture(response, secret)
    const providerRequestID = captured.providerRequestID
    if (response.redirected || (REDIRECT.has(response.status) && (response.status !== 302 || captured.captureError)))
      return setUnresolved({
        preview,
        sessionID,
        dispatchID: dispatch.created.dispatch_id,
        message: captured.captureError ?? `OpenScience refused a redirect from the NVIDIA ${id} endpoint.`,
        httpStatus: response.status,
        providerRequestID,
        secret,
      })

    if (captured.lifecycle && FAILURE.has(captured.lifecycle)) {
      const message = cleanString(
        `NVIDIA ${id} reported terminal status ${captured.lifecycle}: ${captured.safeText.slice(0, 2_000)}`,
        secret,
      )
      await BioNemoHostedDispatch.fail({
        preview,
        sessionID,
        status: "failed",
        error: message,
        http_status: response.status,
        provider_request_id: providerRequestID,
      })
      throw new Error(message)
    }

    const handledFailure = providerHandledFailure(id, captured.parsed)
    if (handledFailure) {
      const message = cleanString(handledFailure, secret)
      await BioNemoHostedDispatch.fail({
        preview,
        sessionID,
        status: "failed",
        error: message,
        http_status: response.status,
        provider_request_id: providerRequestID,
      })
      throw new Error(message)
    }

    if (!response.ok && response.status !== 302) {
      const message = cleanString(
        `NVIDIA ${id} returned HTTP ${response.status}: ${captured.safeText.slice(0, 2_000)}`,
        secret,
      )
      const retryableInitial =
        response.status === 401 || response.status === 403 || response.status === 429 ? response.status : undefined
      if (retryableInitial && !providerRequestID) {
        const retryAfter = retryableInitial === 429 ? retryAfterMilliseconds(response.headers, 0) : 0
        const retryMessage = `${message} No safe NVIDIA status identity was returned. OpenScience will not retry automatically. Start this exact request again after another one-time approval to send at most one new POST${retryAfter ? ` after a bounded ${retryAfter} ms delay` : " after refreshing the NVIDIA credential"}.`
        await BioNemoHostedDispatch.retryable({
          preview,
          sessionID,
          reason: retryableInitial === 429 ? "rate_limit" : "authentication",
          retry_after_ms: retryAfter,
          error: retryMessage,
          http_status: retryableInitial,
        })
        throw new Error(retryMessage)
      }
      await BioNemoHostedDispatch.fail({
        preview,
        sessionID,
        status: response.status >= 500 || retryableInitial ? "unknown" : "failed",
        error: message,
        http_status: response.status,
        provider_request_id: providerRequestID,
      })
      throw new Error(message)
    }

    if ((response.status === 200 || response.status === 302) && !captured.captureError) {
      const terminal = BioNemoOutputsSafe.parse(id, captured.parsed)
      if (terminal && (!captured.lifecycle || SUCCESS.has(captured.lifecycle))) {
        try {
          return await finalize({
            id,
            sessionID,
            preview,
            parsed: terminal,
            providerRequestID,
            startedAt,
            httpStatus: response.status,
            dispatchID: dispatch.created.dispatch_id,
          })
        } catch (error) {
          return setUnresolved({
            preview,
            sessionID,
            dispatchID: dispatch.created.dispatch_id,
            message: `OpenScience could not safely finalize the NVIDIA ${id} response: ${error instanceof Error ? error.message : String(error)}`,
            httpStatus: response.status,
            providerRequestID,
            secret,
          })
        }
      }
    }

    if (providerRequestID) {
      const pending = await BioNemoHostedDispatch.pending({
        preview,
        sessionID,
        status:
          response.status === 202 || (captured.lifecycle && PENDING.has(captured.lifecycle)) ? "pending" : "unknown",
        provider_request_id: providerRequestID,
        http_status: response.status,
        error: cleanString(
          captured.captureError ??
            (response.status === 200 && acceptanceEnvelope(captured.parsed)
              ? "NVIDIA returned a non-terminal status envelope"
              : `NVIDIA returned non-terminal HTTP ${response.status}`),
          secret,
        ),
      })
      return reconcile({ id, sessionID, preview, record: pending, secret })
    }

    return setUnresolved({
      preview,
      sessionID,
      dispatchID: dispatch.created.dispatch_id,
      message:
        captured.captureError ??
        `NVIDIA ${id} returned an accepted but non-terminal response without a safe status identity.`,
      httpStatus: response.status,
      secret,
    })
  }
}

export const BioNemoSpecs = specs
