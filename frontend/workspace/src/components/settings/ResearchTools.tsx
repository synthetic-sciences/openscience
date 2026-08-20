import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { Switch } from "@synsci/ui/switch"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { confirmDialog } from "@/atlas/dialogs"
import { URLS } from "@/config/urls"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import {
  RESEARCH_ACCESS_OPTIONS,
  researchAccessContract,
  researchAccessMode,
  researchAccessMutations,
  type ResearchAccessMode,
} from "../research-access"
import { Card, PanelBody, PanelHeader, PanelScroll, Row, RowCopy, Section } from "./_shared"
import { settingsApi } from "./api"
import { dataSharingDetail, searchStatus, type ResearchToolsStatus } from "./research-tools-state"
import "./preference-panels.css"

export default function ResearchTools() {
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  const sdk = useSDK()
  const [state, setState] = createSignal<ResearchToolsStatus>()
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  const [deleting, setDeleting] = createSignal(false)
  const [access, setAccess] = createSignal<{
    root: string
    trusted: boolean
    sandboxEnabled: boolean
    sandboxAvailable: boolean
    sandboxUnavailableReason?: string
  }>()
  const [accessSaving, setAccessSaving] = createSignal(false)
  const fetchFn = () => platform.fetch ?? fetch

  const load = async () => {
    setError(undefined)
    try {
      setState(await settingsApi<ResearchToolsStatus>(server.url, fetchFn(), "/settings/research-tools"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadAccess = async () => {
    if (!sdk.projectID) return
    const [trust, sandboxResponse] = await Promise.all([
      sdk.client.project.trust.get({ projectID: sdk.projectID, directory: sdk.directory }),
      sdk.request("/settings/sandbox"),
    ])
    if (!trust.data) throw new Error("Project trust status was empty.")
    if (!sandboxResponse.ok) throw new Error(await sandboxResponse.text())
    const sandbox = (await sandboxResponse.json()) as {
      config: { enabled?: boolean }
      status?: { available?: boolean; reason?: string }
    }
    setAccess({
      root: trust.data.root,
      trusted: trust.data.canExecuteProjectCode,
      sandboxEnabled: sandbox.config.enabled !== false,
      sandboxAvailable: sandbox.status?.available === true,
      sandboxUnavailableReason: sandbox.status?.reason,
    })
  }

  onMount(() => {
    void load()
    void loadAccess().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  })

  const search = createMemo(() => {
    const current = state()
    return current ? searchStatus(current) : undefined
  })

  const updateSharing = async (analyticsEnabled: boolean) => {
    if (saving()) return
    setSaving(true)
    setError(undefined)
    try {
      setState(
        await settingsApi<ResearchToolsStatus>(server.url, fetchFn(), "/settings/research-tools/telemetry", {
          method: "PUT",
          body: JSON.stringify({ analyticsEnabled }),
        }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const updateAccess = async (mode: ResearchAccessMode) => {
    const current = access()
    if (!sdk.projectID || !current || accessSaving() || researchAccessMode(current) === mode) return
    if (mode !== "full" && !current.sandboxAvailable) return
    if (mode === "full") {
      const confirmed = await confirmDialog(dialog, {
        title: "Enable Full access?",
        message:
          "Full access disables the execution sandbox. OpenScience may run commands with unrestricted file and network access without asking for action approval.",
        confirmLabel: "Enable Full access",
        danger: true,
      })
      if (!confirmed) return
    }
    setAccessSaving(true)
    try {
      let next = { ...current }
      for (const mutation of researchAccessMutations(mode)) {
        if (mutation.kind === "sandbox") {
          if (next.sandboxEnabled === mutation.enabled) continue
          const response = await sdk.request("/settings/sandbox", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: mutation.enabled }),
          })
          if (!response.ok) throw new Error(await response.text())
          const payload = (await response.json()) as { config: { enabled?: boolean } }
          next.sandboxEnabled = payload.config.enabled !== false
          continue
        }
        if (next.trusted === mutation.trusted) continue
        const result = await sdk.client.project.trust.update({
          projectID: sdk.projectID,
          directory: sdk.directory,
          body: mutation.trusted ? { trusted: true, root: next.root } : { trusted: false },
        })
        if (!result.data) throw new Error("Project trust update was empty.")
        next = { ...next, root: result.data.root, trusted: result.data.canExecuteProjectCode }
      }
      setAccess(next)
      showToast({
        variant: "success",
        title: `${RESEARCH_ACCESS_OPTIONS.find((item) => item.value === mode)?.label} enabled`,
      })
    } catch (cause) {
      showToast({
        variant: "error",
        title: "Access setting failed",
        description: cause instanceof Error ? cause.message : String(cause),
      })
      void loadAccess()
    } finally {
      setAccessSaving(false)
    }
  }

  const deleteAccountAnalytics = async () => {
    const confirmed = await confirmDialog(dialog, {
      title: "Delete account analytics?",
      message:
        "This deletes content-free usage analytics linked to your account. Local research, conversations, files, and artifacts are unaffected.",
      confirmLabel: "Delete analytics",
      danger: true,
    })
    if (!confirmed) return
    setDeleting(true)
    try {
      const result = await settingsApi<{ ok: boolean; message?: string }>(
        server.url,
        fetchFn(),
        "/settings/research-tools/telemetry/account-data",
        { method: "DELETE" },
      )
      if (!result.ok) throw new Error(result.message || "Account analytics could not be deleted.")
      await load()
      showToast({ title: "Analytics deleted", description: "Gateway deleted account-linked usage analytics." })
    } catch (cause) {
      showToast({
        variant: "error",
        title: "Analytics deletion failed",
        description: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--research-tools">
        <PanelHeader
          title="Research tools"
          description="See your plan, search allowance, and exactly what structural usage OpenScience may share."
        />
        <PanelBody>
          <Show when={error()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              <span>{error()}</span>
              <button type="button" class="settings-preference-action" onClick={() => void load()}>
                Retry
              </button>
            </div>
          </Show>

          <Section
            title="Plan and search"
            description="Managed search is included by plan; community search stays model-route dependent."
          >
            <Card>
              <Row>
                <span class="settings-preference-icon">
                  <Icon name="star" size="small" />
                </span>
                <RowCopy
                  title={state()?.plan.label ?? "Loading…"}
                  description={
                    state()?.signedIn ? "Current OpenScience plan" : "Sign in to see managed plan entitlements"
                  }
                />
                <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.dashboardBilling)}>
                  Manage plan
                </Button>
              </Row>
              <Row>
                <span class="settings-preference-icon" data-tone={search()?.tone}>
                  <Icon name="magnifying-glass" size="small" />
                </span>
                <RowCopy title={`${search()?.label ?? "Loading…"} search`} description={search()?.detail} />
                <Show when={search()}>
                  {(value) => (
                    <span class="settings-preference-status" data-tone={value().tone} aria-live="polite">
                      {value().label}
                    </span>
                  )}
                </Show>
              </Row>
            </Card>
          </Section>

          <Section
            title="Action approval"
            description="Choose how project commands are approved. Existing project trust and sandbox choices are preserved."
          >
            <div class="settings-research-access" role="radiogroup" aria-label="Research action approval">
              <For each={RESEARCH_ACCESS_OPTIONS}>
                {(option) => {
                  const contract = () => researchAccessContract(option.value)
                  const unavailable = () => option.value !== "full" && access()?.sandboxAvailable === false
                  return (
                    <button
                      type="button"
                      role="radio"
                      data-tone={option.value === "full" ? "warning" : undefined}
                      aria-checked={access() ? researchAccessMode(access()!) === option.value : false}
                      disabled={!access() || accessSaving() || unavailable()}
                      onClick={() => void updateAccess(option.value)}
                    >
                      <span class="settings-research-access__mark" aria-hidden="true" />
                      <span>
                        <strong>{option.label}</strong>
                        <small>
                          {unavailable()
                            ? `Unavailable: ${access()?.sandboxUnavailableReason ?? "sandbox backend not installed"}`
                            : option.description}
                        </small>
                        <code>
                          {contract().sandbox} · {contract().approval} · {contract().review}
                        </code>
                      </span>
                    </button>
                  )
                }}
              </For>
            </div>
          </Section>

          <Section
            title="Data sharing"
            description="Help improve reliability with bounded, content-free structural usage from completed actions."
          >
            <Card>
              <Row>
                <span
                  class="settings-preference-icon"
                  data-tone={state()?.telemetry.analyticsEnabled ? "success" : undefined}
                >
                  <Icon name="activity" size="small" />
                </span>
                <RowCopy
                  title="Share structural usage"
                  description={state() ? dataSharingDetail(state()!) : "Loading consent…"}
                />
                <Switch
                  hideLabel
                  checked={state()?.telemetry.analyticsEnabled ?? false}
                  disabled={!state() || saving()}
                  onChange={(enabled) => void updateSharing(enabled)}
                >
                  Share content-free structural usage
                </Switch>
              </Row>
              <Row>
                <span class="settings-preference-icon" data-tone="success">
                  <Icon name="shield" size="small" />
                </span>
                <RowCopy
                  title="Research content is never shared"
                  description="Prompts, responses, tool inputs and outputs, retrieved content, URLs, file paths, file contents, and secret values are excluded."
                />
                <span class="settings-preference-status" data-tone="success">
                  Always off
                </span>
              </Row>
            </Card>
            <p class="settings-research-tools-note">
              Sharing is on by default for new installations and accounts, disclosed here, and can be disabled at any
              time. Events are allowlisted, bounded, and sent only after an assistant response, tool, or artifact
              completes. This is separate from the local session trace and billing.
            </p>
          </Section>

          <Show when={state()?.telemetry.deletionAvailable}>
            <Section
              title="Account analytics"
              description="Remove previously collected structural usage linked to this account."
            >
              <Card>
                <Row>
                  <span class="settings-preference-icon">
                    <Icon name="trash" size="small" />
                  </span>
                  <RowCopy
                    title="Delete account analytics"
                    description="This does not delete local projects, conversations, files, artifacts, or research results."
                  />
                  <button
                    type="button"
                    class="settings-preference-action"
                    data-variant="danger"
                    disabled={deleting()}
                    onClick={() => void deleteAccountAnalytics()}
                  >
                    {deleting() ? "Deleting…" : "Delete analytics"}
                  </button>
                </Row>
              </Card>
            </Section>
          </Show>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}
