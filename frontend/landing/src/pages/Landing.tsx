import { useEffect, useMemo, useRef, useState } from "react"
import heroPlate from "@/assets/hero.webp"
import { CONNECTORS } from "@/data/connectors"
import Nav from "@/Nav"

const LOGOS = [
  { id: "harvard", src: "/logos/harvard.png", alt: "Harvard University" },
  { id: "mit", src: "/logos/mit.png", alt: "Massachusetts Institute of Technology" },
  { id: "stanford", src: "/logos/stanford.png", alt: "Stanford University" },
  { id: "fermilab", src: "/logos/fermilab.png", alt: "Fermilab" },
  { id: "yale", src: "/logos/yale.png", alt: "Yale University" },
  { id: "oxford", src: "/logos/oxford.png", alt: "University of Oxford" },
  { id: "nus", src: "/logos/nus.png", alt: "National University of Singapore" },
  { id: "iit-bombay", src: "/logos/iit-bombay.png", alt: "IIT Bombay" },
  { id: "iit-delhi", src: "/logos/iit-delhi.png", alt: "IIT Delhi" },
] as const

/* OpenScience. CMU Concrete, warm dark, coral accents.
   Same design family as Synthetic Sciences.

   Type system, used consistently:
     H_HUGE  dither statements and the closing banner only
     H_BIG   every section heading
     H_MED   card and FAQ titles
     P_BIG   section subheads, max-w-[54ch]
     P       card bodies
   Product moments can break the grid when the interaction benefits. */

const H_HUGE = "text-[clamp(40px,5vw,72px)] leading-[1.02] tracking-[-0.024em]"
const H_BIG = "text-[clamp(30px,3.4vw,48px)] leading-[1.06] tracking-[-0.02em]"
const H_MED = "text-[22px] sm:text-[26px] leading-[1.14] tracking-[-0.012em]"
const P = "text-[14px] leading-[1.7] text-foreground/75"
const P_BIG = "text-[16px] sm:text-[17px] leading-[1.7] text-foreground/75"
const LABEL = "text-[14px] text-muted-foreground"

const GITHUB = "https://github.com/synthetic-sciences/openscience"
const DOCS = "https://github.com/synthetic-sciences/OpenScience#readme"

const MODELS = [
  ["5.6 Sol", "OpenAI", "Reasoning"],
  ["5.6 Terra", "OpenAI", "Reasoning"],
  ["Opus 5", "Anthropic", "Reasoning"],
  ["Kimi K3", "Moonshot AI", "Reasoning"],
  ["GLM 5.3", "Z.AI", "Reasoning"],
  ["DeepSeek V4 Flash", "DeepSeek", "General"],
] as const

/* Eyebrow, the quiet label above every section heading. */
function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`text-[14px] tracking-[0.04em] text-foreground/55 ${className}`}>{children}</div>
}

/* Cta, the one button system. Sharp corners on purpose; the arrow
   nudges right on hover. */
function Cta({
  children,
  href = "#",
  variant = "primary",
  arrow = true,
  external = false,
  className = "",
}: {
  children: React.ReactNode
  href?: string
  variant?: "primary" | "ghost"
  arrow?: boolean
  external?: boolean
  className?: string
}) {
  const base =
    "group/cta inline-flex items-center justify-center gap-2.5 h-11 px-6 text-[14px] leading-none select-none"
  const look =
    variant === "primary"
      ? "btn-primary"
      : "border border-foreground/25 text-foreground/90 hover:border-foreground/55 hover:bg-foreground/[0.04] backdrop-blur-[2px] transition-colors duration-300"
  return (
    <a
      href={href}
      className={`${base} ${look} ${className}`}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {children}
      {arrow ? (
        <svg
          width="14"
          height="10"
          viewBox="0 0 14 10"
          aria-hidden
          className="transition-transform duration-300 group-hover/cta:translate-x-[3px]"
        >
          <path d="M0 5h12M8.5 1 13 5l-4.5 4" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      ) : null}
    </a>
  )
}

/* OsMark, the OpenScience mark. A thin ring with an orbiting coral node. */
function OsMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="text-foreground/85">
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1" opacity="0.9" />
      <ellipse
        cx="8"
        cy="8"
        rx="6.6"
        ry="2.6"
        stroke="currentColor"
        strokeWidth="0.8"
        opacity="0.45"
        transform="rotate(-24 8 8)"
      />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="13.35" cy="4.6" r="1.5" fill="hsl(var(--accent-coral))" />
    </svg>
  )
}

/* ---------------------------- ASCII backdrop ---------------------------- */

