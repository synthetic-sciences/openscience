/**
 * Local model support — point OpenScience at any OpenAI-compatible endpoint
 * running on the user's machine (Ollama, LM Studio, llama.cpp, vLLM, Jan, …) or
 * a custom base URL.
 *
 * A local runtime is registered exactly like any other provider: a config block
 * under `openscience.json` → `provider.<id>` using the `@ai-sdk/openai-compatible`
 * package, a `baseURL` (e.g. http://localhost:11434/v1), a throwaway api key
 * (most local servers ignore it, but the SDK requires a non-empty value), and a
 * `models` map. This module builds that block, discovers the models a running
 * endpoint exposes (GET `<baseURL>/models`), and probes the well-known ports so
 * the CLI/onboarding can offer a zero-typing "we found Ollama" flow.
 *
 * Local providers carry a non-`thk_` key, so the billing gate always classifies
 * them as BYOK — never wallet-gated, never metered, always free.
 */

export namespace LocalProvider {
  /** A well-known local runtime and where it listens by default. */
  export interface Preset {
    /** Provider id written to config (also the `openscience/<id>` model prefix). */
    id: string
    /** Human label shown in pickers. */
    name: string
    /** OpenAI-compatible base URL (ends in `/v1`). */
    baseURL: string
    /** Throwaway key — local servers ignore it, the SDK requires it non-empty. */
    apiKey: string
    /** One-line hint for pickers. */
    hint: string
  }

  /** Ports/paths for the runtimes people actually run locally. Ordered by how
   *  common they are so detection surfaces the likeliest first. */
  export const PRESETS: readonly Preset[] = [
    {
      id: "ollama",
      name: "Ollama",
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
      hint: "ollama serve · http://localhost:11434",
    },
    {
      id: "lmstudio",
      name: "LM Studio",
      baseURL: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      hint: "local server · http://localhost:1234",
    },
    {
      id: "llamacpp",
      name: "llama.cpp",
      baseURL: "http://localhost:8080/v1",
      apiKey: "llama.cpp",
      hint: "llama-server · http://localhost:8080",
    },
    {
      id: "vllm",
      name: "vLLM",
      baseURL: "http://localhost:8000/v1",
      apiKey: "vllm",
      hint: "OpenAI server · http://localhost:8000",
    },
    {
      id: "jan",
      name: "Jan",
      baseURL: "http://localhost:1337/v1",
      apiKey: "jan",
      hint: "local API server · http://localhost:1337",
    },
  ] as const

  /** The npm package every local OpenAI-compatible endpoint routes through. */
  export const NPM = "@ai-sdk/openai-compatible"

  /** How to start / manage a runtime's server from its CLI, when OpenScience can
   *  host it for the user. Only runtimes with a self-contained "serve" command
   *  are auto-startable; the rest are BYO-server (the user runs it themselves). */
  export interface RuntimeCommands {
    /** CLI binary to detect (Bun.which) and drive. */
    bin: string
    /** Args that start the OpenAI-compatible server in the background. */
    serve: string[]
    /** Args to download/pull a model (visible, potentially long-running). */
    pull?: (model: string) => string[]
    /** Where to install the runtime if the binary is missing. */
    install: string
    /** Human command shown to users who prefer to run it in the terminal. */
    serveHint: string
    pullHint?: (model: string) => string
  }

  export const RUNTIME_COMMANDS: Readonly<Record<string, RuntimeCommands>> = {
    ollama: {
      bin: "ollama",
      serve: ["serve"],
      pull: (m) => ["pull", m],
      install: "https://ollama.com/download",
      serveHint: "ollama serve",
      pullHint: (m) => `ollama pull ${m}`,
    },
    lmstudio: {
      bin: "lms",
      serve: ["server", "start"],
      install: "https://lmstudio.ai/docs/cli",
      serveHint: "lms server start",
    },
  } as const

  /** Whether OpenScience can start this runtime itself (a known serve command). */
  export function isAutoStartable(presetId: string): boolean {
    return presetId in RUNTIME_COMMANDS
  }

  /** The apiKey used when the user leaves it blank — local servers ignore it,
   *  but the SDK rejects an empty key. */
  export const DEFAULT_API_KEY = "local"

