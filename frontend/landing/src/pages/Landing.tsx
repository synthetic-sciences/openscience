import { useEffect, useState } from "react"
import heroPlate from "@/assets/hero.webp"
import { CONNECTORS } from "@/data/connectors"
import Nav from "@/Nav"

/* OpenScience. CMU Concrete, warm dark, one coral accent.
   The page is deliberately short: the hero says what it is, one panel shows
   the product, three lines say how it works, the sources it can search, why
   it is safe to run, a few questions, and a footer. No decoration that does
   not carry information. */

const H_BIG = "text-[clamp(30px,3.4vw,48px)] leading-[1.06] tracking-[-0.02em]"
const H_MED = "text-[22px] sm:text-[26px] leading-[1.14] tracking-[-0.012em]"
const P = "text-[14px] leading-[1.7] text-foreground/75"
const P_BIG = "text-[16px] sm:text-[17px] leading-[1.7] text-foreground/75"

const GITHUB = "https://github.com/synthetic-sciences/openscience"
const DOCS = "https://github.com/synthetic-sciences/OpenScience#readme"
const RELEASES = `${GITHUB}/releases`

const MODELS = [
  ["5.6 Sol", "OpenAI", "Reasoning"],
  ["5.6 Terra", "OpenAI", "Reasoning"],
  ["Opus 5", "Anthropic", "Reasoning"],
  ["Kimi K3", "Moonshot AI", "Reasoning"],
  ["GLM 5.3", "Z.AI", "Reasoning"],
  ["DeepSeek V4 Flash", "DeepSeek", "General"],
] as const

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

