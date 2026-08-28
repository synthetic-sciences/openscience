import { describe, expect, test } from "bun:test"

const source = Bun.file(new URL("./message-part.tsx", import.meta.url)).text()
const styles = Bun.file(new URL("./message-part.css", import.meta.url)).text()

describe("Modal permission card", () => {
  test("keeps ordinary approvals in one compact responsive row", async () => {
    const component = await source
    const css = await styles

    expect(component).toContain('data-slot="permission-context"')
    expect(component).toContain('name="shield"')
    expect(component).toContain('i18n.t("ui.permission.required")')
    expect(component).toContain('i18n.t("ui.permission.chooseScope")')
    expect(component).toContain('typeof query === "string" && query.trim()')
    expect(component).toContain("title={value()}")
    expect(component).toContain('role="group"')
    expect(component).toContain("aria-expanded={scopes()}")
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
    const modal = component.slice(
      component.indexOf("Run outside the local sandbox"),
      component.indexOf("export interface MessageProps"),
    )

    expect(modal).toContain('props.respond("once")')
    expect(modal).toContain('props.respond("session")')
    expect(modal).toContain('props.respond("project")')
    expect(modal).toContain('props.respond("always")')
    expect(modal).toContain("Every scope is bound to this exact plan")
    expect(modal).toContain("Remote compute approval scope")
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
    expect(component).toContain('aria-label={mutation() ? "Environment change details"')
    expect(component).toContain('["Environment", mutation().environment]')
    expect(component).toContain('["Manager", mutation().manager]')
    expect(component).toContain("A successful change restarts this environment and clears its in-memory state")
    expect(component).toContain('aria-label={mutation() ? "Environment change approval scope"')
  })

  test("keeps exact change approval scopes compact and consistent", async () => {
    const component = await source
    const mutation = component.slice(
      component.indexOf("environment_mutation"),
      component.indexOf("export interface MessageProps"),
    )

    expect(mutation).toContain('props.respond("once")')
    expect(mutation).toContain('props.respond("session")')
    expect(mutation).toContain('props.respond("project")')
    expect(mutation).toContain('props.respond("always")')
    expect(mutation).toContain("Every scope applies only to this exact requested change")
  })
})
