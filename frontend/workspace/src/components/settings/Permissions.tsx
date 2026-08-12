// Permissions — the standing approvals granted from permission cards (project
// and machine scope, revocable here) plus the per-tool allow/ask/deny defaults
// the agent loop enforces (config `permission` key via the globalSync-backed
// component).
//
// The former "Registry actions" grant grid was removed deliberately: it
// persisted scopes to a JSON store that no backend path ever consulted, so the
// controls were display-only. Per the product truth pass, surfaces without a
// real end-to-end runtime path are removed rather than shown.
import { Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { resolveProjectRoute } from "@/utils/project-route"
import { PermissionToolDefaults } from "../settings-permissions"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import "./preference-panels.css"

interface StandingApproval {
  id: string
  permission: string
  pattern: string
  scope: "project" | "global"
  created: number
}

const Permissions: Component = () => {
  const params = useParams()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const [showAllDefaults, setShowAllDefaults] = createSignal(false)

  const route = createMemo(() => resolveProjectRoute(params.dir, globalSync.data.project))

  const [standing, { refetch }] = createResource(
    () => route()?.directory ?? false,
    async (directory) => {
      const response = await sdk.client.permission.standing.list({ directory })
      return (response.data ?? []) as StandingApproval[]
    },
  )

  const [trust, trustControls] = createResource(
    () => {
      const value = route()
      if (!value) return
      return { projectID: value.projectID, directory: value.directory }
    },
    async (input) => {
      const response = await sdk.client.project.trust.get(input)
      if (!response.data) throw new Error("Project trust status was empty.")
      return response.data
    },
  )

  const revoke = async (approval: StandingApproval) => {
    const directory = route()?.directory
    if (!directory) return
    setBusy(true)
    try {
      await sdk.client.permission.standing.revoke({ id: approval.id, directory })
      await refetch()
    } catch (err) {
      showToast({ title: "Failed to revoke approval", description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const when = (created: number) => new Date(created).toLocaleDateString()

  const updateTrust = async (trusted: boolean) => {
    const value = route()
    const status = trust()
    if (!value || !status || busy()) return
    const confirmed = await confirmDialog(dialog, {
      title: trusted ? "Trust this project?" : "Revoke project trust?",
      message: trusted
        ? `Allow project code under ${status.root} to run using the current execution policy. If sandboxing is off or unavailable and fallback permits it, code may run with your user authority. Review Sandbox settings first.`
        : "New terminals, kernels, package installs, and compute jobs will stay blocked until you trust this project again. Existing processes are stopped when trust is revoked.",
      confirmLabel: trusted ? "Trust project" : "Revoke trust",
      danger: !trusted,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      await sdk.client.project.trust.update({
        projectID: value.projectID,
        directory: value.directory,
        body: trusted ? { trusted: true, root: status.root } : { trusted: false },
      })
      await trustControls.refetch()
      showToast({
        variant: "success",
        title: trusted ? "Project trusted" : "Project trust revoked",
      })
    } catch (error) {
      showToast({
        title: trusted ? "Could not trust project" : "Could not revoke project trust",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--permissions">
        <PanelHeader title="Permissions" description="Control project trust, approvals, and tool behavior." />
        <PanelBody>
          <Show when={route()}>
            <Section
              title="Project execution"
              description="Project code runs only after you trust its current location."
            >
              <div class="settings-card settings-preferences-card">
                <Show
                  when={!trust.loading}
                  fallback={<div class="settings-panel-loading-copy">Checking project trust…</div>}
                >
                  <Show
                    when={!trust.error}
                    fallback={
                      <div class="settings-row settings-preference-row" role="alert">
                        <span class="settings-preference-icon" data-tone="warning" aria-hidden="true">
                          <Icon name="alert-circle" size="small" />
                        </span>
                        <span class="min-w-0 flex-1 text-12-regular text-text-danger">
                          Project trust could not be loaded. {String(trust.error)}
                        </span>
                        <Button size="small" variant="ghost" onClick={() => void trustControls.refetch()}>
                          Retry
                        </Button>
                      </div>
                    }
                  >
                    <div class="settings-row settings-preference-row justify-between">
                      <span
                        class="settings-preference-icon"
                        data-tone={trust()?.canExecuteProjectCode ? "success" : "warning"}
                        aria-hidden="true"
                      >
                        <Icon name={trust()?.canExecuteProjectCode ? "shield" : "shield-alert"} size="small" />
                      </span>
                      <div class="settings-row-copy">
                        <strong>{trust()?.canExecuteProjectCode ? "Trusted project" : "Execution blocked"}</strong>
                        <span class="text-11-regular text-text-weak break-all">{trust()?.root}</span>
                      </div>
                      <span
                        class="settings-preference-status"
                        data-tone={trust()?.canExecuteProjectCode ? "success" : "warning"}
                      >
                        {trust()?.canExecuteProjectCode ? "Trusted" : "Blocked"}
                      </span>
                      <Button
                        size="small"
                        variant={trust()?.canExecuteProjectCode ? "ghost" : "secondary"}
                        disabled={busy() || !trust()}
                        onClick={() => void updateTrust(!trust()?.canExecuteProjectCode)}
                      >
                        {trust()?.canExecuteProjectCode ? "Revoke trust" : "Trust project"}
                      </Button>
                    </div>
                  </Show>
                </Show>
              </div>
            </Section>
          </Show>

          {/* ── Standing approvals ── */}
          <Show when={route()}>
            <Section
              title="Standing approvals"
              description="Approvals granted for this project or every project. Revoke one to ask again next time."
            >
              <div class="settings-card settings-preferences-card">
                <Show
                  when={!standing.loading}
                  fallback={<div class="settings-panel-loading-copy">Loading standing approvals…</div>}
                >
                  <Show
                    when={!standing.error}
                    fallback={
                      <div class="settings-row settings-preference-row" role="alert">
                        <span class="settings-preference-icon" data-tone="warning" aria-hidden="true">
                          <Icon name="alert-circle" size="small" />
                        </span>
                        <span class="min-w-0 flex-1 text-12-regular text-text-danger">
                          Standing approvals could not be loaded. {String(standing.error)}
                        </span>
                        <Button size="small" variant="ghost" disabled={standing.loading} onClick={() => void refetch()}>
                          Retry
                        </Button>
                      </div>
                    }
                  >
                    <Show
                      when={(standing() ?? []).length > 0}
                      fallback={
                        <div class="settings-row settings-preference-row">
                          <span class="settings-preference-icon" aria-hidden="true">
                            <Icon name="checklist" size="small" />
                          </span>
                          <span class="min-w-0 flex-1 text-12-regular text-text-weak">
                            No standing approvals yet. Conversation-scoped approvals end with their session and are
                            never listed here.
                          </span>
                        </div>
                      }
                    >
                      <For each={standing()}>
                        {(approval) => (
                          <div class="settings-row settings-preference-row justify-between">
                            <span class="settings-preference-icon" aria-hidden="true">
                              <Icon name="checklist" size="small" />
                            </span>
                            <div class="settings-row-copy">
                              <strong class="break-all">
                                {approval.permission}
                                <Show when={approval.pattern !== "*"}>
                                  <span class="text-text-weak font-normal"> · {approval.pattern}</span>
                                </Show>
                              </strong>
                              <span class="text-11-regular text-text-weak">
                                {approval.scope === "global" ? "Everywhere" : "This project"} · granted{" "}
                                {when(approval.created)}
                              </span>
                            </div>
                            <span class="ml-auto shrink-0">
                              <Button
                                size="small"
                                variant="ghost"
                                disabled={busy()}
                                onClick={() => void revoke(approval)}
                              >
                                Revoke
                              </Button>
                            </span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                </Show>
              </div>
            </Section>
          </Show>

          {/* Tool defaults are a long list, so keep the most common controls visible first. */}
          <div
            id="permission-tool-defaults"
            class="settings-permission-defaults settings-disclosure-group"
            data-expanded={showAllDefaults() ? "true" : "false"}
          >
            <PermissionToolDefaults />
            <div class="settings-disclosure-footer">
              <button
                type="button"
                class="settings-preference-action"
                data-variant="quiet"
                aria-expanded={showAllDefaults()}
                aria-controls="permission-tool-defaults"
                onClick={() => setShowAllDefaults((value) => !value)}
              >
                <Icon
                  name="chevron-down"
                  size="small"
                  classList={{ "rotate-180": showAllDefaults() }}
                  aria-hidden="true"
                />
                {showAllDefaults() ? "Show fewer tool defaults" : "Show all tool defaults"}
              </button>
            </div>
          </div>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

export default Permissions
