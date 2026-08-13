import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { useParams } from "@solidjs/router"
import { Markdown } from "@synsci/ui/markdown"
import { useSDK } from "@/context/sdk"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { IconCheckCircle, IconDownload, IconFile, IconMoreH, IconTrash, IconX } from "@/atlas/shared/Icon"
import { toast } from "@/atlas/Toast"
import { uiStore } from "@/atlas/store/ui"
import { normalizeReviewerFindings } from "@/artifacts/inspector"
import {
  normalizeStoredArtifact,
  normalizeStoredArtifactDetail,
  storedArtifactReviewTargetID,
  type StoredArtifact,
  type StoredArtifactVersion,
} from "@/artifacts/store"

type Tab = "preview" | "versions" | "made" | "review"
type Action = "menu" | "rename" | "delete"

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "preview", label: "Preview" },
  { id: "versions", label: "Versions" },
  { id: "made", label: "How made" },
  { id: "review", label: "Review" },
]

function sentence(value: string) {
  const text = value.replace(/[-_]+/g, " ").trim()
  if (!text) return text
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  const tier = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length)
  const value = bytes / 1024 ** tier
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[tier - 1]}`
}

function time(value: number) {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
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
  const params = useParams()
  const [tab, setTab] = createSignal<Tab>("preview")
  const [versionID, setVersionID] = createSignal(props.artifact.currentVersionID)
  const [pinned, setPinned] = createSignal(false)
  const [reviewing, setReviewing] = createSignal(false)
  const [action, setAction] = createSignal<Action>()
  const [name, setName] = createSignal(props.artifact.title)
  const [busy, setBusy] = createSignal(false)
  const [launched, setLaunched] = createSignal<string>()
  const timers = new Set<number>()
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
    setPinned(false)
    setVersionID(props.artifact.currentVersionID)
    setTab("preview")
    setAction()
    setName(props.artifact.title)
  })
  createEffect(() => {
    if (pinned() || !detail.latest) return
    setVersionID(detail.latest.currentVersionID)
  })
  createEffect(() => {
    if (action() === "rename" || !detail.latest?.title) return
    setName(detail.latest.title)
  })
  onMount(() => {
    const refresh = () => {
      setPinned(false)
      void detailActions.refetch()
    }
    window.addEventListener("openscience:artifacts-changed", refresh)
    onCleanup(() => window.removeEventListener("openscience:artifacts-changed", refresh))
  })
  const selected = createMemo(
    () => detail.latest?.versions.find((version) => version.id === versionID()) ?? detail.latest?.current,
  )
  const target = createMemo(() => {
    const version = selected()
    return version ? storedArtifactReviewTargetID(version) : undefined
  })
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
  const [reviews, reviewActions] = createResource(target, async (target) => {
    const response = await sdk.request("/provenance/reviews")
    if (!response.ok) throw new Error(`Review findings unavailable (${response.status})`)
    return normalizeReviewerFindings(await response.json()).filter((finding) => finding.target === target)
  })
  onCleanup(() => timers.forEach((timer) => window.clearTimeout(timer)))

  const review = async () => {
    const version = selected()
    const session = version?.sessionID || (params.id && params.id !== "new" ? params.id : undefined)
    if (!session || !version || reviewing()) return
    setReviewing(true)
    const response = await sdk
      .request(`/session/${encodeURIComponent(session)}/review/artifact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactID: props.artifact.id, versionID: version.id }),
      })
      .catch(() => undefined)
    setReviewing(false)
    if (!response?.ok) {
      const message = await response?.text().catch(() => undefined)
      toast.error("review failed to start", message || "The exact artifact version could not be bound.")
      return
    }
    const result = (await response.json().catch(() => undefined)) as
      | { target?: { id?: string; versionID?: string; sha256?: string } }
      | undefined
    if (
      result?.target?.id !== storedArtifactReviewTargetID(version) ||
      result.target.versionID !== version.id ||
      result.target.sha256 !== version.sha256
    ) {
      toast.error("review failed to start", "The server did not confirm the selected immutable bytes.")
      return
    }
    setLaunched(storedArtifactReviewTargetID(version))
    void reviewActions.refetch()
    for (const delay of [2_000, 8_000, 20_000]) {
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        void reviewActions.refetch()
      }, delay)
      timers.add(timer)
    }
    toast.success("review started", `Artifact v${version.version} · sha256 ${version.sha256.slice(0, 12)}`)
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
        background: "var(--color-bg-subtle)",
        "font-family": FONT_SANS,
      }}
    >
      <header style={header()}>
        <span style={icon()}>
          <IconFile size={18} strokeWidth={1.5} />
        </span>
        <span style={{ flex: 1, "min-width": 0 }}>
          <strong style={title()}>{detail.latest?.title ?? props.artifact.title}</strong>
          <span style={meta()}>
            {detail.latest?.kind ?? props.artifact.kind} · v{selected()?.version ?? props.artifact.current.version} ·{" "}
            {size(selected()?.size ?? props.artifact.current.size)}
          </span>
        </span>
        <Show when={selected()}>
          {(version) => (
            <a href={raw(version(), true)} download={version().filename} style={download()}>
              <IconDownload size={14} strokeWidth={1.6} />
              Download
            </a>
          )}
        </Show>
        <button
          type="button"
          aria-label="Manage Result"
          aria-expanded={action() !== undefined}
          onClick={() => setAction(action() ? undefined : "menu")}
          style={download()}
        >
          <IconMoreH size={14} strokeWidth={1.6} />
          Manage
        </button>
      </header>

      <nav aria-label="Result record" style={tablist()}>
        <For each={tabs}>
          {(item) => (
            <button
              type="button"
              aria-current={tab() === item.id ? "page" : undefined}
              data-active={tab() === item.id ? "true" : undefined}
              onClick={() => setTab(item.id)}
              style={tabButton(tab() === item.id)}
            >
              {item.label}
            </button>
          )}
        </For>
      </nav>

      <Show when={action()}>
        {(current) => (
          <section aria-label="Result actions" style={actionCard()}>
            <div style={actionHead()}>
              <strong style={heading()}>
                {current() === "rename" ? "Rename Result" : current() === "delete" ? "Move to Trash" : "Manage"}
              </strong>
              <button type="button" aria-label="Close Result actions" onClick={() => setAction()} style={iconButton()}>
                <IconX size={14} strokeWidth={1.6} />
              </button>
            </div>
            <Switch>
              <Match when={current() === "menu"}>
                <div style={actionRow()}>
                  <button type="button" onClick={() => setAction("rename")} style={secondary()}>
                    Rename
                  </button>
                  <button type="button" onClick={() => setAction("delete")} style={danger()}>
                    <IconTrash size={14} strokeWidth={1.6} />
                    Delete
                  </button>
                </div>
                <p style={copy()}>Delete moves this Result and every version to recoverable Trash for 30 days.</p>
              </Match>
              <Match when={current() === "rename"}>
                <form onSubmit={rename} style={actionForm()}>
                  <label style={field()}>
                    <span>Result name</span>
                    <input
                      aria-label="Result name"
                      value={name()}
                      onInput={(event) => setName(event.currentTarget.value)}
                      maxlength={240}
                      autofocus
                      style={input()}
                    />
                  </label>
                  <div style={actionRow()}>
                    <button type="submit" disabled={!name().trim() || busy()} style={primary()}>
                      {busy() ? "Saving…" : "Save name"}
                    </button>
                    <button type="button" onClick={() => setAction("menu")} disabled={busy()} style={secondary()}>
                      Cancel
                    </button>
                  </div>
                </form>
              </Match>
              <Match when={current() === "delete"}>
                <p style={copy()}>
                  Versions remain immutable and recoverable for 30 days. This does not delete the source file.
                </p>
                <div style={actionRow()}>
                  <button type="button" onClick={remove} disabled={busy()} style={danger()}>
                    <IconTrash size={14} strokeWidth={1.6} />
                    {busy() ? "Moving…" : "Move to trash"}
                  </button>
                  <button type="button" onClick={() => setAction("menu")} disabled={busy()} style={secondary()}>
                    Cancel
                  </button>
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
              <Switch>
                <Match when={tab() === "preview"}>
                  <Preview
                    version={version()}
                    url={raw(version())}
                    content={content.latest}
                    loading={content.loading}
                  />
                </Match>
                <Match when={tab() === "versions"}>
                  <section aria-label="Immutable versions" style={section()}>
                    <p style={copy()}>
                      Every save creates a new immutable version. Repeated bytes share one content-addressed blob.
                    </p>
                    <div role="list" style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                      <For each={detail.latest?.versions ?? []}>
                        {(item) => (
                          <button
                            type="button"
                            role="listitem"
                            aria-current={item.id === version().id ? "true" : undefined}
                            onClick={() => {
                              setPinned(true)
                              setVersionID(item.id)
                              setTab("preview")
                            }}
                            style={versionRow(item.id === version().id)}
                          >
                            <span>
                              <strong>Version {item.version}</strong>
                              <small>{time(item.createdAt)}</small>
                            </span>
                            <span>
                              <small>{size(item.size)}</small>
                              <small style={{ "font-family": FONT_MONO }}>sha256 {item.sha256.slice(0, 12)}</small>
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </section>
                </Match>
                <Match when={tab() === "made"}>
                  <section aria-label="Artifact provenance" style={section()}>
                    <dl style={facts()}>
                      <Fact label="Source file" value={version().sourcePath} mono />
                      <Fact label="Saved from session" value={version().sessionID} mono />
                      <Show when={version().messageID}>
                        {(value) => <Fact label="Producing message" value={value()} mono />}
                      </Show>
                      <Fact label="Capture quality" value={version().captureQuality} />
                      <Fact label="MIME type" value={version().mimeType} mono />
                      <Fact label="Content hash" value={`sha256:${version().sha256}`} mono />
                    </dl>
                    <Show
                      when={detail.latest?.execution}
                      fallback={
                        <p style={notice()}>
                          This version preserves the exact saved bytes and source session. No execution record was
                          attached, so OpenScience does not claim the originating command, model, or environment.
                        </p>
                      }
                    >
                      {(run) => (
                        <dl style={facts()}>
                          <Fact label="Execution" value={run().id} mono />
                          <Fact label="Status" value={run().status} />
                          <Show when={run().command}>{(value) => <Fact label="Command" value={value()} mono />}</Show>
                          <Show when={run().model}>{(value) => <Fact label="Model" value={value()} />}</Show>
                        </dl>
                      )}
                    </Show>
                  </section>
                </Match>
                <Match when={tab() === "review"}>
                  <section aria-label="Result review" style={section()}>
                    <span style={reviewIcon()}>
                      <IconCheckCircle size={20} strokeWidth={1.5} />
                    </span>
                    <h3 style={heading()}>Independent review · version {version().version}</h3>
                    <p style={copy()}>
                      The reviewer receives only this immutable snapshot (sha256 {version().sha256.slice(0, 12)}).
                      Starting a review is not a pass; only recorded evidence appears here.
                    </p>
                    <Show
                      when={!reviews.loading && !reviews.error && (reviews.latest?.length ?? 0) > 0}
                      fallback={
                        <p style={notice()}>
                          {reviews.error
                            ? "Reviewer findings could not be loaded. No verdict is shown."
                            : launched() === storedArtifactReviewTargetID(version())
                              ? "Review launched for these exact bytes. Waiting for recorded evidence."
                              : "No reviewer verdict is recorded for these exact bytes."}
                        </p>
                      }
                    >
                      <div data-component="artifact-version-findings" style={findings()}>
                        <For each={reviews.latest ?? []}>
                          {(finding) => (
                            <article style={findingCard(finding.verdict === "refutes")}>
                              <div style={findingHead()}>
                                <strong style={findingTitle()}>{finding.claim}</strong>
                                <span style={chip(finding.verdict === "refutes")}>
                                  {sentence(finding.verdict === "refutes" ? finding.severity : "supported")}
                                  {finding.status ? ` · ${sentence(finding.status)}` : ""}
                                </span>
                              </div>
                              <p style={copy()}>{finding.issue}</p>
                              <small style={evidence()}>{finding.evidence}</small>
                            </article>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div style={actionRow()}>
                      <button
                        type="button"
                        onClick={() => void review()}
                        disabled={reviewing() || !version().sessionID}
                        style={primary()}
                      >
                        {reviewing() ? "Starting reviewer…" : "Run independent review"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void reviewActions.refetch()}
                        disabled={reviews.loading}
                        style={secondary()}
                      >
                        {reviews.loading ? "Refreshing…" : "Refresh findings"}
                      </button>
                    </div>
                  </section>
                </Match>
              </Switch>
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

function Fact(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <dt style={factLabel()}>{sentence(props.label)}</dt>
      <dd style={{ ...factValue(), "font-family": props.mono ? FONT_MONO : FONT_SANS }}>{props.value}</dd>
    </div>
  )
}

const header = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  gap: "10px",
  padding: "14px 16px",
  "border-bottom": "1px solid var(--color-border-subtle)",
  background: "var(--color-bg)",
})
const icon = (): JSX.CSSProperties => ({
  width: "34px",
  height: "34px",
  display: "grid",
  "place-items": "center",
  color: "var(--color-text-muted)",
  background: "var(--color-bg-subtle)",
  border: "1px solid var(--color-border-subtle)",
  "border-radius": "8px",
})
const title = (): JSX.CSSProperties => ({
  display: "block",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
  color: "var(--color-text)",
  "font-size": "13px",
  "font-weight": "var(--font-weight-emphasis)",
})
const meta = (): JSX.CSSProperties => ({
  display: "block",
  "margin-top": "2px",
  color: "var(--color-text-muted)",
  "font-size": "11px",
})
const download = (): JSX.CSSProperties => ({
  display: "inline-flex",
  "align-items": "center",
  gap: "6px",
  padding: "7px 9px",
  color: "var(--color-text)",
  "font-size": "11px",
  "text-decoration": "none",
  border: "1px solid var(--color-border)",
  "border-radius": "7px",
})
const tablist = (): JSX.CSSProperties => ({
  display: "flex",
  gap: "2px",
  padding: "0 12px",
  "border-bottom": "1px solid var(--color-border-subtle)",
  background: "var(--color-bg)",
})
const tabButton = (active: boolean): JSX.CSSProperties => ({
  padding: "9px 8px 8px",
  color: active ? "var(--color-text)" : "var(--color-text-muted)",
  "font-size": "11px",
  "font-weight": active ? 600 : 500,
  background: "transparent",
  border: 0,
  "border-bottom": active ? "2px solid var(--color-text)" : "2px solid transparent",
  cursor: "pointer",
})
const actionCard = (): JSX.CSSProperties => ({
  margin: "10px 12px 0",
  padding: "12px",
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border-subtle)",
  "border-radius": "9px",
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
const field = (): JSX.CSSProperties => ({
  display: "flex",
  "flex-direction": "column",
  gap: "5px",
  color: "var(--color-text-muted)",
  "font-size": "10px",
  "font-weight": "var(--font-weight-emphasis)",
})
const input = (): JSX.CSSProperties => ({
  width: "100%",
  padding: "8px 9px",
  color: "var(--color-text)",
  "font-family": FONT_SANS,
  "font-size": "12px",
  background: "var(--color-bg-subtle)",
  border: "1px solid var(--color-border)",
  "border-radius": "7px",
  outline: "none",
})
const iconButton = (): JSX.CSSProperties => ({
  width: "28px",
  height: "28px",
  display: "grid",
  "place-items": "center",
  color: "var(--color-text-muted)",
  background: "transparent",
  border: 0,
  "border-radius": "6px",
  cursor: "pointer",
})
const secondary = (): JSX.CSSProperties => ({
  display: "inline-flex",
  "align-items": "center",
  gap: "6px",
  padding: "7px 9px",
  color: "var(--color-text)",
  "font-size": "11px",
  "font-weight": "var(--font-weight-emphasis)",
  background: "var(--color-bg-subtle)",
  border: "1px solid var(--color-border)",
  "border-radius": "7px",
  cursor: "pointer",
})
const danger = (): JSX.CSSProperties => ({
  ...secondary(),
  color: "var(--color-danger, #b42318)",
})
const body = (): JSX.CSSProperties => ({ flex: 1, "min-height": 0, overflow: "auto" })
const section = (): JSX.CSSProperties => ({
  margin: "0 auto",
  padding: "24px 18px",
  width: "min(100%, 720px)",
  display: "flex",
  "flex-direction": "column",
  gap: "14px",
})
const heading = (): JSX.CSSProperties => ({ margin: 0, color: "var(--color-text)", "font-size": "15px" })
const copy = (): JSX.CSSProperties => ({
  margin: 0,
  color: "var(--color-text-muted)",
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
  color: "var(--color-text)",
  "font-family": FONT_MONO,
  "font-size": "11px",
  "line-height": 1.55,
  "white-space": "pre-wrap",
  "overflow-wrap": "anywhere",
})
const versionRow = (active: boolean): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "12px",
  padding: "12px",
  color: "var(--color-text)",
  "text-align": "left",
  background: active ? "var(--color-bg)" : "transparent",
  border: `1px solid ${active ? "var(--color-border)" : "var(--color-border-subtle)"}`,
  "border-radius": "8px",
  cursor: "pointer",
})
const facts = (): JSX.CSSProperties => ({ margin: 0, display: "grid", gap: "14px" })
const factLabel = (): JSX.CSSProperties => ({
  color: "var(--color-text-faint)",
  "font-size": "10px",
  "font-weight": "var(--font-weight-emphasis)",
  "letter-spacing": "normal",
})
const factValue = (): JSX.CSSProperties => ({
  margin: 0,
  color: "var(--color-text)",
  "font-size": "11px",
  "overflow-wrap": "anywhere",
})
const notice = (): JSX.CSSProperties => ({
  ...copy(),
  padding: "12px",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border-subtle)",
  "border-radius": "8px",
})
const reviewIcon = (): JSX.CSSProperties => ({
  width: "38px",
  height: "38px",
  display: "grid",
  "place-items": "center",
  color: "var(--color-text-muted)",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border-subtle)",
  "border-radius": "10px",
})
const findings = (): JSX.CSSProperties => ({ display: "flex", "flex-direction": "column", gap: "8px" })
const findingCard = (flagged: boolean): JSX.CSSProperties => ({
  padding: "12px",
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  background: "var(--color-bg)",
  border: `1px solid ${flagged ? "color-mix(in srgb, var(--color-danger, #b42318) 35%, var(--color-border-subtle))" : "var(--color-border-subtle)"}`,
  "border-radius": "8px",
})
const findingHead = (): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "flex-start",
  "justify-content": "space-between",
  gap: "10px",
})
const findingTitle = (): JSX.CSSProperties => ({
  color: "var(--color-text)",
  "font-size": "12px",
  "line-height": 1.4,
})
const chip = (flagged: boolean): JSX.CSSProperties => ({
  flex: "none",
  padding: "3px 6px",
  color: flagged ? "var(--color-danger, #b42318)" : "var(--color-text-muted)",
  "font-size": "9px",
  "font-weight": "var(--font-weight-emphasis)",
  "letter-spacing": "normal",
  background: "var(--color-bg-subtle)",
  border: "1px solid var(--color-border-subtle)",
  "border-radius": "999px",
})
const evidence = (): JSX.CSSProperties => ({
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "10px",
  "overflow-wrap": "anywhere",
})
const primary = (): JSX.CSSProperties => ({
  "align-self": "flex-start",
  padding: "8px 11px",
  color: "var(--color-bg)",
  "font-size": "11px",
  "font-weight": "var(--font-weight-emphasis)",
  background: "var(--color-text)",
  border: 0,
  "border-radius": "7px",
  cursor: "pointer",
})