  /** Normalize a user-entered base URL to an OpenAI-compatible `…/v1` root:
   *  trims whitespace and trailing slashes, adds `http://` if no scheme, and
   *  appends `/v1` when the path doesn't already end in a version segment. */
  export function normalizeBaseURL(input: string): string {
    let url = input.trim().replace(/\/+$/, "")
    if (!url) return url
    if (!/^https?:\/\//i.test(url)) url = "http://" + url
    // Already versioned (…/v1, …/v1beta, …/openai/v1) → leave it.
    if (/\/v\d+[a-z]*$/i.test(url)) return url
    return url + "/v1"
  }

  /** Join a base URL and a path segment without doubling slashes. */
  export function modelsEndpoint(baseURL: string): string {
    return baseURL.replace(/\/+$/, "") + "/models"
  }

  /** Parse an OpenAI-compatible `GET /v1/models` body into sorted model ids.
   *  Tolerates the `{ object: "list", data: [{ id }] }` shape and, defensively,
   *  a bare array or Ollama's `{ models: [{ name }] }` native shape. */
  export function parseModelsResponse(body: unknown): string[] {
    const ids = new Set<string>()
    const push = (v: unknown) => {
      if (typeof v === "string" && v.trim()) ids.add(v.trim())
    }
    if (Array.isArray(body)) {
      for (const item of body) {
        if (typeof item === "string") push(item)
        else if (item && typeof item === "object") push((item as any).id ?? (item as any).name)
      }
    } else if (body && typeof body === "object") {
      const data = (body as any).data
      const models = (body as any).models
      if (Array.isArray(data)) for (const m of data) push(m?.id ?? m?.name)
      if (Array.isArray(models)) for (const m of models) push(m?.id ?? m?.name)
    }
    return [...ids].sort((a, b) => a.localeCompare(b))
  }

  /** Fetch the model ids a running endpoint exposes via `GET <baseURL>/models`.
   *  Throws on a network error or non-2xx so callers can distinguish "not
   *  running" from "running but empty". */
  export async function listModels(
    baseURL: string,
    apiKey?: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch },
  ): Promise<string[]> {
    const timeout = AbortSignal.timeout(opts?.timeoutMs ?? 4000)
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    const doFetch = opts?.fetchImpl ?? fetch
    const res = await doFetch(modelsEndpoint(baseURL), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${modelsEndpoint(baseURL)}`)
    return parseModelsResponse(await res.json())
  }

  /** Best-effort probe: the models a reachable endpoint exposes, or null when it
   *  can't be reached / returns an error (used for auto-detection). */
  export async function probe(
    baseURL: string,
    apiKey?: string,
    timeoutMs = 1500,
    fetchImpl?: typeof fetch,
  ): Promise<string[] | null> {
    try {
      return await listModels(baseURL, apiKey, { timeoutMs, fetchImpl })
    } catch {
      return null
    }
  }

  export interface Detected {
    preset: Preset
    models: string[]
  }

  /** Probe all known local runtimes in parallel and return those that are up and
   *  serving at least one model. */
  export async function detect(): Promise<Detected[]> {
    const results = await Promise.all(
      PRESETS.map(async (preset) => ({ preset, models: await probe(preset.baseURL, preset.apiKey) })),
    )
    return results.filter((r): r is Detected => Array.isArray(r.models) && r.models.length > 0)
  }

  /** Build the `openscience.json` → `provider.<id>` block for a local endpoint.
   *  Uses `@ai-sdk/openai-compatible`, pins the baseURL + a throwaway key, and
   *  registers each model at zero cost (local inference is free / never metered).
   *  Conservative capability + limit defaults; the user can refine per-model. */
  export function buildProviderConfig(input: {
    name: string
    baseURL: string
    apiKey?: string
    models: string[]
    /** Per-model context window; local models vary widely, 32k is a safe default. */
    contextLimit?: number
    outputLimit?: number
  }): Record<string, unknown> {
    const models: Record<string, unknown> = {}
    for (const id of input.models) {
      models[id] = {
        name: id,
        tool_call: true,
        reasoning: false,
        temperature: true,
        cost: { input: 0, output: 0 },
        limit: { context: input.contextLimit ?? 32_768, output: input.outputLimit ?? 8_192 },
      }
    }
    return {
      name: input.name,
      npm: NPM,
      api: input.baseURL,
      options: { baseURL: input.baseURL, apiKey: input.apiKey || DEFAULT_API_KEY },
      models,
    }
  }
}
