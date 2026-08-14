import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useDialog } from "@synsci/ui/context/dialog"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { uiStore } from "@/atlas/store/ui"
import { toast } from "@/atlas/Toast"
import { promptDialog } from "@/atlas/dialogs"
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
import { resolveArtifactPath, type ArtifactContext } from "./context"
import {
  filterReviewerFindings,
  inspectorTabs,
  normalizeInspectorData,
  normalizePublicationReview,
  normalizeReviewerFindings,
  type InspectorData,
  type InspectorState,
  type InspectorTab,
  type LineageMessage,
  type LineageRun,
  type PublicationReviewFinding,
  type PublicationReviewState,
  type ReviewerFinding,
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

const BODY_FONT_SIZE = "16px"
const META_FONT_SIZE = "14px"
const SECTION_TITLE_SIZE = "20px"
const CONTROL_HEIGHT = "44px"
const CONTROL_RADIUS = "14px"
const GROUP_RADIUS = "18px"

function sentence(value: string) {
  const text = value.replace(/[-_]+/g, " ").trim()
  if (!text) return text
  if (text.toLocaleLowerCase() === "ok") return "OK"
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`
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
  const prompt = usePrompt()
  const params = useParams()
  const dialog = useDialog()
  const [tab, setTab] = createSignal<InspectorTab>("details")
  const path = () => resolveArtifactPath(props.context.directory, props.context.path)
  const query = (path?: string) => ({
    path,
    sessionID: params.id && params.id !== "new" ? params.id : undefined,
  })

  const [records, api] = createResource(
    () => ({
      id: props.context.id,
      path: path(),
      directory: props.context.directory,
      sessionID: params.id && params.id !== "new" ? params.id : undefined,
    }),
    async (current) => {
      const read = async (route: string, path?: string): Promise<unknown> => {
        const response = await sdk.request(route, undefined, query(path)).catch(() => undefined)
        if (!response?.ok) return
        return response.json().catch(() => undefined)
      }
      const [file, provenance, audit, notes, review, lineage, reviews] = await Promise.all([
        read("/file/content", current.path),
        read("/file/provenance", current.path),
        read("/file/reproducibility"),
        read("/file/annotations", current.path),
        read("/file/reviews", current.path),
        read("/file/lineage", current.path),
        read("/provenance/reviews"),
      ])
      return { id: current.id, file, provenance, audit, notes, review, lineage, reviews }
    },
  )
  const model = createMemo<InspectorData>(() => {
    const value = records()
    const input = value?.id === props.context.id ? value : {}
    return normalizeInspectorData(props.context, input)
  })
  const review = createMemo(() => normalizePublicationReview(props.context.format, records()?.review))
  const session = () => (params.id && params.id !== "new" ? params.id : undefined)
  const findings = createMemo(() => filterReviewerFindings(normalizeReviewerFindings(records()?.reviews), session()))

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
    toast.success("Copied", props.context.path)
  }
  const attach = () => {
    prompt.context.add({ type: "file", path: props.context.path })
    toast.success("Added to context", props.context.name)
  }
  const download = async () => {
    const response = await sdk.request("/file/raw", undefined, query(path())).catch(() => undefined)
    if (!response?.ok) {
      toast.error("Download failed", response ? `${response.status}` : "Request failed")
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
    const response = await sdk
      .request(
        route,
        {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        query(),
      )
      .catch(() => undefined)
    if (!response?.ok) {
      toast.error("Annotation failed", response ? `${response.status}` : "Request failed")
      return false
    }
    await api.refetch()
    return true
  }
  const addAnnotation = (body: string) =>
    mutateAnnotation("/file/annotations", "POST", {
      path: path(),
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
    const response = await sdk
      .request(
        route,
        {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        query(),
      )
      .catch(() => undefined)
    if (!response?.ok) {
      const payload = (await response?.json().catch(() => undefined)) as { error?: unknown } | undefined
      const detail =
        typeof payload?.error === "string" ? payload.error : response ? `${response.status}` : "Request failed"
      toast.error("Publication preflight failed", detail)
      return false
    }
    await api.refetch()
    return true
  }
  const actor = () => model().provenance?.commit?.author ?? "Local user"
  // Reviewer findings live in the provenance graph. Marking one addressed is an
  // append-only resolution; it stays unconfirmed until a later reviewer pass
  // records a supporting finding on the same target.
  const addressFinding = async (finding: ReviewerFinding) => {
    const reason = await promptDialog(dialog, {
      title: "Mark finding addressed",
      message:
        "Describe the fix in one line. The record stays 'addressed' — only a later reviewer pass can confirm it.",
      placeholder: "What change addresses this finding?",
      confirmLabel: "Record fix",
    })
    const note = reason?.trim()
    if (!note) return
    const response = await sdk
      .request(
        `/provenance/reviews/${finding.id}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: actor(), reason: note }),
        },
        query(),
      )
      .catch(() => undefined)
    if (!response?.ok) {
      const payload = (await response?.json().catch(() => undefined)) as { error?: unknown } | undefined
      const detail =
        typeof payload?.error === "string" ? payload.error : response ? `${response.status}` : "Request failed"
      toast.error("Could not record the fix", detail)
      return
    }
    toast.success("Finding marked addressed", note)
    await api.refetch()
  }
  const runReview = () =>
    mutateReview("/file/reviews", "POST", {
      path: path(),
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
        "font-family": FONT_SANS,
        "font-size": BODY_FONT_SIZE,
      }}
    >
      <header
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "18px 20px",
          "border-bottom": "1px solid var(--color-border)",
          "flex-shrink": 0,
        }}
      >
        <span style={{ display: "inline-flex", color: "var(--color-text-muted)" }}>
          <IconFile size={20} strokeWidth={1.5} />
        </span>
        <div style={{ flex: 1, "min-width": 0, display: "grid", gap: "4px" }}>
          <strong
            title={props.context.path}
            style={{
              "font-family": FONT_SANS,
              "font-size": "18px",
              "font-weight": "var(--font-weight-medium)",
              "line-height": 1.3,
              color: "var(--color-text)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {props.context.name}
          </strong>
          <span style={{ "font-family": FONT_SANS, "font-size": META_FONT_SIZE, color: "var(--color-text-faint)" }}>
            {props.context.kind} · {props.context.format.toUpperCase()}
          </span>
        </div>
        <button type="button" title="Refresh file details" style={iconButton()} onClick={() => void api.refetch()}>
          <IconRefresh size={13} />
        </button>
        <Show when={props.onClose}>
          <button type="button" style={quietButton()} onClick={() => props.onClose?.()}>
            Close
          </button>
        </Show>
      </header>

      <div
        style={{
          display: "grid",
          "grid-template-columns": "repeat(auto-fit, minmax(108px, 1fr))",
          gap: "10px",
          padding: "16px 20px",
        }}
      >
        <button type="button" style={actionButton(true)} onClick={attach}>
          <IconFlask size={16} /> Ask
        </button>
        <button type="button" style={actionButton()} onClick={() => void copy()}>
          <IconCopy size={16} /> Path
        </button>
        <button type="button" style={actionButton()} onClick={() => void download()}>
          <IconDownload size={16} /> Download
        </button>
      </div>

      <div
        role="tablist"
        aria-label="File details"
        class="atlas-scroll"
        style={{
          display: "flex",
          gap: "6px",
          padding: "0 20px 14px",
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
                <span aria-hidden="true" style={{ color: "var(--color-text-faint)", "font-size": META_FONT_SIZE }}>
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
        style={{
          flex: 1,
          "min-height": 0,
          overflow: "auto",
          padding: "22px",
          "box-sizing": "border-box",
          "font-size": BODY_FONT_SIZE,
        }}
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
                      "font-size": BODY_FONT_SIZE,
                      "line-height": 1.7,
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
              <Runs data={model()} />
            </Match>
            <Match when={tab() === "messages"}>
              <Messages data={model()} session={params.id && params.id !== "new" ? params.id : undefined} />
            </Match>
            <Match when={tab() === "environment"}>
              <Environment data={model()} />
            </Match>
            <Match when={tab() === "review"}>
              <Review
                state={review()}
                findings={findings()}
                scoped={Boolean(session())}
                annotations={annotations(records()?.notes)}
                onRun={runReview}
                onFinding={resolveFinding}
                onFinalize={finalizeReview}
                onAddress={addressFinding}
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
  findings: ReviewerFinding[]
  scoped: boolean
  annotations: Annotation[]
  onRun(): Promise<boolean>
  onFinding(report: string, finding: string, status: "resolved" | "overridden", reason: string): Promise<boolean>
  onFinalize(report: string): Promise<boolean>
  onAddress(finding: ReviewerFinding): Promise<void>
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
    <div style={{ display: "grid", gap: "18px" }}>
      <section
        data-component="publication-review"
        data-review-state={props.state.kind}
        style={{
          ...card(),
          "border-left": `4px solid ${reviewColor(props.state.kind)}`,
          gap: "18px",
        }}
      >
        <div
          style={{
            display: "flex",
            "align-items": "flex-start",
            "justify-content": "space-between",
            gap: "16px",
            "flex-wrap": "wrap",
          }}
        >
          <div style={{ display: "grid", gap: "6px", flex: "1 1 220px" }}>
            <span
              style={{
                "font-family": FONT_MONO,
                "font-size": META_FONT_SIZE,
                "letter-spacing": "normal",
                color: reviewColor(props.state.kind),
              }}
            >
              {sentence(props.state.kind)}
            </span>
            <strong
              style={{
                "font-family": FONT_SANS,
                "font-size": SECTION_TITLE_SIZE,
                "font-weight": "var(--font-weight-medium)",
                color: "var(--color-text)",
              }}
            >
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
                  "grid-template-columns": "repeat(auto-fit, minmax(110px, 1fr))",
                  gap: "10px",
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
                  gap: "12px",
                  "flex-wrap": "wrap",
                }}
              >
                <span
                  data-label="review-version"
                  style={{ "font-family": FONT_MONO, "font-size": META_FONT_SIZE, color: "var(--color-text-faint)" }}
                >
                  Preflight version {report().version} · Evidence hash sha256 {report().artifactHash.slice(0, 12)}
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
                      Finalize preflight-checked bytes
                    </button>
                  }
                >
                  {(value) => (
                    <span
                      style={{ "font-family": FONT_MONO, "font-size": META_FONT_SIZE, color: "var(--color-success)" }}
                    >
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
                <div style={{ display: "grid", gap: "14px" }}>
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
      <section data-component="reviewer-findings" style={card()}>
        <div style={{ display: "grid", gap: "6px" }}>
          <Heading icon="review">Reviewer findings</Heading>
          <p style={copyStyle()}>
            {props.scoped
              ? "Findings the independent reviewer recorded in this session. They are project-wide provenance records, not filtered to this artifact."
              : "All reviewer findings recorded in this project's provenance graph."}
          </p>
        </div>
        <Show
          when={props.findings.length}
          fallback={<p style={copyStyle()}>No reviewer findings are recorded. Run a review from the session menu.</p>}
        >
          <div style={{ display: "grid", gap: "14px" }}>
            <For each={props.findings}>
              {(finding) => <ReviewerFindingCard finding={finding} onAddress={props.onAddress} />}
            </For>
          </div>
        </Show>
      </section>
      <section style={card()}>
        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "12px" }}>
          <Heading icon="review">Manual review threads</Heading>
          <span
            style={{
              "font-family": FONT_MONO,
              "font-size": META_FONT_SIZE,
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
            padding: "14px 16px",
            border: "1px solid var(--color-border)",
            "border-radius": CONTROL_RADIUS,
            outline: "none",
            background: "var(--color-bg)",
            color: "var(--color-text)",
            "font-family": FONT_SANS,
            "font-size": BODY_FONT_SIZE,
            "line-height": 1.6,
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
            <strong
              style={{
                "font-family": FONT_SANS,
                "font-size": "18px",
                "font-weight": "var(--font-weight-medium)",
                color: "var(--color-text)",
              }}
            >
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
        padding: "14px 12px",
        display: "grid",
        gap: "4px",
        "border-radius": CONTROL_RADIUS,
        background: "var(--color-bg)",
      }}
    >
      <strong
        style={{
          "font-family": FONT_SANS,
          "font-size": SECTION_TITLE_SIZE,
          "font-weight": "var(--font-weight-emphasis)",
          color: props.tone ? findingColor(props.tone) : "var(--color-text)",
        }}
      >
        {props.value}
      </strong>
      <span
        style={{
          "font-family": FONT_SANS,
          "font-size": "13px",
          color: "var(--color-text-faint)",
        }}
      >
        {sentence(props.label)}
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
        padding: "18px",
        display: "grid",
        gap: "12px",
        "border-left": `4px solid ${findingColor(props.finding.severity)}`,
        "border-radius": "16px",
        background: "var(--color-bg-subtle)",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
        <span style={findingBadge(props.finding.severity)}>{sentence(props.finding.severity)}</span>
        <span style={findingBadge()}>{sentence(props.finding.check)}</span>
        <span style={{ ...findingBadge(), "margin-left": "auto" }}>{sentence(props.finding.status)}</span>
      </div>
      <strong
        style={{
          "font-family": FONT_SANS,
          "font-size": "18px",
          "font-weight": "var(--font-weight-medium)",
          "line-height": 1.35,
          color: "var(--color-text)",
        }}
      >
        {props.finding.title}
      </strong>
      <p style={copyStyle()}>{props.finding.detail}</p>
      <span style={{ "font-family": FONT_MONO, "font-size": META_FONT_SIZE, color: "var(--color-text-faint)" }}>
        {props.finding.location.path}
        {props.finding.location.line ? `:${props.finding.location.line}` : ""}
      </span>
      <Show when={props.finding.evidence.length}>
        <div data-section="finding-evidence" style={{ display: "grid", gap: "8px" }}>
          <span
            style={{
              "font-family": FONT_SANS,
              "font-size": META_FONT_SIZE,
              "font-weight": "var(--font-weight-emphasis)",
              color: "var(--color-text)",
            }}
          >
            Evidence
          </span>
          <ul style={{ margin: 0, padding: "0 0 0 20px", display: "grid", gap: "6px" }}>
            <For each={props.finding.evidence}>
              {(evidence) => (
                <li
                  style={{
                    "font-family": FONT_MONO,
                    "font-size": META_FONT_SIZE,
                    "line-height": 1.55,
                    color: "var(--color-text-muted)",
                  }}
                >
                  {evidence}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <Show when={props.finding.resolution}>
        {(resolution) => (
          <p style={{ ...copyStyle(), color: "var(--color-text-muted)" }}>
            {resolution().kind} by {resolution().actor}: {resolution().reason}
          </p>
        )}
      </Show>
      <Show when={props.finding.status === "open"}>
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
          <button type="button" disabled={busy()} style={quietButton()} onClick={() => setMode("resolved")}>
            Resolve
          </button>
          <button type="button" disabled={busy()} style={quietButton()} onClick={() => setMode("overridden")}>
            Override
          </button>
        </div>
        <Show when={mode()}>
          {(status) => (
            <div style={{ display: "grid", gap: "10px" }}>
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
                  padding: "14px 16px",
                  border: "1px solid var(--color-border)",
                  "border-radius": CONTROL_RADIUS,
                  outline: "none",
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  "font-family": FONT_SANS,
                  "font-size": BODY_FONT_SIZE,
                  "line-height": 1.6,
                }}
              />
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
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

function ReviewerFindingCard(props: {
  finding: ReviewerFinding
  onAddress(finding: ReviewerFinding): Promise<void>
}): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const address = async () => {
    if (busy()) return
    setBusy(true)
    await props.onAddress(props.finding)
    setBusy(false)
  }
  return (
    <article
      data-component="reviewer-finding"
      data-finding-id={props.finding.id}
      data-finding-status={props.finding.status}
      style={{
        padding: "18px",
        display: "grid",
        gap: "12px",
        "border-left": `4px solid ${findingColor(props.finding.severity)}`,
        "border-radius": "16px",
        background: "var(--color-bg-subtle)",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap" }}>
        <span style={findingBadge(props.finding.severity)}>{sentence(props.finding.severity)}</span>
        <span style={findingBadge()}>{sentence(props.finding.verdict)}</span>
        <Show when={props.finding.status}>
          {(status) => (
            <span data-chip="finding-status" style={{ ...reviewerStatusBadge(status()), "margin-left": "auto" }}>
              {sentence(status())}
            </span>
          )}
        </Show>
      </div>
      <blockquote
        style={{
          margin: 0,
          padding: "0 0 0 14px",
          "border-left": "3px solid var(--color-border)",
          "font-family": FONT_SANS,
          "font-size": "18px",
          "line-height": 1.45,
          color: "var(--color-text)",
        }}
      >
        “{props.finding.claim}”
      </blockquote>
      <p style={copyStyle()}>{props.finding.issue}</p>
      <pre
        data-section="reviewer-evidence"
        class="atlas-scroll"
        style={{
          margin: 0,
          "max-height": "200px",
          overflow: "auto",
          padding: "14px 16px",
          "border-radius": CONTROL_RADIUS,
          background: "var(--color-bg)",
          "font-family": FONT_MONO,
          "font-size": META_FONT_SIZE,
          "line-height": 1.6,
          color: "var(--color-text-muted)",
          "white-space": "pre-wrap",
          "overflow-wrap": "anywhere",
        }}
      >
        {props.finding.evidence}
      </pre>
      <span style={{ "font-family": FONT_MONO, "font-size": META_FONT_SIZE, color: "var(--color-text-faint)" }}>
        {props.finding.reviewer} · {new Date(props.finding.recordedAt).toLocaleString()}
      </span>
      <Show when={props.finding.resolution}>
        {(resolution) => (
          <p style={{ ...copyStyle(), color: "var(--color-text-muted)" }}>
            Fix recorded by {resolution().actor}: {resolution().reason}
          </p>
        )}
      </Show>
      <Show when={props.finding.verdict === "refutes" && props.finding.status === "open"}>
        <button
          type="button"
          disabled={busy()}
          style={{ ...actionButton(), "justify-self": "start", opacity: busy() ? 0.45 : 1 }}
          onClick={() => void address()}
        >
          {busy() ? "Recording…" : "Mark addressed"}
        </button>
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
    if (value.kind === "notebook") return value.label ?? "Saved selection"
    return value.label ?? "Whole file"
  }
  return (
    <article data-component="artifact-annotation" data-status={props.annotation.status} style={card()}>
      <div style={{ display: "flex", "align-items": "center", gap: "10px", "flex-wrap": "wrap" }}>
        <span
          style={{
            padding: "6px 10px",
            "border-radius": "999px",
            background:
              props.annotation.status === "open" ? "var(--color-warning-subtle)" : "var(--color-success-subtle)",
            color: props.annotation.status === "open" ? "var(--color-warning)" : "var(--color-success)",
            "font-family": FONT_SANS,
            "font-size": "13px",
            "font-weight": "var(--font-weight-emphasis)",
          }}
        >
          {props.annotation.status === "open" ? "Open" : "Resolved"}
        </span>
        <span
          title={anchor()}
          style={{
            flex: "1 1 160px",
            "font-family": FONT_MONO,
            "font-size": META_FONT_SIZE,
            "line-height": 1.5,
            color: "var(--color-text-faint)",
          }}
        >
          {anchor()}
        </span>
        <span style={{ "font-family": FONT_MONO, "font-size": META_FONT_SIZE, color: "var(--color-text-faint)" }}>
          Annotation version {props.annotation.version}
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
          <div
            style={{
              display: "grid",
              gap: "8px",
              padding: "16px 0",
              "border-top": "1px solid var(--color-border)",
            }}
          >
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
                  padding: "14px 16px",
                  border: "1px solid var(--color-border)",
                  "border-radius": CONTROL_RADIUS,
                  outline: "none",
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  "font-family": FONT_SANS,
                  "font-size": BODY_FONT_SIZE,
                  "line-height": 1.6,
                }}
              />
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
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
            <span style={{ "font-family": FONT_MONO, "font-size": META_FONT_SIZE, color: "var(--color-text-faint)" }}>
              {message.author} · {new Date(message.createdAt).toLocaleString()}
            </span>
          </div>
        )}
      </For>
      <details>
        <summary
          style={{
            cursor: "pointer",
            "min-height": CONTROL_HEIGHT,
            display: "flex",
            "align-items": "center",
            "font-family": FONT_SANS,
            "font-size": BODY_FONT_SIZE,
            color: "var(--color-text-muted)",
          }}
        >
          History · {props.annotation.revisions.length} revisions
        </summary>
        <ol style={{ margin: "12px 0 0", padding: "0 0 0 22px", display: "grid", gap: "8px" }}>
          <For each={props.annotation.revisions}>
            {(item) => (
              <li
                style={{
                  "font-family": FONT_MONO,
                  "font-size": META_FONT_SIZE,
                  "line-height": 1.5,
                  color: "var(--color-text-faint)",
                }}
              >
                Version {item.version} · {item.event} · {item.actor} · {new Date(item.at).toLocaleString()}
              </li>
            )}
          </For>
        </ol>
      </details>
      <div style={{ display: "flex", gap: "8px" }}>
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
            "min-height": CONTROL_HEIGHT,
            "box-sizing": "border-box",
            padding: "0 14px",
            border: "1px solid var(--color-border)",
            "border-radius": CONTROL_RADIUS,
            outline: "none",
            background: "var(--color-bg)",
            color: "var(--color-text)",
            "font-family": FONT_SANS,
            "font-size": BODY_FONT_SIZE,
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
    <div style={{ display: "grid", gap: "18px" }}>
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
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                <For each={inspection().capabilities}>
                  {(item) => (
                    <span
                      style={{
                        padding: "8px 12px",
                        "border-radius": "999px",
                        background: "var(--color-bg)",
                        "font-family": FONT_SANS,
                        "font-size": META_FONT_SIZE,
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
      <div style={{ display: "grid", gap: "18px" }}>
        <List title="Environment specifications" items={props.data.environments} />
        <List title="Dependency locks" items={props.data.lockfiles} />
      </div>
    </Show>
  )
}

function Runs(props: { data: InspectorData }): JSX.Element {
  return (
    <Show when={props.data.runs.length} fallback={<Empty state={props.data.tabs.run} icon="run" />}>
      <div style={{ display: "grid", gap: "18px" }}>
        <For each={props.data.runs}>{(run) => <RunCard run={run} />}</For>
      </div>
    </Show>
  )
}

function RunCard(props: { run: LineageRun }): JSX.Element {
  const kernel = () => [props.run.kernel?.language, props.run.kernel?.name].filter(Boolean).join(" · ")
  const code = () => props.run.code ?? props.run.command
  return (
    <section data-component="artifact-run" data-run-id={props.run.id} style={card()}>
      <div style={{ display: "flex", "align-items": "center", gap: "10px", "flex-wrap": "wrap" }}>
        <Heading icon="run">{props.run.tool}</Heading>
        <Show when={props.run.status}>
          {(status) => (
            <span data-run-status={status()} style={{ ...runBadge(status()), "margin-left": "auto" }}>
              {sentence(status())}
            </span>
          )}
        </Show>
      </div>
      <Fact label="label" value={props.run.label} />
      <Show when={kernel()}>{(value) => <Fact label="kernel" value={value()} mono />}</Show>
      <Show when={props.run.startedAt}>
        {(value) => <Fact label="started" value={new Date(value()).toLocaleString()} />}
      </Show>
      <Show when={props.run.completedAt}>
        {(value) => <Fact label="completed" value={new Date(value()).toLocaleString()} />}
      </Show>
      <Fact label="recorded" value={new Date(props.run.recordedAt).toLocaleString()} />
      <Show when={props.run.cwd}>{(value) => <Fact label="cwd" value={value()} mono />}</Show>
      <Show when={code()}>
        {(value) => (
          <pre
            class="atlas-scroll"
            style={{
              margin: 0,
              "max-height": "320px",
              overflow: "auto",
              padding: "16px",
              "border-radius": CONTROL_RADIUS,
              background: "var(--color-bg)",
              "font-family": FONT_CODE,
              "font-size": META_FONT_SIZE,
              "line-height": 1.65,
              color: "var(--color-text-muted)",
              "white-space": "pre",
            }}
          >
            {value()}
          </pre>
        )}
      </Show>
    </section>
  )
}

function Messages(props: { data: InspectorData; session?: string }): JSX.Element {
  return (
    <Show when={props.data.messages.length} fallback={<Empty state={props.data.tabs.messages} icon="messages" />}>
      <div style={{ display: "grid", gap: "14px" }}>
        <For each={props.data.messages}>{(message) => <MessageRow message={message} session={props.session} />}</For>
      </div>
    </Show>
  )
}

function MessageRow(props: { message: LineageMessage; session?: string }): JSX.Element {
  const current = () => props.session !== undefined && props.message.sessionID === props.session
  const show = () => {
    const node = document.querySelector(`[data-message-id="${props.message.messageID}"]`)
    node?.scrollIntoView({ behavior: "smooth", block: "center" })
  }
  return (
    <section data-component="artifact-message" data-message={props.message.messageID} style={card()}>
      <div style={{ display: "grid", gap: "4px", padding: "2px 0" }}>
        <span style={{ "font-family": FONT_SANS, "font-size": META_FONT_SIZE, color: "var(--color-text-faint)" }}>
          message
        </span>
        <span
          title={props.message.messageID}
          style={{
            "font-family": FONT_CODE,
            "font-size": BODY_FONT_SIZE,
            "line-height": 1.55,
            color: "var(--color-text)",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {props.message.messageID}
        </span>
      </div>
      <Fact label="session" value={props.message.sessionID} mono />
      <Show when={current()}>
        <button type="button" style={{ ...actionButton(), "justify-self": "start" }} onClick={show}>
          <IconMessageSquare size={16} /> Show in conversation
        </button>
      </Show>
    </section>
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
              <li
                style={{
                  "font-family": FONT_CODE,
                  "font-size": BODY_FONT_SIZE,
                  "line-height": 1.6,
                  color: "var(--color-text-muted)",
                }}
              >
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
        gap: "14px",
        padding: "24px",
        "border-radius": GROUP_RADIUS,
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
    <div data-component="artifact-inspector-loading" style={{ display: "grid", gap: "16px" }}>
      <For each={[1, 2, 3]}>
        {() => <div style={{ height: "92px", "border-radius": GROUP_RADIUS, background: "var(--color-bg-subtle)" }} />}
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
        gap: "10px",
        "font-family": FONT_SANS,
        "font-size": SECTION_TITLE_SIZE,
        "line-height": 1.3,
        "font-weight": "var(--font-weight-emphasis)",
        color: "var(--color-text)",
      }}
    >
      <Icon size={18} strokeWidth={1.5} />
      {props.children}
    </h3>
  )
}

function Fact(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "4px", "align-items": "start", padding: "2px 0 8px" }}>
      <span style={{ "font-family": FONT_SANS, "font-size": META_FONT_SIZE, color: "var(--color-text-faint)" }}>
        {sentence(props.label)}
      </span>
      <span
        title={props.value}
        style={{
          "font-family": props.mono ? FONT_CODE : FONT_SANS,
          "font-size": BODY_FONT_SIZE,
          "line-height": 1.55,
          color: "var(--color-text-muted)",
          "overflow-wrap": "anywhere",
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
    gap: "16px",
    padding: "20px",
    "border-radius": GROUP_RADIUS,
    background: "color-mix(in srgb, var(--color-bg-subtle) 82%, var(--color-bg))",
  }
}

function copyStyle(): JSX.CSSProperties {
  return {
    margin: 0,
    "font-family": FONT_SANS,
    "font-size": BODY_FONT_SIZE,
    "line-height": 1.65,
    color: "var(--color-text-muted)",
  }
}

function actionButton(primary = false): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    cursor: "pointer",
    "min-height": CONTROL_HEIGHT,
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    gap: "8px",
    padding: "0 14px",
    "border-radius": CONTROL_RADIUS,
    border: primary ? "1px solid var(--color-text)" : "1px solid var(--color-border)",
    background: primary ? "var(--color-text)" : "var(--color-bg-subtle)",
    color: primary ? "var(--color-bg)" : "var(--color-text-muted)",
    "font-family": FONT_SANS,
    "font-size": "15px",
    "font-weight": primary ? "var(--font-weight-medium)" : "var(--font-weight-regular)",
  }
}

function tabButton(active: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    cursor: "pointer",
    "min-height": CONTROL_HEIGHT,
    display: "inline-flex",
    "align-items": "center",
    gap: "7px",
    padding: "0 14px",
    "border-radius": CONTROL_RADIUS,
    background: active ? "var(--color-accent-subtle)" : "transparent",
    color: active ? "var(--color-text)" : "var(--color-text-muted)",
    "font-family": FONT_SANS,
    "font-size": "15px",
    "font-weight": active ? "var(--font-weight-medium)" : "var(--font-weight-regular)",
    "white-space": "nowrap",
  }
}

