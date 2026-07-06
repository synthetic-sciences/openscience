import {
  createSignal,
  createResource,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  type JSX,
  Show,
  Switch,
  Match,
} from "solid-js"
import { Portal } from "solid-js/web"
import { Markdown } from "@synsci/ui/markdown"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePlatform } from "@/context/platform"
import { FONT_MONO, FONT_SANS, FONT_CODE } from "@/styles/tokens"
import { PdfViewer } from "@/science/renderers/documents/PdfViewer"
import { toast } from "@/thesis/Toast"
import { IconFile, IconX, IconCopy, IconDownload, IconBookOpen, IconBraces, IconRefresh } from "@/thesis/shared/Icon"

/**
 * Slide-in SIDE PREVIEW pane for opening a file from the Files tree.
 *
 * A file's extension picks the renderer:
 *   .md / .markdown  → formatted markdown (@synsci/ui Markdown)
 *   .pdf             → PdfViewer (pdfjs page rasterizer)
 *   .tex / .latex    → highlighted LaTeX source (a .tex is a source FILE, not a
 *                      math expression — the KaTeX LatexView is reserved for
 *                      kind:"latex" math ARTIFACTS with a single math string)
 *   images           → inline <img>
 *   everything else  → syntax-aware code/text view (with edit + save)
 *
 * It mounts as a right-anchored drawer over the session so md / pdf / latex
 * get room to breathe instead of the cramped 360px pane. Esc / backdrop
 * click / the header × all close it.
 */

const ext = (name: string): string => {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

// Extension → shiki/highlight.js language id for the code fallback.
const LANG: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  rs: "rust",
  go: "go",
  swift: "swift",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cu: "cpp",
  // .tex and friends are text/source files — highlight them as LaTeX source
  // (shiki has a `latex` grammar). A full \documentclass document must never
  // be fed to KaTeX (which only typesets a single math string → blank page).
  tex: "latex",
  latex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "latex",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  r: "r",
  jl: "julia",
  lua: "lua",
  dockerfile: "docker",
  makefile: "makefile",
  csv: "csv",
  txt: "text",
  log: "text",
}

type Kind = "markdown" | "pdf" | "image" | "code" | "binary"

type FileData = { content?: string; encoding?: string; mimeType?: string }

/**
 * Inline file view — header (icon + name + subtitle + controls) over the
 * type-aware renderer body. This is the single source of truth for the
 * renderer dispatch; both the slide-in drawer (FilePreview, below) and the
 * center-pane document tabs mount it, so nothing about opening a file is
 * duplicated.
 */
