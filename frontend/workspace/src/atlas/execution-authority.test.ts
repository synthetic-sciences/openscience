import { describe, expect, test } from "bun:test"
import { createProjectRequest } from "@/utils/openscience-fetch"
import {
  createExecutionAuthorityAPI,
  executionAuthorityError,
  executionAuthorityMessage,
  type ExecutionDecision,
} from "./execution-authority"

const hook = await Bun.file(new URL("./use-execution-authority.ts", import.meta.url)).text()

const decision = (value: Partial<ExecutionDecision> = {}): ExecutionDecision => ({
  allowed: true,
  reason: "allowed",
  capability: "terminal",
  mode: "sandboxed",
  projectID: "prj_alpha",
  sessionID: "ses_alpha",
  trustRevision: 3,
  grantRevision: 5,
  generation: "authority-generation",
  workspace: "/managed/project/.openscience/sessions/ses_alpha",
  writable: ["/managed/project/.openscience/sessions/ses_alpha"],
  sandbox: {
    enabled: true,
    network: "deny",
    allowWrite: [],
    onUnavailable: "error",
    requireProjectTrust: false,
    backend: "seatbelt",
    available: true,
    enforced: true,
  },
  ...value,
})

describe("frontend execution authority", () => {
  test("inspects the current opaque project, session, and capability without a directory selector", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init })
      return Response.json(decision())
    }) as typeof fetch
    const request = createProjectRequest({
      baseUrl: () => "http://127.0.0.1:4096",
      projectID: () => "prj_alpha",
      directory: () => "/managed/project",
      fetch: () => fetcher,
    })

    const result = await createExecutionAuthorityAPI(request).inspect({
      projectID: "prj_alpha",
      sessionID: "ses_alpha",
      capability: "terminal",
    })

    expect(result.allowed).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toBe("/project/prj_alpha/execution")
    expect(calls[0].url.searchParams.get("sessionID")).toBe("ses_alpha")
    expect(calls[0].url.searchParams.get("capability")).toBe("terminal")
    expect(calls[0].url.searchParams.get("directory")).toBeNull()
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("x-openscience-project")).toBe("prj_alpha")
    expect(headers.get("x-openscience-directory")).toBe("/managed/project")
  })

  test("explains trust and sandbox denial in terms of the blocked action", () => {
    expect(executionAuthorityMessage(decision())).toBeUndefined()
    expect(
      executionAuthorityMessage(
        decision({
          allowed: false,
          reason: "project_untrusted",
          mode: "read_only",
          capability: "kernel",
        }),
      ),
    ).toBe("Trust this project to start or restart a kernel in this session.")
    expect(
      executionAuthorityMessage(
        decision({
          allowed: false,
          reason: "sandbox_unavailable",
          mode: "read_only",
          capability: "remote_job",
        }),
      ),
    ).toBe(
      "A verified OS sandbox is required to dispatch a remote job. OpenScience could not enforce one on this computer.",
    )
    expect(executionAuthorityError(new Error("503 Service Unavailable"))).toBe(
      "Execution access could not be verified. 503 Service Unavailable",
    )
    expect(
      executionAuthorityMessage(
        decision({
          allowed: false,
          reason: "project_untrusted",
          message: "Trust is required by the stricter global policy.",
        }),
      ),
    ).toBe("Trust is required by the stricter global policy.")
  })

  test("submits only the canonical trust remediation returned by the server", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init })
      return Response.json({ state: "trusted" })
    }) as typeof fetch
    const request = createProjectRequest({
      baseUrl: () => "http://127.0.0.1:4096",
      projectID: () => "prj_alpha",
      directory: () => "/managed/project",
      fetch: () => fetcher,
    })
    const blocked = decision({
      allowed: false,
      reason: "project_untrusted",
      mode: "read_only",
      remediation: {
        code: "trust_project_required",
        message: "Trust required",
        method: "PUT",
        path: "/project/prj_alpha/trust",
        body: { trusted: true, root: "/managed/project" },
      },
    })

    await createExecutionAuthorityAPI(request).trust(blocked)

    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toBe("/project/prj_alpha/trust")
    expect(calls[0].init?.method).toBe("PUT")
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ trusted: true, root: "/managed/project" })
    await expect(
      createExecutionAuthorityAPI(request).trust({
        ...blocked,
        remediation: { ...blocked.remediation!, path: "/project/prj_other/trust" },
      }),
    ).rejects.toThrow("valid project-trust action")
  })
})
