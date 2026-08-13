import { createOpenScienceClient, type OpenScienceClientConfig } from "./client.js"
import type { RuntimeEvent, RuntimeEventReplay, RuntimePromptAccepted, RuntimePromptData } from "./gen/types.gen.js"

export type RuntimePromptInput = NonNullable<RuntimePromptData["body"]>

export type RuntimeEventInput = {
  sessionID: string
  /** Replay events strictly after this per-session sequence. */
  afterSequence?: number
  signal?: AbortSignal
}

export class RuntimeEventCursorError extends Error {
  readonly status = 409

  constructor(message = "The runtime event cursor is outside the retained window") {
    super(message)
    this.name = "RuntimeEventCursorError"
  }
}

export type OpenScienceRuntimeConfig = OpenScienceClientConfig & {
  directory?: string
  projectID?: string
  project?: string
  /** Delay before reconnecting an event stream that ended without an error. */
  runtimeReconnectDelayMs?: number
}

function statusFromSseError(error: unknown) {
  if (!(error instanceof Error)) return
  const match = error.message.match(/SSE failed:\s+(\d{3})\b/)
  if (!match) return
  return Number(match[1])
}

function waitForReconnect(delay: number, signal?: AbortSignal) {
  if (signal?.aborted || delay <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

/**
 * Stable, result-first facade over the generated HTTP client.
 *
 * The facade carries `Last-Event-ID` across reconnects; the server treats that
 * ID as the authoritative cursor, so each yielded event is durably replayable
 * and sequences remain monotonic within a session.
 */
export class OpenScienceRuntime {
  readonly #client: ReturnType<typeof createOpenScienceClient>
  readonly #reconnectDelay: number

  constructor(config?: OpenScienceRuntimeConfig) {
    const { runtimeReconnectDelayMs: _, ...clientConfig } = config ?? {}
    this.#client = createOpenScienceClient(clientConfig)
    this.#reconnectDelay = Math.max(0, config?.runtimeReconnectDelayMs ?? 100)
  }

  prompt(input: RuntimePromptInput): Promise<RuntimePromptAccepted> {
    return this.#client.runtime
      .prompt(input, {
        throwOnError: true,
      })
      .then((result) => result.data)
  }

  replay(input: Omit<RuntimeEventInput, "signal">): Promise<RuntimeEventReplay> {
    return this.#client.runtime
      .replay(input, {
        throwOnError: true,
      })
      .then((result) => result.data)
  }

  async *events(input: RuntimeEventInput): AsyncGenerator<RuntimeEvent, void, void> {
    const { signal, ...parameters } = input
    let lastSequence = input.afterSequence
    let failures = 0

    while (!signal?.aborted) {
      let connectionError: unknown
      const result = await this.#client.runtime.subscribe(parameters, {
        signal,
        throwOnError: true,
        // The stable facade owns reconnect policy so normal EOF and HTTP
        // errors follow the same cursor-aware path.
        sseMaxRetryAttempts: 1,
        headers: lastSequence === undefined ? undefined : { "Last-Event-ID": String(lastSequence) },
        onSseError(error) {
          connectionError = error
        },
      })

      for await (const event of result.stream) {
        lastSequence = event.sequence
        failures = 0
        yield event
      }
      if (signal?.aborted) return

      if (connectionError) {
        const status = statusFromSseError(connectionError)
        if (status === 409) throw new RuntimeEventCursorError((connectionError as Error).message)
        if (status !== undefined && status >= 400 && status < 500) throw connectionError
        failures += 1
      }

      const delay = connectionError
        ? Math.min(this.#reconnectDelay * 2 ** Math.max(0, failures - 1), 30_000)
        : this.#reconnectDelay
      await waitForReconnect(delay, signal)
    }
  }
}

export function createOpenScienceRuntime(config?: OpenScienceRuntimeConfig) {
  return new OpenScienceRuntime(config)
}