export function FileView(props: {
  path: string
  directory?: string
  subtitle?: string
  onClose?: () => void
}): JSX.Element {
  const sdk = useSDK()
  const sync = useSync()
  const platform = usePlatform()
  const directory = () => props.directory || sync.project?.worktree || sync.data.path.directory || sdk.directory
  const name = () => props.path.split("/").pop() || props.path
  const e = () => ext(name())

  // `showSource` flips rendered docs (md / tex) to their raw text; for code
  // files it flips the read-only highlighted view into an editable textarea.
  const [showSource, setShowSource] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [savedText, setSavedText] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [refreshKey, setRefreshKey] = createSignal(0)

  const [file] = createResource(
    () => [directory(), props.path, refreshKey()] as const,
    async ([dir, path]) => {
      if (!dir || !path) return undefined
      // Pass the params FLAT — the generated client maps `directory`/`path`
      // into the query string; a `{ query: {...} }` wrapper is dropped and
      // sends nothing. `directory` re-roots the backend Instance so any host
      // file is readable by absolute directory + relative path (File.read).
      const res: any = await sdk.client.file.read({ directory: dir, path })
      return (res?.data ?? res) as FileData
    },
  )

  const data = () => file()
  const isBinary = () => data()?.encoding === "base64"
  const mime = () => data()?.mimeType ?? ""
  const b64 = () => data()?.content ?? ""
  const dataUrl = () => `data:${mime() || "application/octet-stream"};base64,${b64()}`
  const text = () => (!data() || isBinary() ? "" : (data()!.content ?? ""))
  const dirty = () => draft() !== savedText()

  const kind = createMemo<Kind>(() => {
    const x = e()
    if (isBinary()) {
      if (mime().startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(x)) return "image"
      if (mime() === "application/pdf" || x === "pdf") return "pdf"
      return "binary"
    }
    if (x === "md" || x === "markdown" || x === "mdx") return "markdown"
    if (x === "pdf") return "pdf"
    // .tex / .latex / .sty / .cls are source files → highlighted "code" view
    // (LANG maps them to the shiki `latex` grammar). They are NEVER routed to
    // KaTeX, which blanks on a full \documentclass document.
    return "code"
  })

  const badge = () => {
    const k = kind()
    if (k === "code") return LANG[e()] ?? e() ?? "text"
    return k
  }

  createEffect(() => {
    if (file.loading) return
    const next = text()
    setDraft(next)
    setSavedText(next)
  })

  const save = async () => {
    if (saving() || isBinary() || !dirty()) return
    setSaving(true)
    try {
      // The generated SDK has no file.write; hit the real PUT /file/content
      // route directly. `directory` re-roots the backend Instance, `path` is
      // relative to it (see server middleware + File.write).
      const url = `${sdk.url.replace(/\/$/, "")}/file/content?directory=${encodeURIComponent(directory())}`
      const doFetch = platform.fetch ?? fetch
      const res = await doFetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: props.path, content: draft() }),
      })
      if (!res.ok) throw new Error(`save failed (${res.status})`)
      const d: any = await res.json().catch(() => ({}))
      const next = typeof d?.content === "string" ? d.content : draft()
      setDraft(next)
      setSavedText(next)
      toast.success("saved", name())
    } catch (err: any) {
      toast.error("save failed", err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(isBinary() ? dataUrl() : draft())
      toast.success("copied", name())
    } catch {}
  }

  const toggleable = () => kind() === "markdown" || kind() === "code"

  return (
    <div
      style={{
        flex: 1,
        "min-height": 0,
        "min-width": 0,
        display: "flex",
        "flex-direction": "column",
        background: "var(--color-surface-solid)",
        overflow: "hidden",
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          padding: "10px 12px 10px 16px",
          "border-bottom": "1px solid var(--color-border)",
          background: "var(--color-bg)",
          "flex-shrink": 0,
        }}
      >
        <IconFile size={14} strokeWidth={1.5} />
        <div style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column", gap: "1px" }}>
          <span
            title={props.path}
            style={{
              "font-family": FONT_CODE,
              "font-size": "12px",
              color: "var(--color-text)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {name()}
          </span>
          <Show when={props.subtitle}>
            <span
              title={props.subtitle}
              style={{
                "font-family": FONT_MONO,
                "font-size": "10px",
                color: "var(--color-text-faint)",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {props.subtitle}
            </span>
          </Show>
        </div>
        <span
          style={{
            "flex-shrink": 0,
            padding: "2px 8px",
            "border-radius": "4px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-subtle)",
            "font-family": FONT_MONO,
            "font-size": "10px",
            color: "var(--color-text-faint)",
            "letter-spacing": "0.03em",
          }}
        >
          {badge()}
        </span>

        <Show when={dirty()}>
          <button type="button" onClick={() => setDraft(savedText())} style={ctlBtn()}>
            reset
          </button>
          <button type="button" onClick={() => void save()} style={ctlBtn(true)}>
            {saving() ? "saving…" : "save"}
          </button>
        </Show>

        <Show when={toggleable()}>
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            title={showSource() ? "rendered view" : kind() === "code" ? "edit source" : "raw source"}
            style={iconBtn(showSource())}
          >
            <Show when={showSource()} fallback={<IconBraces size={13} strokeWidth={1.6} />}>
              <IconBookOpen size={13} strokeWidth={1.6} />
            </Show>
          </button>
        </Show>

        <Show when={!isBinary()}>
          <button type="button" onClick={() => void copy()} title="copy contents" style={iconBtn()}>
            <IconCopy size={13} strokeWidth={1.6} />
          </button>
        </Show>
        <Show when={isBinary()}>
          <a href={dataUrl()} download={name()} title="download" style={{ ...iconBtn(), "text-decoration": "none" }}>
            <IconDownload size={13} strokeWidth={1.6} />
          </a>
        </Show>

        <button type="button" onClick={() => setRefreshKey((k) => k + 1)} title="refresh" style={iconBtn()}>
          <IconRefresh size={13} strokeWidth={1.6} />
        </button>

        <Show when={props.onClose}>
          <button type="button" onClick={() => props.onClose!()} title="close" style={iconBtn()}>
            <IconX size={14} strokeWidth={1.7} />
          </button>
        </Show>
      </div>

      {/* body */}
      <Show
        when={!file.loading}
        fallback={
          <div
            style={{ padding: "20px", "font-family": FONT_MONO, "font-size": "12px", color: "var(--color-text-faint)" }}
          >
            loading…
          </div>
        }
      >
        <Show
          when={!file.error}
          fallback={
            <div
              style={{
                flex: 1,
                "min-height": 0,
                display: "flex",
                "flex-direction": "column",
                "align-items": "center",
                "justify-content": "center",
                gap: "10px",
                padding: "40px 24px",
                "text-align": "center",
                background: "var(--color-bg-subtle)",
              }}
            >
              <IconFile size={20} strokeWidth={1.4} />
              <div
                style={{
                  "font-family": FONT_SANS,
                  "font-size": "13px",
                  "font-weight": 500,
                  color: "var(--color-text)",
                }}
              >
                couldn't open this file
              </div>
              <div
                style={{
                  "font-family": FONT_SANS,
                  "font-size": "12px",
                  color: "var(--color-text-faint)",
                  "line-height": 1.5,
                  "max-width": "340px",
                }}
              >
                {file.error instanceof Error ? file.error.message : String(file.error)}
              </div>
              <button type="button" onClick={() => setRefreshKey((k) => k + 1)} style={retryBtn()}>
                retry
              </button>
            </div>
          }
        >
          <div
            class="thesis-scroll"
            style={{
              flex: 1,
              "min-height": 0,
              overflow: "auto",
              background: "var(--color-bg-subtle)",
            }}
          >
            <Switch>
              {/* markdown */}
              <Match when={kind() === "markdown" && !showSource()}>
                <div style={{ padding: "22px 26px", "max-width": "820px", margin: "0 auto" }}>
                  <Markdown class="thesis-md" text={draft()} />
                </div>
              </Match>

              {/* pdf */}
              <Match when={kind() === "pdf"}>
                <div style={{ padding: "14px" }}>
                  <PdfViewer kind="pdf" data={{ base64: b64(), maxPages: 40 }} height={100000} />
                </div>
              </Match>

              {/* image */}
              <Match when={kind() === "image"}>
                <div style={{ display: "grid", "place-items": "center", padding: "22px", "min-height": "100%" }}>
                  <img
                    src={dataUrl()}
                    alt={name()}
                    style={{
                      "max-width": "100%",
                      "max-height": "100%",
                      "object-fit": "contain",
                      "border-radius": "4px",
                    }}
                  />
                </div>
              </Match>

              {/* binary */}
              <Match when={kind() === "binary"}>
                <div
                  style={{
                    display: "grid",
                    "place-items": "center",
                    padding: "40px 24px",
                    "min-height": "100%",
                    "text-align": "center",
                  }}
                >
                  <div
                    style={{
                      "font-family": FONT_SANS,
                      "font-size": "13px",
                      color: "var(--color-text-muted)",
                      "line-height": 1.6,
                    }}
                  >
                    Binary file — no inline preview.
                    <br />
                    Use the download button above to open it.
                  </div>
                </div>
              </Match>

              {/* code / text — editable source, or highlighted read view */}
              <Match when={kind() === "code" && showSource()}>
                <textarea
                  value={draft()}
                  spellcheck={false}
                  onInput={(ev) => setDraft(ev.currentTarget.value)}
                  class="thesis-scroll"
                  style={{
                    all: "unset",
                    "box-sizing": "border-box",
                    display: "block",
                    width: "100%",
                    "min-height": "100%",
                    padding: "16px 18px",
                    "font-family": FONT_CODE,
                    "font-size": "12px",
                    "line-height": 1.65,
                    color: "var(--color-text)",
                    "white-space": "pre",
                    "tab-size": 2,
                  }}
                />
              </Match>
              <Match when={kind() === "code" || (kind() === "markdown" && showSource())}>
                <div style={{ padding: "14px 16px" }}>
                  <Markdown
                    class="thesis-md"
                    text={fence(
                      showSource() && kind() !== "code" ? langFor(kind(), e()) : (LANG[e()] ?? "text"),
                      draft(),
                    )}
                  />
                </div>
              </Match>
            </Switch>
          </div>
        </Show>
      </Show>
    </div>
  )
}

/**
 * Slide-in drawer wrapper around FileView — kept for the legacy right-pane
 * preview path. Backdrop / Esc / the header × all close it.
 */
export function FilePreview(props: { path: string; onClose: () => void }): JSX.Element {
  const [mounted, setMounted] = createSignal(false)
  onMount(() => {
    requestAnimationFrame(() => setMounted(true))
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") props.onClose()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })
  return (
    <Portal>
      <div
        onClick={props.onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.42)",
          "backdrop-filter": "blur(2px)",
          "z-index": 90,
          opacity: mounted() ? 1 : 0,
          transition: "opacity 120ms ease",
        }}
      />
      <div
        role="dialog"
        aria-label={`preview ${props.path}`}
        style={{
          position: "fixed",
          top: "14px",
          bottom: "14px",
          right: "14px",
          width: "clamp(360px, 60vw, 820px)",
          "max-width": "calc(100vw - 28px)",
          display: "flex",
          "flex-direction": "column",
          background: "var(--color-surface-solid)",
          border: "1px solid var(--color-border-strong)",
          "border-radius": "4px",
          "box-shadow": "var(--shadow-lg, 0 24px 60px rgba(0,0,0,0.35))",
          overflow: "hidden",
          "z-index": 91,
          transform: mounted() ? "translateX(0)" : "translateX(16px)",
          opacity: mounted() ? 1 : 0,
          transition: "transform 200ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease",
        }}
      >
        <FileView path={props.path} onClose={props.onClose} />
      </div>
    </Portal>
  )
}

function langFor(k: Kind, x: string): string {
  if (k === "markdown") return "markdown"
  return LANG[x] ?? "text"
}

// Wrap raw file text in a fenced code block so the shared Markdown renderer
// (marked + shiki) syntax-highlights it. Guards against content that already
// contains a triple backtick by widening the fence.
function fence(lang: string, body: string): string {
  let ticks = "```"
  while (body.includes(ticks)) ticks += "`"
  return `${ticks}${lang}\n${body}\n${ticks}`
}

function iconBtn(active = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    width: "28px",
    height: "28px",
    "border-radius": "4px",
    color: active ? "var(--color-text)" : "var(--color-text-faint)",
    background: active ? "var(--color-accent-subtle)" : "transparent",
    "flex-shrink": 0,
    transition: "background 120ms ease, color 120ms ease",
  } as JSX.CSSProperties
}

function retryBtn(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    "margin-top": "2px",
    padding: "5px 12px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text)",
  } as JSX.CSSProperties
}

function ctlBtn(primary = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    padding: "5px 11px",
    "border-radius": "4px",
    border: primary ? "1px solid var(--color-text)" : "1px solid var(--color-border)",
    background: primary ? "var(--color-text)" : "var(--color-bg-subtle)",
    color: primary ? "var(--color-bg)" : "var(--color-text-muted)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    "font-weight": primary ? 600 : 500,
    "flex-shrink": 0,
  } as JSX.CSSProperties
}

export default FilePreview
