import { describe, expect, test } from "bun:test"
import { PermissionActions, describeRequest } from "./permission-actions"

const digest = (seed: string) => seed.repeat(64).slice(0, 64)

function mount(metadata: Record<string, unknown>) {
  const container = document.createElement("div")
  const responses: string[] = []
  document.body.append(container)
  container.append(PermissionActions({ respond: (response) => responses.push(response), metadata }))
  const card = container.querySelector<HTMLElement>('[data-component="request-card"]')!
  const buttons = () => Array.from(card.querySelectorAll("button")).map((button) => button.textContent)
  const click = (label: string) => {
    const button = Array.from(card.querySelectorAll("button")).find((item) => item.textContent === label)
    if (!button) throw new Error(`no button ${label} among ${buttons().join(", ")}`)
    button.click()
  }
  return {
    card,
    responses,
    buttons,
    click,
    title: () => card.querySelector('[data-slot="request-title"]')?.textContent ?? "",
    subline: () => card.querySelector('[data-slot="request-subline"]')?.textContent ?? "",
    details: () => card.querySelector('[data-slot="request-details"]')?.textContent ?? "",
    rows: () =>
      Array.from(card.querySelectorAll('[data-slot="request-rows"] > span')).map(
        (label) => `${label.textContent}: ${label.nextElementSibling?.textContent}`,
      ),
    dispose: () => container.remove(),
  }
}

const modal = {
  compute: {
    provider: "modal",
    name: "Final churn ensemble",
    purpose: "Fit the locked ensemble and score the benchmark",
    digest: digest("7"),
    gpu: "T4",
    resources: { cpus: 4, gpus: 1, memory_gb: 16 },
    image: "python:3.12-slim",
    timeout_minutes: 25,
    network: "none",
    command: "python final_evaluate.py",
    uploads: [{ path: "development.csv", size: 775971, sha256: digest("a") }],
    upload_bytes: 775971,
    allowance: { proposed_minutes: 120 },
  },
}

