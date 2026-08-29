import { describe, expect, test } from "bun:test"
import { PermissionActions } from "./permission-actions"

const source = Bun.file(new URL("./permission-actions.ts", import.meta.url)).text()
const styles = Bun.file(new URL("./message-part.css", import.meta.url)).text()

describe("Modal permission card", () => {
  test("keeps ordinary approvals in one compact responsive row", async () => {
    const component = await source
    const css = await styles

    expect(component).toContain('"data-slot": "permission-context"')
    expect(component).toContain('"data-icon": "shield"')
    expect(component).toContain('i18n.t("ui.permission.required")')
    expect(component).toContain('i18n.t("ui.permission.chooseScope")')
    expect(component).toContain('typeof query === "string" && query.trim()')
    expect(component).toContain('"data-slot": "permission-summary", title: text')
    expect(component).toContain('role: "group"')
    expect(component).toContain('node.setAttribute("aria-expanded", String(opts.expanded))')
    expect(component).toContain('i18n.t("ui.permission.allow")')
    expect(component).toContain("queueMicrotask(() => scopeBack?.focus())")
    expect(component).toContain("queueMicrotask(() => scopeTrigger?.focus())")
    expect(css).toContain("min-height: 44px")
    expect(css).toContain("flex: 1 1 220px")
    expect(css).toContain("text-overflow: ellipsis")
    expect(css).not.toContain("chase-border")
  })

  test("shows the remote and billing boundary with the reviewed workload", async () => {
    const component = await source

    expect(component).toContain("Run outside the local sandbox")
    expect(component).toContain("boundary().purpose")
    expect(component).toContain("modalMachine(plan)")
    expect(component).toContain("`${plan.timeout_minutes} min`")
    expect(component).toContain("It may incur Modal charges")
    expect(component).toContain("input file")
    expect(component).toContain("hashes.")
  })

  test("offers every exact-plan scope without broadening the digest", async () => {
    const component = await source

    expect(component).toContain('() => props.respond("once")')
    expect(component).toContain('() => props.respond("session")')
    expect(component).toContain('() => props.respond("project")')
    expect(component).toContain('props.respond("always")')
    expect(component).toContain("Every scope is bound to this exact plan")
    expect(component).toContain('"Remote compute approval scope"')
  })

  test("uses compact, readable details with aligned numeric values", async () => {
    const css = await styles

    expect(css).toContain('[data-slot="permission-compute-details"]')
    expect(css).toContain("font-variant-numeric: tabular-nums")
    expect(css).toContain("text-wrap: pretty")
  })

  test("uses the same exact-plan approval surface for saved SSH hosts", async () => {
    const component = await source

    expect(component).toContain('compute()?.provider === "ssh"')
    expect(component).toContain("Run on a saved SSH host")
    expect(component).toContain('["Host", `${plan.label} · ${plan.host}`]')
    expect(component).toContain('plan.scheduler === "none" ? "Direct SSH"')
    expect(component).toContain(": boundary().warning")
  })

  test("makes permanent Python and R environment changes explicit before approval", async () => {
    const component = await source

    expect(component).toContain("environment_mutation")
    expect(component).toContain("Change ${String(mutation().language).toUpperCase()} environment")
    expect(component).toContain('"Environment change details"')
    expect(component).toContain('["Environment", mutation().environment]')
    expect(component).toContain('["Manager", mutation().manager]')
    expect(component).toContain("A successful change restarts this environment and clears its in-memory state")
    expect(component).toContain('"Environment change approval scope"')
  })

  test("keeps exact change approval scopes compact and consistent", async () => {
    const component = await source

    expect(component).toContain('() => props.respond("once")')
    expect(component).toContain('() => props.respond("session")')
    expect(component).toContain('() => props.respond("project")')
    expect(component).toContain('props.respond("always")')
    expect(component).toContain("Every scope applies only to this exact requested change")
  })

  test("surfaces hosted scientific approvals as one-time exact provider requests", async () => {
    const component = await source

    expect(component).toContain("const scientific = () => props.metadata?.scientific_capability")
    expect(component).toContain(
      'const kind = mutation() ? "environment-mutation" : hostedScientific() ? "hosted-scientific" : "remote-compute"',
    )
    expect(component).toContain("Send a hosted scientific request")
    expect(component).toContain("`${hostedScientificLabel(String(hostedScientific().id))} via NVIDIA`")
    expect(component).toContain('"Hosted scientific request details"')
    expect(component).toContain('["Provider", hostedScientific().provider.toUpperCase()]')
    expect(component).toContain('["Request host", endpointHost(hostedScientific().endpoint)]')
    expect(component).toContain('["Request endpoint", hostedScientific().endpoint]')
    expect(component).toContain('["Status host", hostedScientific().status_host]')
    expect(component).toContain('["Status endpoint", hostedScientific().status_endpoint_template]')
    expect(component).toContain('["API schema", hostedScientific().api_schema_version]')
    expect(component).toContain("NVIDIA does not disclose a model-weight version here.")
    expect(component).not.toContain("hostedScientific().model_version")
    expect(component).toContain('["Payload exact", formatApprovalBytes(hostedScientific().payload_bytes)]')
    expect(component).toContain('["Request SHA-256", hostedScientific().request_sha256]')
    expect(component).toContain("...hostedEgressRows(hostedScientific().egress_summary)")
    expect(component).toContain("This approval is one-time only.")
    expect(component).toContain("It does not create standing host or provider access.")
    expect(component).toContain('? "Hosted scientific approval scope"')
    expect(component).toContain("if (scopes && !hostedScientific())")
    expect(component).toContain(
      'hostedScientific() || !special ? i18n.t("ui.permission.allowOnce") : i18n.t("ui.permission.scopeOnce")',
    )
  })

  test("renders hosted scientific approval details and one-time scope in the mounted card", () => {
    const container = document.createElement("div")
    const responses: string[] = []
    document.body.append(container)
    container.append(
      PermissionActions({
        respond(response) {
          responses.push(response)
        },
        metadata: {
          scientific_capability: {
            id: "boltz2",
            provider: "nvidia",
            endpoint: "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict",
            status_endpoint_template: "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}",
            status_host: "api.nvcf.nvidia.com",
            api_schema_version: "api-schema-1.5.0",
            method: "POST",
            payload_bytes: 1536,
            request_sha256: "a".repeat(64),
            approval_sha256: "b".repeat(64),
            egress_summary: {
              input_kinds: ["protein sequence"],
              sequences: {
                count: 1,
                total_bytes: 18,
                sha256: "e".repeat(64),
                lengths: [18],
              },
              scalar_parameters: [{ name: "diffusion_samples", value: 1 }],
            },
            terms_url: "https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA_API_Trial_Service_Terms.pdf",
            warning: "NVIDIA trial-service terms apply.",
          },
        },
      }),
    )

    try {
      const text = container.textContent ?? ""
      expect(text).toContain("Send a hosted scientific request")
      expect(text).toContain("Boltz-2 via NVIDIA")
      expect(text).toContain("https://health.api.nvidia.com/v1/biology/mit/boltz2/predict")
      expect(text).toContain("health.api.nvidia.com")
      expect(text).toContain("https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}")
      expect(text).toContain("api.nvcf.nvidia.com")
      expect(text).toContain("api-schema-1.5.0")
      expect(text).toContain("API schema")
      expect(text).not.toContain("Modelapi-schema")
      expect(text).toContain("POST")
      expect(text).toContain("1.5 KB (1,536 bytes)")
      expect(text).toContain("a".repeat(64))
      expect(text).toContain("Data leaving device")
      expect(text).toContain("protein sequence")
      expect(text).toContain("lengths 18")
      expect(text).toContain("e".repeat(64))
      expect(text).toContain("diffusion_samples=1")
      expect(text).not.toContain("nvapi-")
      expect(text).toContain("NVIDIA_API_Trial_Service_Terms.pdf")
      expect(text).toContain("NVIDIA trial-service terms apply.")
      expect(text).toContain("This approval is one-time only.")
      expect(text).toContain("Allow once")
      expect(text).not.toContain("This conversation")
      expect(text).not.toContain("This project")
      expect(text).not.toContain("Global")
      expect(container.querySelector('[data-kind="hosted-scientific"]')).toBeTruthy()
      expect(container.querySelectorAll("button")).toHaveLength(2)
      const allow = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Allow once",
      )
      allow?.click()
      expect(responses).toEqual(["once"])
    } finally {
      container.remove()
    }
  })

  test("keeps hosted scientific details readable and actions wrapped at desktop and mobile widths", async () => {
    const css = await styles

    expect(css).toContain('[data-slot="permission-summary"][data-kind="hosted-scientific"]')
    expect(css).toContain('&[data-kind="hosted-scientific"]')
    expect(css).toContain("flex-direction: column")
    expect(css).toContain("flex-wrap: wrap")
    expect(css).toContain("overflow-wrap: anywhere")
    expect(css).toContain("@media (max-width: 560px)")
    expect(css).toContain("width: 100%")
    expect(css).toContain("min-height: 32px")

    for (const width of [960, 390]) {
      const container = document.createElement("div")
      container.style.width = `${width}px`
      document.body.append(container)
      container.append(
        PermissionActions({
          respond() {},
          metadata: {
            scientific_capability: {
              id: "openfold3",
              provider: "nvidia",
              endpoint: "https://health.api.nvidia.com/v1/biology/openfold/openfold3/predict",
              status_endpoint_template: "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}",
              status_host: "api.nvcf.nvidia.com",
              api_schema_version: "api-schema-1.0.0",
              method: "POST",
              payload_bytes: 2_048,
              request_sha256: "c".repeat(64),
              approval_sha256: "d".repeat(64),
              egress_summary: {
                input_kinds: ["biomolecular complex", "MSA or alignment"],
                sequences: {
                  count: 1,
                  total_bytes: 4,
                  sha256: "e".repeat(64),
                  lengths: [4],
                },
                alignments: { count: 1, total_bytes: 12, sha256: "f".repeat(64) },
                scalar_parameters: [{ name: "diffusion_samples", value: 1 }],
              },
              terms_url: "https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA_API_Trial_Service_Terms.pdf",
              warning: "NVIDIA trial-service terms apply.",
            },
          },
        }),
      )

      try {
        const text = container.textContent ?? ""
        expect(text).toContain("health.api.nvidia.com")
        expect(text).toContain("api.nvcf.nvidia.com")
        expect(text).toContain("2 KB (2,048 bytes)")
        expect(text).toContain("c".repeat(64))
        expect(container.querySelectorAll("button")).toHaveLength(2)
      } finally {
        container.remove()
      }
    }
  })

  test("generic filesystem, network, and query approvals reveal all scopes and cancel restores the trigger", async () => {
    const cases = [
      { filesystem: { access: "read", path: "results/table.csv" } },
      { network: { host: "api.example.test" } },
      { query: "approve this search" },
    ]
    for (const metadata of cases) {
      const responses: string[] = []
      const container = document.createElement("div")
      document.body.append(container)
      container.append(
        PermissionActions({
          respond(response) {
            responses.push(response)
          },
          metadata,
        }),
      )

      try {
        const trigger = container.querySelector('button[data-variant="secondary"]') as HTMLButtonElement | null
        expect(trigger).toBeTruthy()
        trigger?.click()
        await new Promise((resolve) => queueMicrotask(resolve))
        const text = container.textContent ?? ""
        expect(text).toContain("This conversation")
        expect(text).toContain("This project")
        expect(text).toContain("Allow always")
        const cancel = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent === "Cancel",
        ) as HTMLButtonElement | undefined
        expect(cancel).toBeTruthy()
        if (!cancel) throw new Error("Cancel scope button was not rendered")
        expect(document.activeElement).toBe(cancel)
        cancel.click()
        await new Promise((resolve) => queueMicrotask(resolve))
        expect(container.textContent ?? "").toContain("Allow once")
        expect(container.textContent ?? "").not.toContain("This conversation")
        const restored = container.querySelector('button[data-variant="secondary"]') as HTMLButtonElement | null
        expect(document.activeElement).toBe(restored)
        restored?.click()
        const project = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent === "This project",
        ) as HTMLButtonElement | undefined
        project?.click()
        expect(responses).toEqual(["project"])
      } finally {
        container.remove()
      }
    }
  })
})