function useAsciiContours(cols: number, rows: number, seed = 1) {
  return useMemo(() => {
    const RAMP = [" ", " ", ".", ".", ",", ":", ";", "-", "~", "+", "=", "o", "0", "#"]
    const peaks = [
      { x: cols * 0.28, y: rows * 0.42, s: cols * 0.22, h: 1.0 },
      { x: cols * 0.72, y: rows * 0.38, s: cols * 0.18, h: 0.85 },
      { x: cols * 0.55, y: rows * 0.82, s: cols * 0.3, h: 0.55 },
    ]
    let out = ""
    for (let y = 0; y < rows; y++) {
      let line = ""
      for (let x = 0; x < cols; x++) {
        let v = 0
        for (const p of peaks) {
          const dx = (x - p.x) / p.s
          const dy = ((y - p.y) * 1.9) / p.s
          v += p.h * Math.exp(-(dx * dx + dy * dy))
        }
        const n = (Math.sin((x * 12.9898 + y * 78.233 + seed) * 0.5) + 1) * 0.04
        v = Math.max(0, Math.min(0.999, v + n))
        line += RAMP[Math.floor(v * RAMP.length)]
      }
      out += line + "\n"
    }
    return out
  }, [cols, rows, seed])
}

function AsciiBackdrop({ seed = 1, opacity = "text-foreground/[0.06]" }: { seed?: number; opacity?: string }) {
  const art = useAsciiContours(220, 80, seed)
  return (
    <pre aria-hidden className={`ascii absolute inset-0 m-0 p-0 text-[10px] leading-[1.05] ${opacity} vignette`}>
      {art}
    </pre>
  )
}

