import { createSignal, createResource, type JSX, Show } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { useDialog } from "@synsci/ui/context/dialog"
import { IconRefresh, IconArrowRight } from "@/atlas/shared/Icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { resolveServerRoute } from "@/config/server-url"
import "./FdaBanner.css"

interface ProbeResult {
  fda: boolean
  reason?: "permission_denied"
}

const DISMISS_KEY = "atlas.fda.banner.hidden"

async function probeFda(server: string): Promise<ProbeResult> {
  try {
    const res = await fetch(resolveServerRoute("/api/resolve-folder/probe", server, window.location.origin))
    if (!res.ok) return { fda: true }
    return await res.json()
  } catch {
    return { fda: true }
  }
}

function detectOS(): "mac" | "win" | "linux" {
  if (typeof navigator === "undefined") return "mac"
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes("mac")) return "mac"
  if (ua.includes("win")) return "win"
  return "linux"
}

const SETTINGS_URL: Record<"mac" | "win" | "linux", string | null> = {
  mac: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  win: null,
  linux: null,
}

const STEP_TITLE: Record<"mac" | "win" | "linux", string> = {
  mac: "Allow project folder access",
  win: "Allow project folder access",
  linux: "Allow project folder access",
}

const STEP_BODY: Record<"mac" | "win" | "linux", string> = {
  mac: "macOS denied OpenScience access to a protected folder. Grant access to the terminal or app that started this server, then relaunch it.",
  win: "Windows denied OpenScience access to this project folder. Relaunch it from a terminal with access to the folder.",
  linux:
    "Linux denied OpenScience access to this project folder. Relaunch it outside a confined shell or grant the shell access.",
}

/**
 * Tiny status chip that surfaces only after an explicit protected-folder
 * permission denial. Lives next to the new-project button; click opens a
 * compact recovery sheet with a deliberate settings link and recheck.
 */
function FdaChip(): JSX.Element {
  const sdk = useGlobalSDK()
  const [dismissed, setDismissed] = createSignal(
    typeof localStorage !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1",
  )
  const [probe, { refetch }] = createResource(() => sdk.url, probeFda)
  const dialog = useDialog()

  const recheck = async () => {
    const r = await refetch()
    if (r?.fda) dialog.close()
  }

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {}
    setDismissed(true)
  }

  const openSheet = () => {
    const os = detectOS()
    dialog.show(
      () => (
        <FdaSheet
          os={os}
          onRecheck={recheck}
          onDismiss={() => {
            dismiss()
            dialog.close()
          }}
        />
      ),
      () => {},
    )
  }

  return (
    <Show when={!dismissed() && !probe.loading && probe()?.fda === false}>
      <button type="button" class="folder-access-chip" onClick={openSheet} title="Project folder access is blocked">
        <span class="folder-access-chip__dot" aria-hidden="true" />
        Folder access
      </button>
    </Show>
  )
}

function FdaSheet(props: {
  os: "mac" | "win" | "linux"
  onRecheck: () => Promise<void>
  onDismiss: () => void
}): JSX.Element {
  const url = () => SETTINGS_URL[props.os]
  const [busy, setBusy] = createSignal(false)
  return (
    <Dialog title={STEP_TITLE[props.os]} description={STEP_BODY[props.os]} class="folder-access-dialog" fit transition>
      <section class="folder-access-sheet" aria-label="Folder access recovery">
        <div class="folder-access-status">
          <span class="folder-access-status__dot" aria-hidden="true" />
          <span>
            <strong>Protected folders are unavailable</strong>
            <small>You can keep working with folders this process is allowed to read.</small>
          </span>
        </div>
        <Show when={props.os === "mac"}>
          <ol class="folder-access-steps">
            <li>
              <span>Open Privacy &amp; Security → Full Disk Access.</span>
            </li>
            <li>
              <span>Enable the terminal or desktop app you used to launch OpenScience.</span>
            </li>
            <li>
              <span>
                If you launch the executable directly, run <code>which openscience</code> in that shell to locate it.
              </span>
            </li>
            <li>
              <span>Quit and relaunch OpenScience, then recheck access.</span>
            </li>
          </ol>
        </Show>
        <div class="folder-access-actions">
          <Show when={url()}>
            <a href={url()!} target="_self" class="folder-access-action folder-access-action--primary">
              <IconArrowRight size={12} strokeWidth={1.5} />
              Open privacy settings
            </a>
          </Show>
          <button
            type="button"
            class="folder-access-action folder-access-action--secondary"
            onClick={async () => {
              setBusy(true)
              await props.onRecheck()
              setBusy(false)
            }}
            disabled={busy()}
          >
            <IconRefresh size={12} strokeWidth={1.5} />
            {busy() ? "Checking…" : "Recheck"}
          </button>
          <button type="button" class="folder-access-action folder-access-action--dismiss" onClick={props.onDismiss}>
            Dismiss
          </button>
        </div>
      </section>
    </Dialog>
  )
}

// Backwards-compat: home.tsx still imports FdaBanner. Re-export the chip.
export const FdaBanner = FdaChip