function iconButton(): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    cursor: "pointer",
    width: CONTROL_HEIGHT,
    height: CONTROL_HEIGHT,
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    "border-radius": CONTROL_RADIUS,
    color: "var(--color-text-muted)",
  }
}

function quietButton(): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    cursor: "pointer",
    "min-height": CONTROL_HEIGHT,
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    padding: "0 14px",
    "border-radius": CONTROL_RADIUS,
    "font-family": FONT_SANS,
    "font-size": "15px",
    "font-weight": "var(--font-weight-regular)",
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

function runBadge(status: "ok" | "error"): JSX.CSSProperties {
  return {
    padding: "5px 10px",
    "border-radius": "999px",
    background:
      status === "error"
        ? "var(--color-error-subtle, var(--color-bg))"
        : "var(--color-success-subtle, var(--color-bg))",
    color: status === "error" ? "var(--color-danger, var(--color-error))" : "var(--color-success)",
    "font-family": FONT_SANS,
    "font-size": "13px",
    "font-weight": "var(--font-weight-emphasis)",
    "letter-spacing": "normal",
  }
}

function reviewerStatusBadge(status: NonNullable<ReviewerFinding["status"]>): JSX.CSSProperties {
  const color =
    status === "open"
      ? "var(--color-warning)"
      : status === "confirmed"
        ? "var(--color-success)"
        : "var(--color-text-muted)"
  return {
    padding: "5px 10px",
    "border-radius": "999px",
    background: "var(--color-bg)",
    color,
    "font-family": FONT_SANS,
    "font-size": "13px",
    "font-weight": "var(--font-weight-emphasis)",
    "letter-spacing": "normal",
  }
}

function findingBadge(severity?: PublicationReviewFinding["severity"]): JSX.CSSProperties {
  return {
    padding: "5px 8px",
    "border-radius": "999px",
    background: "var(--color-bg)",
    color: severity ? findingColor(severity) : "var(--color-text-muted)",
    "font-family": FONT_SANS,
    "font-size": "13px",
    "font-weight": severity ? "var(--font-weight-emphasis)" : "var(--font-weight-medium)",
    "letter-spacing": "normal",
  }
}

export default ArtifactInspector
