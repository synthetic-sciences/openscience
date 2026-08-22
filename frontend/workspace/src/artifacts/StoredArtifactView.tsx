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
import { PdfViewer } from "@/science/renderers/documents/PdfViewer"
import {
  downloadBlob,
  loadStoredArtifactPreview,
  requestStoredArtifact,
  STORED_ARTIFACT_PREVIEW_LIMIT,
  STORED_PDF_PREVIEW_LIMIT,
  storedArtifactPreviewKind,
  type StoredArtifactPreview,
} from "@/artifacts/bytes"
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

function markdown(version: StoredArtifactVersion) {
  return /\.(md|markdown)$/i.test(version.filename)
}

function label(version: StoredArtifactVersion | undefined, fallback: string) {
  if (!version) return fallback
  if (version.mimeType === "application/pdf" || version.filename.toLowerCase().endsWith(".pdf")) return "PDF"
  if (version.mimeType.startsWith("image/")) return "Image"
  return fallback === "report" ? "Document" : fallback
}

export function StoredArtifactView(props: { artifact: StoredArtifact }): JSX.Element {
  const sdk = useSDK()
  const [action, setAction] = createSignal<Action>()
  const [name, setName] = createSignal(props.artifact.title)
  const [busy, setBusy] = createSignal(false)
  const [downloading, setDownloading] = createSignal(false)
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
  const selected = createMemo(() => {
    const current = detail.latest
    if (!current || current.id !== props.artifact.id) return
    return current.current
  })
  const previewAbort = { current: undefined as AbortController | undefined }
  createEffect(() => {
    props.artifact.id
    previewAbort.current?.abort()
  })
  const [preview] = createResource(
    () => {
      const version = selected()
      if (!version) return
      return [props.artifact.id, version] as const
    },
    ([artifactID, version]) => {
      previewAbort.current?.abort()
      const controller = new AbortController()
      previewAbort.current = controller
      return loadStoredArtifactPreview(sdk.request, artifactID, version, controller.signal)
    },
  )
  onCleanup(() => previewAbort.current?.abort())
  const download = async (version: StoredArtifactVersion) => {
    if (downloading()) return
    setDownloading(true)
    return requestStoredArtifact(sdk.request, props.artifact.id, version.id, true)
      .then((response) => response.blob())
      .then((blob) => downloadBlob(version.filename, blob))
      .catch((error) => toast.error("download failed", error instanceof Error ? error.message : String(error)))
      .finally(() => setDownloading(false))
  }
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
            {label(selected(), detail.latest?.kind ?? props.artifact.kind)} ·{" "}
            {size(selected()?.size ?? props.artifact.current.size)}
          </span>
        </span>
        <Show when={selected()}>
          {(version) => (
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={downloading()}
              onClick={() => void download(version())}
            >
              <IconDownload size={14} strokeWidth={1.6} />
              {downloading() ? "Downloading…" : "Download"}
            </Button>
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
              <Preview version={version()} data={preview.latest} loading={preview.loading} error={preview.error} />
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}

function Preview(props: {
  version: StoredArtifactVersion
  data?: StoredArtifactPreview
  loading: boolean
  error?: unknown
}): JSX.Element {
  const kind = () => storedArtifactPreviewKind(props.version)
  const limit = () => (kind() === "pdf" ? STORED_PDF_PREVIEW_LIMIT : STORED_ARTIFACT_PREVIEW_LIMIT)
  const error = () =>
    props.error instanceof Error ? props.error.message : String(props.error || "Preview unavailable.")
  return (
    <Switch
      fallback={
        <p role="alert" style={empty()}>
          Preview unavailable.
        </p>
      }
    >
      <Match when={!kind()}>
        <section style={section()}>
          <h3 style={heading()}>Preview is not available for {props.version.mimeType}</h3>
          <p style={copy()}>The immutable bytes are stored safely and can be downloaded without conversion.</p>
        </section>
      </Match>
      <Match when={props.version.size > limit()}>
        <p style={empty()}>
          This Result is larger than the {size(limit())} browser preview limit. Download preserves exact bytes.
        </p>
      </Match>
      <Match when={props.error !== undefined}>
        <p role="alert" style={empty()}>
          {error()}
        </p>
      </Match>
      <Match when={props.loading}>
        <p style={empty()}>Loading preview…</p>
      </Match>
      <Match when={props.data?.kind === "image" ? props.data : undefined}>
        {(data) => <img src={data().data} alt={props.version.filename} style={image()} />}
      </Match>
      <Match when={props.data?.kind === "pdf" ? props.data : undefined}>
        {(data) => <PdfViewer kind="pdf" data={{ bytes: data().data, maxPages: 40 }} />}
      </Match>
      <Match when={props.data?.kind === "text" ? props.data : undefined}>
        {(data) => (
          <Show when={markdown(props.version)} fallback={<pre style={pre()}>{data().data}</pre>}>
            <article class="markdown-body" style={document()}>
              <Markdown text={data().data} />
            </article>
          </Show>
        )}
      </Match>
    </Switch>
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
