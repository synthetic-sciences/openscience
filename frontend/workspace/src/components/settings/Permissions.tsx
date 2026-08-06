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
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { resolveProjectRoute } from "@/utils/project-route"
import { PermissionToolDefaults } from "../settings-permissions"

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
  const [busy, setBusy] = createSignal(false)

  const route = createMemo(() => resolveProjectRoute(params.dir, globalSync.data.project))

  const [standing, { refetch }] = createResource(
    () => route()?.directory ?? false,
    async (directory) => {
      const response = await sdk.client.permission.standing.list({ directory })
      return (response.data ?? []) as StandingApproval[]
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
    }
    setBusy(false)
  }

  const when = (created: number) => new Date(created).toLocaleDateString()

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">Permissions</h2>
          <p class="text-13-regular text-text-weak">
            Standing approvals you have granted, and how the agent may use tools.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 px-4 pb-12 sm:px-8 max-w-[760px]">
        {/* ── Standing approvals ── */}
        <Show when={route()}>
          <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-0.5">
              <h3 class="text-13-medium text-text-weak tracking-wide">Standing approvals</h3>
              <p class="text-12-regular text-text-weak">
                Granted from permission cards with “This project” or “Always” scope. Revoking one makes that action
                prompt again.
              </p>
            </div>

            <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
              <Show
                when={(standing() ?? []).length > 0}
                fallback={
                  <div class="px-4 py-5 text-12-regular text-text-weak">
                    No standing approvals yet. Conversation-scoped approvals end with their session and are never listed
                    here.
                  </div>
                }
              >
                <For each={standing()}>
                  {(approval) => (
                    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border-weak-base last:border-none">
                      <div class="flex flex-col gap-0.5 min-w-0">
                        <span class="text-13-medium text-text-strong break-all">
                          {approval.permission}
                          <Show when={approval.pattern !== "*"}>
                            <span class="text-text-weak font-normal"> · {approval.pattern}</span>
                          </Show>
                        </span>
                        <span class="text-11-regular text-text-weak">
                          {approval.scope === "global" ? "Everywhere" : "This project"} · granted{" "}
                          {when(approval.created)}
                        </span>
                      </div>
                      <Button size="small" variant="ghost" disabled={busy()} onClick={() => void revoke(approval)}>
                        Revoke
                      </Button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Show>

        {/* ── Tool defaults (config-backed) ── */}
        <PermissionToolDefaults />
      </div>
    </div>
  )
}

export default Permissions
