import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { Button } from "@synsci/ui/button"
import { IconButton } from "@synsci/ui/icon-button"
import { Markdown } from "@synsci/ui/markdown"
import { TextField } from "@synsci/ui/text-field"
import { useSDK } from "@/context/sdk"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { IconDownload, IconFile, IconMoreH, IconTrash } from "@/atlas/shared/Icon"
import { toast } from "@/atlas/Toast"
import { uiStore } from "@/atlas/store/ui"
import {
  normalizeStoredArtifact,
  normalizeStoredArtifactDetail,
  type StoredArtifact,
  type StoredArtifactVersion,
} from "@/artifacts/store"

type Action = "menu" | "rename" | "delete"

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  const tier = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length)
  const value = bytes / 1024 ** tier
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[tier - 1]}`
}

function text(version: StoredArtifactVersion) {
  return (
    version.mimeType.startsWith("text/") ||
    version.mimeType.includes("json") ||
    /\.(md|markdown|txt|csv|tsv|json|jsonl|yaml|yml|toml|py|r|jl|tex)$/i.test(version.filename)
  )
}

function markdown(version: StoredArtifactVersion) {
  return /\.(md|markdown)$/i.test(version.filename)
}

export function StoredArtifactView(props: { artifact: StoredArtifact }): JSX.Element {
  const sdk = useSDK()
  const [action, setAction] = createSignal<Action>()
  const [name, setName] = createSignal(props.artifact.title)
  const [busy, setBusy] = createSignal(false)
  const [detail, detailActions] = createResource(
    () => props.artifact.id,
    async (id) => {
      const response = await sdk.request(`/file/artifact-store/${encodeURIComponent(id)}`)
      if (!response.ok) throw new Error(`Artifact record unavailable (${response.status})`)
      const value = normalizeStoredArtifactDetail(await response.json())
      if (!value) throw new Error("Artifact record is malformed")
      return value
    },
  )
  createEffect(() => {
    props.artifact.id
    setAction()
    setName(props.artifact.title)
  })
  createEffect(() => {
    if (action() === "rename" || !detail.latest?.title) return
    setName(detail.latest.title)
  })
  onMount(() => {
    const refresh = () => {
      void detailActions.refetch()
    }
    window.addEventListener("openscience:artifacts-changed", refresh)
    onCleanup(() => window.removeEventListener("openscience:artifacts-changed", refresh))
  })
  const selected = createMemo(() => detail.latest?.current)
  const raw = (version: StoredArtifactVersion, download = false) =>
    sdk.request.url(`/file/artifact-store/${encodeURIComponent(props.artifact.id)}/raw`, {
      versionID: version.id,
      ...(download ? { download: "true" } : {}),
    })
  const [content] = createResource(
    () => {
      const version = selected()
      if (!version || !text(version) || version.size > 8 * 1024 * 1024) return
      return [version.id, raw(version)] as const
    },
    async ([, url]) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Preview unavailable (${response.status})`)
      return response.text()
    },
  )
  const rename = (event: SubmitEvent) => {
    event.preventDefault()
    const title = name().trim()
    if (!title || busy()) return
    setBusy(true)
    sdk
      .request(`/file/artifact-store/${encodeURIComponent(props.artifact.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || `Rename failed (${response.status})`)
        const updated = normalizeStoredArtifact(await response.json())
        if (!updated) throw new Error("The renamed Result record is malformed.")
        uiStore.updateSaved(updated)
        setName(updated.title)
        setAction()
        void detailActions.refetch()
        window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
        toast.success("Result renamed", updated.title)
      })
      .catch((error) => toast.error("rename failed", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false))
  }
  const remove = () => {
    if (busy()) return
    setBusy(true)
    sdk
      .request(`/file/artifact-store/${encodeURIComponent(props.artifact.id)}`, { method: "DELETE" })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text()) || `Delete failed (${response.status})`)
        window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
        uiStore.closeWorkTab(`saved:${props.artifact.id}`)
        toast.success("Result moved to Trash", "Recoverable from Files for 30 days.")
      })
      .catch((error) => toast.error("delete failed", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false))
  }

  return (
    <div
      role="region"
      aria-label={`Saved Result ${props.artifact.title}`}
      style={{
        flex: 1,
        "min-height": 0,
        display: "flex",
        "flex-direction": "column",
        background: "var(--background-weak)",
        "font-family": FONT_SANS,
      }}
    >
      <header style={header()}>
        <span style={fileIcon()}>
          <IconFile size={18} strokeWidth={1.5} />
        </span>
        <span style={{ flex: 1, "min-width": 0 }}>
          <strong style={title()}>{detail.latest?.title ?? props.artifact.title}</strong>
          <span style={meta()}>
            {detail.latest?.kind ?? props.artifact.kind} · {size(selected()?.size ?? props.artifact.current.size)}
          </span>
        </span>
        <Show when={selected()}>
          {(version) => (
            <a
              href={raw(version(), true)}
              download={version().filename}
              data-component="button"
              data-size="small"
              data-variant="secondary"
            >
              <IconDownload size={14} strokeWidth={1.6} />
              Download
            </a>
          )}
        </Show>
        <Button
          type="button"
          size="small"
          variant="secondary"
          aria-label="Manage Result"
          aria-expanded={action() !== undefined}
          onClick={() => setAction(action() ? undefined : "menu")}
        >
          <IconMoreH size={14} strokeWidth={1.6} />
          Manage
        </Button>
      </header>

      <Show when={action()}>
        {(current) => (
          <section aria-label="Result actions" style={actionPanel()}>
            <div style={actionHead()}>
              <strong style={heading()}>
                {current() === "rename" ? "Rename Result" : current() === "delete" ? "Move to Trash" : "Manage"}
              </strong>
              <IconButton
                type="button"
                icon="close"
                variant="ghost"
                aria-label="Close Result actions"
                onClick={() => setAction()}
              />
            </div>
            <Switch>
              <Match when={current() === "menu"}>
                <div style={actionRow()}>
                  <Button type="button" size="small" variant="secondary" onClick={() => setAction("rename")}>
                    Rename
                  </Button>
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    onClick={() => setAction("delete")}
                    style={dangerText()}
                  >
                    <IconTrash size={14} strokeWidth={1.6} />
                    Delete
                  </Button>
                </div>
                <p style={copy()}>Delete moves this Result and its saved history to recoverable Trash for 30 days.</p>
              </Match>
              <Match when={current() === "rename"}>
                <form onSubmit={rename} style={actionForm()}>
                  <TextField
                    type="text"
                    label="Result name"
                    value={name()}
                    onChange={setName}
                    maxlength={240}
                    autofocus
                  />
                  <div style={actionRow()}>
                    <Button type="submit" size="small" variant="primary" disabled={!name().trim() || busy()}>
                      {busy() ? "Saving…" : "Save name"}
                    </Button>
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      onClick={() => setAction("menu")}
                      disabled={busy()}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </Match>
              <Match when={current() === "delete"}>
                <p style={copy()}>
                  Saved history remains recoverable for 30 days. This does not delete the source file.
                </p>
                <div style={actionRow()}>
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    onClick={remove}
                    disabled={busy()}
                    style={dangerText()}
                  >
                    <IconTrash size={14} strokeWidth={1.6} />
                    {busy() ? "Moving…" : "Move to trash"}
                  </Button>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    onClick={() => setAction("menu")}
                    disabled={busy()}
                  >
                    Cancel
                  </Button>
                </div>
              </Match>
            </Switch>
          </section>
        )}
      </Show>

      <div class="atlas-scroll" style={body()}>
        <Show when={!detail.loading} fallback={<p style={empty()}>Loading immutable record…</p>}>
          <Show
            when={!detail.error && selected()}
            fallback={
              <p role="alert" style={empty()}>
                {detail.error instanceof Error ? detail.error.message : "Artifact record unavailable."}
              </p>
            }
          >
            {(version) => (
              <Preview version={version()} url={raw(version())} content={content.latest} loading={content.loading} />
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}

function Preview(props: {
  version: StoredArtifactVersion
  url: string
  content?: string
  loading: boolean
}): JSX.Element {
  if (props.version.mimeType.startsWith("image/")) {
    return <img src={props.url} alt={props.version.filename} style={image()} />
  }
  if (props.version.mimeType === "application/pdf" || props.version.filename.toLowerCase().endsWith(".pdf")) {
    return <iframe title={props.version.filename} src={props.url} style={frame()} />
  }
  if (text(props.version) && props.version.size > 8 * 1024 * 1024) {
    return (
      <p style={empty()}>This text Result is larger than the 8 MB preview limit. Download preserves exact bytes.</p>
    )
  }
  if (text(props.version)) {
    return (
      <Show when={!props.loading} fallback={<p style={empty()}>Loading preview…</p>}>
        <Show when={markdown(props.version)} fallback={<pre style={pre()}>{props.content ?? ""}</pre>}>
          <article class="markdown-body" style={document()}>
            <Markdown text={props.content ?? ""} />
          </article>
        </Show>
      </Show>
    )
  }
  return (
    <section style={section()}>
      <h3 style={heading()}>Preview is not available for {props.version.mimeType}</h3>
      <p style={copy()}>The immutable bytes are stored safely and can be downloaded without conversion.</p>
    </section>
  )
}

const header = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  gap: "10px",
  padding: "14px 16px",
  "border-bottom": "1px solid var(--border-weak-base)",
  background: "var(--surface-raised-stronger-non-alpha)",
})
const fileIcon = (): JSX.CSSProperties => ({
  width: "32px",
  height: "32px",
  display: "grid",
  "place-items": "center",
  color: "var(--icon-base)",
  background: "var(--surface-raised-base-hover)",
  "border-radius": "var(--radius-sm)",
})
const title = (): JSX.CSSProperties => ({
  display: "block",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
  color: "var(--text-strong)",
  "font-size": "13px",
  "font-weight": "var(--font-weight-emphasis)",
})
const meta = (): JSX.CSSProperties => ({
  display: "block",
  "margin-top": "2px",
  color: "var(--text-weak)",
  "font-size": "11px",
})
const actionPanel = (): JSX.CSSProperties => ({
  margin: "10px 12px 0",
  padding: "12px",
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  background: "var(--surface-raised-base)",
  "border-radius": "var(--radius-md)",
})
const actionHead = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "8px",
})
const actionRow = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  gap: "8px",
  "flex-wrap": "wrap",
})
const actionForm = (): JSX.CSSProperties => ({ display: "flex", "flex-direction": "column", gap: "10px" })
const dangerText = (): JSX.CSSProperties => ({ color: "var(--text-on-critical-base)" })
const body = (): JSX.CSSProperties => ({ flex: 1, "min-height": 0, overflow: "auto" })
const section = (): JSX.CSSProperties => ({
  margin: "0 auto",
  padding: "24px 18px",
  width: "min(100%, 720px)",
  display: "flex",
  "flex-direction": "column",
  gap: "14px",
})
const heading = (): JSX.CSSProperties => ({ margin: 0, color: "var(--text-strong)", "font-size": "15px" })
const copy = (): JSX.CSSProperties => ({
  margin: 0,
  color: "var(--text-weak)",
  "font-size": "12px",
  "line-height": 1.55,
})
const empty = (): JSX.CSSProperties => ({ ...copy(), padding: "24px", "text-align": "center" })
const image = (): JSX.CSSProperties => ({
  display: "block",
  "max-width": "calc(100% - 32px)",
  "max-height": "calc(100vh - 220px)",
  margin: "16px auto",
  "object-fit": "contain",
})
const frame = (): JSX.CSSProperties => ({ display: "block", width: "100%", height: "100%", border: 0 })
const document = (): JSX.CSSProperties => ({ margin: "0 auto", padding: "24px", width: "min(100%, 760px)" })
const pre = (): JSX.CSSProperties => ({
  margin: 0,
  padding: "20px",
  color: "var(--text-strong)",
  "font-family": FONT_MONO,
  "font-size": "11px",
  "line-height": 1.55,
  "white-space": "pre-wrap",
  "overflow-wrap": "anywhere",
})
