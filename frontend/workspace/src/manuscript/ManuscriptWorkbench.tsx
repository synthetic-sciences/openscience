import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { Markdown } from "@synsci/ui/markdown"
import { useSDK } from "@/context/sdk"
import { uiStore } from "@/atlas/store/ui"
import { linkedFileTarget, type FileOpenScope } from "@/atlas/file-viewer"
import { toast } from "@/atlas/Toast"
import { IconBookOpen, IconCheckCircle, IconDownload, IconFile, IconSearch } from "@/atlas/shared/Icon"
import { FONT_CODE, FONT_MONO, FONT_SANS } from "@/styles/tokens"
import type { ArtifactInfo } from "@/artifacts/model"
import { downloadBlob } from "@/artifacts/bytes"
import { resolveArtifactPath } from "@/artifacts/context"
import {
  figureMarkdown,
  insertSelection,
  parseBibtex,
  parseManuscript,
  resolveReferencePath,
  rewritePreviewImages,
  type Citation,
} from "./model"
import { localAssetPath } from "@/utils/markdown-assets"
import { projectContains, projectFileQuery, rawFileQuery, type FileScope } from "@/utils/project-file"
import {
  normalizePublicationReview,
  type PublicationReviewReport,
  type PublicationReviewState,
} from "./publication-review"

type Panel = "citations" | "figures" | "review" | "publish"
type PublicationFormat = "html" | "pdf" | "docx" | "latex" | "pptx"

interface PublicationCapabilities {
  pandoc: boolean
  pdf_engine?: string
  formats: Record<PublicationFormat, boolean>
}

interface PublicationResult {
  path: string
  format: PublicationFormat
  readiness: "draft" | "reviewed"
}

interface CitationItem extends Citation {
  source: string
}

