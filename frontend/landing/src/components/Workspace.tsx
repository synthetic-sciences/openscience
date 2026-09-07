import { useEffect, useLayoutEffect, useRef, useState } from "react"
import "./Workspace.css"

/* A pixel-faithful replica of the OpenScience workspace, in the product's
   own font, tokens, and icon set (Iconoir, as vendored by frontend/ui). The
   frame is 1440 × 810 and scales to its container. The sidebar's Files,
   Terminal, and Compute rows open the right pane, as in the app, and the
   agent's activity reveals in sequence on load. Replace with a screen
   recording when one exists. */

const ICONS = {
  plus: ["M6 12H12M18 12H12M12 12V6M12 12V18"],
  search: [
    "M17 17L21 21",
    "M3 11C3 15.4183 6.58172 19 11 19C13.213 19 15.2161 18.1015 16.6644 16.6493C18.1077 15.2022 19 13.2053 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11Z",
  ],
  settings: [
    "M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z",
    "M19.6224 10.3954L18.5247 7.7448L20 6L18 4L16.2647 5.48295L13.5578 4.36974L12.9353 2H10.981L10.3491 4.40113L7.70441 5.51596L6 4L4 6L5.45337 7.78885L4.3725 10.4463L2 11V13L4.40111 13.6555L5.51575 16.2997L4 18L6 20L7.79116 18.5403L10.397 19.6123L11 22H13L13.6045 19.6132L16.2551 18.5155C16.6969 18.8313 18 20 18 20L20 18L18.5159 16.2494L19.6139 13.598L21.9999 12.9772L22 11L19.6224 10.3954Z",
  ],
  folder: [
    "M2 11V4.6C2 4.26863 2.26863 4 2.6 4H8.77805C8.92127 4 9.05977 4.05124 9.16852 4.14445L12.3315 6.85555C12.4402 6.94876 12.5787 7 12.722 7H21.4C21.7314 7 22 7.26863 22 7.6V11M2 11V19.4C2 19.7314 2.26863 20 2.6 20H21.4C21.7314 20 22 19.7314 22 19.4V11M2 11H22",
  ],
  terminal: ["M13 17H20", "M5 7L10 12L5 17"],
  cpu: [
    "M8 15.4V8.6C8 8.26863 8.26863 8 8.6 8H15.4C15.7314 8 16 8.26863 16 8.6V15.4C16 15.7314 15.7314 16 15.4 16H8.6C8.26863 16 8 15.7314 8 15.4Z",
    "M20 4.6V19.4C20 19.7314 19.7314 20 19.4 20H4.6C4.26863 20 4 19.7314 4 19.4V4.6C4 4.26863 4.26863 4 4.6 4H19.4C19.7314 4 20 4.26863 20 4.6Z",
    "M17 4V2",
    "M12 4V2",
    "M7 4V2",
    "M7 20V22",
    "M12 20V22",
    "M17 20V22",
    "M20 17H22",
    "M20 12H22",
    "M20 7H22",
    "M4 17H2",
    "M4 12H2",
    "M4 7H2",
  ],
  chevronLeft: ["M15 6L9 12L15 18"],
  chevronDown: ["M6 9L12 15L18 9"],
  xmark: [
    "M6.75827 17.2426L12.0009 12M17.2435 6.75736L12.0009 12M12.0009 12L6.75827 6.75736M12.0009 12L17.2435 17.2426",
  ],
  attachment: [
    "M21.4383 11.6622L12.2483 20.8522C11.1225 21.9781 9.59552 22.6106 8.00334 22.6106C6.41115 22.6106 4.88418 21.9781 3.75834 20.8522C2.63249 19.7264 2 18.1994 2 16.6072C2 15.015 2.63249 13.4881 3.75834 12.3622L12.9483 3.17222C13.6989 2.42166 14.7169 2 15.7783 2C16.8398 2 17.8578 2.42166 18.6083 3.17222C19.3589 3.92279 19.7806 4.94077 19.7806 6.00222C19.7806 7.06368 19.3589 8.08166 18.6083 8.83222L9.40834 18.0222C9.03306 18.3975 8.52406 18.6083 7.99334 18.6083C7.46261 18.6083 6.95362 18.3975 6.57834 18.0222C6.20306 17.6469 5.99222 17.138 5.99222 16.6072C5.99222 16.0765 6.20306 15.5675 6.57834 15.1922L15.0683 6.71222",
  ],
  arrowUp: ["M12 21L12 3M12 3L20.5 11.5M12 3L3.5 11.5"],
  copy: [
    "M19.4 20H9.6C9.26863 20 9 19.7314 9 19.4V9.6C9 9.26863 9.26863 9 9.6 9H19.4C19.7314 9 20 9.26863 20 9.6V19.4C20 19.7314 19.7314 20 19.4 20Z",
    "M15 9V4.6C15 4.26863 14.7314 4 14.4 4H4.6C4.26863 4 4 4.26863 4 4.6V14.4C4 14.7314 4.26863 15 4.6 15H9",
  ],
  undo: [
    "M4.5 8C8.5 8 11 8 15 8C15 8 15 8 15 8C15 8 20 8 20 12.7059C20 18 15 18 15 18C11.5714 18 9.71429 18 6.28571 18",
    "M7.5 11.5C6.13317 10.1332 5.36683 9.36683 4 8C5.36683 6.63317 6.13317 5.86683 7.5 4.5",
  ],
  fork: [
    "M17 7C18.1046 7 19 6.10457 19 5C19 3.89543 18.1046 3 17 3C15.8954 3 15 3.89543 15 5C15 6.10457 15.8954 7 17 7Z",
    "M7 7C8.10457 7 9 6.10457 9 5C9 3.89543 8.10457 3 7 3C5.89543 3 5 3.89543 5 5C5 6.10457 5.89543 7 7 7Z",
    "M7 21C8.10457 21 9 20.1046 9 19C9 17.8954 8.10457 17 7 17C5.89543 17 5 17.8954 5 19C5 20.1046 5.89543 21 7 21Z",
    "M7 7V17",
    "M17 7V8C17 10.5 15 11 15 11L9 13C9 13 7 13.5 7 16V17",
  ],
  book: [
    "M12 21V7C12 5.89543 12.8954 5 14 5H21.4C21.7314 5 22 5.26863 22 5.6V18.7143",
    "M12 21V7C12 5.89543 11.1046 5 10 5H2.6C2.26863 5 2 5.26863 2 5.6V18.7143",
    "M14 19L22 19",
    "M10 19L2 19",
    "M12 21C12 19.8954 12.8954 19 14 19",
    "M12 21C12 19.8954 11.1046 19 10 19",
  ],
  database: [
    "M5 12V18C5 18 5 21 12 21C19 21 19 18 19 18V12",
    "M5 6V12C5 12 5 15 12 15C19 15 19 12 19 12V6",
    "M12 3C19 3 19 6 19 6C19 6 19 9 12 9C5 9 5 6 5 6C5 6 5 3 12 3Z",
  ],
  page: [
    "M4 21.4V2.6C4 2.26863 4.26863 2 4.6 2H16.2515C16.4106 2 16.5632 2.06321 16.6757 2.17574L19.8243 5.32426C19.9368 5.43679 20 5.5894 20 5.74853V21.4C20 21.7314 19.7314 22 19.4 22H4.6C4.26863 22 4 21.7314 4 21.4Z",
    "M8 10L16 10",
    "M8 18L16 18",
    "M8 14L12 14",
    "M16 2V5.4C16 5.73137 16.2686 6 16.6 6H20",
  ],
  checkCircle: [
    "M7 12.5L10 15.5L17 8.5",
    "M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z",
  ],
  clock: [
    "M12 6L12 12L18 12",
    "M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z",
  ],
  refresh: [
    "M21.8883 13.5C21.1645 18.3113 17.013 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C16.1006 2 19.6248 4.46819 21.1679 8",
    "M17 8H21.4C21.7314 8 22 7.73137 22 7.4V3",
  ],
  expand: [
    "M9 9L4 4M4 4V8M4 4H8",
    "M15 9L20 4M20 4V8M20 4H16",
    "M9 15L4 20M4 20V16M4 20H8",
    "M15 15L20 20M20 20V16M20 20H16",
  ],
  separate: ["M17 8L12 3L7 8", "M17 16L12 21L7 16"],
  moreHoriz: [
    "M20 12.5C20.2761 12.5 20.5 12.2761 20.5 12C20.5 11.7239 20.2761 11.5 20 11.5C19.7239 11.5 19.5 11.7239 19.5 12C19.5 12.2761 19.7239 12.5 20 12.5Z",
    "M12 12.5C12.2761 12.5 12.5 12.2761 12.5 12C12.5 11.7239 12.2761 11.5 12 11.5C11.7239 11.5 11.5 11.7239 11.5 12C11.5 12.2761 11.7239 12.5 12 12.5Z",
    "M4 12.5C4.27614 12.5 4.5 12.2761 4.5 12C4.5 11.7239 4.27614 11.5 4 11.5C3.72386 11.5 3.5 11.7239 3.5 12C3.5 12.2761 3.72386 12.5 4 12.5Z",
  ],
  reports: [
    "M4 21.4V2.6C4 2.26863 4.26863 2 4.6 2H16.2515C16.4106 2 16.5632 2.06321 16.6757 2.17574L19.8243 5.32426C19.9368 5.43679 20 5.5894 20 5.74853V21.4C20 21.7314 19.7314 22 19.4 22H4.6C4.26863 22 4 21.7314 4 21.4Z",
    "M8 17V13",
    "M12 17V9",
    "M16 17V15",
  ],
  square: [
    "M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z",
  ],
} as const