describe("request card", () => {
  test("every kind shares one shape: eyebrow, one-line title, quiet facts, details behind a disclosure, actions right", () => {
    const kinds = [
      { network: { host: "api.semanticscholar.org" }, url: "https://api.semanticscholar.org/graph/v1/paper/search" },
      { filesystem: { path: "/data/telco", access: "read" } },
      modal,
      {
        environment_mutation: {
          plan_digest: digest("c"),
          language: "python",
          environment: "default",
          manager: "pip",
          operation: "package_install",
          packages: ["lightgbm==4.6.0"],
          warning: "Installs into the kernel's environment.",
        },
      },
    ]
    for (const metadata of kinds) {
      const mounted = mount(metadata)
      try {
        expect(mounted.card.getAttribute("data-component")).toBe("request-card")
        expect(mounted.card.querySelector('[data-slot="request-eyebrow"]')?.textContent).toBe("Approval required")
        expect(mounted.title().length).toBeGreaterThan(0)
        expect(mounted.card.querySelector('[data-slot="request-actions"]')).toBeTruthy()
        // The same three actions, in the same order, whatever is being asked.
        expect(mounted.buttons()).toEqual(["Deny", "Allow…", "Allow once"])
      } finally {
        mounted.dispose()
      }
    }
  })

  test("a network host is one line with its URL beneath; Allow… offers the three scopes and Cancel returns", () => {
    const mounted = mount({
      network: { host: "api.semanticscholar.org" },
      url: "https://api.semanticscholar.org/graph/v1/paper/search",
    })
    try {
      expect(mounted.title()).toBe("Allow network access to api.semanticscholar.org")
      expect(mounted.subline()).toBe("https://api.semanticscholar.org/graph/v1/paper/search")
      mounted.click("Allow…")
      expect(mounted.card.getAttribute("data-expanded")).toBe("true")
      expect(mounted.buttons()).toEqual(["Cancel", "This conversation", "This project", "Allow always"])
      mounted.click("Cancel")
      expect(mounted.buttons()).toEqual(["Deny", "Allow…", "Allow once"])
      mounted.click("Allow…")
      mounted.click("This project")
      expect(mounted.responses).toEqual(["project"])
    } finally {
      mounted.dispose()
    }
  })

  test("folder access never offers a machine-wide scope", () => {
    const mounted = mount({ filesystem: { path: "/data/telco", access: "write" } })
    try {
      expect(mounted.title()).toBe("Grant read & write access to /data/telco")
      mounted.click("Allow…")
      expect(mounted.buttons()).toEqual(["Cancel", "This conversation", "This project"])
    } finally {
      mounted.dispose()
    }
  })

  test("a Modal job names the job, shows the machine in one line, keeps the plan behind Details, and says what each scope adds", () => {
    const mounted = mount(modal)
    try {
      expect(mounted.title()).toBe("Run on Modal: Final churn ensemble")
      expect(mounted.subline()).toBe("T4 GPU · 4 CPU · 16 GB · 25 min · no network · 758 KB uploaded")
      expect(mounted.rows()).toEqual([
        "Purpose: Fit the locked ensemble and score the benchmark",
        "Machine: T4 GPU · 4 CPU · 16 GB · python:3.12-slim",
        "Timeout: 25 min",
        "Network: Blocked",
        "Command: python final_evaluate.py",
        "Uploads: 1 file · 758 KB",
      ])
      expect(mounted.details()).toContain("may incur Modal charges")
      expect(mounted.details()).toContain("up to 2 h of job time in total")
      // The plan itself stays folded until asked for.
      expect(mounted.card.querySelector<HTMLDetailsElement>('[data-slot="request-details"]')?.open).toBe(false)
      mounted.click("Allow…")
      expect(mounted.buttons()).toEqual([
        "Cancel",
        "This conversation · +2 h",
        "This project · +2 h",
        "Allow always · +2 h",
      ])
      expect(mounted.card.querySelector('[data-slot="request-eyebrow"]')?.textContent).toBe(
        "Choose approval scope · Each scope also allows up to 2 h of Modal jobs there",
      )
      mounted.click("This conversation · +2 h")
      expect(mounted.responses).toEqual(["session"])
    } finally {
      mounted.dispose()
    }
  })

  test("a Modal job covered by an allowance says so in its rows", () => {
    const covered = {
      compute: {
        ...modal.compute,
        allowance: { proposed_minutes: 120, covered_by: "allowance:120", used_minutes: 25 },
      },
    }
    const mounted = mount(covered)
    try {
      expect(mounted.rows()).toContain("Allowance: covered; 25 min of 2 h used")
    } finally {
      mounted.dispose()
    }
  })

  test("a study is approved as a study: one primary action for the session, a project scope behind Allow…, and a one-off escape", () => {
    const mounted = mount({
      study: {
        id: "stu_1",
        name: "IBM Telco churn GPU search",
        target: { kind: "modal", gpu: "T4" },
        concurrency: 2,
        budget: { maxRuns: 12, maxHours: 2, target: 0.86, runMinutes: 10 },
        killCriteria: "12 minutes",
        followUpMinutes: 120,
      },
      compute: { purpose: "Approve the runs of study …" },
    })
    try {
      expect(mounted.card.getAttribute("data-kind")).toBe("study")
      expect(mounted.title()).toBe("Approve study: IBM Telco churn GPU search")
      expect(mounted.subline()).toBe(
        "Modal · T4 GPU · 12 runs · 2 h of compute · stop at 0.86 · 10 min per run · 2 at a time · kill rule 12 minutes",
      )
      expect(mounted.rows()).toContain("Follow-up jobs: up to 2 h of Modal time after the runs")
      expect(mounted.details()).toContain("One approval covers every run this study dispatches")
      expect(mounted.details()).not.toContain("bound to this exact plan")
      expect(mounted.buttons()).toEqual(["Deny", "Only this request", "Allow…", "Approve study"])
      mounted.click("Approve study")
      expect(mounted.responses).toEqual(["session"])
      mounted.click("Allow…")
      expect(mounted.buttons()).toEqual(["Cancel", "This project"])
      mounted.click("This project")
      expect(mounted.responses).toEqual(["session", "project"])
    } finally {
      mounted.dispose()
    }
  })

  test("an environment change names the packages and the restart; every scope is the exact change", () => {
    const mounted = mount({
      environment_mutation: {
        plan_digest: digest("c"),
        language: "python",
        environment: "openscience-default",
        manager: "pip",
        operation: "package_install",
        packages: ["lightgbm==4.6.0", "xgboost==3.0.2"],
        warning: "Installs into the kernel's Python environment.",
      },
    })
    try {
      expect(mounted.card.getAttribute("data-kind")).toBe("environment-mutation")
      expect(mounted.title()).toBe("Install lightgbm==4.6.0, xgboost==3.0.2 in Python")
      expect(mounted.subline()).toBe("openscience-default · pip · Python kernel restarts")
      expect(mounted.details()).toContain("Every scope applies only to this exact requested change")
    } finally {
      mounted.dispose()
    }
  })

  test("a hosted scientific request is one-time: no Allow…, the egress in one line, the exact binding behind Details", () => {
    const mounted = mount({
      scientific_capability: {
        id: "boltz2",
        provider: "nvidia",
        endpoint: "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict",
        status_endpoint_template: "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}",
        status_host: "api.nvcf.nvidia.com",
        api_schema_version: "api-schema-1.5.0",
        method: "POST",
        payload_bytes: 1536,
        request_sha256: digest("d"),
        approval_sha256: digest("e"),
        egress_summary: {
          input_kinds: ["protein sequence"],
          sequences: { count: 1, total_bytes: 120, lengths: [120], sha256: digest("f") },
          scalar_parameters: [{ name: "recycling_steps", value: 3 }],
        },
        terms_url: "https://www.nvidia.com/terms",
        warning: "The sequence leaves this device for NVIDIA's hosted service.",
      },
    })
    try {
      expect(mounted.card.getAttribute("data-kind")).toBe("hosted-scientific")
      expect(mounted.title()).toBe("Send Boltz-2 request to NVIDIA")
      expect(mounted.subline()).toBe("2 KB leaves this device: protein sequence · health.api.nvidia.com")
      expect(mounted.buttons()).toEqual(["Deny", "Allow once"])
      expect(mounted.rows()).toContain("Request endpoint: https://health.api.nvidia.com/v1/biology/mit/boltz2/predict")
      expect(mounted.rows()).toContain("Parameters: recycling_steps=3")
      expect(mounted.details()).toContain("This approval is one-time only.")
      mounted.click("Allow once")
      expect(mounted.responses).toEqual(["once"])
    } finally {
      mounted.dispose()
    }
  })

  test("describeRequest falls back to the URL, the query, then the plain eyebrow", () => {
    const labels = {
      deny: "Deny",
      allow: "Allow…",
      allowOnce: "Allow once",
      session: "This conversation",
      project: "This project",
      always: "Allow always",
      grantRead: (path: string) => `read ${path}`,
      grantWrite: (path: string) => `write ${path}`,
      allowHost: (host: string) => `host ${host}`,
      runCode: (language: string) => `Run ${language} code`,
      runShell: "Run a shell command",
      required: "Approval required",
    }
    // Running code names what runs; the source itself is the tool row above the card.
    expect(
      describeRequest({ kernel: { language: "python", title: "Fit the survival model", lines: 22 } }, labels),
    ).toMatchObject({
      kind: "code",
      title: "Run Python code",
      subline: "Fit the survival model · 22 lines",
    })
    expect(describeRequest({ kernel: { language: "r", lines: 1 } }, labels)).toMatchObject({
      title: "Run R code",
      subline: "1 line",
    })
    expect(describeRequest({ shell: { command: "  ls -la data\nwc -l data/*.csv\n" } }, labels)).toMatchObject({
      kind: "code",
      title: "Run a shell command",
      subline: "ls -la data … +1 line",
    })
    expect(describeRequest({ shell: { command: "git status" } }, labels).subline).toBe("git status")
    // A network request a shell command raises is still about the host.
    expect(describeRequest({ network: { host: "pypi.org" }, shell: { command: "pip download x" } }, labels).kind).toBe(
      "network",
    )
    expect(describeRequest({ url: " https://example.org/x " }, labels).title).toBe("https://example.org/x")
    expect(describeRequest({ query: "tabular foundation models" }, labels).title).toBe("“tabular foundation models”")
    expect(describeRequest({}, labels).title).toBe("Approval required")
    expect(describeRequest(undefined, labels).scopes.map((scope) => scope.reply)).toEqual([
      "session",
      "project",
      "always",
    ])
  })
})
