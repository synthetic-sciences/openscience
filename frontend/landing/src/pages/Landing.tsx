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
   Every content section: Eyebrow, H_BIG, one P_BIG sub, content at mt-14.
   Product moments can break the grid when the interaction benefits. */

const H_HUGE = "text-[clamp(40px,5vw,72px)] leading-[1.02] tracking-[-0.024em]"
const H_BIG = "text-[clamp(30px,3.4vw,48px)] leading-[1.06] tracking-[-0.02em]"
const H_MED = "text-[22px] sm:text-[26px] leading-[1.14] tracking-[-0.012em]"
const P = "text-[14px] leading-[1.7] text-foreground/75"
const P_BIG = "text-[16px] sm:text-[17px] leading-[1.7] text-foreground/75"
const LABEL = "text-[14px] text-muted-foreground"

const GITHUB = "https://github.com/synthetic-sciences/openscience"
const DOCS = "https://openscience.sh/docs"
const APP = "https://app.syntheticsciences.ai"

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
            <Cta href="/download">Download OpenScience</Cta>
            <Cta href={GITHUB} variant="ghost" arrow={false} external>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              Star on GitHub
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
        <span className="text-[12px] text-foreground/45">research-session / working</span>
        <span className="flex items-center gap-2 font-terminal text-[9px] tracking-[0.08em] text-foreground/35">
          <span className="size-1.5 rounded-full bg-[hsl(92,36%,56%)]" /> LOCALHOST
        </span>
      </div>

      <div className="relative min-h-[620px] overflow-hidden bg-background/45 p-4 sm:min-h-[520px] sm:p-6">
        <div className="pointer-events-none absolute inset-0 grid-paper opacity-50" />
        <div className="pointer-events-none absolute left-8 top-9 hidden w-[42%] sm:block">
          <div className="font-terminal text-[9px] tracking-[0.08em] text-foreground/25">CURRENT TASK</div>
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

function LoopVisual() {
  return (
    <Visual label="research session / active">
      <div className="mx-auto w-full max-w-[510px] py-4">
        {["Read the sources", "Frame the claim", "Run the analysis", "Check the result", "Write from evidence"].map(
          (item, index) => (
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
          ),
        )}
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
          <span className="inline-block h-2 w-2 bg-[hsl(var(--accent-coral))]" /> outputs remain in this session
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
        <div className="font-terminal text-[10px] text-foreground/40">check before writing the conclusion</div>
      </div>
    </Visual>
  )
}

