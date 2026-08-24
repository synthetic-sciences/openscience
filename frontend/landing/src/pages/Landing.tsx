import { useEffect, useMemo, useRef, useState } from "react"
import workspaceShot from "@/assets/workspace.png"
import modelPickerShot from "@/assets/model-picker.png"
import heroPlate from "@/assets/hero.webp"

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
     CAPTION 13px/50 under visuals
     MONO_N  11px terminal numerals and counts
   Every content section: Eyebrow, H_BIG, one P_BIG sub, content at mt-14.
   Left-aligned throughout; only the two dither moments break the grid. */

const H_HUGE = "text-[clamp(40px,5vw,72px)] leading-[1.02] tracking-[-0.024em]"
const H_BIG = "text-[clamp(30px,3.4vw,48px)] leading-[1.06] tracking-[-0.02em]"
const H_MED = "text-[22px] sm:text-[26px] leading-[1.14] tracking-[-0.012em]"
const P = "text-[14px] leading-[1.7] text-foreground/75"
const P_BIG = "text-[16px] sm:text-[17px] leading-[1.7] text-foreground/75"
const CAPTION = "text-[13px] leading-[1.6] text-foreground/50"
const MONO_N = "font-terminal text-[11px] tracking-[0.08em] text-foreground/40"
const LABEL = "text-[14px] text-muted-foreground"

const GITHUB = "https://github.com/synthetic-sciences/openscience"
const DOCS = "https://openscience.sh/docs"
const APP = "https://app.syntheticsciences.ai"
const NPM_CMD = "npm i -g @synsci/openscience"
const CURL_CMD = "curl -fsSL https://openscience.sh/install | bash"

/* Eyebrow, the quiet label above every section heading. */
function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`text-[14px] tracking-[0.04em] text-foreground/55 ${className}`}>{children}</div>
}

/* SectionHeader, the one header pattern every content section uses. */
function SectionHeader({
  eyebrow,
  title,
  sub,
  className = "",
}: {
  eyebrow: string
  title: string
  sub?: string
  className?: string
}) {
  return (
    <div className={`max-w-[820px] ${className}`}>
      <Reveal>
        <Eyebrow className="mb-5">{eyebrow}</Eyebrow>
        <h2 className={`text-balance ${H_BIG}`}>{title}</h2>
      </Reveal>
      {sub ? (
        <Reveal delay={150}>
          <p className={`mt-5 max-w-[54ch] ${P_BIG}`}>{sub}</p>
        </Reveal>
      ) : null}
    </div>
  )
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

/* CopyChip, a copyable shell command. Click to copy, icon confirms. */
function CopyChip({ cmd, className = "" }: { cmd: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(cmd).catch(() => {})
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      }}
      className={`group/chip inline-flex items-center gap-3 border border-border/70 bg-background/45 backdrop-blur-[3px] pl-4 pr-3 h-11 font-terminal text-[13px] text-foreground/80 hover:border-foreground/35 hover:text-foreground transition-colors duration-300 cursor-pointer max-w-full ${className}`}
      aria-label={`Copy command: ${cmd}`}
    >
      <span className="text-foreground/40 shrink-0">$</span>
      <span className="truncate min-w-0">{cmd}</span>
      <span
        className="ml-1 text-foreground/40 group-hover/chip:text-foreground/75 transition-colors shrink-0"
        aria-hidden
      >
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2.5 7 5 9.5 10.5 3.5" stroke="hsl(86 30% 60%)" strokeWidth="1.4" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <rect x="4" y="4" width="7" height="7" stroke="currentColor" />
            <path d="M9 4V2H2v7h2" stroke="currentColor" fill="none" />
          </svg>
        )}
      </span>
    </button>
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
/* The Pharos of Alexandria engraving — the beam sweeps from the tower at the
   right down to a small ship steering by its light at bottom-left. The plate
   is already monochrome warm sepia, the same hue family as the site's cream,
   so it ships unfiltered. Covered and biased right so the tower sits on the
   right and the ship stays in view at bottom-left; the veil blends the edges.
   One rule at every width — the crop reads the same on any screen. */

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
            <Cta href="#install">Install OpenScience</Cta>
            <Cta href={GITHUB} variant="ghost" arrow={false} external>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              Star on GitHub
            </Cta>
            <CopyChip cmd={NPM_CMD} className="hidden lg:inline-flex ml-2" />
          </div>
        </div>
      </div>
    </section>
  )
}

