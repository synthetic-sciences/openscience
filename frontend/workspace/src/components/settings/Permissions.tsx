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

interface FolderGrant {
  id: string
  path: string
  access: "read" | "write"
  scope: "once" | "session" | "project" | "installation"
  source: "permission" | "api"
  time: { created: number }
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

  const [folders, folderControls] = createResource(
    () => {
      const value = route()
      const sessionID = params.id
      if (!value || !sessionID || sessionID === "new") return
      return { sessionID, directory: value.directory }
    },
    async (input) => {
      const response = await sdk.client.session.filesystem.list(input)
      return (response.data?.grants ?? []).filter(
        (grant): grant is FolderGrant =>
          (grant.source === "permission" || grant.source === "api") && !grant.time.consumed && !grant.time.revoked,
      )
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

  const revokeFolder = async (grant: FolderGrant) => {
    const value = route()
    const sessionID = params.id
    if (!value || !sessionID || busy()) return
    const confirmed = await confirmDialog(dialog, {
      title: `Revoke access to ${grant.path}?`,
      message: "OpenScience will stop affected kernels so the folder cannot remain mounted with stale access.",
      confirmLabel: "Revoke folder access",
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    await sdk.client.session.filesystem
      .revoke({ sessionID, grantID: grant.id, directory: value.directory })
      .then(() => folderControls.refetch())
      .catch((error) =>
        showToast({
          title: "Failed to revoke folder access",
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setBusy(false))
  }

  const updateTrust = async (trusted: boolean) => {
    const value = route()
    const status = trust()
    if (!value || !status || busy()) return
    const confirmed = await confirmDialog(dialog, {
      title: trusted ? "Trust this project?" : "Revoke project trust?",
      message: trusted
        ? `Allow project-owned code under ${status.root}, including plugins, MCP servers, formatters, language servers, provider commands, and startup hooks. Trust also permits remote jobs, kernel environment changes such as package installs, and host execution when the sandbox is off or explicitly configured to fall back without containment. Sandboxed terminals, kernels, and local jobs do not require project trust unless you enable that stricter policy in Sandbox settings.`
        : "Remote jobs, kernel environment changes such as package installs, project-owned extensions, and unsandboxed execution will be blocked. Existing project processes are stopped. Sandboxed terminals, kernels, and local jobs remain available unless Sandbox settings require project trust for all execution.",
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
              title="Project code"
              description="Trust remote jobs, kernel environment changes, project-owned extensions, and host execution separately from routine sandboxed work."
            >
              <div class="settings-card settings-preferences-card">
                <Show
                  when={!trust.loading}
                  fallback={
                    <div class="settings-panel-loading__rows" role="status" aria-label="Checking project trust">
                      <span />
                    </div>
                  }
                >
                  <Show
                    when={!trust.error}
                    fallback={
                      <div class="settings-alert" data-tone="critical" role="alert">
                        <span>Project trust could not be loaded. {String(trust.error)}</span>
                        <Button
                          size="small"
                          variant="secondary"
                          class="settings-panel-action"
                          onClick={() => void trustControls.refetch()}
                        >
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
                        <strong>
                          {trust()?.canExecuteProjectCode ? "Project code enabled" : "Project extensions blocked"}
                        </strong>
                        <span class="text-11-regular text-text-weak break-all">{trust()?.root}</span>
                      </div>
                      <span
                        class="settings-preference-status"
                        data-tone={trust()?.canExecuteProjectCode ? "success" : "warning"}
                      >
                        {trust()?.canExecuteProjectCode ? "Trusted" : "Restricted"}
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

          <Show when={route() && params.id && params.id !== "new"}>
            <Section
              title="Connected folders"
              description="Review durable read-only and read-write access from the active research session."
            >
              <div class="settings-card settings-preferences-card">
                <Show
                  when={!folders.loading}
                  fallback={
                    <div class="settings-panel-loading__rows" role="status" aria-label="Loading connected folders">
                      <span />
                    </div>
                  }
                >
                  <Show
                    when={!folders.error}
                    fallback={
                      <div class="settings-alert" data-tone="critical" role="alert">
                        <span>Connected folders could not be loaded.</span>
                        <Button
                          size="small"
                          variant="secondary"
                          class="settings-panel-action"
                          onClick={() => void folderControls.refetch()}
                        >
                          Retry
                        </Button>
                      </div>
                    }
                  >
                    <Show
                      when={(folders() ?? []).length > 0}
                      fallback={
                        <p class="settings-card-empty" role="status">
                          No connected folders in this session.
                        </p>
                      }
                    >
                      <For each={folders()}>
                        {(grant) => (
                          <div class="settings-row settings-preference-row justify-between">
                            <div class="settings-row-copy">
                              <strong class="break-all">{grant.path}</strong>
                              <span class="text-11-regular text-text-weak">
                                {grant.access === "write" ? "Read & write" : "Read only"} ·{" "}
                                {grant.scope === "installation"
                                  ? "Every project"
                                  : grant.scope === "project"
                                    ? "This project"
                                    : "This session"}
                              </span>
                            </div>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={busy()}
                              onClick={() => void revokeFolder(grant)}
                            >
                              Revoke
                            </Button>
                          </div>
                        )}
                      </For>
                    </Show>
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
                  fallback={
                    <div class="settings-panel-loading__rows" role="status" aria-label="Loading standing approvals">
                      <span />
                      <span />
                    </div>
                  }
                >
                  <Show
                    when={!standing.error}
                    fallback={
                      <div class="settings-alert" data-tone="critical" role="alert">
                        <span>Standing approvals could not be loaded. {String(standing.error)}</span>
                        <Button
                          size="small"
                          variant="secondary"
                          class="settings-panel-action"
                          disabled={standing.loading}
                          onClick={() => void refetch()}
                        >
                          Retry
                        </Button>
                      </div>
                    }
                  >
                    <Show
                      when={(standing() ?? []).length > 0}
                      fallback={
                        <p class="settings-card-empty" role="status">
                          No standing approvals yet. Conversation-scoped approvals end with their session.
                        </p>
                      }
                    >
                      <For each={standing()}>
                        {(approval) => (
                          <div class="settings-row settings-preference-row justify-between">
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
