import { createSignal, createResource, type JSX, Show, onMount } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { useDialog } from "@synsci/ui/context/dialog"
import { FONT_CODE, FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { IconRefresh, IconArrowRight } from "@/thesis/shared/Icon"

interface ProbeResult {
  fda: boolean
  reason?: string
}

const DISMISS_KEY = "thesis.fda.banner.hidden"

async function probeFda(): Promise<ProbeResult> {
  try {
    const res = await fetch("/api/resolve-folder/probe")
    if (!res.ok) return { fda: false, reason: `probe ${res.status}` }
    return await res.json()
  } catch (err: any) {
    return { fda: false, reason: err?.message ?? "network error" }
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
  mac: "Grant Full Disk Access",
  win: "Filesystem access",
  linux: "Filesystem access",
}

const STEP_BODY: Record<"mac" | "win" | "linux", string> = {
  mac: "macOS blocks ~/Desktop · ~/Documents · ~/Downloads from any process that doesn't have Full Disk Access. Add the openscience binary itself to the FDA list — that way it works no matter which shell you launch it from.",
  win: "Run openscience from Windows Terminal / PowerShell — not a sandboxed Microsoft Store shell.",
  linux: "Run openscience from a system shell, not a confined Snap/Flatpak terminal.",
}

/**
 * Tiny status chip that surfaces only when Full Disk Access is missing.
 * Lives next to the "+ new project" button on home; click → small sheet
 * with a one-tap deep-link to System Settings (mac) and a recheck.
 */
export function FdaChip(): JSX.Element {
  const [dismissed, setDismissed] = createSignal(
    typeof localStorage !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1",
  )
  const [refreshKey, setRefreshKey] = createSignal(0)
  const [probe, { refetch }] = createResource(refreshKey, probeFda)
  const dialog = useDialog()

  onMount(() => {
    setTimeout(() => {
      if (probe()?.fda && !dismissed()) {
        try {
          localStorage.setItem(DISMISS_KEY, "1")
        } catch {}
        setDismissed(true)
      }
    }, 800)
  })

  const recheck = async () => {
    setRefreshKey((k) => k + 1)
    const r = await refetch()
    if (r?.fda) {
      try {
        localStorage.setItem(DISMISS_KEY, "1")
      } catch {}
      setDismissed(true)
      dialog.close()
    }
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
          reason={probe()?.reason}
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
      <button
        onClick={openSheet}
        title="grant filesystem access for the OS file picker"
        style={{
          all: "unset",
          "box-sizing": "border-box",
          cursor: "pointer",
          display: "inline-flex",
          "align-items": "center",
          gap: "6px",
          height: "32px",
          padding: "0 10px",
          "border-radius": "4px",
          background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-warning) 35%, transparent)",
          color: "color-mix(in srgb, var(--color-warning) 65%, var(--color-text))",
          "font-family": FONT_MONO,
          "font-size": "11px",
          "font-weight": 400,
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "color-mix(in srgb, var(--color-warning) 18%, transparent)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "color-mix(in srgb, var(--color-warning) 10%, transparent)")
        }
      >
        <span
          style={{
            width: "6px",
            height: "6px",
            "border-radius": "50%",
            background: "var(--color-warning)",
            display: "inline-block",
          }}
        />
        FDA
      </button>
    </Show>
  )
}

function FdaSheet(props: {
  os: "mac" | "win" | "linux"
  reason: string | undefined
  onRecheck: () => Promise<void>
  onDismiss: () => void
}): JSX.Element {
  const url = () => SETTINGS_URL[props.os]
  const [busy, setBusy] = createSignal(false)
  return (
    <Dialog title={STEP_TITLE[props.os]}>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "14px",
          "max-width": "440px",
        }}
      >
        <p
          style={{
            "font-family": FONT_SANS,
            "font-size": "13px",
            color: "var(--color-text-muted)",
            "line-height": 1.55,
            margin: 0,
          }}
        >
          {STEP_BODY[props.os]}
        </p>
        <Show when={props.os === "mac"}>
          <ol
            style={{
              margin: 0,
              "padding-left": "18px",
              display: "flex",
              "flex-direction": "column",
              gap: "4px",
              "font-family": FONT_MONO,
              "font-size": "12px",
              color: "var(--color-text)",
            }}
          >
            <li>Open Privacy &amp; Security → Full Disk Access</li>
            <li>
              Click <strong>+</strong>, press <code style={kbd()}>⌘⇧G</code>, paste{" "}
              <code style={kbd()}>/opt/homebrew/bin/openscience</code>, hit Enter, Open
            </li>
            <li>Toggle the openscience entry on</li>
            <li>Restart OpenScience (kill + relaunch) — recheck below</li>
          </ol>
        </Show>
        <div style={{ display: "flex", gap: "8px", "padding-top": "4px" }}>
          <Show when={url()}>
            <a
              href={url()!}
              target="_self"
              style={{
                all: "unset",
                cursor: "pointer",
                padding: "7px 14px",
                "border-radius": "4px",
                background: "var(--color-accent)",
                color: "var(--color-on-accent)",
                "font-family": FONT_MONO,
                "font-size": "11px",
                "font-weight": 400,
                display: "inline-flex",
                "align-items": "center",
                gap: "5px",
              }}
            >
              <IconArrowRight size={11} strokeWidth={1.5} />
              open system settings
            </a>
          </Show>
          <button
            onClick={async () => {
              setBusy(true)
              await props.onRecheck()
              setBusy(false)
            }}
            disabled={busy()}
            style={{
              all: "unset",
              cursor: busy() ? "not-allowed" : "pointer",
              padding: "7px 14px",
              "border-radius": "4px",
              background: "var(--color-surface-solid)",
              border: "1px solid var(--color-border)",
              "font-family": FONT_MONO,
              "font-size": "11px",
              color: "var(--color-text)",
              opacity: busy() ? 0.5 : 1,
              display: "inline-flex",
              "align-items": "center",
              gap: "5px",
            }}
          >
            <IconRefresh size={11} strokeWidth={1.5} />
            recheck
          </button>
          <span style={{ flex: 1 }} />
          <button
            onClick={props.onDismiss}
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "7px 12px",
              "border-radius": "4px",
              "font-family": FONT_MONO,
              "font-size": "11px",
              color: "var(--color-text-muted)",
            }}
          >
            skip
          </button>
        </div>
        <Show when={props.reason}>
          <div
            style={{
              "font-family": FONT_MONO,
              "font-size": "10px",
              color: "var(--color-text-faint)",
              "padding-top": "4px",
              "border-top": "1px dashed var(--color-border)",
            }}
          >
            {props.reason}
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

// Backwards-compat: home.tsx still imports FdaBanner. Re-export the chip.
export const FdaBanner = FdaChip

function kbd(): JSX.CSSProperties {
  return {
    "font-family": FONT_CODE,
    "font-size": "11px",
    padding: "1px 5px",
    "border-radius": "4px",
    background: "var(--color-bg-elevated)",
    border: "1px solid var(--color-border)",
    color: "var(--color-text-muted)",
    "white-space": "nowrap",
  } as JSX.CSSProperties
}