function Hero() {
  return (
    <section className="relative h-screen min-h-[680px] w-full bg-background overflow-hidden grain">
      <div className="absolute inset-0" aria-hidden>
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

        <div className="hero-text mt-auto mb-[5vh] self-end text-right max-w-[820px]">
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

/* One quiet row of institutions. Static: a marquee is motion for its own sake. */
function TrustRow() {
  return (
    <section className="w-full border-t border-border/40 py-10">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col items-center gap-6 px-6 sm:px-10">
        <div className="text-[13px] tracking-[0.04em] text-foreground/45">Used by researchers at</div>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
          {LOGOS.map((logo) => (
            <img
              key={logo.id}
              src={logo.src}
              alt={logo.alt}
              title={logo.alt}
              className="logo-wall-img"
              draggable={false}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

/* Section frame: a top rule, generous vertical space, nothing else. */
function Section({ id, children, className = "" }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className="w-full border-t border-border/40">
      <div className={`mx-auto w-full max-w-[1400px] px-6 py-20 sm:px-10 sm:py-28 ${className}`}>{children}</div>
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

export default function Landing() {
  return (
    <div
      id="top"
      className="min-h-screen bg-background text-foreground antialiased selection:bg-primary/30 selection:text-foreground"
    >
      <Hero />
      <TrustRow />

      <Section id="models">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
          <div className="max-w-[520px]">
            <h2 className={`text-balance ${H_BIG}`}>Model agnostic.</h2>
            <p className={`mt-6 max-w-[40ch] ${P_BIG}`}>
              Use a connected provider, your own API key, or a local model. Switch per session. OpenScience does not
              proxy model traffic.
            </p>
          </div>
          <div className="min-w-0">
            <ModelRouteVisual />
          </div>
        </div>
      </Section>

      <Section id="skills">
        <h2 className={`text-balance ${H_BIG}`}>Plan. Run. Check.</h2>
        <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
          {[
            ["Plan", "Define the method and what would count as a useful result before anything runs."],
            [
              "Run",
              "Use the files, code, terminal, and tools already in the project. Results are saved next to the work.",
            ],
            ["Check", "Check the result against the method and the source material before writing it up."],
          ].map(([title, body]) => (
            <div key={title} className="border-t border-border/60 pt-5">
              <h3 className={H_MED}>{title}</h3>
              <p className={`mt-3 max-w-[38ch] ${P}`}>{body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="sources">
        <div className="mb-10 max-w-[560px]">
          <h2 className={`text-balance ${H_BIG}`}>Search {CONNECTORS.length} scientific sources.</h2>
          <p className={`mt-4 max-w-[52ch] ${P_BIG}`}>
            Papers, structures, variants, compounds, pathways, and expression data, queried directly by the agent.
          </p>
        </div>
        <div className="overflow-hidden border border-border/55">
          <ConnectorWall />
        </div>
      </Section>

      <Section id="local-first">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          <div className="max-w-[560px]">
            <h2 className={`text-balance ${H_BIG}`}>Runs on your computer. Open source.</h2>
            <p className={`mt-6 max-w-[46ch] ${P_BIG}`}>
              There is no hosted control plane. Projects, settings, credentials, and results stay on your device, and
              requests go directly to the services you choose. The agent, skills, tools, and workspace are public under
              Apache 2.0.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Cta href="/download">Download</Cta>
              <Cta href={GITHUB} variant="ghost" external>
                View on GitHub
              </Cta>
            </div>
          </div>
          <div className="divide-y divide-border/50 border-y border-border/50 self-center text-[13px] sm:text-[14px]">
            {[
              ["Projects", "On your device"],
              ["Credentials", "Encrypted locally"],
              ["Providers", "Direct connections"],
              ["License", "Apache 2.0"],
            ].map((item) => (
              <div key={item[0]} className="flex items-center justify-between gap-6 py-3.5">
                <span className="text-foreground/55">{item[0]}</span>
                <span className="text-right text-foreground/85">{item[1]}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section id="faq">
        <div className="grid grid-cols-12 gap-10 lg:gap-16">
          <div className="col-span-12 self-start lg:sticky lg:top-28 lg:col-span-5">
            <h2 className={`text-balance ${H_BIG}`}>Questions.</h2>
            <p className={`mt-4 max-w-[36ch] ${P_BIG}`}>The rest is in the docs.</p>
          </div>
          <div className="col-span-12 lg:col-span-7">
            <FaqList
              items={[
                {
                  q: "What is OpenScience?",
                  a: "A local app for research. Chat, files, terminals, sources, and results are in the same workspace.",
                },
                {
                  q: "How is it different from a coding agent?",
                  a: "It works with papers and datasets as well as code, and saves results inside the project.",
                },
                {
                  q: "Which models can it use?",
                  a: "Connected provider accounts, your own API keys, or local models. OpenScience does not proxy model traffic.",
                },
                {
                  q: "Do I need an account?",
                  a: "No. Install the app, connect only the providers and tools you want, and work locally.",
                },
                {
                  q: "Can I extend it?",
                  a: "Yes. Add skills, plugins, MCP servers, custom agents, and commands. The SDK can connect private lab tools.",
                },
              ]}
            />
          </div>
        </div>
      </Section>

      <footer className="w-full border-t border-border/40">
        <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-6 py-10 text-[13px] text-foreground/55 sm:flex-row sm:items-center sm:justify-between sm:px-10">
          <div className="flex items-center gap-2.5 text-foreground">
            <OsMark size={15} />
            <span className="font-display text-[20px] leading-none tracking-tight">openscience</span>
            <span className="ml-2 text-foreground/45">by Synthetic Sciences · Apache 2.0</span>
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2" aria-label="Footer">
            {[
              ["Docs", DOCS, true],
              ["GitHub", GITHUB, true],
              ["Releases", RELEASES, true],
              ["npm", "https://www.npmjs.com/package/@synsci/openscience", true],
              ["Download", "/download", false],
              ["X", "https://x.com/SynScience", true],
            ].map(([label, href, external]) => (
              <a
                key={label as string}
                href={href as string}
                className="link-underline hover:text-foreground"
                {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {label as string}
              </a>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  )
}