function ProjectContextVisual() {
  return (
    <div className="flex h-full flex-col overflow-hidden border border-border/55 bg-[hsl(28,14%,5%)] shadow-[0_30px_90px_-35px_rgba(0,0,0,0.8)]">
      <div className="flex items-center justify-between border-b border-border/55 px-5 py-3.5 sm:px-6">
        <span className="text-[12px] text-foreground/50">project / context</span>
        <span className="flex items-center gap-2 font-terminal text-[9px] tracking-[0.08em] text-foreground/35">
          <span className="size-1.5 rounded-full bg-[hsl(92,36%,56%)]" /> LOCAL
        </span>
      </div>

      <div className="grid min-h-[390px] flex-1 md:grid-cols-[230px_1fr]">
        <div className="border-b border-border/55 bg-background/55 p-5 md:border-b-0 md:border-r sm:p-6">
          <div className="font-terminal text-[9px] tracking-[0.08em] text-foreground/35">LOCAL PROJECT</div>
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
            Files and artifacts stay beside the work.
          </div>
        </div>

        <div className="p-5 sm:p-7">
          <div className="flex flex-col gap-2 border-b border-border/45 pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-[15px] text-foreground/90">Working context</div>
              <div className="mt-1 text-[11px] text-foreground/35">Files, sources, and outputs stay within reach.</div>
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

      {/* ----------------------- RESEARCH LOOP ------------------------- */}
      <section id="how" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid grid-cols-12 items-stretch gap-8 lg:gap-12">
            <Reveal className="col-span-12 lg:col-span-6">
              <div className="dither-warm flex h-full min-h-[440px] flex-col justify-center border border-border/40 p-8 sm:p-12">
                <div className="dither-content">
                  <Eyebrow className="mb-6 text-foreground/70">Research loop</Eyebrow>
                  <h2 className={`text-balance ${H_HUGE} text-foreground`}>Chat is where the work starts.</h2>
                  <p className={`mt-7 max-w-[40ch] ${P_BIG} text-foreground/85`}>
                    Carry the conversation into papers, files, terminals, analyses, and results, all in one local
                    workspace.
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
          eyebrow="From prompt to result"
          title="Plan. Run. Check."
          sub="One research agent works through the method, computation, and evidence with you."
        />
        <div className="mt-16 grid grid-cols-12 gap-px border border-border/40 bg-border/40">
          {[
            {
              visual: <PlanVisual />,
              title: "Plan the work.",
              body: "Turn a broad goal into a testable plan and make the success criteria explicit.",
            },
            {
              visual: <RunVisual />,
              title: "Run in your project.",
              body: "Read files, write code, use the terminal, and inspect the result in the same session.",
            },
            {
              visual: <CritiqueVisual />,
              title: "Check the claim.",
              body: "Look for confounds, leakage, missing controls, and unsupported conclusions before writing.",
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
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-28 sm:px-10 sm:py-40">
          <div className="grid gap-8 lg:grid-cols-2 lg:items-stretch lg:gap-12">
            <Reveal className="dither-red flex min-h-[470px] items-center border border-border/40 p-8 sm:min-h-[520px] sm:p-12 lg:p-14">
              <div className="dither-content max-w-[520px]">
                <Eyebrow className="mb-6 text-foreground/70">Project context</Eyebrow>
                <h2 className={`text-balance ${H_HUGE} text-foreground`}>Everything the work depends on.</h2>
                <p className={`mt-7 max-w-[38ch] ${P_BIG} text-foreground/85`}>
                  Papers, datasets, code, notes, and prior runs stay together in the local workspace.
                </p>
              </div>
            </Reveal>
            <Reveal delay={120} className="min-w-0">
              <ProjectContextVisual />
            </Reveal>
          </div>

          <Reveal delay={220} className="mt-28 sm:mt-36">
            <div className="mb-10 text-center sm:mb-12">
              <Eyebrow className="mb-3">Scientific sources</Eyebrow>
              <h3 className="text-[clamp(24px,2.6vw,36px)] leading-[1.08] tracking-[-0.018em] text-foreground">
                42 scientific sources, searched directly.
              </h3>
              <p className={`mx-auto mt-3 max-w-[52ch] ${P}`}>
                Literature, structures, variants, compounds, pathways, and expression data, inside the same session.
              </p>
            </div>
            <div className="tool-field overflow-hidden border border-border/55 p-5 sm:p-8">
              <ConnectorWall />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ----------------------- MODEL FREEDOM ------------------------- */}
      <section id="models" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-28 sm:px-10 sm:py-40">
          <div className="grid gap-8 lg:grid-cols-2 lg:items-stretch lg:gap-12">
            <Reveal className="dither-purple order-1 flex min-h-[470px] items-center border border-border/40 p-8 sm:min-h-[520px] sm:p-12 lg:order-2 lg:p-14">
              <div className="dither-content max-w-[520px]">
                <Eyebrow className="mb-6 text-foreground/70">Model access</Eyebrow>
                <h2 className={`text-balance ${H_HUGE} text-foreground`}>Use the model the work needs.</h2>
                <p className={`mt-7 max-w-[36ch] ${P_BIG} text-foreground/85`}>
                  Switch between Ace, eligible ChatGPT access, your provider keys, and local models.
                </p>
              </div>
            </Reveal>
            <Reveal delay={120} className="order-2 min-w-0 lg:order-1">
              <ModelRouteVisual />
            </Reveal>
          </div>
        </div>
      </section>

      {/* -------------------------- OPEN SOURCE ------------------------ */}
      <section id="opensource" className="dither-red relative w-full overflow-hidden border-t border-border/40">
        <div className="dither-content mx-auto w-full max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
          <div className="mx-auto max-w-[900px] text-center">
            <Reveal>
              <Eyebrow className="mb-5 flex justify-center text-foreground/70">Open source</Eyebrow>
              <h2 className={`text-balance ${H_HUGE} text-foreground`}>See how the work gets done.</h2>
            </Reveal>
            <Reveal delay={200}>
              <p className={`mx-auto mt-6 max-w-[46ch] ${P_BIG} text-foreground/85`}>
                The agent loop, skills, tools, and workspace are Apache-2.0. Read the code, change the workflow, or
                connect your own tools.
              </p>
            </Reveal>
            <Reveal delay={320}>
              <div className="mt-10 flex flex-col items-center gap-4">
                <Cta href={GITHUB} external>
                  Explore the code
                </Cta>
                <span className="font-terminal text-[12.5px] text-foreground/60">
                  github.com/synthetic-sciences/openscience
                </span>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------ ACE --------------------------- */}
      <Section seed={9} id="ace">
        <div className="grid gap-12 lg:grid-cols-12 lg:items-end lg:gap-16">
          <div className="lg:col-span-7">
            <Reveal>
              <Eyebrow className="mb-5">OpenScience Ace</Eyebrow>
              <h2 className={`max-w-[13ch] text-balance ${H_BIG}`}>Managed models, when you need them.</h2>
            </Reveal>
            <Reveal delay={140}>
              <p className={`mt-5 max-w-[50ch] ${P_BIG}`}>
                Add funds when you want Ace, then pay only for the models and research search you use. OpenScience
                remains free.
              </p>
            </Reveal>
            <Reveal delay={240} className="mt-9">
              <Cta href={`${APP}/billing?checkout=ace`}>Add funds to get Ace</Cta>
            </Reveal>
          </div>

          <Reveal
            delay={180}
            className="border-t border-border/55 pt-8 lg:col-span-5 lg:border-l lg:border-t-0 lg:pl-12 lg:pt-0"
          >
            <div className="text-[13px] text-foreground/55">Start with</div>
            <div className="mt-3 font-display text-[clamp(58px,8vw,94px)] leading-none tracking-[-0.035em]">$20</div>
            <div className="mt-4 text-[14px] text-foreground/70">No monthly charge.</div>
          </Reveal>
        </div>

        <Reveal delay={300} className="mt-16 border-t border-border/55 pt-8 sm:mt-20 sm:pt-10">
          <div className="grid gap-9 sm:grid-cols-3 sm:gap-10 lg:gap-16">
            {[
              ["Models", "Managed access without setting up provider keys."],
              ["Research search", "Search and retrieve sources through Ace."],
              ["Usage", "See every charge in Billing and Usage."],
            ].map((item) => (
              <div key={item[0]}>
                <h3 className="text-[17px] leading-tight text-foreground">{item[0]}</h3>
                <p className="mt-2 text-[14px] leading-6 text-foreground/60">{item[1]}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

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
                  a: "An open-source research workspace with one adaptive agent for literature, files, code, analysis, and writing.",
                },
                {
                  q: "How is it different from a coding agent?",
                  a: "It is organized around research evidence and project context, while still giving the agent access to code, files, and the terminal.",
                },
                {
                  q: "Which models can it use?",
                  a: "Use Ace, eligible ChatGPT access, your provider keys, or local models. Only Ace activity uses the Ace wallet.",
                },
                {
                  q: "Where does my work live?",
                  a: "Sessions and artifacts stay on your machine. BYOK requests go directly to your provider. If Use my data is on, OpenScience sends a credential-redacted research trace to Synthetic Sciences.",
                },
                {
                  q: "Do I need Ace to use OpenScience?",
                  a: "No. A free Synthetic Sciences account is required to connect the installation. Local models, your keys, and eligible ChatGPT access remain separate from Ace.",
                },
                {
                  q: "Can it work with my tools?",
                  a: "Yes. OpenScience can use its built-in scientific sources, code in your project, software in your environment, and MCP or lab tools you configure.",
                },
                {
                  q: "Can I extend it?",
                  a: "Yes. Add skills, plugins, MCP servers, custom agents and commands, or use the SDK to connect a private lab tool.",
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
                    Open your next project in OpenScience.
                  </h2>
                </Reveal>
              </div>
              <div className="col-span-12 lg:col-span-5">
                <Reveal delay={200}>
                  <p className={`${P_BIG} text-foreground/85 max-w-[38ch]`}>
                    Free and open source. Use your keys, eligible ChatGPT, local models, or Ace.
                  </p>
                  <div className="mt-8 flex flex-wrap items-center gap-3">
                    <Cta href="/download">Download OpenScience</Cta>
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
