import { useParams } from "@solidjs/router"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { createProjectRequest } from "@/utils/openscience-fetch"
import { resolveProjectRoute } from "@/utils/project-route"
import {
  RESEARCH_ACCESS_OPTIONS,
  researchAccessContract,
  researchAccessMode,
  type ResearchAccessMode,
} from "../research-access"
import { Card, PanelBody, PanelHeader, PanelScroll, Row, RowCopy, Section } from "./_shared"
import "./preference-panels.css"

export default function ResearchTools() {
  const params = useParams()
  const platform = usePlatform()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const route = createMemo(() => resolveProjectRoute(params.dir, globalSync.data.project))
  const [error, setError] = createSignal<string>()
  const [access, setAccess] = createSignal<{
    root: string
    mode: ResearchAccessMode
    requestedMode: ResearchAccessMode
    sandboxStatus: { available: boolean; reason?: string }
  }>()
  const [accessSaving, setAccessSaving] = createSignal(false)
  const fetchFn = () => platform.fetch ?? fetch
  const projectRequest = createProjectRequest({
    baseUrl: () => sdk.url,
    fetch: fetchFn,
    directory: () => route()?.directory ?? "",
    projectID: () => route()?.projectID,
  })

  const loadAccess = async (project: NonNullable<ReturnType<typeof route>>) => {
    const response = await projectRequest(`/project/${encodeURIComponent(project.projectID)}/access`)
    if (!response.ok) throw new Error(await response.text())
    setAccess(await response.json())
    setError(undefined)
  }

  createEffect(() => {
    const project = route()
    if (!project) {
      setAccess(undefined)
      return
    }
    void loadAccess(project).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  })

  const updateAccess = async (mode: ResearchAccessMode) => {
    const project = route()
    const current = access()
    if (!project || !current || accessSaving() || researchAccessMode(current) === mode) return
    if (mode === "full") {
      const confirmed = await confirmDialog(dialog, {
        title: "Enable Full access?",
        message:
          "Full access disables the execution sandbox and routine action prompts. Credential and paid-compute boundaries still apply.",
        confirmLabel: "Enable Full access",
        danger: true,
      })
      if (!confirmed) return
    }
    setAccessSaving(true)
    try {
      const response = await projectRequest(`/project/${encodeURIComponent(project.projectID)}/access`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, ...(mode === "ask" ? {} : { root: current.root }) }),
      })
      if (!response.ok) throw new Error(await response.text())
      const confirmed = (await response.json()) as NonNullable<ReturnType<typeof access>>
      setAccess(confirmed)
      const effective = researchAccessMode(confirmed)
      if (effective !== mode) {
        showToast({
          variant: "error",
          title: "Access is limited by local policy",
          description: `The effective mode remains ${RESEARCH_ACCESS_OPTIONS.find((item) => item.value === effective)?.label ?? "Restricted access"}.`,
        })
        return
      }
      showToast({
        variant: "success",
        title: `${RESEARCH_ACCESS_OPTIONS.find((item) => item.value === effective)?.label} enabled`,
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
          description="Choose how local research tools can act inside the open project."
        />
        <PanelBody>
          <Show when={error()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              <span>{error()}</span>
              <button
                type="button"
                class="settings-preference-action"
                onClick={() => {
                  const project = route()
                  if (project) void loadAccess(project)
                }}
              >
                Retry
              </button>
            </div>
          </Show>

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
                    const unavailable = () => option.value !== "full" && access()?.sandboxStatus.available === false
                    return (
                      <button
                        type="button"
                        role="radio"
                        data-tone={option.value === "full" ? "warning" : undefined}
                        aria-checked={access() ? researchAccessMode(access()!) === option.value : false}
                        disabled={!access() || accessSaving()}
                        onClick={() => void updateAccess(option.value)}
                      >
                        <span class="settings-research-access__mark" aria-hidden="true" />
                        <span>
                          <strong>{option.label}</strong>
                          <small>
                            {unavailable()
                              ? `Fail-closed until setup: ${access()?.sandboxStatus.reason ?? "sandbox backend not installed"}`
                              : option.description}
                          </small>
                          <code>
                            {contract().sandbox} · {contract().approval} · {contract().boundary}
                          </code>
                        </span>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>
          </Section>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}
