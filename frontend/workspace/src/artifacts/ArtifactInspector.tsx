import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { centerTabs } from "@/atlas/store/centerTabs"
import { uiStore } from "@/atlas/store/ui"
import { toast } from "@/atlas/Toast"
import {
  IconBookOpen,
  IconBraces,
  IconClock,
  IconCopy,
  IconDownload,
  IconFile,
  IconFlask,
  IconMessageSquare,
  IconRefresh,
  IconSettings,
} from "@/atlas/shared/Icon"
import { FONT_CODE, FONT_MONO, FONT_SANS } from "@/styles/tokens"
import type { ArtifactContext } from "./context"
import {
  inspectorTabs,
  normalizeInspectorData,
  normalizePublicationReview,
  type InspectorData,
  type InspectorState,
  type InspectorTab,
  type PublicationReviewFinding,
  type PublicationReviewState,
} from "./inspector"

const labels: Record<InspectorTab, string> = {
  details: "Details",
  code: "Code",
  run: "Run",
  messages: "Messages",
  environment: "Environment",
  review: "Review",
  history: "History",
}

interface AnnotationMessage {
  id: string
  body: string
  author: string
  createdAt: number
}

interface Annotation {
  id: string
  path: string
  artifactHash: string
  anchor: {
    kind: "artifact" | "text" | "notebook" | "molecule" | "genome"
    label?: string
    startLine?: number
    endLine?: number
    selection?: string
    chromosome?: string
    start?: number
    end?: number
    cellId?: string
  }
  messages: AnnotationMessage[]
  status: "open" | "resolved"
  version: number
  revisions: Array<{
    version: number
    event: "created" | "edited" | "replied" | "resolved" | "reopened" | "deleted"
    actor: string
    at: number
    status: "open" | "resolved"
  }>
  createdAt: number
  updatedAt: number
}

function annotations(value: unknown): Annotation[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Annotation => {
    if (!item || typeof item !== "object") return false
    const row = item as Partial<Annotation>
    return (
      typeof row.id === "string" &&
      (row.status === "open" || row.status === "resolved") &&
      typeof row.version === "number" &&
      Array.isArray(row.revisions) &&
      Array.isArray(row.messages) &&
      !!row.anchor &&
      typeof row.anchor.kind === "string"
    )
  })
}

