/** Public HTTP surfaces only. This example never imports the agent implementation. */
export type Transport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type Run = { runID: string; sessionID: string; state: string; resultMessageID?: string }
export type Pending = { id: string; sessionID: string; permission?: string; patterns?: string[]; questions?: unknown[] }
export type Snapshot = { runs: Run[]; latestSequence: number; permissions: Pending[]; questions: Pending[] }
export type Replay = { events: { sequence: number; runID: string; type: string }[]; latestSequence: number }
export type Receipt = { runID: string; acceptedAt: number }
export type Decision = { sessionID: string; requestID: string; kind: string; reply?: string; answers?: string[][] }

export interface Runtime {
  create(project: string): Promise<{ id: string }>
  prompt(
    project: string,
    input: { sessionID: string; requestID: string; message: string; effort: "normal" },
  ): Promise<Receipt>
  snapshot(project: string, sessionID: string): Promise<Snapshot>
  replay(project: string, sessionID: string, cursor: number): Promise<Replay>
  cancel(project: string, sessionID: string, runID: string): Promise<Run>
  decide(project: string, input: Decision): Promise<{ status: string }>
}

export class HTTPFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Runtime HTTP ${status}: ${code}`)
  }
}

export class RuntimeHTTP implements Runtime {
  constructor(
    readonly url: string,
    private token?: string,
    private transport: Transport = fetch,
  ) {
    const parsed = new URL(url)
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Runtime URL must be HTTP(S) without credentials, query, or fragment")
  }
  private async request<T>(
    project: string,
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(this.url.replace(/\/$/, "") + path)
    url.searchParams.set("directory", project)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const response = await this.transport(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as { error?: string }
      throw new HTTPFailure(response.status, problem.error ?? "request_failed")
    }
    return response.json() as Promise<T>
  }
  capabilities(project: string) {
    return this.request<{ protocolVersion: string }>(project, "/runtime/capabilities")
  }
  create(project: string) {
    return this.request<{ id: string }>(project, "/session", { title: "Slack research" })
  }
  prompt(project: string, input: { sessionID: string; requestID: string; message: string; effort: "normal" }) {
    return this.request<Receipt>(project, "/runtime/prompt", input)
  }
  snapshot(project: string, sessionID: string) {
    return this.request<Snapshot>(project, "/runtime/snapshot", undefined, { sessionID })
  }
  replay(project: string, sessionID: string, cursor: number) {
    return this.request<Replay>(project, "/runtime/events/replay", undefined, {
      sessionID,
      afterSequence: String(cursor),
    })
  }
  cancel(project: string, sessionID: string, runID: string) {
    return this.request<Run>(project, "/runtime/cancel", { sessionID, runID })
  }
  decide(project: string, input: Decision) {
    return this.request<{ status: string }>(project, "/runtime/decision", input)
  }
}

export interface Slack {
  post(input: { channel: string; thread_ts: string; text: string }): Promise<{ ts: string }>
}

export class SlackHTTP implements Slack {
  constructor(
    private token: string,
    private transport: Transport = fetch,
  ) {}
  async post(input: { channel: string; thread_ts: string; text: string }) {
    const response = await this.transport("https://slack.com/api/chat.postMessage", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false }),
    })
    const data = (await response.json()) as { ok?: boolean; ts?: string }
    if (!response.ok || !data.ok || !data.ts) throw new Error("Slack delivery was not confirmed; inspect the outbox")
    return { ts: data.ts }
  }
}