export function ManuscriptWorkbench(props: {
  directory: string
  path: string
  sessionID?: string
  scope: FileScope
  openScope?: FileOpenScope
  text: string
  dirty: boolean
  saving: boolean
  onChange: (text: string) => void
}): JSX.Element {
  const sdk = useSDK()
  const [panel, setPanel] = createSignal<Panel>()
  const [citationQuery, setCitationQuery] = createSignal("")
  const [figureQuery, setFigureQuery] = createSignal("")
  const [alt, setAlt] = createSignal("")
  const [posting, setPosting] = createSignal<string>()
  const [preflightAction, setPreflightAction] = createSignal<"run" | "finalize">()
  const [editor, setEditor] = createSignal<HTMLTextAreaElement>()
  const [reviewKey, setReviewKey] = createSignal(0)
  const manuscript = createMemo(() => parseManuscript(props.text))
  const query = (path?: string) =>
    projectFileQuery({
      directory: props.directory,
      path,
      sessionID: props.sessionID,
      scope: props.scope,
    })
  const raw = (path: string, inline = true) =>
    rawFileQuery({
      directory: props.directory,
      path,
      sessionID: props.sessionID,
      scope: props.scope,
      inline,
    })

  const [artifacts] = createResource(
    () => `${props.directory}:${props.scope}:${props.sessionID ?? ""}`,
    async () => {
      const response = await sdk.request("/file/artifacts", undefined, query())
      if (!response.ok) throw new Error(`Artifact discovery failed (${response.status})`)
      const value: unknown = await response.json()
      if (!Array.isArray(value)) return []
      return value.filter(isArtifact)
    },
  )

  const [citations] = createResource(
    () =>
      `${props.directory}:${props.path}:${props.scope}:${props.sessionID ?? ""}:${manuscript().bibliographies.join("|")}`,
    async () => {
      const rows = await Promise.all(
        manuscript().bibliographies.map(async (reference) => {
          const path = resolveReferencePath(props.path, reference)
          const response = await sdk.request("/file/content", undefined, query(path))
          if (!response.ok) return []
          const value: unknown = await response.json()
          const content = record(value)?.content
          if (typeof content !== "string") return []
          return parseBibtex(content).map((citation) => ({ ...citation, source: path }))
        }),
      )
      const unique = new Map<string, CitationItem>()
      for (const citation of rows.flat()) unique.set(citation.key, citation)
      return Array.from(unique.values()).toSorted((a, b) => a.key.localeCompare(b.key))
    },
  )

  const [capabilities] = createResource(
    () => props.directory,
    async () => {
      const response = await sdk.request("/file/publication/capabilities")
      if (!response.ok) throw new Error(`Publication tools unavailable (${response.status})`)
      return (await response.json()) as PublicationCapabilities
    },
  )

  const [review, reviewApi] = createResource(
    () => `${props.directory}:${props.path}:${props.scope}:${props.sessionID ?? ""}:${reviewKey()}`,
    async () => {
      const response = await sdk.request("/file/reviews", undefined, query(props.path))
      if (response.status === 404) return
      if (!response.ok) throw new Error(`Publication preflight unavailable (${response.status})`)
      return (await response.json()) as PublicationReviewReport & { stale: boolean }
    },
  )

  const figures = createMemo(() => {
    const query = figureQuery().trim().toLowerCase()
    return (artifacts.latest ?? [])
      .filter((item) => item.kind === "figure" && projectContains(props.directory, item.path))
      .filter((item) => !query || `${item.name} ${item.path}`.toLowerCase().includes(query))
  })
  const filteredCitations = createMemo(() => {
    const query = citationQuery().trim().toLowerCase()
    if (!query) return citations.latest ?? []
    return (citations.latest ?? []).filter((citation) =>
      [citation.key, citation.title, citation.author, citation.year, citation.venue]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    )
  })
  const formats = createMemo(() =>
    (["html", "pdf", "docx", "latex", "pptx"] as PublicationFormat[]).filter(
      (format) => capabilities.latest?.formats[format],
    ),
  )
  const preflight = createMemo(() => normalizePublicationReview("md", review.latest))
  const reviewed = createMemo(() => Boolean(review.latest?.finalized && !review.latest.stale && !props.dirty))
  const preview = createMemo(() =>
    rewritePreviewImages(manuscript().body, props.path, (path) => sdk.request.url("/file/raw", raw(path))),
  )
  const file = (href: string) => localAssetPath(href, props.path)
  const openFile = (path: string) => {
    const target = linkedFileTarget({
      directory: props.directory,
      path,
      scope: props.openScope ?? props.scope,
      resolved: props.scope,
      sessionID: props.sessionID,
    })
    uiStore.openFile(props.directory, target.path, target)
  }

  const toggle = (next: Panel) => setPanel((current) => (current === next ? undefined : next))
  const openPublish = () => {
    const opening = panel() !== "publish"
    toggle("publish")
    if (!opening) return
    setReviewKey((value) => value + 1)
    void reviewApi.refetch()
  }
  const insert = (value: string) => {
    const target = editor()
    const result = insertSelection(
      props.text,
      value,
      target?.selectionStart ?? props.text.length,
      target?.selectionEnd ?? props.text.length,
    )
    props.onChange(result.text)
    queueMicrotask(() => {
      const next = editor()
      next?.focus()
      next?.setSelectionRange(result.start, result.end)
    })
  }
  const addCitation = (citation: CitationItem) => {
    insert(`[@${citation.key}]`)
    setPanel(undefined)
    toast.success("citation inserted", `@${citation.key}`)
  }
  const addFigure = (figure: ArtifactInfo) => {
    const markdown = figureMarkdown(
      alt(),
      resolveArtifactPath(props.directory, props.path),
      resolveArtifactPath(props.directory, figure.path),
    )
    const prefix = props.text.endsWith("\n\n") ? "" : props.text.endsWith("\n") ? "\n" : "\n\n"
    insert(`${prefix}${markdown}`)
    setPanel(undefined)
    setAlt("")
    toast.success("figure inserted", figure.path)
  }
  const openReview = () => {
    setPanel("review")
    setReviewKey((value) => value + 1)
    void reviewApi.refetch()
  }
  const toggleReview = () => {
    if (panel() === "review") {
      setPanel(undefined)
      return
    }
    openReview()
  }
  const mutatePreflight = async (action: "run" | "finalize", route: string, body: Record<string, unknown>) => {
    if (preflightAction()) return false
    setPreflightAction(action)
    const response = await sdk
      .request(
        route,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        query(),
      )
      .catch(() => undefined)
    setPreflightAction(undefined)
    if (!response?.ok) {
      const payload = (await response?.json().catch(() => undefined)) as { error?: unknown } | undefined
      const detail =
        typeof payload?.error === "string" ? payload.error : response ? `${response.status}` : "Request failed"
      toast.error("Publication preflight failed", detail)
      return false
    }
    await reviewApi.refetch()
    return true
  }
  const runPreflight = async () => {
    if (props.dirty || props.saving) {
      toast.error("save before preflight", "Publication checks run against exact saved bytes.")
      return
    }
    const ok = await mutatePreflight("run", "/file/reviews", {
      path: props.path,
      actor: "Local user",
    })
    if (ok) toast.success("Publication preflight complete")
  }
  const finalizePreflight = async () => {
    const report = review.latest
    if (!report || report.stale || props.dirty || props.saving) {
      toast.error("preflight cannot be finalized", "Save the manuscript and run the current checks first.")
      return
    }
    if (report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) {
      toast.error("preflight is blocked", "Resolve the blocking manuscript findings, then run the checks again.")
      return
    }
    const ok = await mutatePreflight("finalize", `/file/reviews/${report.id}/finalize`, {
      actor: "Local user",
    })
    if (ok) toast.success("Preflight-checked bytes finalized")
  }
  const publish = async (format: PublicationFormat, readiness: "draft" | "reviewed") => {
    if (props.dirty || props.saving) {
      toast.error("save before export", "Publication exports are generated from exact saved bytes.")
      return
    }
    const report = review.latest
    if (readiness === "reviewed" && (!report?.finalized || report.stale)) {
      toast.error("preflight export locked", "Finalize the current publication preflight first.")
      return
    }
    const key = `${readiness}:${format}`
    setPosting(key)
    const response = await sdk
      .request(
        "/file/publication",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: props.path,
            format,
            readiness,
            ...(readiness === "reviewed" && report ? { review_id: report.id } : {}),
          }),
        },
        query(),
      )
      .catch(() => undefined)
    setPosting(undefined)
    if (!response?.ok) {
      const detail = await response?.text().catch(() => "")
      toast.error("publication export failed", detail || (response ? `${response.status}` : "request failed"))
      return
    }
    const result = (await response.json()) as PublicationResult
    toast.success(`${format.toUpperCase()} ready`, result.path)
    if (!["docx", "pptx"].includes(result.format)) {
      openFile(result.path)
      return
    }
    const download = await sdk.request("/file/raw", undefined, raw(result.path, false))
    if (!download.ok) return
    downloadBlob(result.path.split("/").pop() || `manuscript.${result.format}`, await download.blob())
  }

  return (
    <div
      data-component="manuscript-workbench"
      style={{
        height: "100%",
        "min-height": 0,
        display: "flex",
        "flex-direction": "column",
        background: "var(--color-bg-subtle)",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          padding: "8px 10px",
          border: "0",
          "border-bottom": "1px solid var(--color-border)",
          background: "var(--color-bg)",
          "flex-shrink": 0,
        }}
      >
        <span style={eyebrow()}>Manuscript</span>
        <span style={{ flex: 1, "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
          live source + preview
        </span>
        <button type="button" style={toolButton(panel() === "citations")} onClick={() => toggle("citations")}>
          <IconBookOpen size={11} /> Citations
        </button>
        <button type="button" style={toolButton(panel() === "figures")} onClick={() => toggle("figures")}>
          <IconFile size={11} /> Figures
        </button>
        <button type="button" style={toolButton(panel() === "review")} onClick={toggleReview}>
          <IconCheckCircle size={11} /> Review
        </button>
        <button type="button" style={toolButton(panel() === "publish")} onClick={openPublish}>
          <IconDownload size={11} /> Publish
        </button>
      </div>

      <Show when={panel() === "citations"}>
        <BrowserShell
          component="citation-browser"
          title="Citation library"
          detail={citationDetail(manuscript().bibliographies)}
        >
          <Search value={citationQuery()} placeholder="Find by author, title, or key…" onInput={setCitationQuery} />
          <div class="atlas-scroll" style={browserList()}>
            <Show when={!citations.loading} fallback={<Empty>Reading local bibliographies…</Empty>}>
              <Show
                when={filteredCitations().length}
                fallback={
                  <Empty>
                    {manuscript().bibliographies.length
                      ? "No matching BibTeX entries."
                      : "Add bibliography: references.bib to the manuscript frontmatter."}
                  </Empty>
                }
              >
                <For each={filteredCitations()}>
                  {(citation) => (
                    <button
                      type="button"
                      aria-label={`Insert @${citation.key}`}
                      style={browserRow()}
                      onClick={() => addCitation(citation)}
                    >
                      <span style={rowText()}>
                        <strong>{citation.title || citation.key}</strong>
                        <small>
                          {[citation.author, citation.venue, citation.year].filter(Boolean).join(" · ") ||
                            citation.source}
                        </small>
                      </span>
                      <span style={keyBadge()}>@{citation.key}</span>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </BrowserShell>
      </Show>

      <Show when={panel() === "figures"}>
        <BrowserShell
          component="figure-browser"
          title="Local figures"
          detail={`${(artifacts.latest ?? []).filter((item) => item.kind === "figure").length} discovered`}
        >
          <div style={{ display: "grid", gap: "5px" }}>
            <Search value={figureQuery()} placeholder="Find a local figure…" onInput={setFigureQuery} />
            <input
              aria-label="Figure alt text"
              value={alt()}
              onInput={(event) => setAlt(event.currentTarget.value)}
              placeholder="Describe the figure for readers…"
              style={input()}
            />
          </div>
          <div class="atlas-scroll" style={browserList()}>
            <Show when={!artifacts.loading} fallback={<Empty>Discovering local figures…</Empty>}>
              <Show when={figures().length} fallback={<Empty>No matching local figures.</Empty>}>
                <For each={figures()}>
                  {(figure) => (
                    <button
                      type="button"
                      aria-label={`Insert ${figure.name}`}
                      style={browserRow()}
                      onClick={() => addFigure(figure)}
                    >
                      <img
                        src={sdk.request.url("/file/raw", raw(figure.path))}
                        alt=""
                        style={{ width: "50px", height: "34px", "object-fit": "cover", "border-radius": "3px" }}
                      />
                      <span style={rowText()}>
                        <strong>{figure.name}</strong>
                        <small>{figure.path}</small>
                      </span>
                      <span style={keyBadge()}>{figure.format.toUpperCase()}</span>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </BrowserShell>
      </Show>

      <Show when={panel() === "review"}>
        <BrowserShell
          component="publication-preflight"
          title="Publication preflight"
          detail="Deterministic checks for exact saved bytes"
        >
          <div style={{ "grid-column": "2 / -1", "min-width": 0 }}>
            <Show when={!review.loading} fallback={<Empty>Loading publication preflight…</Empty>}>
              <PreflightControls
                state={preflight()}
                dirty={props.dirty || props.saving}
                action={preflightAction()}
                onRun={() => void runPreflight()}
                onFinalize={() => void finalizePreflight()}
              />
            </Show>
          </div>
        </BrowserShell>
      </Show>

      <Show when={panel() === "publish"}>
        <BrowserShell
          component="publication-controls"
          title="Publication exports"
          detail="Generated locally from exact saved bytes"
        >
          <div style={{ "grid-column": "2 / -1", "min-width": 0 }}>
            <Show when={!capabilities.loading} fallback={<Empty>Checking local publication tools…</Empty>}>
              <div style={{ display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", gap: "10px" }}>
                <ExportGroup
                  title="Draft"
                  detail={props.dirty ? "Save changes before exporting." : "Watermarked as draft."}
                >
                  <For each={formats()}>
                    {(format) => (
                      <ExportButton
                        format={format}
                        readiness="draft"
                        busy={posting() === `draft:${format}`}
                        disabled={props.dirty || Boolean(posting())}
                        onClick={() => void publish(format, "draft")}
                      />
                    )}
                  </For>
                </ExportGroup>
                <ExportGroup
                  title={reviewed() ? "Preflight-checked bytes" : "Preflight export locked"}
                  detail={
                    reviewed()
                      ? `Bound to ${review.latest!.finalized!.artifactHash.slice(0, 12)}.`
                      : props.dirty
                        ? "Save the manuscript, then refresh its preflight."
                        : review.latest?.stale
                          ? "The last preflight is stale. Run and finalize it again."
                          : "Run and finalize the publication preflight first."
                  }
                >
                  <Show
                    when={reviewed()}
                    fallback={
                      <button type="button" style={reviewButton()} onClick={openReview}>
                        review preflight
                      </button>
                    }
                  >
                    <For each={formats()}>
                      {(format) => (
                        <ExportButton
                          format={format}
                          readiness="reviewed"
                          busy={posting() === `reviewed:${format}`}
                          disabled={Boolean(posting())}
                          onClick={() => void publish(format, "reviewed")}
                        />
                      )}
                    </For>
                  </Show>
                </ExportGroup>
              </div>
              <Show when={!capabilities.latest?.pandoc}>
                <span style={notice()}>HTML is ready. Install Pandoc to add Word, LaTeX, and PowerPoint.</span>
              </Show>
              <Show when={capabilities.latest?.pandoc && !capabilities.latest.formats.pdf}>
                <span style={notice()}>Install a local TeX or Typst engine to add PDF export.</span>
              </Show>
            </Show>
          </div>
        </BrowserShell>
      </Show>

      <div style={{ flex: 1, "min-height": 0, display: "flex", overflow: "hidden" }}>
        <section
          data-slot="manuscript-source"
          style={{
            flex: "1 1 50%",
            "min-width": "280px",
            "min-height": 0,
            display: "flex",
            "flex-direction": "column",
            border: "0",
            "border-right": "1px solid var(--color-border)",
            background: "var(--color-bg)",
          }}
        >
          <PaneLabel label="Source" detail={props.dirty ? "Unsaved changes" : "Saved"} active={props.dirty} />
          <textarea
            ref={setEditor}
            aria-label="Manuscript source"
            value={props.text}
            spellcheck
            onInput={(event) => props.onChange(event.currentTarget.value)}
            class="atlas-scroll"
            style={{
              all: "unset",
              "box-sizing": "border-box",
              flex: 1,
              "min-height": 0,
              overflow: "auto",
              padding: "18px 20px 42px",
              "font-family": FONT_CODE,
              "font-size": "12px",
              "line-height": 1.72,
              color: "var(--color-text)",
              "white-space": "pre-wrap",
              "tab-size": 2,
            }}
          />
        </section>
        <section
          data-slot="manuscript-preview-pane"
          style={{
            flex: "1.08 1 50%",
            "min-width": "300px",
            "min-height": 0,
            display: "flex",
            "flex-direction": "column",
            background: "var(--color-bg-subtle)",
          }}
        >
          <PaneLabel label="Live preview" detail={`${wordCount(manuscript().body)} words`} />
          <div
            data-slot="manuscript-preview"
            class="atlas-scroll"
            style={{ flex: 1, "min-height": 0, overflow: "auto", padding: "24px 28px 64px" }}
          >
            <div style={{ "max-width": "780px", margin: "0 auto" }}>
              <Markdown class="atlas-md" text={preview()} resolveFile={file} onOpenFile={openFile} />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function BrowserShell(props: { component: string; title: string; detail: string; children: JSX.Element }): JSX.Element {
  return (
    <section
      data-component={props.component}
      style={{
        display: "grid",
        "grid-template-columns": "minmax(150px, .55fr) minmax(190px, .7fr) minmax(280px, 1.75fr)",
        gap: "8px",
        "align-items": "center",
        padding: "10px",
        "max-height": "190px",
        border: "0",
        "border-bottom": "1px solid var(--color-border)",
        background: "var(--color-bg-subtle)",
        "flex-shrink": 0,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "grid", gap: "3px", "align-self": "start", padding: "5px 6px" }}>
        <strong style={{ "font-family": FONT_SANS, "font-size": "11px", color: "var(--color-text)" }}>
          {props.title}
        </strong>
        <span style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
          {props.detail}
        </span>
      </div>
      {props.children}
    </section>
  )
}

function Search(props: { value: string; placeholder: string; onInput: (value: string) => void }): JSX.Element {
  return (
    <label style={{ ...input(), display: "flex", "align-items": "center", gap: "6px" }}>
      <IconSearch size={11} />
      <input
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        placeholder={props.placeholder}
        style={{ all: "unset", width: "100%", "min-width": 0 }}
      />
    </label>
  )
}

function Empty(props: { children: JSX.Element }): JSX.Element {
  return (
    <span
      style={{
        display: "grid",
        "place-items": "center",
        "min-height": "42px",
        padding: "8px",
        "font-family": FONT_SANS,
        "font-size": "10px",
        color: "var(--color-text-faint)",
        "text-align": "center",
      }}
    >
      {props.children}
    </span>
  )
}

function ExportGroup(props: { title: string; detail: string; children: JSX.Element }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "6px", "align-content": "start" }}>
      <div style={{ display: "grid", gap: "2px" }}>
        <strong style={{ "font-family": FONT_SANS, "font-size": "10px", color: "var(--color-text)" }}>
          {props.title}
        </strong>
        <span style={{ "font-family": FONT_SANS, "font-size": "9px", color: "var(--color-text-faint)" }}>
          {props.detail}
        </span>
      </div>
      <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>{props.children}</div>
    </div>
  )
}

function PreflightControls(props: {
  state: PublicationReviewState
  dirty: boolean
  action?: "run" | "finalize"
  onRun: () => void
  onFinalize: () => void
}): JSX.Element {
  const report = () => props.state.report
  const blocking = () =>
    report()?.findings.some((finding) => finding.severity === "blocking" && finding.status === "open") ?? false
  const finalizeDisabled = () => Boolean(props.action || props.dirty || report()?.stale || blocking())
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          "justify-content": "space-between",
          "min-width": 0,
        }}
      >
        <div style={{ display: "grid", gap: "2px", "min-width": 0 }}>
          <strong style={{ "font-family": FONT_SANS, "font-size": "10px", color: "var(--color-text)" }}>
            {props.state.title}
          </strong>
          <span style={{ "font-family": FONT_SANS, "font-size": "9px", color: "var(--color-text-faint)" }}>
            {props.dirty ? "Save the manuscript before running checks." : props.state.detail}
          </span>
        </div>
        <div style={{ display: "flex", gap: "5px", "flex-shrink": 0 }}>
          <button
            type="button"
            disabled={Boolean(props.action || props.dirty)}
            style={preflightButton(Boolean(props.action || props.dirty))}
            onClick={props.onRun}
          >
            {props.action === "run" ? "Checking…" : report() ? "Run again" : "Run checks"}
          </button>
          <Show when={report() && !report()?.finalized}>
            <button
              type="button"
              disabled={finalizeDisabled()}
              style={preflightButton(finalizeDisabled(), true)}
              onClick={props.onFinalize}
            >
              {props.action === "finalize" ? "Finalizing…" : "Finalize checked bytes"}
            </button>
          </Show>
        </div>
      </div>
      <Show when={report()}>
        {(current) => (
          <div style={{ display: "flex", "align-items": "center", gap: "5px", "flex-wrap": "wrap" }}>
            <PreflightMetric
              label="blocking"
              value={current().summary.blocking}
              alert={current().summary.blocking > 0}
            />
            <PreflightMetric label="major" value={current().summary.major} />
            <PreflightMetric label="minor" value={current().summary.minor} />
            <PreflightMetric label="closed" value={current().summary.resolved + current().summary.overridden} />
            <span style={{ ...keyBadge(), "margin-left": "auto" }}>sha256 {current().artifactHash.slice(0, 12)}</span>
          </div>
        )}
      </Show>
    </div>
  )
}

function PreflightMetric(props: { label: string; value: number; alert?: boolean }): JSX.Element {
  return (
    <span
      style={{
        ...keyBadge(),
        color: props.alert ? "var(--color-warning)" : "var(--color-text-muted)",
        border: `1px solid ${props.alert ? "var(--color-warning)" : "transparent"}`,
      }}
    >
      {props.value} {props.label}
    </span>
  )
}

function ExportButton(props: {
  format: PublicationFormat
  readiness: "draft" | "reviewed"
  busy: boolean
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  const label = () =>
    props.format === "docx" ? "Word" : props.format === "pptx" ? "PowerPoint" : props.format.toUpperCase()
  return (
    <button
      type="button"
      aria-label={`Export ${props.readiness === "reviewed" ? "preflight-checked" : "draft"} ${label()}`}
      disabled={props.disabled}
      onClick={props.onClick}
      style={exportButton(props.disabled)}
    >
      <IconDownload size={9} />
      {props.busy ? "working…" : label()}
    </button>
  )
}

function PaneLabel(props: { label: string; detail: string; active?: boolean }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "8px",
        height: "30px",
        padding: "0 12px",
        border: "0",
        "border-bottom": "1px solid var(--color-border)",
        background: "var(--color-bg-subtle)",
        "flex-shrink": 0,
      }}
    >
      <span style={{ ...eyebrow(), color: props.active ? "var(--color-warning)" : "var(--color-text-faint)" }}>
        {props.label}
      </span>
      <span style={{ flex: 1, "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
        {props.detail}
      </span>
    </div>
  )
}

function isArtifact(value: unknown): value is ArtifactInfo {
  const item = record(value)
  return (
    typeof item?.name === "string" &&
    typeof item.path === "string" &&
    typeof item.kind === "string" &&
    typeof item.format === "string" &&
    typeof item.size === "number" &&
    typeof item.modified === "number"
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function wordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0
}

function citationDetail(paths: string[]): string {
  if (!paths.length) return "No bibliography declared"
  return paths.length === 1 ? paths[0]! : `${paths.length} bibliography files`
}

function eyebrow(): JSX.CSSProperties {
  return {
    "font-family": FONT_MONO,
    "font-size": "9px",
    "font-weight": "var(--font-weight-emphasis)",
    "letter-spacing": "0.08em",
    color: "var(--color-text-faint)",
  }
}

function toolButton(active = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    gap: "5px",
    height: "25px",
    padding: "0 8px",
    "border-radius": "5px",
    border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
    background: active ? "var(--color-accent-subtle)" : "var(--color-bg-subtle)",
    color: active ? "var(--color-text)" : "var(--color-text-muted)",
    "font-family": FONT_SANS,
    "font-size": "10px",
    "font-weight": "var(--font-weight-emphasis)",
  }
}

function input(): JSX.CSSProperties {
  return {
    "box-sizing": "border-box",
    width: "100%",
    height: "29px",
    padding: "0 9px",
    border: "1px solid var(--color-border)",
    "border-radius": "5px",
    outline: "none",
    background: "var(--color-bg)",
    color: "var(--color-text)",
    "font-family": FONT_SANS,
    "font-size": "10px",
  }
}

function browserList(): JSX.CSSProperties {
  return {
    display: "grid",
    gap: "4px",
    "max-height": "126px",
    overflow: "auto",
    "align-content": "start",
  }
}

function browserRow(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "flex",
    "align-items": "center",
    gap: "8px",
    padding: "7px 8px",
    "border-radius": "5px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg)",
  }
}

function rowText(): JSX.CSSProperties {
  return {
    flex: 1,
    "min-width": 0,
    display: "grid",
    gap: "2px",
    "text-align": "left",
    "font-family": FONT_SANS,
    color: "var(--color-text)",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  }
}

function keyBadge(): JSX.CSSProperties {
  return {
    padding: "2px 5px",
    "border-radius": "3px",
    background: "var(--color-accent-subtle)",
    "font-family": FONT_MONO,
    "font-size": "8px",
    color: "var(--color-text-muted)",
    "flex-shrink": 0,
  }
}

function exportButton(disabled: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    "align-items": "center",
    gap: "4px",
    padding: "4px 7px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg)",
    color: "var(--color-text-muted)",
    opacity: disabled ? 0.48 : 1,
    "font-family": FONT_MONO,
    "font-size": "9px",
  }
}

function reviewButton(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    width: "fit-content",
    padding: "4px 8px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    "font-family": FONT_MONO,
    "font-size": "9px",
    color: "var(--color-text-muted)",
  }
}

function preflightButton(disabled: boolean, primary = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    "align-items": "center",
    height: "25px",
    padding: "0 9px",
    "border-radius": "5px",
    border: "1px solid var(--color-border)",
    background: primary ? "var(--color-text)" : "var(--color-bg)",
    color: primary ? "var(--color-bg)" : "var(--color-text-muted)",
    opacity: disabled ? 0.45 : 1,
    "font-family": FONT_SANS,
    "font-size": "9px",
    "font-weight": "var(--font-weight-emphasis)",
  }
}

function notice(): JSX.CSSProperties {
  return {
    "grid-column": "1 / -1",
    "font-family": FONT_SANS,
    "font-size": "9px",
    color: "var(--color-warning)",
  }
}

export default ManuscriptWorkbench
