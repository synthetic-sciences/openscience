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
import { TextField } from "@synsci/ui/text-field"
import { MarkdownImages } from "@synsci/ui/markdown"
import { useSDK } from "@/context/sdk"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { IconDownload, IconEdit, IconFile, IconMoreH, IconTrash } from "@/atlas/shared/Icon"
import { toast } from "@/atlas/Toast"
import { uiStore } from "@/atlas/store/ui"
import { PdfViewer } from "@/science/renderers/documents/PdfViewer"
import { moveStoredArtifactMenuFocus } from "@/artifacts/stored-artifact-menu"
import { TextContentView } from "@/atlas/files/TextContentView"
import { resolveViewer } from "@/atlas/files/viewer-registry"
import { fileErrorMessage, isFileRequestCancellation } from "@/atlas/file-viewer"
import { createStoredArtifactPreview } from "@/artifacts/preview"
import { assetUrl, localAssetPath } from "@/utils/markdown-assets"
import { rawFileQuery } from "@/utils/project-file"
import {
  downloadBlob,
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

function label(version: StoredArtifactVersion | undefined, fallback: string) {
  if (!version) return fallback
  if (version.mimeType === "application/pdf" || version.filename.toLowerCase().endsWith(".pdf")) return "PDF"
  if (version.mimeType.startsWith("image/")) return "Image"
  return fallback === "report" ? "Document" : fallback
}

export function StoredArtifactView(props: { artifact: StoredArtifact }): JSX.Element {
  const sdk = useSDK()
  const previewScope = () => `${sdk.url}\n${sdk.scope}`
  const [action, setAction] = createSignal<Action>()
  const [name, setName] = createSignal(props.artifact.title)
  const [busy, setBusy] = createSignal(false)
  const [downloading, setDownloading] = createSignal(false)
  let actionTrigger: HTMLButtonElement | undefined
  let actionPanelElement: HTMLElement | undefined
  const [detail, detailActions] = createResource(
    () => ({ scope: previewScope(), id: props.artifact.id }),
    async ({ scope, id }) => {
      const response = await sdk.request(`/file/artifact-store/${encodeURIComponent(id)}`)
      if (!response.ok) throw new Error(`Artifact record unavailable (${response.status})`)
      const value = normalizeStoredArtifactDetail(await response.json())
      if (!value || value.id !== id) throw new Error("Artifact record is malformed")
      return { scope, record: value }
    },
  )
  const record = () => {
    if (detail.error) return
    const current = detail.latest
    if (current?.scope !== previewScope() || current.record.id !== props.artifact.id) return
    return current.record
  }
  createEffect(() => {
    props.artifact.id
    setAction()
    setName(props.artifact.title)
  })
  createEffect(() => {
    const current = record()
    if (action() === "rename" || !current?.title) return
    setName(current.title)
  })
  createEffect(() => {
    if (!action()) return
    queueMicrotask(() => actionPanelElement?.querySelector<HTMLElement>('input, [role="menuitem"], button')?.focus())
  })
  onMount(() => {
    const refresh = () => {
      void detailActions.refetch()
    }
    window.addEventListener("openscience:artifacts-changed", refresh)
    onCleanup(() => window.removeEventListener("openscience:artifacts-changed", refresh))
  })
  const selected = createMemo(() => {
    const current = record()
    if (!current || current.id !== props.artifact.id) return
    return current.current
  })
  const [preview, previewActions] = createStoredArtifactPreview(sdk.request, () => ({
    scope: previewScope(),
    artifactID: props.artifact.id,
    version: selected(),
  }))
  const previewData = () => {
    if (preview.error) return
    const current = preview.latest
    if (
      current?.scope !== previewScope() ||
      current.artifactID !== props.artifact.id ||
      current.versionID !== selected()?.id
    )
      return
    return current.data
  }
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
        closeActions(true)
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
  const closeActions = (restoreFocus = false) => {
    setAction()
    if (restoreFocus) queueMicrotask(() => actionTrigger?.focus())
  }

  return (
    <div
      class="atlas-file-view atlas-stored-artifact"
      role="region"
      aria-label={`Saved Result ${props.artifact.title}`}
      style={{
        flex: 1,
        "min-height": 0,
        display: "flex",
        "flex-direction": "column",
        background: "var(--color-surface-solid)",
        "font-family": FONT_SANS,
      }}
    >
      <header style={header()}>
        <span style={fileIcon()}>
          <IconFile size={18} strokeWidth={1.5} />
        </span>
        <span style={{ flex: 1, "min-width": 0 }}>
          <strong style={title()}>{record()?.title ?? props.artifact.title}</strong>
          <span style={meta()}>
            {label(selected(), record()?.kind ?? props.artifact.kind)} ·{" "}
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
        <span style={actionAnchor()}>
          <Button
            ref={actionTrigger}
            type="button"
            size="small"
            variant="secondary"
            aria-label="Manage Result"
            aria-haspopup="menu"
            aria-expanded={action() !== undefined}
            onClick={() => (action() ? closeActions() : setAction("menu"))}
          >
            <IconMoreH size={14} strokeWidth={1.6} />
            Manage
          </Button>

          <Show when={action()}>
            {(current) => (
              <>
                <button
                  type="button"
                  tabindex={-1}
                  aria-hidden="true"
                  style={actionScrim()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => closeActions(true)}
                />
                <section
                  ref={actionPanelElement}
                  aria-label="Result actions"
                  role={current() === "menu" ? "menu" : "dialog"}
                  style={actionPanel()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault()
                      closeActions(true)
                      return
                    }
                    if (current() !== "menu") return
                    if (!moveStoredArtifactMenuFocus(event.currentTarget, event.target, event.key)) return
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onFocusOut={(event) => {
                    if (current() !== "menu") return
                    const next = event.relatedTarget
                    if (next instanceof Node && event.currentTarget.contains(next)) return
                    closeActions()
                  }}
                >
                  <Switch>
                    <Match when={current() === "menu"}>
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        role="menuitem"
                        tabindex={0}
                        style={menuItem()}
                        onClick={() => setAction("rename")}
                      >
                        <IconEdit size={14} strokeWidth={1.55} />
                        Rename
                      </Button>
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        role="menuitem"
                        tabindex={-1}
                        style={{ ...menuItem(), ...dangerText() }}
                        onClick={() => setAction("delete")}
                      >
                        <IconTrash size={14} strokeWidth={1.55} />
                        Move to trash
                      </Button>
                    </Match>
                    <Match when={current() === "rename"}>
                      <form onSubmit={rename} style={actionForm()}>
                        <strong style={heading()}>Rename Result</strong>
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
                      <strong style={heading()}>Move to Trash?</strong>
                      <p style={copy()}>The Result stays recoverable from Files for 30 days.</p>
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
              </>
            )}
          </Show>
        </span>
      </header>

      <div class="atlas-scroll" style={body()}>
        <Show when={!detail.loading} fallback={<p style={empty()}>Loading immutable record…</p>}>
          <Show
            when={!detail.error && selected()}
            fallback={
              <section class="atlas-file-error" role="alert">
                <h2>Couldn’t open this file</h2>
                <p>{detail.error instanceof Error ? detail.error.message : "Artifact record unavailable."}</p>
                <Button type="button" size="small" variant="secondary" onClick={() => void detailActions.refetch()}>
                  Retry
                </Button>
              </section>
            }
          >
            {(version) => (
              <Preview
                version={version()}
                data={previewData()}
                loading={preview.loading}
                error={preview.error}
                onRetry={() => void previewActions.refetch()}
              />
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
  onRetry: () => void
}): JSX.Element {
  const sdk = useSDK()
  const file = (href: string) => localAssetPath(href, props.version.sourcePath)
  const imageUrl = (src: string) =>
    assetUrl(src, {
      base: props.version.sourcePath,
      url: (path) =>
        sdk.request.url(
          "/file/raw",
          rawFileQuery({
            directory: sdk.directory,
            path,
            sessionID: props.version.sessionID,
            scope: "session",
            inline: true,
          }),
        ),
    })
  const openFile = (path: string) =>
    uiStore.openFile(sdk.directory, path, { scope: "auto", sessionID: props.version.sessionID })
  const kind = () => storedArtifactPreviewKind(props.version)
  const viewer = () =>
    resolveViewer({
      name: props.version.filename,
      mimeType: props.version.mimeType,
      content: props.data?.kind === "text" ? props.data.data : undefined,
    })
  const limit = () => (kind() === "pdf" ? STORED_PDF_PREVIEW_LIMIT : STORED_ARTIFACT_PREVIEW_LIMIT)
  const error = () =>
    isFileRequestCancellation(props.error)
      ? "The connection was interrupted. Try opening this preview again."
      : fileErrorMessage(props.error)
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
      <Match when={props.loading}>
        <p style={empty()}>Loading preview…</p>
      </Match>
      <Match when={props.error !== undefined}>
        <section class="atlas-file-error" role="alert">
          <h2>Couldn’t open this preview</h2>
          <p>{error()}</p>
          <Button type="button" size="small" variant="secondary" onClick={props.onRetry}>
            Retry
          </Button>
        </section>
      </Match>
      <Match when={props.data?.kind === "image" ? props.data : undefined}>
        {(data) => <img src={data().data} alt={props.version.filename} style={image()} />}
      </Match>
      <Match when={props.data?.kind === "pdf" ? props.data : undefined}>
        {(data) => <PdfViewer kind="pdf" data={{ bytes: data().data, maxPages: 40 }} />}
      </Match>
      <Match when={props.data?.kind === "text" ? props.data : undefined}>
        {(data) => (
          <div style={viewer().kind === "markdown" || viewer().kind === "notebook" ? undefined : pre()}>
            <MarkdownImages resolve={imageUrl} resolveFile={file} openFile={openFile}>
              <TextContentView name={props.version.filename} text={data().data} viewer={viewer()} />
            </MarkdownImages>
          </div>
        )}
      </Match>
    </Switch>
  )
}

const header = (): JSX.CSSProperties => ({
  position: "relative",
  display: "flex",
  "align-items": "center",
  gap: "10px",
  padding: "14px 16px",
  "border-bottom": "1px solid var(--border-weak-base)",
  background: "var(--surface-raised-stronger-non-alpha)",
})
const actionAnchor = (): JSX.CSSProperties => ({ position: "relative", display: "inline-flex", flex: "none" })
const actionScrim = (): JSX.CSSProperties => ({
  position: "fixed",
  inset: 0,
  "z-index": 4,
  width: "100%",
  padding: 0,
  border: 0,
  background: "transparent",
  cursor: "default",
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
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  "z-index": 5,
  width: "min(280px, calc(100vw - 32px))",
  padding: "6px",
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
  border: "1px solid var(--border-weak-base)",
  background: "var(--surface-raised-stronger-non-alpha)",
  "border-radius": "var(--radius-md)",
  "box-shadow": "var(--atlas-shadow-md)",
})
const menuItem = (): JSX.CSSProperties => ({
  appearance: "none",
  width: "100%",
  "min-height": "36px",
  display: "flex",
  "align-items": "center",
  gap: "8px",
  padding: "0 9px",
  border: 0,
  "border-radius": "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-strong)",
  "font-family": FONT_SANS,
  "font-size": "12px",
  "text-align": "left",
  cursor: "pointer",
})
const actionRow = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  gap: "8px",
  "flex-wrap": "wrap",
})
const actionForm = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  padding: "6px",
})
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
const pre = (): JSX.CSSProperties => ({
  margin: 0,
  padding: "20px 18px 48px",
  color: "var(--text-strong)",
  "font-family": FONT_MONO,
  "font-size": "12px",
  "line-height": 1.65,
  "white-space": "pre-wrap",
  "overflow-wrap": "anywhere",
})