/* ------------------------------- Reveal -------------------------------- */

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true)
            obs.disconnect()
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-[1100ms] ease-[cubic-bezier(0.19,1,0.22,1)] will-change-transform ${
        shown ? "opacity-100 translate-y-0 blur-0" : "opacity-0 translate-y-6 blur-[5px]"
      } ${className}`}
    >
      {children}
    </div>
  )
}

/* ----------------------------- Section frame ---------------------------- */

function Section({
  children,
  className = "",
  seed = 1,
  id,
}: {
  children: React.ReactNode
  className?: string
  seed?: number
  id?: string
}) {
  return (
    <section id={id} className="relative w-full overflow-hidden border-t border-border/40">
      <div className="absolute inset-0 graticule opacity-[0.04]" />
      <AsciiBackdrop seed={seed} />
      <div className={`relative z-10 mx-auto max-w-[1400px] w-full px-6 sm:px-10 py-24 sm:py-32 ${className}`}>
        {children}
      </div>
    </section>
  )
}

/* ----------------------------- Hero plate ------------------------------- */
/* The Pharos of Alexandria engraving. The beam sweeps from the tower at the
   right down to a small ship steering by its light at bottom-left. The plate
   is already monochrome warm sepia, the same hue family as the site's cream,
   so it ships unfiltered. Covered and biased right so the tower sits on the
   right and the ship stays in view at bottom-left; the veil blends the edges.
   One rule at every width keeps the crop consistent on any screen. */

const HERO_NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/* Veil: a light uniform scrim softens the plate; a soft top-left shield sits
   under the wordmark and a bottom-right shield under the copy, so the beam
   and the ship at bottom-left stay in view. */
const HERO_VEIL = [
  "linear-gradient(hsl(30 14% 7% / 0.2), hsl(30 14% 7% / 0.2))",
  "radial-gradient(ellipse 55% 45% at 5% 6%, hsl(30 14% 7% / 0.8) 0%, hsl(30 14% 7% / 0.4) 55%, transparent 85%)",
  "radial-gradient(ellipse 85% 75% at 96% 94%, hsl(var(--background)) 0%, hsl(30 14% 7% / 0.84) 38%, hsl(30 14% 7% / 0.28) 66%, transparent 90%)",
  "linear-gradient(180deg, hsl(28 18% 4% / 0.5) 0%, transparent 15%)",
].join(", ")

/* ------------------------------ Hero ----------------------------------- */

function Hero() {
  const backdrop = useRef<HTMLDivElement>(null)
  const copy = useRef<HTMLDivElement>(null)

  /* Gentle parallax: the constellation sinks slower than the page, the
     copy eases away. rAF-throttled, passive, respects reduced motion. */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        const y = window.scrollY
        if (backdrop.current) backdrop.current.style.transform = `translateY(${y * 0.22}px)`
        if (copy.current) {
          const t = Math.min(y / 640, 1)
          copy.current.style.opacity = `${1 - t * 0.85}`
          copy.current.style.transform = `translateY(${y * 0.06}px)`
        }
      })
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll)
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <section className="relative h-screen min-h-[680px] w-full bg-background overflow-hidden grain">
      <div ref={backdrop} className="absolute inset-0 will-change-transform" aria-hidden>
        <div
          className="absolute inset-0 bg-background bg-no-repeat [background-position:62%_center] [background-size:cover]"
          style={{ backgroundImage: `url(${heroPlate})` }}
        />
        <div className="absolute inset-0 opacity-[0.32] mix-blend-overlay" style={{ backgroundImage: HERO_NOISE }} />
        <div className="absolute inset-0" style={{ background: HERO_VEIL }} />
      </div>

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[5]"
        style={{
          height: "16%",
          background: "linear-gradient(to top, hsl(var(--background)) 0%, hsl(var(--background) / 0) 100%)",
        }}
      />

      <div className="absolute inset-x-0 top-0 z-20 mx-auto flex h-20 w-full max-w-[1400px] items-center justify-center px-6 sm:px-10">
        <Nav />
      </div>

      <div className="absolute inset-0 z-10 mx-auto flex h-full max-w-[1400px] flex-col px-6 sm:px-10">
        <div className="hero-text rise self-start mt-[9vh]" style={{ animationDelay: "120ms" }}>
          <div className="text-[clamp(40px,6.4vw,96px)] leading-[0.9] tracking-[-0.04em]">openscience</div>
          <a
            href="https://syntheticsciences.ai"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-[13px] tracking-[0.04em] text-foreground/55 transition-colors duration-300 hover:text-foreground/85"
          >
            by Synthetic Sciences
          </a>
        </div>

        <div ref={copy} className="hero-text mt-auto mb-[5vh] self-end text-right max-w-[820px]">
          <div className="rise" style={{ animationDelay: "260ms" }}>
            <h1 className="text-balance text-[clamp(34px,4.6vw,62px)] leading-[1.04] tracking-[-0.024em] text-foreground">
              The open-source AI workbench for scientists.
            </h1>
          </div>
          <div
            className="rise mt-9 flex flex-wrap items-center justify-end gap-3 [text-shadow:none]"
            style={{ animationDelay: "420ms" }}
          >
            <Cta href="/download#desktop">Download desktop</Cta>
            <Cta href="/download#terminal" variant="ghost" arrow={false}>
              Install with npm
            </Cta>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ------------------------ Product-story visuals ------------------------- */

function TrustStrip() {
  return (
    <section className="relative w-full overflow-hidden border-t border-border/40 py-14">
      <div className="relative z-10">
        <div className="mb-9 text-center text-[14px] tracking-[0.04em] text-foreground/55">Used by researchers at</div>
        <div className="marquee-mask overflow-hidden">
          <div className="marquee-track">
            {[0, 1].map((group) => (
              <div className="marquee-group" key={group} aria-hidden={group === 1}>
                {LOGOS.map((logo) => (
                  <div key={`${logo.id}-${group}`} className="flex items-center gap-14">
                    <img
                      src={logo.src}
                      alt={logo.alt}
                      title={logo.alt}
                      className="logo-wall-img"
                      data-logo={logo.id}
                      draggable={false}
                    />
                    <span className="trust-dot" aria-hidden />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function ModelRouteVisual() {
  const [index, setIndex] = useState(0)
  const [manual, setManual] = useState(false)

  useEffect(() => {
    if (manual) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % MODELS.length), 1700)
    return () => window.clearInterval(timer)
  }, [manual])

  const model = MODELS[index]

  return (
    <div className="model-stage h-full overflow-hidden border border-border/55 bg-[hsl(28,14%,5%)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.75)]">
      <div className="flex items-center justify-between border-b border-border/55 px-5 py-3.5 sm:px-6">
        <span className="text-[12px] text-foreground/45">session / models</span>
        <span className="flex items-center gap-2 font-terminal text-[9px] tracking-[0.08em] text-foreground/35">
          <span className="size-1.5 rounded-full bg-[hsl(92,36%,56%)]" /> LOCALHOST
        </span>
      </div>

      <div className="relative min-h-[620px] overflow-hidden bg-background/45 p-4 sm:min-h-[520px] sm:p-6">
        <div className="pointer-events-none absolute inset-0 grid-paper opacity-50" />
        <div className="pointer-events-none absolute left-8 top-9 hidden w-[42%] sm:block">
          <div className="font-terminal text-[9px] tracking-[0.08em] text-foreground/25">TASK</div>
          <p className="mt-3 max-w-[34ch] text-[13px] leading-6 text-foreground/35">
            Compare the held-out cohort with the preregistered result and cite the supporting evidence.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {["study.csv", "analysis.ipynb", "manuscript.md"].map((file) => (
              <span
                key={file}
                className="border border-border/40 bg-background/65 px-2.5 py-1.5 font-terminal text-[9px] text-foreground/30"
              >
                {file}
              </span>
            ))}
          </div>
        </div>

        <div
          className="relative z-10 ml-auto w-full max-w-[470px] overflow-hidden border border-border/70 bg-[hsl(28,14%,7%)] shadow-[0_24px_70px_-24px_rgba(0,0,0,0.9)]"
          onFocusCapture={() => setManual(true)}
        >
          <div className="flex items-center justify-between border-b border-border/55 px-4 py-3">
            <div>
              <div className="text-[13px] text-foreground/90">Models</div>
              <div className="mt-0.5 text-[10px] text-foreground/35">Choose for this session</div>
            </div>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden className="text-foreground/35">
              <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" />
              <path d="m9.5 9.5 3 3" stroke="currentColor" />
            </svg>
          </div>

          <div className="p-1.5">
            {MODELS.map(([name, provider, kind], item) => (
              <button
                type="button"
                key={name}
                onClick={() => {
                  setIndex(item)
                  setManual(true)
                }}
                className={`relative flex w-full items-center gap-3 px-3 py-2 text-left transition-all duration-500 ${
                  item === index
                    ? "model-picker-active translate-x-0.5 bg-foreground/[0.085]"
                    : "text-foreground/55 hover:bg-foreground/[0.035]"
                }`}
                aria-pressed={item === index}
              >
                <span
                  className={`flex size-7 shrink-0 items-center justify-center border font-terminal text-[9px] ${
                    item === index
                      ? "border-[hsl(var(--accent-coral))]/55 text-[hsl(var(--accent-coral))]"
                      : "border-border/60 text-foreground/35"
                  }`}
                >
                  {provider.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-foreground/85">{name}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-foreground/35">
                    {kind} · {provider}
                  </span>
                </span>
                <span
                  className={`text-[13px] ${item === index ? "text-[hsl(var(--accent-coral))]" : "text-transparent"}`}
                >
                  ✓
                </span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 border-t border-border/55">
            <div className="border-r border-border/55 px-4 py-3">
              <div className="text-[11px] text-foreground/70">More models</div>
              <div className="mt-1 text-[9.5px] text-foreground/30">Browse connected providers.</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-[11px] text-foreground/70">Manage models</div>
              <div className="mt-1 text-[9.5px] text-foreground/30">Choose what appears here.</div>
            </div>
          </div>
        </div>

        <div className="absolute inset-x-4 bottom-4 z-20 border border-border/65 bg-[hsl(28,14%,6%)] p-3 sm:inset-x-6 sm:bottom-6">
          <div className="text-[11px] text-foreground/35">Ask OpenScience to work through the evidence…</div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span
              key={model[0]}
              className="model-chip-change inline-flex items-center gap-2 border border-border/55 px-2.5 py-1.5 text-[10.5px] text-foreground/70"
            >
              <span className="size-1.5 rounded-full bg-[hsl(var(--accent-coral))]" />
              {model[0]}
            </span>
            <span className="flex size-7 items-center justify-center bg-primary text-primary-foreground" aria-hidden>
              ↑
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Visual({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="atmosphere atmosphere-stars h-full min-h-[300px] p-5 sm:p-7 flex flex-col">
      <div className="flex items-center justify-between border-b border-border/45 pb-3 font-terminal text-[10px] tracking-[0.05em] text-foreground/45">
        <span>{label}</span>
        <span className="flex items-center gap-1.5" aria-hidden>
          <span className="size-1.5 rounded-full bg-foreground/20" />
          <span className="size-1.5 rounded-full bg-foreground/20" />
          <span className="size-1.5 rounded-full bg-[hsl(var(--accent-coral))]/70" />
        </span>
      </div>
      <div className="flex-1 flex flex-col justify-center">{children}</div>
    </div>
  )
}

function PlanVisual() {
  return (
    <Visual label="Plan">
      <div className="space-y-3 font-terminal text-[11px] leading-[1.65]">
        <div className="border border-border/50 bg-background/55 px-4 py-3">
          <span className="text-foreground/40">goal </span>
          <span className="text-foreground/85">test whether the effect survives the held-out cohort</span>
        </div>
        <div className="border border-border/50 bg-background/55 px-4 py-3">
          <span className="text-foreground/40">changes my mind </span>
          <span className="text-foreground/85">the interval crosses the null after correction</span>
        </div>
      </div>
    </Visual>
  )
}

function RunVisual() {
  return (
    <Visual label="Run">
      <div className="font-terminal text-[11px] leading-[1.75]">
        <div>
          <span className="text-foreground/40">$ </span>
          <span className="text-foreground/90">python analysis.py</span>
        </div>
        <div className="text-foreground/45">reading study.csv</div>
        <div className="text-foreground/45">fitting preregistered model</div>
        <div className="text-[hsl(86_30%_62%)]">saved results/model-summary.csv</div>
        <div className="text-[hsl(86_30%_62%)]">saved results/diagnostic.png</div>
        <div className="mt-3 flex items-center gap-2 text-foreground/55">
          <span className="inline-block h-2 w-2 bg-[hsl(var(--accent-coral))]" /> saved to this project
        </div>
      </div>
    </Visual>
  )
}

function CritiqueVisual() {
  return (
    <Visual label="Check">
      <div className="space-y-3 text-[12px] leading-[1.55]">
        <div className="border border-border/50 bg-background/55 px-4 py-3 text-foreground/80">
          “The treatment improved recovery.”
        </div>
        <div className="border-l border-[hsl(var(--accent-coral))]/70 pl-4 text-foreground/65">
          The subgroup split was chosen after inspection. Re-run with the declared grouping and report both results.
        </div>
        <div className="font-terminal text-[10px] text-foreground/40">check before writing the conclusion</div>
      </div>
    </Visual>
  )
}

function ProjectContextVisual() {
  return (
    <div className="flex h-full flex-col overflow-hidden border border-border/55 bg-[hsl(28,14%,5%)] shadow-[0_30px_90px_-35px_rgba(0,0,0,0.8)]">
      <div className="flex items-center justify-between border-b border-border/55 px-5 py-3.5 sm:px-6">
        <span className="text-[12px] text-foreground/50">project</span>
        <span className="flex items-center gap-2 font-terminal text-[9px] tracking-[0.08em] text-foreground/35">
          <span className="size-1.5 rounded-full bg-[hsl(92,36%,56%)]" /> LOCAL
        </span>
      </div>

      <div className="grid min-h-[390px] flex-1 md:grid-cols-[230px_1fr]">
        <div className="border-b border-border/55 bg-background/55 p-5 md:border-b-0 md:border-r sm:p-6">
          <div className="font-terminal text-[9px] tracking-[0.08em] text-foreground/35">FILES</div>
          <div className="mt-5 space-y-1 font-terminal text-[10.5px] text-foreground/45">
            <div className="pb-2 text-foreground/80">openscience/</div>
            {["data/", "notebooks/", "results/", "papers/", "lab-notes.md", "manuscript.md"].map((file, index) => (
              <div
                key={file}
                className={`flex items-center gap-2 px-2 py-1.5 ${index === 5 ? "bg-foreground/[0.07] text-foreground/80" : ""}`}
              >
                <span className="text-foreground/25">{index < 5 ? "├─" : "└─"}</span>
                <span>{file}</span>
              </div>
            ))}
          </div>
          <div className="mt-7 border-t border-border/45 pt-4 text-[10px] leading-5 text-foreground/35">
            Files and outputs stay in this project.
          </div>
        </div>

        <div className="p-5 sm:p-7">
          <div className="flex flex-col gap-2 border-b border-border/45 pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-[15px] text-foreground/90">In this session</div>
              <div className="mt-1 text-[11px] text-foreground/35">Open files, sources, and results.</div>
            </div>
            <span className="font-terminal text-[9px] tracking-[0.06em] text-foreground/35">
              4 ITEMS · LOCAL PROJECT
            </span>
          </div>

          <div className="mt-3">
            {[
              ["PAPER", "held-out-cohort.pdf", "opened in this session", "PDF"],
              ["DATA", "study.csv", "used by analysis.py", "2.4 MB"],
              ["RUN", "model-summary.csv", "saved to results/", "CSV"],
              ["NOTE", "lab-notes.md", "local project file", "MARKDOWN"],
            ].map(([kind, name, link, meta], index) => (
              <div
                key={name}
                className="group grid gap-3 border-b border-border/40 px-2 py-3.5 last:border-b-0 sm:grid-cols-[54px_1fr_auto] sm:items-center"
              >
                <span className="font-terminal text-[8.5px] tracking-[0.08em] text-[hsl(var(--accent-coral))]/75">
                  {kind}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] text-foreground/80">{name}</div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-foreground/30">
                    <span className="h-px w-4 bg-border transition-all duration-300 group-hover:w-7" />
                    {link}
                  </div>
                </div>
                <span className="font-terminal text-[9px] text-foreground/25 sm:text-right">{meta}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ConnectorLogo({ connector }: { connector: (typeof CONNECTORS)[number] }) {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-white/10 bg-white/[0.94] p-1.5 shadow-[0_6px_18px_-10px_rgba(0,0,0,0.9)]"
      aria-hidden
    >
      <img src={connector.logo} alt="" className="size-full object-contain" loading="lazy" decoding="async" />
    </span>
  )
}

function ConnectorWall() {
  return (
    <ul className="tool-wall grid grid-cols-2 gap-px bg-border/45 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {CONNECTORS.map((connector) => (
        <li key={connector.id} className="min-w-0">
          <a
            href={connector.home}
            target="_blank"
            rel="noreferrer"
            title={connector.name}
            className="group relative flex min-h-[72px] min-w-0 items-center gap-3 overflow-hidden bg-[hsl(28,14%,7%)] px-3 py-3 text-[10.5px] text-foreground/65 transition-[background-color,color,transform] duration-300 hover:-translate-y-px hover:bg-foreground/[0.07] hover:text-foreground focus-visible:z-10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[hsl(var(--accent-coral))] sm:px-4 sm:text-[11.5px]"
          >
            <ConnectorLogo connector={connector} />
            <span className="min-w-0 break-words leading-[1.35] [overflow-wrap:anywhere]">{connector.name}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

/* -------------------------------- FAQ ----------------------------------- */

function FaqItem({ q, a, isOpen, onToggle }: { q: string; a: string; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="border-t border-border/40 first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="w-full text-left py-7 flex items-center gap-5 group cursor-pointer"
      >
        <div className="flex-1">
          <div
            className={`${H_MED} transition-colors duration-300 ${
              isOpen ? "text-foreground" : "text-foreground/80 group-hover:text-foreground"
            }`}
          >
            {q}
          </div>
        </div>
        <span
          className={`text-[hsl(var(--accent-coral))] shrink-0 transition-transform duration-300 ${
            isOpen ? "rotate-180" : ""
          }`}
          aria-hidden
        >
          <svg width="14" height="8" viewBox="0 0 14 8" fill="none">
            <polyline points="1,1 7,7 13,1" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <p className={`pr-12 pb-7 max-w-[58ch] ${P}`}>{a}</p>
        </div>
      </div>
    </div>
  )
}

function FaqList({ items }: { items: Array<{ q: string; a: string }> }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0)
  return (
    <div>
      {items.map((item, i) => (
        <FaqItem
          key={item.q}
          q={item.q}
          a={item.a}
          isOpen={openIdx === i}
          onToggle={() => setOpenIdx(openIdx === i ? null : i)}
        />
      ))}
    </div>
  )
}

/* -------------------------------- Page ---------------------------------- */

export default function Landing() {
  return (
    <div
      id="top"
      className="min-h-screen bg-background text-foreground antialiased selection:bg-primary/30 selection:text-foreground"
    >
      <Hero />

      <TrustStrip />

      {/* -------------------------- MODELS ---------------------------- */}
      <section id="models" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid gap-8 lg:grid-cols-2 lg:items-stretch lg:gap-12">
            <Reveal className="dither-models flex min-h-[470px] items-center border border-border/40 p-8 sm:min-h-[520px] sm:p-12 lg:p-14">
              <div className="dither-content max-w-[520px]">
                <h2 className={`text-balance ${H_HUGE} text-foreground`}>Model agnostic.</h2>
                <p className={`mt-7 max-w-[38ch] ${P_BIG} text-foreground/85`}>
                  Use a connected provider, your own API key, or a local model. Switch per session.
                </p>
              </div>
            </Reveal>
            <Reveal delay={120} className="min-w-0">
              <ModelRouteVisual />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---------------------- PLAN, RUN, CHECK ---------------------- */}
      <Section seed={3} id="skills">
        <Reveal>
          <h2 className={`text-balance ${H_BIG}`}>Plan. Run. Check.</h2>
        </Reveal>
        <div className="mt-16 grid grid-cols-12 gap-px border border-border/40 bg-border/40">
          {[
            {
              visual: <PlanVisual />,
              title: "Plan",
              body: "Define the method and what would count as a useful result.",
            },
            {
              visual: <RunVisual />,
              title: "Run",
              body: "Use the files, code, terminal, and tools already in the project.",
            },
            {
              visual: <CritiqueVisual />,
              title: "Check",
              body: "Check the result against the method and source material before writing it up.",
            },
          ].map((feature, index) => (
            <Reveal key={feature.title} delay={index * 90} className="col-span-12 bg-background md:col-span-4">
              <div className="group flex h-full flex-col transition-colors duration-500 hover:bg-foreground/[0.02]">
                <div className="border-b border-border/40 bg-background/55 px-6 pb-4 pt-6 sm:px-8">
                  <div className="h-[250px] overflow-hidden border border-border/40 transition-all duration-500 group-hover:-translate-y-0.5 group-hover:border-foreground/35">
                    {feature.visual}
                  </div>
                </div>
                <div className="flex-1 p-7 sm:p-8">
                  <h3 className={H_MED}>{feature.title}</h3>
                  <p className={`mt-3.5 max-w-[42ch] ${P}`}>{feature.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ---------------------- PROJECT AND SOURCES -------------------- */}
      <section id="sources" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid gap-8 lg:grid-cols-2 lg:items-stretch lg:gap-12">
            <Reveal className="min-w-0">
              <ProjectContextVisual />
            </Reveal>
            <Reveal
              delay={120}
              className="dither-red flex min-h-[470px] items-center border border-border/40 p-8 sm:min-h-[520px] sm:p-12 lg:p-14"
            >
              <div className="dither-content max-w-[520px]">
                <h2 className={`text-balance ${H_HUGE} text-foreground`}>Papers. Data. Code. Results.</h2>
                <p className={`mt-7 max-w-[38ch] ${P_BIG} text-foreground/85`}>
                  OpenScience reads the files in your project and keeps earlier work available in the same session.
                </p>
              </div>
            </Reveal>
          </div>

          <Reveal delay={220} className="mt-20 sm:mt-24">
            <div className="mb-10 text-center sm:mb-12">
              <h3 className="text-[clamp(24px,2.6vw,36px)] leading-[1.08] tracking-[-0.018em] text-foreground">
                Search 42 scientific sources.
              </h3>
              <p className={`mx-auto mt-3 max-w-[52ch] ${P}`}>
                Papers, structures, variants, compounds, pathways, and expression data.
              </p>
            </div>
            <div className="tool-field overflow-hidden border border-border/55 p-5 sm:p-8">
              <ConnectorWall />
            </div>
          </Reveal>
        </div>
      </section>

      {/* -------------------------- OPEN SOURCE ------------------------ */}
      <section id="opensource" className="dither-red relative w-full overflow-hidden border-t border-border/40">
        <div className="dither-content mx-auto w-full max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
          <div className="mx-auto max-w-[900px] text-center">
            <Reveal>
              <h2 className={`text-balance ${H_HUGE} text-foreground`}>Open source, Apache 2.0.</h2>
            </Reveal>
            <Reveal delay={200}>
              <p className={`mx-auto mt-6 max-w-[46ch] ${P_BIG} text-foreground/85`}>
                The agent, skills, tools, and workspace are public. Read the code, change it, or connect your own tools.
              </p>
            </Reveal>
            <Reveal delay={320}>
              <div className="mt-10 flex flex-col items-center gap-4">
                <Cta href={GITHUB} external>
                  View on GitHub
                </Cta>
                <span className="font-terminal text-[12.5px] text-foreground/60">
                  github.com/synthetic-sciences/openscience
                </span>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* -------------------------- LOCAL FIRST ------------------------ */}
      <section id="local-first" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="mx-auto w-full max-w-[1400px] px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-stretch lg:gap-12">
            <Reveal className="dither-purple relative flex min-h-[430px] items-center overflow-hidden border border-border/40 p-8 sm:p-12 lg:p-14">
              <div className="dither-content max-w-[580px]">
                <h2 className={`text-balance ${H_HUGE} text-foreground`}>Your machine. Your accounts.</h2>
                <p className={`mt-7 max-w-[42ch] ${P_BIG} text-foreground/85`}>
                  OpenScience has no hosted control plane. Projects, settings, credentials, and results stay on your
                  device. Requests go directly to services you choose.
                </p>
                <div className="mt-9">
                  <Cta href="/download">Download OpenScience</Cta>
                </div>
              </div>
            </Reveal>

            <Reveal
              delay={140}
              className="flex min-h-[430px] flex-col justify-center border border-border/55 bg-[hsl(28,14%,5%)] p-7 sm:p-10 lg:p-12"
            >
              <div className="text-[12px] text-foreground/50">Local by default</div>
              <div className="mt-3 font-display text-[clamp(46px,6vw,76px)] leading-none tracking-[-0.035em]">
                Yours.
              </div>
              <div className="mt-4 text-[13px] text-foreground/70">No product account required.</div>
              <div className="mt-8 divide-y divide-border/50 border-y border-border/50 text-[12px] sm:text-[13px]">
                {[
                  ["Projects", "On your device"],
                  ["Credentials", "Encrypted locally"],
                  ["Providers", "Direct connections"],
                ].map((item) => (
                  <div key={item[0]} className="flex items-center justify-between gap-6 py-3.5">
                    <span className="text-foreground/55">{item[0]}</span>
                    <span className="text-right text-foreground/85">{item[1]}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ----------------------------- FAQ ----------------------------- */}
      <Section seed={7} id="faq">
        <div className="grid grid-cols-12 gap-10 lg:gap-16">
          <div className="col-span-12 self-start lg:sticky lg:top-28 lg:col-span-5">
            <Reveal>
              <h2 className={`text-balance ${H_BIG}`}>Questions.</h2>
            </Reveal>
            <Reveal delay={150}>
              <p className={`mt-5 max-w-[36ch] ${P_BIG}`}>The rest is in the docs.</p>
            </Reveal>
          </div>
          <div className="col-span-12 lg:col-span-7">
            <FaqList
              items={[
                {
                  q: "What is OpenScience?",
                  a: "OpenScience is a local app for research. Chat, files, terminals, sources, and results are in the same workspace.",
                },
                {
                  q: "How is it different from a coding agent?",
                  a: "It works with papers and datasets as well as code, and saves results inside the project.",
                },
                {
                  q: "Which models can it use?",
                  a: "Use connected provider accounts, your own API keys, or local models. OpenScience does not proxy model traffic.",
                },
                {
                  q: "Where does my work live?",
                  a: "Sessions, projects, results, settings, and credentials stay on your machine. Provider calls go directly from the app to that provider.",
                },
                {
                  q: "Do I need an OpenScience account?",
                  a: "No. Install the app, connect only the providers and tools you want, and work locally.",
                },
                {
                  q: "Can it work with my tools?",
                  a: "Yes. It can use the scientific sources that ship with OpenScience, code in your project, software on your machine, and MCP or lab tools you connect.",
                },
                {
                  q: "Can I extend it?",
                  a: "Yes. Add skills, plugins, MCP servers, custom agents, and commands. The SDK can also connect private lab tools.",
                },
              ]}
            />
          </div>
        </div>
      </Section>

      {/* ------------------- FINAL CTA (warm dither banner) ---------------- */}
      <section className="relative w-full overflow-hidden border-t border-border/40">
        <div className="mx-auto max-w-[1400px] w-full px-6 sm:px-10 py-20 sm:py-24">
          <div className="dither-warm border border-border/40 p-10 sm:p-16 min-h-[380px] flex flex-col justify-center relative">
            <div className="dither-content grid grid-cols-12 gap-10 items-center">
              <div className="col-span-12 lg:col-span-7">
                <Reveal>
                  <h2 className={`max-w-[16ch] text-balance ${H_HUGE} text-foreground`}>
                    OpenScience runs on your computer.
                  </h2>
                </Reveal>
              </div>
              <div className="col-span-12 lg:col-span-5">
                <Reveal delay={200}>
                  <p className={`${P_BIG} text-foreground/85 max-w-[38ch]`}>
                    Free and open source. Use your provider accounts, your API keys, or local models.
                  </p>
                  <div className="mt-8 flex flex-wrap items-center gap-3">
                    <Cta href="/download#desktop">Download desktop</Cta>
                    <Cta href="/download#terminal" variant="ghost" arrow={false}>
                      Install with npm
                    </Cta>
                  </div>
                </Reveal>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------ FOOTER ----------------------------- */}
      <footer className="relative overflow-hidden">
        <div className={`mx-auto max-w-[1400px] px-6 sm:px-10 pt-16 pb-10 border-t border-border/40 ${LABEL}`}>
          <div className="grid grid-cols-12 gap-10">
            <div className="col-span-12 md:col-span-5">
              <div className="flex items-center gap-2.5 text-foreground">
                <OsMark size={15} />
                <span className="font-display text-[22px] tracking-tight leading-none">openscience</span>
              </div>
              <p className="mt-4 max-w-[36ch] text-[13.5px] leading-[1.7] text-foreground/55">
                Open-source research workspace by Synthetic Sciences.
              </p>
            </div>
            <div className="col-span-6 sm:col-span-4 md:col-span-2">
              <div className="text-[13px] tracking-[0.04em] text-foreground/45 mb-4">Project</div>
              <ul className="space-y-2.5 text-[13.5px]">
                <li>
                  <a
                    href={GITHUB}
                    target="_blank"
                    rel="noreferrer"
                    className="link-underline text-foreground/70 hover:text-foreground"
                  >
                    GitHub
                  </a>
                </li>
                <li>
                  <a
                    href="https://www.npmjs.com/package/@synsci/openscience"
                    target="_blank"
                    rel="noreferrer"
                    className="link-underline text-foreground/70 hover:text-foreground"
                  >
                    npm
                  </a>
                </li>
                <li>
                  <a
                    href={`${GITHUB}/releases`}
                    target="_blank"
                    rel="noreferrer"
                    className="link-underline text-foreground/70 hover:text-foreground"
                  >
                    Releases
                  </a>
                </li>
              </ul>
            </div>
            <div className="col-span-6 sm:col-span-4 md:col-span-2">
              <div className="text-[13px] tracking-[0.04em] text-foreground/45 mb-4">Resources</div>
              <ul className="space-y-2.5 text-[13.5px]">
                <li>
                  <a
                    href={DOCS}
                    target="_blank"
                    rel="noreferrer"
                    className="link-underline text-foreground/70 hover:text-foreground"
                  >
                    Docs
                  </a>
                </li>
                <li>
                  <a href="#skills" className="link-underline text-foreground/70 hover:text-foreground">
                    Skills
                  </a>
                </li>
                <li>
                  <a href="/download" className="link-underline text-foreground/70 hover:text-foreground">
                    Download
                  </a>
                </li>
                <li>
                  <a href="#faq" className="link-underline text-foreground/70 hover:text-foreground">
                    FAQ
                  </a>
                </li>
              </ul>
            </div>
            <div className="col-span-12 sm:col-span-4 md:col-span-3">
              <div className="text-[13px] tracking-[0.04em] text-foreground/45 mb-4">Company</div>
              <ul className="space-y-2.5 text-[13.5px]">
                <li>
                  <a
                    href="https://syntheticsciences.ai"
                    className="link-underline text-foreground/70 hover:text-foreground inline-flex items-center gap-1.5"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Synthetic Sciences
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                      <path d="M2 8 L8 2 M4 2 L8 2 L8 6" stroke="currentColor" fill="none" />
                    </svg>
                  </a>
                </li>
                <li>
                  <a
                    href="https://x.com/SynScience"
                    target="_blank"
                    rel="noreferrer"
                    className="link-underline text-foreground/70 hover:text-foreground"
                  >
                    X / Twitter
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-14 pt-6 border-t border-border/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-[12.5px] text-foreground/45">
            <div>&copy; {new Date().getFullYear()} Synthetic Sciences. Apache 2.0.</div>
            <a href="#top" className="link-underline hover:text-foreground inline-flex items-center gap-2">
              Back to top
              <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden>
                <path d="M4.5 10V1.5M1 4.5 4.5 1 8 4.5" stroke="currentColor" fill="none" />
              </svg>
            </a>
          </div>
        </div>

        {/* Giant clipped wordmark, the closing brand moment. */}
        <div className="relative h-[13vw] min-h-[90px] max-h-[200px] overflow-hidden" aria-hidden>
          <div className="footer-watermark absolute left-1/2 -translate-x-1/2 top-[0.04em] text-center">
            openscience
          </div>
        </div>
      </footer>
    </div>
  )
}