/* --------------------------- Product screenshot ------------------------- */

function ProductShot() {
  return (
    <section className="relative w-full overflow-hidden border-t border-border/40">
      <div className="absolute inset-0 graticule opacity-[0.04]" />
      <div className="relative z-10 mx-auto max-w-[1400px] w-full px-6 sm:px-10 py-20 sm:py-24">
        <Reveal>
          <div className="border border-border/50 bg-[hsl(28,14%,6%)] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8)]">
            <img
              src={workspaceShot}
              alt="The OpenScience workspace: a research session with agent selector, model picker, files, terminal, and the research graph"
              className="block w-full h-auto select-none"
              draggable={false}
              decoding="async"
            />
          </div>
        </Reveal>
        <Reveal delay={150}>
          <div className={`mt-5 flex items-center justify-between gap-4 ${CAPTION}`}>
            <span>The workspace. One command, and it opens in your browser.</span>
            <span className="font-terminal hidden sm:block">localhost:4096</span>
          </div>
        </Reveal>
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

function LoopVisual() {
  return (
    <Visual label="research session / active">
      <div className="mx-auto w-full max-w-[510px] py-4">
        {[
          "Read the literature",
          "Form a testable claim",
          "Run the analysis",
          "Challenge the result",
          "Write from evidence",
        ].map((item, index) => (
          <div key={item} className="flex items-stretch gap-4">
            <div className="flex w-4 shrink-0 flex-col items-center">
              <span
                className={`mt-[5px] size-2 rounded-full border ${
                  index < 3
                    ? "border-[hsl(86_30%_62%)] bg-[hsl(86_30%_62%)]/70"
                    : index === 3
                      ? "border-[hsl(var(--accent-coral))] bg-[hsl(var(--accent-coral))]/65"
                      : "border-foreground/30"
                }`}
              />
              {index < 4 ? <span className="my-1 w-px flex-1 bg-border/70" /> : null}
            </div>
            <div className="pb-5">
              <div className="text-[15px] leading-none text-foreground/90">{item}</div>
              <div className="mt-1.5 font-terminal text-[10px] text-foreground/40">
                {index < 3 ? "complete" : index === 3 ? "in progress" : "waiting on evidence"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Visual>
  )
}

function PlanVisual() {
  return (
    <Visual label="plan / success criterion">
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
    <Visual label="workspace / live run">
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
          <span className="inline-block h-2 w-2 bg-[hsl(var(--accent-coral))]" /> evidence attached to the session
        </div>
      </div>
    </Visual>
  )
}

function CritiqueVisual() {
  return (
    <Visual label="critique / claim review">
      <div className="space-y-3 text-[12px] leading-[1.55]">
        <div className="border border-border/50 bg-background/55 px-4 py-3 text-foreground/80">
          “The treatment improved recovery.”
        </div>
        <div className="border-l border-[hsl(var(--accent-coral))]/70 pl-4 text-foreground/65">
          The subgroup split was chosen after inspection. Re-run with the declared grouping and report both results.
        </div>
        <div className="font-terminal text-[10px] text-foreground/40">claim held until the check resolves</div>
      </div>
    </Visual>
  )
}

function ContextVisual() {
  return (
    <Visual label="source-grounded research">
      <div className="mx-auto w-full max-w-[520px] space-y-4">
        <div className="border border-border/55 bg-background/65 px-4 py-3 text-[13px] text-foreground/85">
          What evidence would falsify the proposed mechanism?
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {["paper / methods", "dataset / cohort", "repo / analysis", "notes / prior attempt"].map((source) => (
            <div
              key={source}
              className="border border-border/45 bg-background/50 px-3 py-2.5 font-terminal text-[10px] text-foreground/55"
            >
              <span className="mr-2 text-[hsl(var(--accent-coral))]">●</span>
              {source}
            </div>
          ))}
        </div>
        <div className="border-t border-border/45 pt-4 text-[12px] leading-[1.65] text-foreground/65">
          The answer stays attached to the sources and the work that followed from them.
        </div>
      </div>
    </Visual>
  )
}

function LocalVisual() {
  return (
    <Visual label="local project / openscience">
      <div className="grid gap-5 sm:grid-cols-[0.8fr_1.2fr]">
        <div className="border border-border/45 bg-background/55 p-4 font-terminal text-[10px] leading-[1.9] text-foreground/55">
          <div className="text-foreground/85">project/</div>
          <div>├─ data/</div>
          <div>├─ notebooks/</div>
          <div>├─ results/</div>
          <div>└─ manuscript.md</div>
        </div>
        <div className="border border-border/45 bg-background/55 p-4">
          <div className="font-terminal text-[10px] text-foreground/40">model route</div>
          <div className="mt-3 text-[14px] text-foreground/90">Use the model that fits the task.</div>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-foreground/60">
            {["your provider", "local model", "managed model"].map((item) => (
              <span key={item} className="border border-border/55 px-2.5 py-1.5">
                {item}
              </span>
            ))}
          </div>
          <div className="mt-5 text-[11px] leading-[1.6] text-foreground/50">
            Files and credentials stay in the environment you control.
          </div>
        </div>
      </div>
    </Visual>
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

export default function Landing({
  analyticsEnabled = true,
  onAnalyticsToggle,
}: {
  analyticsEnabled?: boolean
  onAnalyticsToggle?: () => void
} = {}) {
  return (
    <div
      id="top"
      className="min-h-screen bg-background text-foreground antialiased selection:bg-primary/30 selection:text-foreground"
    >
      <Hero />

      <ProductShot />

      <TrustStrip />

      {/* ----------------------- RESEARCH LOOP ------------------------- */}
      <section id="how" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid grid-cols-12 items-stretch gap-8 lg:gap-12">
            <Reveal className="col-span-12 lg:col-span-6">
              <div className="dither-warm flex h-full min-h-[440px] flex-col justify-center border border-border/40 p-8 sm:p-12">
                <div className="dither-content">
                  <Eyebrow className="mb-6 text-foreground/70">Research loop</Eyebrow>
                  <h2 className={`text-balance ${H_HUGE} text-foreground`}>A chat window is not a laboratory.</h2>
                  <p className={`mt-7 max-w-[40ch] ${P_BIG} text-foreground/85`}>
                    OpenScience runs the whole arc of a project: reading, planning, analysis, critique, and writing. The
                    files, terminal, evidence, and conversation stay in one working session.
                  </p>
                </div>
              </div>
            </Reveal>
            <Reveal delay={150} className="col-span-12 self-center lg:col-span-6">
              <div className="h-[440px] overflow-hidden border border-border/40">
                <LoopVisual />
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <Section seed={3} id="skills">
        <SectionHeader
          eyebrow="How it works"
          title="Built around the research loop."
          sub="The agent does more than produce an answer. It defines the test, runs the work, and makes the result defend itself."
        />
        <div className="mt-16 grid grid-cols-12 gap-px border border-border/40 bg-border/40">
          {[
            {
              visual: <PlanVisual />,
              title: "Plan before acting.",
              body: "The session turns a broad goal into a testable plan, including what evidence would change the conclusion.",
            },
            {
              visual: <RunVisual />,
              title: "Work in the real environment.",
              body: "It reads project files, writes and runs code, inspects outputs, and keeps artifacts beside the reasoning that produced them.",
            },
            {
              visual: <CritiqueVisual />,
              title: "Challenge weak claims.",
              body: "Critique agents look for leakage, confounds, unsupported leaps, and missing controls before the result becomes a write-up.",
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

      {/* ---------------------- RESEARCH CONTEXT ----------------------- */}
      <section id="sources" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid grid-cols-12 items-stretch gap-8 lg:gap-12">
            <Reveal className="order-2 col-span-12 self-center lg:order-1 lg:col-span-6">
              <div className="h-[440px] overflow-hidden border border-border/40">
                <ContextVisual />
              </div>
            </Reveal>
            <Reveal delay={150} className="order-1 col-span-12 lg:order-2 lg:col-span-6">
              <div className="dither-purple flex h-full min-h-[440px] flex-col justify-center border border-border/40 p-8 sm:p-12">
                <div className="dither-content">
                  <Eyebrow className="mb-6 text-foreground/70">Research context</Eyebrow>
                  <h2 className={`text-balance ${H_HUGE} text-foreground`}>Read the record before making a claim.</h2>
                  <p className={`mt-7 max-w-[40ch] ${P_BIG} text-foreground/85`}>
                    Papers, datasets, repositories, and prior attempts become working context. The agent can search the
                    scientific record directly and keep the trail from source to decision intact.
                  </p>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <Section seed={4}>
        <div className="grid grid-cols-12 items-stretch gap-8 lg:gap-12">
          <Reveal className="col-span-12 self-center lg:col-span-5">
            <Eyebrow className="mb-5">Grounded work</Eyebrow>
            <h2 className={`text-balance ${H_BIG}`}>Your project is the context.</h2>
            <p className={`mt-6 max-w-[42ch] ${P_BIG}`}>
              OpenScience works across the materials researchers already use. It does not flatten a paper, a dataset,
              and a failed run into the same anonymous search result.
            </p>
            <div className="mt-8 flex flex-wrap gap-2 text-[13px]">
              {["Literature", "Data", "Code", "Prior runs", "Lab notes"].map((item) => (
                <span key={item} className="border border-border/60 bg-background/40 px-3 py-1.5 text-foreground/70">
                  {item}
                </span>
              ))}
            </div>
          </Reveal>
          <Reveal delay={150} className="col-span-12 lg:col-span-7">
            <div className="h-[400px] overflow-hidden border border-border/40">
              <LocalVisual />
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ----------------------- MODEL FREEDOM ------------------------- */}
      <section id="models" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid grid-cols-12 items-stretch gap-8 lg:gap-12">
            <Reveal className="col-span-12 lg:col-span-6">
              <div className="dither-blue flex h-full min-h-[440px] flex-col justify-center border border-border/40 p-8 sm:p-12">
                <div className="dither-content">
                  <Eyebrow className="mb-6 text-foreground/70">Model freedom</Eyebrow>
                  <h2 className={`text-balance ${H_HUGE} text-foreground`}>Use the model the work deserves.</h2>
                  <p className={`mt-7 max-w-[40ch] ${P_BIG} text-foreground/85`}>
                    After signing in, use local models, provider accounts, eligible ChatGPT access, or credit-backed
                    models through OpenRouter. The desktop and local runtime remain free; BYOK and ChatGPT remain
                    separate from the Ace wallet.
                  </p>
                </div>
              </div>
            </Reveal>
            <Reveal delay={150} className="col-span-12 self-center lg:col-span-6">
              <div className="border border-border/50 bg-[hsl(28,14%,6%)] p-6 shadow-[0_30px_90px_-30px_rgba(0,0,0,0.75)] sm:p-10">
                <img
                  src={modelPickerShot}
                  alt="The OpenScience model selector showing available providers, models, pricing, and effort controls"
                  className="block h-auto w-full select-none"
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------ ACE --------------------------- */}
      <Section seed={9} id="ace">
        <div className="grid grid-cols-12 items-start gap-10 lg:gap-16">
          <div className="col-span-12 lg:col-span-5">
            <Reveal>
              <Eyebrow className="mb-5">Ace</Eyebrow>
              <h2 className={`text-balance ${H_BIG}`}>OpenScience is free. Ace is pay as you go.</h2>
            </Reveal>
            <Reveal delay={150}>
              <p className={`mt-5 max-w-[44ch] ${P_BIG}`}>
                Add a purchased balance only when you want credit-backed models or enhanced search. There is no
                subscription or fixed monthly charge.
              </p>
            </Reveal>
          </div>
          <Reveal delay={200} className="col-span-12 lg:col-span-7">
            <div className="border border-border/60 bg-background/55 p-6 backdrop-blur-[3px] sm:p-9">
              <div className="flex flex-col gap-4 border-b border-border/50 pb-7 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="flex items-baseline gap-3">
                    <span className="font-display text-[clamp(38px,5vw,56px)] leading-none tracking-[-0.025em]">
                      $20
                    </span>
                    <span className={CAPTION}>to start</span>
                  </div>
                  <p className={`mt-3 ${P}`}>20 credits added to your purchased Wallet balance.</p>
                </div>
                <span className="w-fit border border-border/70 px-3 py-1.5 font-terminal text-[11px] tracking-[0.08em] text-foreground/60">
                  PAY AS YOU GO
                </span>
              </div>
              <p className={`mt-7 max-w-[60ch] ${P_BIG}`}>
                One credit is one dollar of prepaid OpenScience balance. Credits cover managed model and enhanced search
                usage at the rates shown in Billing.
              </p>
              <div className="mt-7 grid gap-px border border-border/50 bg-border/50 sm:grid-cols-2">
                {[
                  ["Credit-backed models through OpenRouter", "A curated route without provider setup."],
                  ["One balance for models and enhanced search", "Free basic search still works without Ace."],
                  ["Reloads 20 credits below 2", "One on/off setting. Your remaining balance stays available."],
                  ["Stay in control", "Turn auto-reload off any time and review every charge in Billing."],
                ].map(([title, copy]) => (
                  <div key={title} className="bg-background/90 p-5">
                    <h3 className="text-[15px] leading-6 text-foreground/90">{title}</h3>
                    <p className={`mt-2 ${CAPTION}`}>{copy}</p>
                  </div>
                ))}
              </div>
              <div className="mt-7 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <p className={`max-w-[48ch] ${CAPTION}`}>
                  Processing fee shown before payment and never added to your credit balance.
                </p>
                <Cta href={`${APP}/billing`} className="shrink-0">
                  Add credits
                </Cta>
              </div>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ---------------------------- INSTALL -------------------------- */}
      <Section seed={8} id="install">
        <div className="grid grid-cols-12 items-start gap-10 lg:gap-16">
          <div className="col-span-12 lg:col-span-5">
            <Reveal>
              <Eyebrow className="mb-5">Run it locally</Eyebrow>
              <h2 className={`text-balance ${H_BIG}`}>The workbench lives with the work.</h2>
            </Reveal>
            <Reveal delay={150}>
              <p className={`mt-5 max-w-[44ch] ${P_BIG}`}>
                Install OpenScience, sign in once, and point it at a project. Sessions and artifacts stay on disk.
                Provider account requests go directly to that provider; Ace requests use Synthetic Sciences and
                OpenRouter.
              </p>
              <div className="mt-7 flex flex-wrap gap-2 text-[13px]">
                {["Your files", "Your keys", "Your environment"].map((item) => (
                  <span key={item} className="border border-border/60 px-3 py-1.5 text-foreground/70">
                    {item}
                  </span>
                ))}
              </div>
            </Reveal>
          </div>
          <Reveal delay={200} className="col-span-12 lg:col-span-7">
            <div className="flex flex-col items-start gap-3 lg:pt-2">
              <CopyChip cmd={NPM_CMD} />
              <CopyChip cmd={CURL_CMD} />
              <a
                href={`${GITHUB}/releases`}
                target="_blank"
                rel="noreferrer"
                className="link-underline mt-3 text-[13.5px] text-foreground/60 hover:text-foreground"
              >
                Binaries on GitHub Releases
              </a>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* -------------------------- OPEN SOURCE ------------------------ */}
      <section id="opensource" className="dither-red relative w-full overflow-hidden border-t border-border/40">
        <div className="dither-content mx-auto w-full max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
          <div className="mx-auto max-w-[900px] text-center">
            <Reveal>
              <Eyebrow className="mb-5 flex justify-center text-foreground/70">Open source</Eyebrow>
              <h2 className={`text-balance ${H_HUGE} text-foreground`}>Inspect the scientist in the loop.</h2>
            </Reveal>
            <Reveal delay={200}>
              <p className={`mx-auto mt-6 max-w-[46ch] ${P_BIG} text-foreground/85`}>
                The prompts, agents, tools, and interfaces are in the repository. Read how a decision gets made, replace
                what does not fit your lab, and keep the full system under your control.
              </p>
            </Reveal>
            <Reveal delay={320}>
              <div className="mt-10 flex flex-col items-center gap-4">
                <Cta href={GITHUB} external>
                  Read the source
                </Cta>
                <span className="font-terminal text-[12.5px] text-foreground/60">
                  github.com/synthetic-sciences/openscience
                </span>
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
              <Eyebrow className="mb-5">FAQ</Eyebrow>
              <h2 className={`text-balance ${H_BIG}`}>Questions.</h2>
            </Reveal>
            <Reveal delay={150}>
              <p className={`mt-5 max-w-[36ch] ${P_BIG}`}>Everything else lives in the docs.</p>
            </Reveal>
          </div>
          <div className="col-span-12 lg:col-span-7">
            <FaqList
              items={[
                {
                  q: "What is OpenScience?",
                  a: "An open-source AI workbench for scientific research. You give it a goal and it works through literature, hypotheses, code, experiments, critique, and a write-up in one local workspace.",
                },
                {
                  q: "How is it different from a coding agent?",
                  a: "It is organized around evidence and the research loop rather than a ticket. The agent plans what would change its mind, runs the analysis, preserves artifacts, and challenges claims before writing them up.",
                },
                {
                  q: "Which models can it use?",
                  a: "Use frontier providers, open-weight models, local models, eligible ChatGPT access, or credit-backed models through OpenRouter. Local, provider-account, and ChatGPT-backed use does not debit the Ace wallet.",
                },
                {
                  q: "Where does my work live?",
                  a: "Sessions and artifacts stay on your machine. BYOK keys remain local and requests go straight to your provider. When Use my data is enabled, OpenScience uploads a redacted complete session trajectory to improve the product.",
                },
                {
                  q: "Do I need Ace to use OpenScience?",
                  a: "No paid plan is required. A free Synthetic Sciences account is required to keep your sessions and settings connected, while local models, BYOK providers, and eligible ChatGPT access remain available without Ace.",
                },
                {
                  q: "What data does OpenScience collect?",
                  a: "The Use my data setting is on for a new connected account. It records the complete trajectory, including prompts, responses, tool activity, and errors. Turn it off anytime in Settings; local session history keeps working.",
                },
                {
                  q: "What if enhanced search is unavailable?",
                  a: "OpenScience uses the free basic-search fallback instead of breaking the research session. Ace can use enhanced search when it is available.",
                },
                {
                  q: "Can it work with my field?",
                  a: "OpenScience loads the tools the task calls for, from scientific search and analysis libraries to domain software and your lab's own interfaces. The workflow stays the same while the tools change with the research.",
                },
                {
                  q: "Can I extend it?",
                  a: "Yes. Add skills, plugins, MCP servers, custom agents and commands, or use the TypeScript SDK to connect a private lab tool.",
                },
                {
                  q: "How do I manage my account?",
                  a: "Open Settings for connected accounts and model access, or use the Synthetic Sciences dashboard for wallet credits, auto-reload, receipts, and devices.",
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
                    Run your first experiment tonight.
                  </h2>
                </Reveal>
              </div>
              <div className="col-span-12 lg:col-span-5">
                <Reveal delay={200}>
                  <p className={`${P_BIG} text-foreground/85 max-w-[38ch]`}>
                    Free and open source. Use your keys, eligible ChatGPT, local models, or optional Ace credits.
                  </p>
                  <div className="mt-8 flex flex-wrap items-center gap-3">
                    <Cta href="#install">Install OpenScience</Cta>
                    <CopyChip cmd={NPM_CMD} />
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
                The open-source AI workbench for scientific research, by Synthetic Sciences.
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
                  <a href="#install" className="link-underline text-foreground/70 hover:text-foreground">
                    Install
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
            {onAnalyticsToggle ? (
              <button
                type="button"
                className="link-underline hover:text-foreground"
                onClick={onAnalyticsToggle}
                aria-pressed={analyticsEnabled}
                title="Website analytics records page activity, never research content"
              >
                Website analytics: {analyticsEnabled ? "on" : "off"}
              </button>
            ) : null}
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