export function ArtifactInspector(props: { context: ArtifactContext; onClose?: () => void }): JSX.Element {
  const sdk = useSDK()
  const platform = usePlatform()
  const prompt = usePrompt()
  const [tab, setTab] = createSignal<InspectorTab>("details")
  const request = () => platform.fetch ?? fetch
  const url = (route: string, path?: string) =>
    `${sdk.url.replace(/\/$/, "")}${route}?directory=${encodeURIComponent(props.context.directory)}${path ? `&path=${encodeURIComponent(path)}` : ""}`

  const [records, api] = createResource(
    () => ({ id: props.context.id, path: props.context.path, directory: props.context.directory }),
    async (current) => {
      const read = async (route: string, path?: string): Promise<unknown> => {
        const response = await request()(url(route, path)).catch(() => undefined)
        if (!response?.ok) return
        return response.json().catch(() => undefined)
      }
      const [file, provenance, audit, notes, review] = await Promise.all([
        read("/file/content", current.path),
        read("/file/provenance", current.path),
        read("/file/reproducibility"),
        read("/file/annotations", current.path),
        read("/file/reviews", current.path),
      ])
      return { id: current.id, file, provenance, audit, notes, review }
    },
  )
  const model = createMemo<InspectorData>(() => {
    const value = records()
    const input = value?.id === props.context.id ? value : {}
    return normalizeInspectorData(props.context, input)
  })
  const review = createMemo(() => normalizePublicationReview(props.context.format, records()?.review))

  createEffect(() => {
    props.context.id
    setTab("details")
  })
  createEffect(() => {
    const next = uiStore.artifactPaneTab()
    if (!next) return
    props.context.id
    setTab(next)
    uiStore.setArtifactPaneTab(undefined)
  })

  const copy = async () => {
    await navigator.clipboard?.writeText(props.context.path)
    toast.success("copied", props.context.path)
  }
  const attach = () => {
    prompt.context.add({ type: "file", path: props.context.path })
    centerTabs.showChat()
    toast.success("added to context", props.context.name)
  }
  const download = async () => {
    const response = await request()(url("/file/raw", props.context.path)).catch(() => undefined)
    if (!response?.ok) {
      toast.error("download failed", response ? `${response.status}` : "request failed")
      return
    }
    const object = URL.createObjectURL(await response.blob())
    const anchor = document.createElement("a")
    anchor.href = object
    anchor.download = props.context.name
    anchor.click()
    URL.revokeObjectURL(object)
  }
  const mutateAnnotation = async (route: string, method: "POST" | "PATCH", body: Record<string, unknown>) => {
    const response = await request()(url(route), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined)
    if (!response?.ok) {
      toast.error("annotation failed", response ? `${response.status}` : "request failed")
      return false
    }
    await api.refetch()
    return true
  }
  const addAnnotation = (body: string) =>
    mutateAnnotation("/file/annotations", "POST", {
      path: props.context.path,
      body,
      anchor:
        props.context.inspection?.selection?.kind === "molecule"
          ? {
              kind: "molecule",
              selection: props.context.inspection.selection.label,
              count: props.context.inspection.selection.count,
            }
          : { kind: "artifact", label: props.context.name },
    })
  const updateAnnotation = (id: string, body: Record<string, unknown>) =>
    mutateAnnotation(`/file/annotations/${id}`, "PATCH", body)
  const mutateReview = async (route: string, method: "POST" | "PATCH", body: Record<string, unknown>) => {
    const response = await request()(url(route), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined)
    if (!response?.ok) {
      const payload = (await response?.json().catch(() => undefined)) as { error?: unknown } | undefined
      const detail =
        typeof payload?.error === "string" ? payload.error : response ? `${response.status}` : "request failed"
      toast.error("publication review failed", detail)
      return false
    }
    await api.refetch()
    return true
  }
  const actor = () => model().provenance?.commit?.author ?? "Local user"
  const runReview = () =>
    mutateReview("/file/reviews", "POST", {
      path: props.context.path,
      actor: actor(),
    })
  const resolveFinding = (report: string, finding: string, status: "resolved" | "overridden", reason: string) =>
    mutateReview(`/file/reviews/${report}/findings/${finding}`, "PATCH", {
      status,
      actor: actor(),
      reason,
    })
  const finalizeReview = (report: string) =>
    mutateReview(`/file/reviews/${report}/finalize`, "POST", {
      actor: actor(),
    })

  const move = (event: KeyboardEvent, current: InspectorTab) => {
    const index = inspectorTabs.indexOf(current)
    const next =
      event.key === "Home"
        ? inspectorTabs[0]
        : event.key === "End"
          ? inspectorTabs.at(-1)
          : event.key === "ArrowRight"
            ? inspectorTabs[(index + 1) % inspectorTabs.length]
            : event.key === "ArrowLeft"
              ? inspectorTabs[(index - 1 + inspectorTabs.length) % inspectorTabs.length]
              : undefined
    if (!next) return
    event.preventDefault()
    setTab(next)
    document.getElementById(`artifact-inspector-tab-${next}`)?.focus()
  }

  return (
    <section
      data-component="artifact-inspector"
      data-artifact-id={props.context.id}
      style={{
        flex: 1,
        "min-height": 0,
        display: "flex",
        "flex-direction": "column",
        background: "var(--color-bg)",
      }}
    >
      <header
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          padding: "12px 14px",
          "border-bottom": "1px solid var(--color-border)",
          "flex-shrink": 0,
        }}
      >
        <span style={{ display: "inline-flex", color: "var(--color-text-muted)" }}>
          <IconFile size={15} strokeWidth={1.5} />
        </span>
        <div style={{ flex: 1, "min-width": 0, display: "grid", gap: "2px" }}>
          <strong
            title={props.context.path}
            style={{
              "font-family": FONT_SANS,
              "font-size": "13px",
              color: "var(--color-text)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {props.context.name}
          </strong>
          <span style={{ "font-family": FONT_MONO, "font-size": "10px", color: "var(--color-text-faint)" }}>
            {props.context.kind} · {props.context.format.toUpperCase()}
          </span>
        </div>
        <button type="button" title="refresh file details" style={iconButton()} onClick={() => void api.refetch()}>
          <IconRefresh size={13} />
        </button>
        <Show when={props.onClose}>
          <button type="button" style={quietButton()} onClick={() => props.onClose?.()}>
            close
          </button>
        </Show>
      </header>

      <div style={{ display: "grid", "grid-template-columns": "repeat(3, 1fr)", gap: "6px", padding: "10px 12px" }}>
        <button type="button" style={actionButton(true)} onClick={attach}>
          <IconFlask size={12} /> ask
        </button>
        <button type="button" style={actionButton()} onClick={() => void copy()}>
          <IconCopy size={12} /> path
        </button>
        <button type="button" style={actionButton()} onClick={() => void download()}>
          <IconDownload size={12} /> download
        </button>
      </div>

      <div
        role="tablist"
        aria-label="File details"
        class="atlas-scroll"
        style={{
          display: "flex",
          gap: "4px",
          padding: "0 12px 10px",
          overflow: "auto hidden",
          "border-bottom": "1px solid var(--color-border)",
          "flex-shrink": 0,
        }}
      >
        <For each={inspectorTabs}>
          {(item) => (
            <button
              id={`artifact-inspector-tab-${item}`}
              type="button"
              role="tab"
              aria-selected={tab() === item}
              aria-controls={`artifact-inspector-panel-${item}`}
              tabindex={tab() === item ? 0 : -1}
              onClick={() => setTab(item)}
              onKeyDown={(event) => move(event, item)}
              style={tabButton(tab() === item)}
            >
              {labels[item]}
              <Show when={!model().tabs[item].available}>
                <span aria-hidden="true" style={{ color: "var(--color-text-faint)", "font-size": "9px" }}>
                  ○
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <div
        id={`artifact-inspector-panel-${tab()}`}
        role="tabpanel"
        aria-labelledby={`artifact-inspector-tab-${tab()}`}
        class="atlas-scroll"
        style={{ flex: 1, "min-height": 0, overflow: "auto", padding: "14px", "box-sizing": "border-box" }}
      >
        <Show when={!records.loading} fallback={<Loading />}>
          <Switch>
            <Match when={tab() === "details"}>
              <Details data={model()} />
            </Match>
            <Match when={tab() === "code"}>
              <Show when={model().source !== undefined} fallback={<Empty state={model().tabs.code} icon="code" />}>
                <section style={card()}>
                  <Heading icon="code">Source</Heading>
                  <pre
                    class="atlas-scroll"
                    style={{
                      margin: 0,
                      "max-height": "460px",
                      overflow: "auto",
                      "font-family": FONT_CODE,
                      "font-size": "11px",
                      "line-height": 1.6,
                      color: "var(--color-text-muted)",
                      "white-space": "pre",
                    }}
                  >
                    {model().source}
                  </pre>
                </section>
              </Show>
            </Match>
            <Match when={tab() === "run"}>
              <Empty state={model().tabs.run} icon="run" />
            </Match>
            <Match when={tab() === "messages"}>
              <Empty state={model().tabs.messages} icon="messages" />
            </Match>
            <Match when={tab() === "environment"}>
              <Environment data={model()} />
            </Match>
            <Match when={tab() === "review"}>
              <Review
                state={review()}
                annotations={annotations(records()?.notes)}
                onRun={runReview}
                onFinding={resolveFinding}
                onFinalize={finalizeReview}
                onAdd={addAnnotation}
                onUpdate={updateAnnotation}
              />
            </Match>
            <Match when={tab() === "history"}>
              <History data={model()} />
            </Match>
          </Switch>
        </Show>
      </div>
    </section>
  )
}

function Review(props: {
  state: PublicationReviewState
  annotations: Annotation[]
  onRun(): Promise<boolean>
  onFinding(report: string, finding: string, status: "resolved" | "overridden", reason: string): Promise<boolean>
  onFinalize(report: string): Promise<boolean>
  onAdd(body: string): Promise<boolean>
  onUpdate(id: string, body: Record<string, unknown>): Promise<boolean>
}): JSX.Element {
  const [body, setBody] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const open = () => props.annotations.filter((item) => item.status === "open").length
  const run = async () => {
    if (busy()) return
    setBusy(true)
    await props.onRun()
    setBusy(false)
  }
  const finalize = async () => {
    const report = props.state.report
    if (!report || busy()) return
    setBusy(true)
    await props.onFinalize(report.id)
    setBusy(false)
  }
  const add = async () => {
    const value = body().trim()
    if (!value || busy()) return
    setBusy(true)
    const ok = await props.onAdd(value)
    setBusy(false)
    if (ok) setBody("")
  }
  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <section
        data-component="publication-review"
        data-review-state={props.state.kind}
        style={{
          ...card(),
          "border-left": `3px solid ${reviewColor(props.state.kind)}`,
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", "align-items": "flex-start", "justify-content": "space-between", gap: "10px" }}>
          <div style={{ display: "grid", gap: "3px" }}>
            <span
              style={{
                "font-family": FONT_MONO,
                "font-size": "9px",
                "text-transform": "uppercase",
                "letter-spacing": "0.08em",
                color: reviewColor(props.state.kind),
              }}
            >
              {props.state.kind.replace("-", " ")}
            </span>
            <strong style={{ "font-family": FONT_SANS, "font-size": "13px", color: "var(--color-text)" }}>
              {props.state.title}
            </strong>
            <p style={copyStyle()}>{props.state.detail}</p>
          </div>
          <Show when={props.state.kind !== "not-applicable"}>
            <button
              type="button"
              disabled={busy()}
              style={{ ...actionButton(true), "white-space": "nowrap" }}
              onClick={() => void run()}
            >
              {busy() ? "Checking…" : props.state.report ? "Run again" : "Run checks"}
            </button>
          </Show>
        </div>
        <Show when={props.state.report}>
          {(report) => (
            <>
              <div
                style={{
                  display: "grid",
                  "grid-template-columns": "repeat(4, minmax(0, 1fr))",
                  gap: "6px",
                }}
              >
                <ReviewMetric label="blocking" value={report().summary.blocking} tone="blocking" />
                <ReviewMetric label="major" value={report().summary.major} tone="major" />
                <ReviewMetric label="minor" value={report().summary.minor} tone="minor" />
                <ReviewMetric label="closed" value={report().summary.resolved + report().summary.overridden} />
              </div>
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  gap: "8px",
                  "flex-wrap": "wrap",
                }}
              >
                <span style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
                  v{report().version} · sha256 {report().artifactHash.slice(0, 12)}
                </span>
                <Show
                  when={report().finalized}
                  fallback={
                    <button
                      type="button"
                      disabled={
                        busy() ||
                        report().stale ||
                        report().findings.some(
                          (finding) => finding.severity === "blocking" && finding.status === "open",
                        )
                      }
                      style={{
                        ...actionButton(true),
                        opacity:
                          busy() ||
                          report().stale ||
                          report().findings.some(
                            (finding) => finding.severity === "blocking" && finding.status === "open",
                          )
                            ? 0.45
                            : 1,
                      }}
                      onClick={() => void finalize()}
                    >
                      Finalize reviewed bytes
                    </button>
                  }
                >
                  {(value) => (
                    <span style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-success)" }}>
                      Finalized by {value().actor} · {new Date(value().at).toLocaleString()}
                    </span>
                  )}
                </Show>
              </div>
              <Show
                when={report().findings.length}
                fallback={
                  <p style={copyStyle()}>No deterministic findings were recorded for these manuscript bytes.</p>
                }
              >
                <div style={{ display: "grid", gap: "8px" }}>
                  <For each={report().findings}>
                    {(finding) => (
                      <ReviewFindingCard report={report().id} finding={finding} onFinding={props.onFinding} />
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </section>
      <section style={card()}>
        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
          <Heading icon="review">Manual review threads</Heading>
          <span
            style={{
              "font-family": FONT_MONO,
              "font-size": "10px",
              color: open() ? "var(--color-warning)" : "var(--color-text-faint)",
            }}
          >
            {open()} open
          </span>
        </div>
        <textarea
          aria-label="New annotation"
          value={body()}
          rows={3}
          placeholder="Record a question, correction, or publication check…"
          onInput={(event) => setBody(event.currentTarget.value)}
          style={{
            width: "100%",
            resize: "vertical",
            "box-sizing": "border-box",
            padding: "9px 10px",
            border: "1px solid var(--color-border)",
            "border-radius": "6px",
            outline: "none",
            background: "var(--color-bg)",
            color: "var(--color-text)",
            "font-family": FONT_SANS,
            "font-size": "11px",
            "line-height": 1.5,
          }}
        />
        <button
          type="button"
          disabled={!body().trim() || busy()}
          style={{ ...actionButton(true), opacity: !body().trim() || busy() ? 0.45 : 1 }}
          onClick={() => void add()}
        >
          {busy() ? "Adding…" : "Add annotation"}
        </button>
      </section>
      <Show
        when={props.annotations.length}
        fallback={
          <div style={{ ...card(), "justify-items": "start" }}>
            <strong style={{ "font-family": FONT_SANS, "font-size": "12px", color: "var(--color-text)" }}>
              No annotations yet
            </strong>
            <p style={copyStyle()}>Add the first review note. Threads persist with this project and file.</p>
          </div>
        }
      >
        <For each={props.annotations}>{(item) => <AnnotationThread annotation={item} onUpdate={props.onUpdate} />}</For>
      </Show>
    </div>
  )
}

function ReviewMetric(props: {
  label: string
  value: number
  tone?: PublicationReviewFinding["severity"]
}): JSX.Element {
  return (
    <div
      style={{
        padding: "7px 8px",
        display: "grid",
        gap: "2px",
        border: "1px solid var(--color-border)",
        "border-radius": "5px",
        background: "var(--color-surface)",
      }}
    >
      <strong
        style={{
          "font-family": FONT_MONO,
          "font-size": "13px",
          color: props.tone ? findingColor(props.tone) : "var(--color-text)",
        }}
      >
        {props.value}
      </strong>
      <span
        style={{
          "font-family": FONT_MONO,
          "font-size": "8px",
          "text-transform": "uppercase",
          color: "var(--color-text-faint)",
        }}
      >
        {props.label}
      </span>
    </div>
  )
}

function ReviewFindingCard(props: {
  report: string
  finding: PublicationReviewFinding
  onFinding(report: string, finding: string, status: "resolved" | "overridden", reason: string): Promise<boolean>
}): JSX.Element {
  const [mode, setMode] = createSignal<"resolved" | "overridden">()
  const [reason, setReason] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    const status = mode()
    const note = reason().trim()
    if (!status || !note || busy()) return
    setBusy(true)
    const ok = await props.onFinding(props.report, props.finding.id, status, note)
    setBusy(false)
    if (!ok) return
    setMode()
    setReason("")
  }
  return (
    <article
      data-component="publication-finding"
      data-finding-id={props.finding.id}
      style={{
        padding: "10px",
        display: "grid",
        gap: "7px",
        border: "1px solid var(--color-border)",
        "border-left": `3px solid ${findingColor(props.finding.severity)}`,
        "border-radius": "5px",
        background: "var(--color-bg)",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "6px", "flex-wrap": "wrap" }}>
        <span style={findingBadge(props.finding.severity)}>{props.finding.severity}</span>
        <span style={findingBadge()}>{props.finding.check}</span>
        <span style={{ ...findingBadge(), "margin-left": "auto" }}>{props.finding.status}</span>
      </div>
      <strong style={{ "font-family": FONT_SANS, "font-size": "11px", color: "var(--color-text)" }}>
        {props.finding.title}
      </strong>
      <p style={copyStyle()}>{props.finding.detail}</p>
      <span style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
        {props.finding.location.path}
        {props.finding.location.line ? `:${props.finding.location.line}` : ""}
      </span>
      <Show when={props.finding.evidence.length}>
        <ul style={{ margin: 0, padding: "0 0 0 16px", display: "grid", gap: "3px" }}>
          <For each={props.finding.evidence}>
            {(evidence) => (
              <li style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-muted)" }}>
                {evidence}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.finding.resolution}>
        {(resolution) => (
          <p style={{ ...copyStyle(), color: "var(--color-text-muted)" }}>
            {resolution().kind} by {resolution().actor}: {resolution().reason}
          </p>
        )}
      </Show>
      <Show when={props.finding.status === "open"}>
        <div style={{ display: "flex", gap: "6px" }}>
          <button type="button" disabled={busy()} style={quietButton()} onClick={() => setMode("resolved")}>
            Resolve
          </button>
          <button type="button" disabled={busy()} style={quietButton()} onClick={() => setMode("overridden")}>
            Override
          </button>
        </div>
        <Show when={mode()}>
          {(status) => (
            <div style={{ display: "grid", gap: "6px" }}>
              <textarea
                aria-label={`${status() === "resolved" ? "Resolution" : "Override"} reason for ${props.finding.title}`}
                value={reason()}
                rows={2}
                placeholder={
                  status() === "resolved"
                    ? "What evidence or edit resolves this finding?"
                    : "Why is it acceptable to publish despite this finding?"
                }
                onInput={(event) => setReason(event.currentTarget.value)}
                style={{
                  width: "100%",
                  resize: "vertical",
                  "box-sizing": "border-box",
                  padding: "8px",
                  border: "1px solid var(--color-border)",
                  "border-radius": "5px",
                  outline: "none",
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  "font-family": FONT_SANS,
                  "font-size": "10px",
                  "line-height": 1.5,
                }}
              />
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  disabled={!reason().trim() || busy()}
                  style={{ ...actionButton(true), opacity: !reason().trim() || busy() ? 0.45 : 1 }}
                  onClick={() => void submit()}
                >
                  {busy() ? "Saving…" : `Confirm ${status()}`}
                </button>
                <button type="button" disabled={busy()} style={quietButton()} onClick={() => setMode()}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </article>
  )
}

function AnnotationThread(props: {
  annotation: Annotation
  onUpdate(id: string, body: Record<string, unknown>): Promise<boolean>
}): JSX.Element {
  const [reply, setReply] = createSignal("")
  const [edit, setEdit] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const update = async (body: Record<string, unknown>) => {
    if (busy()) return
    setBusy(true)
    const ok = await props.onUpdate(props.annotation.id, body)
    setBusy(false)
    if (ok && typeof body.reply === "string") setReply("")
    if (ok && typeof body.body === "string") setEditing(false)
  }
  const anchor = () => {
    const value = props.annotation.anchor
    if (value.kind === "text") return `Lines ${value.startLine}–${value.endLine}`
    if (value.kind === "molecule") return value.selection ?? "Molecular selection"
    if (value.kind === "genome") return `${value.chromosome}:${value.start}–${value.end}`
    if (value.kind === "notebook") return `Cell ${value.cellId}`
    return value.label ?? "Whole file"
  }
  return (
    <article data-component="artifact-annotation" data-status={props.annotation.status} style={card()}>
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <span
          style={{
            padding: "3px 6px",
            "border-radius": "999px",
            background:
              props.annotation.status === "open" ? "var(--color-warning-subtle)" : "var(--color-success-subtle)",
            color: props.annotation.status === "open" ? "var(--color-warning)" : "var(--color-success)",
            "font-family": FONT_SANS,
            "font-size": "9px",
            "font-weight": 650,
            "text-transform": "capitalize",
          }}
        >
          {props.annotation.status === "open" ? "Open" : "Resolved"}
        </span>
        <span
          title={anchor()}
          style={{
            flex: 1,
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
            "font-family": FONT_MONO,
            "font-size": "9px",
            color: "var(--color-text-faint)",
          }}
        >
          {anchor()}
        </span>
        <span style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
          v{props.annotation.version}
        </span>
        <button
          type="button"
          disabled={busy()}
          style={quietButton()}
          onClick={() => {
            setEdit(props.annotation.messages[0]?.body ?? "")
            setEditing(true)
          }}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={busy()}
          style={quietButton()}
          onClick={() => void update({ status: props.annotation.status === "open" ? "resolved" : "open" })}
        >
          {props.annotation.status === "open" ? "Resolve" : "Reopen"}
        </button>
      </div>
      <For each={props.annotation.messages}>
        {(message, index) => (
          <div style={{ display: "grid", gap: "4px", padding: "8px 0", "border-top": "1px solid var(--color-border)" }}>
            <Show
              when={index() === 0 && editing()}
              fallback={<p style={{ ...copyStyle(), color: "var(--color-text)" }}>{message.body}</p>}
            >
              <textarea
                aria-label={`Edit annotation ${props.annotation.id}`}
                value={edit()}
                rows={3}
                onInput={(event) => setEdit(event.currentTarget.value)}
                style={{
                  width: "100%",
                  resize: "vertical",
                  "box-sizing": "border-box",
                  padding: "8px",
                  border: "1px solid var(--color-border)",
                  "border-radius": "5px",
                  outline: "none",
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  "font-family": FONT_SANS,
                  "font-size": "10px",
                  "line-height": 1.5,
                }}
              />
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  disabled={!edit().trim() || busy()}
                  style={{ ...quietButton(), border: "1px solid var(--color-border)" }}
                  onClick={() => void update({ body: edit().trim() })}
                >
                  Save edit
                </button>
                <button type="button" disabled={busy()} style={quietButton()} onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </Show>
            <span style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
              {message.author} · {new Date(message.createdAt).toLocaleString()}
            </span>
          </div>
        )}
      </For>
      <details>
        <summary
          style={{
            cursor: "pointer",
            "font-family": FONT_SANS,
            "font-size": "10px",
            color: "var(--color-text-muted)",
          }}
        >
          History · {props.annotation.revisions.length} revisions
        </summary>
        <ol style={{ margin: "8px 0 0", padding: "0 0 0 20px", display: "grid", gap: "5px" }}>
          <For each={props.annotation.revisions}>
            {(item) => (
              <li style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
                v{item.version} · {item.event} · {item.actor} · {new Date(item.at).toLocaleString()}
              </li>
            )}
          </For>
        </ol>
      </details>
      <div style={{ display: "flex", gap: "6px" }}>
        <input
          aria-label={`Reply to ${props.annotation.id}`}
          value={reply()}
          placeholder="Reply…"
          onInput={(event) => setReply(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !reply().trim()) return
            event.preventDefault()
            void update({ reply: reply().trim() })
          }}
          style={{
            flex: 1,
            "min-width": 0,
            padding: "7px 8px",
            border: "1px solid var(--color-border)",
            "border-radius": "5px",
            outline: "none",
            background: "var(--color-bg)",
            color: "var(--color-text)",
            "font-family": FONT_SANS,
            "font-size": "10px",
          }}
        />
        <button
          type="button"
          disabled={!reply().trim() || busy()}
          style={{ ...quietButton(), border: "1px solid var(--color-border)" }}
          onClick={() => void update({ reply: reply().trim() })}
        >
          Reply
        </button>
      </div>
    </article>
  )
}

function Details(props: { data: InspectorData }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <section style={card()}>
        <Heading icon="details">File</Heading>
        <Fact label="name" value={props.data.context.name} />
        <Fact label="kind" value={props.data.context.kind} />
        <Fact label="format" value={props.data.context.format.toUpperCase()} mono />
        <Fact label="path" value={props.data.context.path} mono />
        <Fact label="location" value={props.data.context.directory} mono />
        <Show when={props.data.context.scienceKind}>
          <Fact label="renderer" value={props.data.context.scienceKind!} mono />
        </Show>
      </section>
      <Show when={props.data.context.inspection}>
        {(inspection) => (
          <>
            <section style={card()}>
              <Heading icon="details">Scientific properties</Heading>
              <For each={inspection().facts}>{(item) => <Fact label={item.label} value={item.value} mono />}</For>
              <Show when={inspection().selection}>
                {(selection) => <Fact label="selection" value={selection().label} />}
              </Show>
            </section>
            <section style={card()}>
              <Heading icon="details">Available operations</Heading>
              <div style={{ display: "flex", gap: "5px", "flex-wrap": "wrap" }}>
                <For each={inspection().capabilities}>
                  {(item) => (
                    <span
                      style={{
                        padding: "4px 6px",
                        "border-radius": "5px",
                        border: "1px solid var(--color-border)",
                        background: "var(--color-bg)",
                        "font-family": FONT_SANS,
                        "font-size": "10px",
                        color: "var(--color-text-muted)",
                      }}
                    >
                      {item}
                    </span>
                  )}
                </For>
              </div>
            </section>
          </>
        )}
      </Show>
      <section style={card()}>
        <Heading icon="history">Provenance</Heading>
        <Show
          when={props.data.provenance}
          fallback={<p style={copyStyle()}>No Git provenance is recorded for this local file.</p>}
        >
          {(value) => (
            <>
              <Fact label="status" value={value().status} />
              <Fact label="branch" value={value().branch ?? "detached or unavailable"} mono />
              <Fact label="working tree" value={value().dirty ? "modified" : "clean"} />
              <Fact label="commit" value={value().commit?.sha.slice(0, 12) ?? "not committed"} mono />
            </>
          )}
        </Show>
      </section>
    </div>
  )
}

function Environment(props: { data: InspectorData }): JSX.Element {
  return (
    <Show
      when={props.data.tabs.environment.available}
      fallback={<Empty state={props.data.tabs.environment} icon="environment" />}
    >
      <div style={{ display: "grid", gap: "12px" }}>
        <List title="Environment specifications" items={props.data.environments} />
        <List title="Dependency locks" items={props.data.lockfiles} />
      </div>
    </Show>
  )
}

function History(props: { data: InspectorData }): JSX.Element {
  return (
    <Show when={props.data.provenance?.commit} fallback={<Empty state={props.data.tabs.history} icon="history" />}>
      {(version) => (
        <section style={card()}>
          <Heading icon="history">Latest recorded version</Heading>
          <Fact label="commit" value={version().sha} mono />
          <Fact label="author" value={`${version().author} <${version().email}>`} />
          <Fact label="date" value={new Date(version().date).toLocaleString()} />
          <Fact label="message" value={version().message} />
          <p style={copyStyle()}>
            This is the latest Git commit touching the file. Artifact-level branches and comparisons are not recorded
            yet.
          </p>
        </section>
      )}
    </Show>
  )
}

function List(props: { title: string; items: string[] }): JSX.Element {
  return (
    <section style={card()}>
      <Heading icon="environment">{props.title}</Heading>
      <Show when={props.items.length} fallback={<p style={copyStyle()}>None recorded.</p>}>
        <ul style={{ margin: 0, padding: "0 0 0 18px", display: "grid", gap: "6px" }}>
          <For each={props.items}>
            {(item) => (
              <li style={{ "font-family": FONT_CODE, "font-size": "11px", color: "var(--color-text-muted)" }}>
                {item}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}

function Empty(props: {
  state: InspectorState
  icon: "code" | "run" | "messages" | "environment" | "review" | "history"
}): JSX.Element {
  return (
    <div
      data-component="artifact-inspector-empty"
      style={{
        display: "grid",
        "justify-items": "start",
        gap: "10px",
        padding: "18px",
        border: "1px solid var(--color-border)",
        "border-radius": "8px",
        background: "var(--color-bg-subtle)",
      }}
    >
      <Heading icon={props.icon}>{props.state.title}</Heading>
      <p style={{ ...copyStyle(), margin: 0 }}>{props.state.detail}</p>
    </div>
  )
}

function Loading(): JSX.Element {
  return (
    <div data-component="artifact-inspector-loading" style={{ display: "grid", gap: "10px" }}>
      <For each={[1, 2, 3]}>
        {() => <div style={{ height: "58px", "border-radius": "7px", background: "var(--color-bg-subtle)" }} />}
      </For>
    </div>
  )
}

function Heading(props: {
  icon: "details" | "code" | "run" | "messages" | "environment" | "review" | "history"
  children: JSX.Element
}): JSX.Element {
  const icons = {
    details: IconFile,
    code: IconBraces,
    run: IconClock,
    messages: IconMessageSquare,
    environment: IconSettings,
    review: IconFlask,
    history: IconBookOpen,
  }
  const Icon = icons[props.icon]
  return (
    <h3
      style={{
        margin: 0,
        display: "flex",
        "align-items": "center",
        gap: "7px",
        "font-family": FONT_SANS,
        "font-size": "12px",
        "font-weight": 650,
        color: "var(--color-text)",
      }}
    >
      <Icon size={13} strokeWidth={1.5} />
      {props.children}
    </h3>
  )
}

function Fact(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div
      style={{ display: "grid", "grid-template-columns": "78px minmax(0, 1fr)", gap: "10px", "align-items": "start" }}
    >
      <span style={{ "font-family": FONT_SANS, "font-size": "11px", color: "var(--color-text-faint)" }}>
        {props.label}
      </span>
      <span
        title={props.value}
        style={{
          "font-family": props.mono ? FONT_CODE : FONT_SANS,
          "font-size": "11px",
          "line-height": 1.45,
          color: "var(--color-text-muted)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.value}
      </span>
    </div>
  )
}

function card(): JSX.CSSProperties {
  return {
    display: "grid",
    gap: "9px",
    padding: "13px",
    border: "1px solid var(--color-border)",
    "border-radius": "8px",
    background: "var(--color-bg-subtle)",
  }
}

function copyStyle(): JSX.CSSProperties {
  return {
    margin: 0,
    "font-family": FONT_SANS,
    "font-size": "11px",
    "line-height": 1.55,
    color: "var(--color-text-muted)",
  }
}

function actionButton(primary = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    gap: "6px",
    padding: "7px 8px",
    "border-radius": "6px",
    border: primary ? "1px solid var(--color-text)" : "1px solid var(--color-border)",
    background: primary ? "var(--color-text)" : "var(--color-bg-subtle)",
    color: primary ? "var(--color-bg)" : "var(--color-text-muted)",
    "font-family": FONT_SANS,
    "font-size": "11px",
    "font-weight": primary ? 650 : 500,
  }
}

function tabButton(active: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    gap: "5px",
    padding: "6px 8px",
    "border-radius": "5px",
    background: active ? "var(--color-accent-subtle)" : "transparent",
    color: active ? "var(--color-text)" : "var(--color-text-muted)",
    "font-family": FONT_SANS,
    "font-size": "11px",
    "font-weight": active ? 650 : 500,
    "white-space": "nowrap",
  }
}

function iconButton(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    width: "28px",
    height: "28px",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    "border-radius": "5px",
    color: "var(--color-text-muted)",
  }
}

function quietButton(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    padding: "5px 8px",
    "border-radius": "5px",
    "font-family": FONT_SANS,
    "font-size": "11px",
    color: "var(--color-text-muted)",
  }
}

function reviewColor(kind: PublicationReviewState["kind"]): string {
  if (kind === "blocked" || kind === "stale") return "var(--color-danger, var(--color-error))"
  if (kind === "warnings") return "var(--color-warning)"
  if (kind === "ready" || kind === "finalized") return "var(--color-success)"
  return "var(--color-text-faint)"
}

function findingColor(severity: PublicationReviewFinding["severity"]): string {
  if (severity === "blocking") return "var(--color-danger, var(--color-error))"
  if (severity === "major") return "var(--color-warning)"
  if (severity === "minor") return "var(--color-text-muted)"
  return "var(--color-text-faint)"
}

function findingBadge(severity?: PublicationReviewFinding["severity"]): JSX.CSSProperties {
  return {
    padding: "3px 6px",
    "border-radius": "999px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-subtle)",
    color: severity ? findingColor(severity) : "var(--color-text-muted)",
    "font-family": FONT_MONO,
    "font-size": "8px",
    "font-weight": severity ? 650 : 500,
    "text-transform": "uppercase",
    "letter-spacing": "0.04em",
  }
}

export default ArtifactInspector
