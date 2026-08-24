import { useParams } from "@solidjs/router"
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { Switch } from "@synsci/ui/switch"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { confirmDialog } from "@/atlas/dialogs"
import { URLS } from "@/config/urls"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { createProjectRequest } from "@/utils/openscience-fetch"
import { resolveProjectRoute } from "@/utils/project-route"
import {
  RESEARCH_ACCESS_OPTIONS,
  researchAccessContract,
  researchAccessMode,
  researchAccessMutations,
  type ResearchAccessMode,
} from "../research-access"
import { Card, PanelBody, PanelHeader, PanelScroll, Row, RowCopy, Section } from "./_shared"
import { settingsApi } from "./api"
import { dataSharingDetail, dataSharingEnabled, searchStatus, type ResearchToolsStatus } from "./research-tools-state"
import "./preference-panels.css"

export default function ResearchTools() {
  const params = useParams()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const route = createMemo(() => resolveProjectRoute(params.dir, globalSync.data.project))
  const [state, setState] = createSignal<ResearchToolsStatus>()
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  const [access, setAccess] = createSignal<{
    root: string
    trusted: boolean
    sandboxEnabled: boolean
    sandboxAvailable: boolean
    sandboxUnavailableReason?: string
  }>()
  const [accessSaving, setAccessSaving] = createSignal(false)
  const fetchFn = () => platform.fetch ?? fetch
  const projectRequest = createProjectRequest({
    baseUrl: () => sdk.url,
    fetch: fetchFn,
    directory: () => route()?.directory ?? "",
    projectID: () => route()?.projectID,
  })

  const load = async () => {
    setError(undefined)
    try {
      setState(await settingsApi<ResearchToolsStatus>(server.url, fetchFn(), "/settings/research-tools"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadAccess = async (project: NonNullable<ReturnType<typeof route>>) => {
    const [trust, sandboxResponse] = await Promise.all([
      sdk.client.project.trust.get({ projectID: project.projectID, directory: project.directory }),
      projectRequest("/settings/sandbox"),
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
  })

  createEffect(() => {
    const project = route()
    if (!project) {
      setAccess(undefined)
      return
    }
    void loadAccess(project).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  })

  const search = createMemo(() => {
    const current = state()
    return current ? searchStatus(current) : undefined
  })
  const sharingEnabled = createMemo(() => {
    const current = state()
    return current ? dataSharingEnabled(current) : false
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
    const project = route()
    const current = access()
    if (!project || !current || accessSaving() || researchAccessMode(current) === mode) return
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
          const response = await projectRequest("/settings/sandbox", {
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
          projectID: project.projectID,
          directory: project.directory,
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
      void loadAccess(project)
    } finally {
      setAccessSaving(false)
    }
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--research-tools">
        <PanelHeader
          title="Research tools"
          description="Manage research access, search, and how OpenScience uses your activity."
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

          <Section title="Search" description="The Ace wallet covers credit-backed models and enhanced search.">
            <Card>
              <Row>
                <span class="settings-preference-icon" data-tone={search()?.tone}>
                  <Icon name="magnifying-glass" size="small" />
                </span>
                <RowCopy
                  title="Research search"
                  description={search()?.detail ?? "Basic community search is available. Checking enhanced search…"}
                />
                <Show when={search()}>
                  {(value) => (
                    <span class="settings-preference-status" data-tone={value().tone} aria-live="polite">
                      {value().label}
                    </span>
                  )}
                </Show>
                <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.dashboardBilling)}>
                  Open billing
                </Button>
              </Row>
            </Card>
          </Section>

          <Section
            title="Action approval"
            description="Choose how project commands are approved. Existing project trust and sandbox choices are preserved."
          >
            <Show
              when={route()}
              fallback={
                <Card>
                  <Row>
                    <span class="settings-preference-icon" aria-hidden="true">
                      <Icon name="folder" size="small" />
                    </span>
                    <RowCopy
                      title="Open a project to manage action approval"
                      description="Project trust and sandbox choices are available after you open a project."
                    />
                  </Row>
                </Card>
              }
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
            </Show>
          </Section>

          <Section title="Data use" description="Choose whether activity from this device helps improve OpenScience.">
            <Card>
              <Row>
                <span class="settings-preference-icon" data-tone={sharingEnabled() ? "success" : undefined}>
                  <Icon name="activity" size="small" />
                </span>
                <RowCopy
                  title="Use my data to improve OpenScience"
                  description={state() ? dataSharingDetail(state()!) : "Loading consent…"}
                />
                <Switch
                  hideLabel
                  checked={sharingEnabled()}
                  disabled={!state() || saving()}
                  onChange={(enabled) => void updateSharing(enabled)}
                >
                  Use my data to improve OpenScience
                </Switch>
              </Row>
            </Card>
          </Section>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}