type IconName = keyof typeof ICONS

function Ic({ name, className, ...rest }: { name: IconName; className?: string; "data-ok"?: string }) {
  return (
    <svg className={`ic ${className ?? ""}`} viewBox="0 0 24 24" aria-hidden {...rest}>
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

function Dots() {
  const cells = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  return (
    <svg className="os-dots" viewBox="0 0 15 15" fill="currentColor" aria-hidden>
      {cells.map((cell, index) => (
        <rect
          key={cell}
          width="3"
          height="3"
          rx="1"
          x={(index % 3) * 4 + 2}
          y={Math.floor(index / 3) * 4 + 2}
          style={{ animation: `os-blink ${1 + (index % 4) * 0.2}s steps(2, start) ${index * 0.13}s infinite` }}
        />
      ))}
    </svg>
  )
}

type Pane = "files" | "terminal" | "compute"
const PANE_LABEL: Record<Pane, string> = { files: "Files", terminal: "Terminal", compute: "Compute" }
const PANE_ICON: Record<Pane, IconName> = { files: "folder", terminal: "terminal", compute: "cpu" }

const TOOLS: readonly { icon: IconName; title: string; subject: string; arg?: string; time: string; body?: string }[] =
  [
    { icon: "book", title: "Searching", subject: "T4 lysozyme stabilizing mutations", arg: "literature", time: "1.8s" },
    { icon: "database", title: "Querying", subject: "UniProt P00720", arg: "ProTherm · PDB 2LZM", time: "0.9s" },
    {
      icon: "terminal",
      title: "Running",
      subject: "python ddg_scan.py",
      arg: "--pdb structures/2LZM.pdb",
      time: "3.4s",
      body: "scoring 26 point mutants against 2LZM\nwrote results/ddg_vs_protherm.png\nr = 0.71  (n = 26)",
    },
    { icon: "reports", title: "Writing", subject: "results/ddg_vs_protherm.png", time: "0.1s" },
  ]

const FILES: readonly {
  name: string
  kind: "folder" | "py" | "file"
  size?: string
  tint?: "green" | "blue"
  dim?: boolean
}[] = [
  { name: "data", kind: "folder", tint: "blue" },
  { name: "results", kind: "folder", tint: "green" },
  { name: "structures", kind: "folder" },
  { name: ".venv", kind: "folder", dim: true },
  { name: "ddg_scan.py", kind: "py", size: "4.2 KB" },
  { name: "environment.yml", kind: "file", size: "612 B" },
  { name: "notes.md", kind: "file", size: "1.8 KB" },
  { name: "README.md", kind: "file", size: "940 B" },
]

/* (measured, predicted) ΔΔG in kcal/mol for the Results preview. */
const POINTS: readonly [number, number, string?][] = [
  [-0.9, -1.2, "S38D"],
  [-0.6, -0.8, "T109D"],
  [-0.5, -0.7, "N116D"],
  [-0.3, 0.1],
  [-0.2, -0.4],
  [0.1, 0.3],
  [0.2, -0.1],
  [0.4, 0.6],
  [0.5, 0.2],
  [0.7, 0.9],
  [0.8, 0.4],
  [0.9, 1.3],
  [1.0, 0.7],
  [1.2, 1.5],
  [1.3, 0.9],
  [1.4, 1.8],
  [1.6, 1.2],
  [1.7, 2.1],
  [1.9, 1.5],
  [2.0, 2.4],
  [2.2, 1.7],
  [2.3, 2.6],
  [2.5, 2.0],
  [2.6, 2.9],
  [2.8, 2.3],
  [2.9, 2.7],
]

function Plot() {
  const x0 = 44
  const x1 = 336
  const y0 = 232
  const y1 = 18
  const sx = (v: number) => x0 + ((v + 2) / 5.5) * (x1 - x0)
  const sy = (v: number) => y0 - ((v + 2) / 5.5) * (y0 - y1)
  const ticks = [-2, -1, 0, 1, 2, 3]
  return (
    <svg className="os-plot" viewBox="0 0 352 262" role="img" aria-label="Predicted against measured stability change">
      <rect x={x0} y={y1} width={x1 - x0} height={y0 - y1} fill="var(--bg-inset)" stroke="var(--border)" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x0} y1={sy(t)} x2={x1} y2={sy(t)} stroke="var(--border)" strokeDasharray="2 4" />
          <text x={x0 - 8} y={sy(t) + 3.5} fontSize="9.5" fill="var(--text-weaker)" textAnchor="end">
            {t}
          </text>
          <text x={sx(t)} y={y0 + 14} fontSize="9.5" fill="var(--text-weaker)" textAnchor="middle">
            {t}
          </text>
        </g>
      ))}
      <line
        x1={sx(-1.6)}
        y1={sy(-1.6 * 0.93 + 0.05)}
        x2={sx(3.2)}
        y2={sy(3.2 * 0.93 + 0.05)}
        stroke="var(--text-weak)"
        strokeWidth="1"
      />
      {POINTS.map(([xm, yp, label], i) => (
        <g key={i}>
          <circle
            cx={sx(xm)}
            cy={sy(yp)}
            r={label ? 4 : 3}
            fill={label ? "var(--brand)" : "var(--bg)"}
            stroke={label ? "var(--brand)" : "var(--text-weak)"}
            strokeWidth="1"
          />
          {label ? (
            <text
              x={sx(xm) + (label === "S38D" ? -8 : 8)}
              y={sy(yp) + (label === "S38D" ? 12 : label === "T109D" ? -9 : 5)}
              fontSize="9.5"
              fill="var(--brand)"
              textAnchor={label === "S38D" ? "end" : "start"}
            >
              {label}
            </text>
          ) : null}
        </g>
      ))}
      <text x={x0 + 10} y={y1 + 16} fontSize="10" fill="var(--text)">
        r = 0.71, n = 26
      </text>
      <text x={(x0 + x1) / 2} y="256" fontSize="10" fill="var(--text-weak)" textAnchor="middle">
        ΔΔG measured (kcal/mol)
      </text>
      <text
        x="12"
        y={(y0 + y1) / 2}
        fontSize="10"
        fill="var(--text-weak)"
        textAnchor="middle"
        transform={`rotate(-90 12 ${(y0 + y1) / 2})`}
      >
        ΔΔG predicted
      </text>
    </svg>
  )
}

function useScale(ref: React.RefObject<HTMLDivElement>) {
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => setScale(node.clientWidth / 1440)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return scale
}

function useReveal(steps: number) {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStage(steps)
      return
    }
    let current = 0
    const timer = window.setInterval(() => {
      current += 1
      setStage(current)
      if (current >= steps) window.clearInterval(timer)
    }, 720)
    return () => window.clearInterval(timer)
  }, [steps])
  return stage
}

export default function Workspace() {
  const viewport = useRef<HTMLDivElement>(null)
  const scale = useScale(viewport)
  const [pane, setPane] = useState<Pane | null>(null)
  const [open, setOpen] = useState<Pane[]>([])
  const [expanded, setExpanded] = useState(true)
  const [filesTab, setFilesTab] = useState<"project" | "results">("project")
  const touched = useRef(false)
  const stage = useReveal(TOOLS.length + 1)
  const streaming = stage <= TOOLS.length
  const done = stage > TOOLS.length

  /* When the run finishes, the app surfaces the new result: open Files on
     the Results tab, unless the viewer already chose a pane. */
  useEffect(() => {
    if (!done || touched.current) return
    const timer = window.setTimeout(() => {
      if (touched.current) return
      setOpen((list) => (list.includes("files") ? list : [...list, "files"]))
      setPane("files")
      setFilesTab("results")
    }, 500)
    return () => window.clearTimeout(timer)
  }, [done])

  const show = (next: Pane) => {
    touched.current = true
    setOpen((list) => (list.includes(next) ? list : [...list, next]))
    setPane((current) => (current === next ? null : next))
  }
  const close = () => {
    touched.current = true
    setPane(null)
  }

  return (
    <section data-component="demo" id="workspace" data-nav="Workspace" aria-label="The OpenScience workspace">
      <div className="os-viewport" ref={viewport}>
        <div className="os" style={{ transform: `scale(${scale})` }}>
          <aside className="os-side" aria-label="Research sessions">
            <div className="os-side__brand">
              <span className="os-side__mark" aria-hidden>
                <svg focusable="false">
                  <use href="/provider-logos.svg#synsci" />
                </svg>
              </span>
              <span>OpenScience</span>
              <Ic name="chevronLeft" />
            </div>
            <div className="os-side__nav">
              <button type="button" className="os-row" data-active="true">
                <Ic name="plus" />
                New
              </button>
              <button type="button" className="os-row">
                <Ic name="search" />
                Search
              </button>
              <button type="button" className="os-row">
                <Ic name="settings" />
                Customize
              </button>
            </div>
            <div className="os-side__label">Workspace</div>
            {(["files", "terminal", "compute"] as Pane[]).map((item) => (
              <button
                key={item}
                type="button"
                className="os-row"
                data-selected={pane === item ? "true" : undefined}
                aria-pressed={pane === item}
                onClick={() => show(item)}
              >
                <Ic name={PANE_ICON[item]} />
                {PANE_LABEL[item]}
              </button>
            ))}
            <div className="os-side__label">Sessions</div>
            <button type="button" className="os-row os-row--session" data-selected="true">
              T4 lysozyme stability scan
            </button>
            <button type="button" className="os-row os-row--session">
              ProTherm cross-check
            </button>
            <button type="button" className="os-row os-row--session">
              Figure 3 regeneration
            </button>
          </aside>

          <div className="os-main" data-pane={pane ? "true" : "false"}>
            <div className="os-session">
              <div className="os-tabs">
                <div className="os-tab">
                  {streaming ? <i className="os-tab__dot" /> : null}
                  <span>T4 lysozyme stability scan</span>
                  <Ic name="xmark" />
                </div>
                <div className="os-context" aria-label="Context usage">
                  <i />
                  <b>{done ? "31.2K" : "18.4K"}</b>
                  <span>{done ? "3%" : "2%"}</span>
                </div>
              </div>

              <div className="os-thread">
                <div className="os-col">
                  <div className="os-user">
                    Which T4 lysozyme point mutants are predicted to be stabilizing? Compare against ProTherm
                    measurements and plot ΔΔG predicted vs. measured.
                  </div>

                  <div className="os-turn">
                    <button
                      type="button"
                      className="os-status"
                      aria-expanded={expanded}
                      onClick={() => setExpanded((value) => !value)}
                    >
                      {streaming ? <Dots /> : <i className="os-caret" />}
                      <span>
                        {streaming
                          ? "Gathering context"
                          : expanded
                            ? "Hide reasoning and activity"
                            : "Show reasoning and activity"}
                      </span>
                      <em>·</em>
                      <em>{streaming ? `${(stage * 1.6).toFixed(0)}s` : "6.2s"}</em>
                    </button>

                    {expanded ? (
                      <div className="os-activity">
                        {TOOLS.map((tool, index) => {
                          const shown = stage > index
                          const running = stage === index + 1 && streaming
                          return (
                            <div
                              key={tool.title + tool.subject}
                              className="os-tool"
                              data-shown={shown ? "true" : "false"}
                            >
                              <div className="os-tool__head">
                                <Ic name={tool.icon} />
                                <span className="os-tool__title">{tool.title}</span>
                                <span className="os-tool__subject">{tool.subject}</span>
                                {tool.arg ? <span className="os-tool__arg">{tool.arg}</span> : null}
                                <span className="os-tool__meta">
                                  {running ? <Dots /> : <Ic name="checkCircle" data-ok="" />}
                                  {tool.time}
                                </span>
                              </div>
                              {tool.body && shown && !running ? (
                                <div className="os-tool__body mono">{tool.body}</div>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    ) : null}

                    <div className="os-answer" data-shown={done ? "true" : "false"} aria-hidden={!done}>
                      <p>
                        Predicted ΔΔG tracks the ProTherm measurements (r = 0.71, n = 26). Three substitutions are
                        stabilizing under both, and all three sit on the solvent-exposed face of helix C:
                      </p>
                      <ul>
                        <li>
                          <code>S38D</code> −1.2 predicted, −0.9 measured kcal/mol
                        </li>
                        <li>
                          <code>T109D</code> −0.8 predicted, −0.6 measured
                        </li>
                        <li>
                          <code>N116D</code> −0.7 predicted, −0.5 measured
                        </li>
                      </ul>
                      <p>
                        The scatter is in <code>results/ddg_vs_protherm.png</code>. Next I can run the three through
                        FoldX for an independent estimate, or draft the methods paragraph with the ProTherm citation.
                        Which first?
                      </p>
                      <div className="os-actions">
                        <button type="button">
                          <Ic name="copy" />
                          Copy
                        </button>
                        <span className="right">
                          <button type="button">
                            <Ic name="undo" />
                            Undo
                          </button>
                          <button type="button">
                            <Ic name="fork" />
                            Fork
                          </button>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="os-composer-wrap">
                <div className="os-composer" aria-label="Research composer">
                  <div className="os-composer__placeholder">
                    <i className="os-composer__caret" />
                    Describe the research task you want to work through…
                  </div>
                  <div className="os-composer__row">
                    <span className="os-chip">
                      <Ic name="attachment" />
                    </span>
                    <span className="os-chip">
                      Tools
                      <Ic name="chevronDown" />
                    </span>
                    <span className="os-composer__right">
                      <span className="os-chip" data-strong="">
                        <span className="os-provider" aria-hidden>
                          <svg>
                            <use href="/provider-logos.svg#anthropic" />
                          </svg>
                        </span>
                        Claude Opus 5
                        <Ic name="chevronDown" />
                      </span>
                      <span className="os-composer__divider" />
                      <span className="os-chip">
                        Provider default
                        <Ic name="chevronDown" />
                      </span>
                      <span className="os-send" data-streaming={streaming ? "true" : "false"} aria-hidden>
                        <Ic name={streaming ? "square" : "arrowUp"} />
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {pane ? (
              <div className="os-pane" aria-label={PANE_LABEL[pane]}>
                <div className="os-pane__tabs">
                  {open.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="os-pane__tab"
                      data-active={pane === item ? "true" : "false"}
                      onClick={() => setPane(item)}
                    >
                      <Ic name={PANE_ICON[item]} />
                      {PANE_LABEL[item]}
                      {pane === item ? <Ic name="xmark" className="close" /> : null}
                    </button>
                  ))}
                  <span className="os-pane__tools">
                    <button type="button" aria-label="Resize">
                      <Ic name="separate" />
                    </button>
                    <button type="button" aria-label="Expand">
                      <Ic name="expand" />
                    </button>
                    <button type="button" aria-label="Close pane" onClick={close}>
                      <Ic name="xmark" />
                    </button>
                  </span>
                </div>
                <div className="os-pane__body">
                  {pane === "files" ? (
                    <>
                      <div className="os-subtabs">
                        <button
                          type="button"
                          className="os-subtab"
                          data-active={filesTab === "project" ? "true" : "false"}
                          onClick={() => setFilesTab("project")}
                        >
                          <Ic name="folder" />
                          Project files
                        </button>
                        <span className="os-subtab">
                          <Ic name="clock" />
                          This session
                        </span>
                        <button
                          type="button"
                          className="os-subtab"
                          data-active={filesTab === "results" ? "true" : "false"}
                          onClick={() => setFilesTab("results")}
                        >
                          <Ic name="reports" />
                          Results
                        </button>
                      </div>
                      {filesTab === "project" ? (
                        <>
                          <div className="os-more">
                            <Ic name="moreHoriz" />
                            More
                            <Ic name="chevronDown" />
                          </div>
                          <div className="os-filter">
                            <Ic name="search" />
                            <span>Filter this folder</span>
                            <Ic name="refresh" />
                          </div>
                          <div className="os-files__head">
                            <span>Name</span>
                            <span>Size</span>
                          </div>
                          {FILES.map((file) => (
                            <button
                              key={file.name}
                              type="button"
                              className="os-file"
                              data-kind={file.kind}
                              data-tint={file.tint}
                              data-dim={file.dim ? "true" : undefined}
                            >
                              <Ic name={file.kind === "folder" ? "folder" : "page"} />
                              <span>{file.name}</span>
                              {file.size ? <small>{file.size}</small> : null}
                            </button>
                          ))}
                        </>
                      ) : (
                        <div className="os-result">
                          <div className="os-result__head">
                            <Ic name="reports" />
                            <span>ddg_vs_protherm.png</span>
                            <small>just now · 1200 × 900</small>
                          </div>
                          <Plot />
                          <div className="os-result__actions">
                            <button type="button">
                              <Ic name="expand" />
                              Open
                            </button>
                            <button type="button">
                              <Ic name="copy" />
                              Copy
                            </button>
                          </div>
                          <div className="os-result__row">
                            <Ic name="page" />
                            <span>ddg_scores.csv</span>
                            <small>26 rows</small>
                          </div>
                        </div>
                      )}
                    </>
                  ) : null}

                  {pane === "terminal" ? (
                    <>
                      <div className="os-subtabs">
                        <span className="os-subtab" data-active="true">
                          Terminal 1
                          <Ic name="xmark" className="close" />
                        </span>
                        <span className="os-subtab os-subtab--right">
                          <Ic name="plus" />
                          New
                        </span>
                      </div>
                      <div className="os-term">
                        {"Mac protein-stability % python ddg_scan.py \\\n    --pdb structures/2LZM.pdb\n"}
                        <b>
                          {
                            "loading structures/2LZM.pdb … 164 residues\nscoring 26 point mutants\nwrote results/ddg_scores.csv\nwrote results/ddg_vs_protherm.png\nr = 0.71  (n = 26)\n"
                          }
                        </b>
                        {"Mac protein-stability % "}
                        <i className="os-composer__caret" />
                      </div>
                    </>
                  ) : null}

                  {pane === "compute" ? (
                    <>
                      <div className="os-compute__card">
                        <span className="os-compute__icon">
                          <Ic name="cpu" />
                        </span>
                        <div>
                          <div className="os-compute__title">This computer</div>
                          <div className="os-compute__sub">1 active · 0 running</div>
                          <div className="os-meters">
                            <div>
                              <div className="os-meter__row">
                                <span>Memory</span>
                                <span>
                                  <b>3.1 GB</b> / 25.8 GB
                                </span>
                              </div>
                              <div className="os-meter__bar">
                                <i style={{ width: "12%" }} />
                              </div>
                            </div>
                            <div>
                              <div className="os-meter__row">
                                <span>CPU</span>
                                <span>
                                  <b>~1 of 10</b> cores
                                </span>
                              </div>
                              <div className="os-meter__bar">
                                <i style={{ width: "10%" }} />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="os-job">
                        <Ic name="terminal" />
                        Python 3.12 · ddg_scan.py
                        <small>
                          <span className="ok">done</span> · 3.4s
                        </small>
                      </div>
                      <div className="os-job">
                        <Ic name="cpu" />
                        Modal · A100 40GB
                        <small>not connected</small>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
