import { useEffect, useMemo, useRef, useState } from "react";
import workspaceShot from "@/assets/workspace.png";
import modelPickerShot from "@/assets/model-picker.png";
import heroPlate from "@/assets/hero.webp";

/* OpenScience. CMU Concrete, warm dark, coral accents.
   Same design family as the Atlas landing page.

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

const H_HUGE = "text-[clamp(40px,5vw,72px)] leading-[1.02] tracking-[-0.024em]";
const H_BIG = "text-[clamp(30px,3.4vw,48px)] leading-[1.06] tracking-[-0.02em]";
const H_MED = "text-[22px] sm:text-[26px] leading-[1.14] tracking-[-0.012em]";
const P = "text-[14px] leading-[1.7] text-foreground/75";
const P_BIG = "text-[16px] sm:text-[17px] leading-[1.7] text-foreground/75";
const CAPTION = "text-[13px] leading-[1.6] text-foreground/50";
const MONO_N = "font-terminal text-[11px] tracking-[0.08em] text-foreground/40";
const LABEL = "text-[14px] text-muted-foreground";

const GITHUB = "https://github.com/synthetic-sciences/openscience";
const DOCS = "https://syntheticsciences.ai/docs";
const NPM_CMD = "npm i -g @synsci/openscience";
const CURL_CMD = "curl -fsSL https://openscience.sh/install | bash";

/* Eyebrow, the quiet label above every section heading. */
function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[14px] tracking-[0.04em] text-foreground/55 ${className}`}>{children}</div>
  );
}

/* SectionHeader, the one header pattern every content section uses. */
function SectionHeader({
  eyebrow,
  title,
  sub,
  className = "",
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  className?: string;
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
  );
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
  children: React.ReactNode;
  href?: string;
  variant?: "primary" | "ghost";
  arrow?: boolean;
  external?: boolean;
  className?: string;
}) {
  const base =
    "group/cta inline-flex items-center justify-center gap-2.5 h-11 px-6 text-[14px] leading-none select-none";
  const look =
    variant === "primary"
      ? "btn-primary"
      : "border border-foreground/25 text-foreground/90 hover:border-foreground/55 hover:bg-foreground/[0.04] backdrop-blur-[2px] transition-colors duration-300";
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
  );
}

/* CopyChip, a copyable shell command. Click to copy, icon confirms. */
function CopyChip({ cmd, className = "" }: { cmd: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(cmd).catch(() => {});
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
      className={`group/chip inline-flex items-center gap-3 border border-border/70 bg-background/45 backdrop-blur-[3px] pl-4 pr-3 h-11 font-terminal text-[13px] text-foreground/80 hover:border-foreground/35 hover:text-foreground transition-colors duration-300 cursor-pointer max-w-full ${className}`}
      aria-label={`Copy command: ${cmd}`}
    >
      <span className="text-foreground/40 shrink-0">$</span>
      <span className="truncate min-w-0">{cmd}</span>
      <span className="ml-1 text-foreground/40 group-hover/chip:text-foreground/75 transition-colors shrink-0" aria-hidden>
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
  );
}

/* OsMark, the OpenScience mark. A thin ring with an orbiting coral node. */
function OsMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="text-foreground/85">
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1" opacity="0.9" />
      <ellipse cx="8" cy="8" rx="6.6" ry="2.6" stroke="currentColor" strokeWidth="0.8" opacity="0.45" transform="rotate(-24 8 8)" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="13.35" cy="4.6" r="1.5" fill="hsl(var(--accent-coral))" />
    </svg>
  );
}

/* ---------------------------- ASCII backdrop ---------------------------- */

function useAsciiContours(cols: number, rows: number, seed = 1) {
  return useMemo(() => {
    const RAMP = [" ", " ", ".", ".", ",", ":", ";", "-", "~", "+", "=", "o", "0", "#"];
    const peaks = [
      { x: cols * 0.28, y: rows * 0.42, s: cols * 0.22, h: 1.0 },
      { x: cols * 0.72, y: rows * 0.38, s: cols * 0.18, h: 0.85 },
      { x: cols * 0.55, y: rows * 0.82, s: cols * 0.3, h: 0.55 },
    ];
    let out = "";
    for (let y = 0; y < rows; y++) {
      let line = "";
      for (let x = 0; x < cols; x++) {
        let v = 0;
        for (const p of peaks) {
          const dx = (x - p.x) / p.s;
          const dy = ((y - p.y) * 1.9) / p.s;
          v += p.h * Math.exp(-(dx * dx + dy * dy));
        }
        const n = (Math.sin((x * 12.9898 + y * 78.233 + seed) * 0.5) + 1) * 0.04;
        v = Math.max(0, Math.min(0.999, v + n));
        line += RAMP[Math.floor(v * RAMP.length)];
      }
      out += line + "\n";
    }
    return out;
  }, [cols, rows, seed]);
}

function AsciiBackdrop({ seed = 1, opacity = "text-foreground/[0.06]" }: { seed?: number; opacity?: string }) {
  const art = useAsciiContours(220, 80, seed);
  return (
    <pre aria-hidden className={`ascii absolute inset-0 m-0 p-0 text-[10px] leading-[1.05] ${opacity} vignette`}>
      {art}
    </pre>
  );
}

/* ------------------------------- Reveal -------------------------------- */

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
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
  );
}

/* ----------------------------- Section frame ---------------------------- */

function Section({
  children,
  className = "",
  seed = 1,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  seed?: number;
  id?: string;
}) {
  return (
    <section id={id} className="relative w-full overflow-hidden border-t border-border/40">
      <div className="absolute inset-0 graticule opacity-[0.04]" />
      <AsciiBackdrop seed={seed} />
      <div className={`relative z-10 mx-auto max-w-[1400px] w-full px-6 sm:px-10 py-24 sm:py-32 ${className}`}>
        {children}
      </div>
    </section>
  );
}

/* ----------------------------- Hero plate ------------------------------- */
/* The Pharos of Alexandria engraving — the beam sweeps from the tower at the
   right down to a small ship steering by its light at bottom-left. The plate
   is already monochrome warm sepia, the same hue family as the site's cream,
   so it ships unfiltered. Anchored right; on wide viewports the background
   color fills the left edge and the veil blends the seam. */

const HERO_NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

/* Veil: a light uniform scrim softens the plate; a soft top-left shield sits
   under the wordmark and a bottom-right shield under the copy, so the beam
   and the ship at bottom-left stay in view. */
const HERO_VEIL = [
  "linear-gradient(hsl(30 14% 7% / 0.2), hsl(30 14% 7% / 0.2))",
  "radial-gradient(ellipse 55% 45% at 5% 6%, hsl(30 14% 7% / 0.8) 0%, hsl(30 14% 7% / 0.4) 55%, transparent 85%)",
  "radial-gradient(ellipse 85% 75% at 96% 94%, hsl(var(--background)) 0%, hsl(30 14% 7% / 0.84) 38%, hsl(30 14% 7% / 0.28) 66%, transparent 90%)",
  "linear-gradient(180deg, hsl(28 18% 4% / 0.5) 0%, transparent 15%)",
].join(", ");

/* ------------------------------ Hero ----------------------------------- */

function Hero() {
  const backdrop = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);

  /* Gentle parallax: the constellation sinks slower than the page, the
     copy eases away. rAF-throttled, passive, respects reduced motion. */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        if (backdrop.current) backdrop.current.style.transform = `translateY(${y * 0.22}px)`;
        if (copy.current) {
          const t = Math.min(y / 640, 1);
          copy.current.style.opacity = `${1 - t * 0.85}`;
          copy.current.style.transform = `translateY(${y * 0.06}px)`;
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="relative h-screen min-h-[680px] w-full bg-background overflow-hidden grain">
      <div ref={backdrop} className="absolute inset-0 will-change-transform" aria-hidden>
        <div
          className="absolute inset-0 bg-background bg-no-repeat [background-position:62%_14%] [background-size:cover] sm:[background-position:right_center] sm:[background-size:auto_114%]"
          style={{ backgroundImage: `url(${heroPlate})` }}
        />
        <div
          className="absolute inset-0 opacity-[0.32] mix-blend-overlay"
          style={{ backgroundImage: HERO_NOISE }}
        />
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
          <div className="mt-3 text-[13px] tracking-[0.04em] text-foreground/55">by Synthetic Sciences</div>
        </div>

        <div ref={copy} className="hero-text mt-auto mb-[7vh] self-end text-right max-w-[820px]">
          <div className="rise" style={{ animationDelay: "260ms" }}>
            <h1 className="text-balance text-[clamp(34px,4.6vw,62px)] leading-[1.04] tracking-[-0.024em] text-foreground">
              The open-source AI workbench for scientists.
            </h1>
          </div>
          <div className="rise" style={{ animationDelay: "420ms" }}>
            <p className={`mt-6 ml-auto max-w-[44ch] ${P_BIG} text-foreground/85`}>
              One environment for the whole loop: literature, code, experiments, figures,
              and the write-up. In your browser, on any model, with your keys.
            </p>
          </div>
          <div className="rise mt-9 flex flex-wrap items-center justify-end gap-3 [text-shadow:none]" style={{ animationDelay: "580ms" }}>
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
  );
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
  );
}

/* ------------------------- Database marquee strip ----------------------- */

const DATABASES = [
  "arXiv", "bioRxiv", "PubMed", "Europe PMC", "OpenAlex", "Semantic Scholar", "Crossref",
  "UniProt", "RCSB PDB", "PDBe", "AlphaFold DB", "InterPro", "STRING", "IntAct", "SIFTS",
  "Ensembl", "UCSC", "NCBI Gene", "MyGene", "ClinVar", "gnomAD", "dbSNP", "MyVariant", "GTEx",
  "PubChem", "ChEMBL", "ChEBI", "BindingDB", "SureChEMBL", "Guide to Pharmacology",
  "KEGG", "Reactome", "WikiPathways", "GEO", "ArrayExpress", "Expression Atlas",
  "Human Protein Atlas", "Single Cell Atlas", "DepMap", "BioGRID", "Open Targets",
];

function DbMarquee() {
  return (
    <section className="relative w-full overflow-hidden border-t border-border/40 py-14">
      <div className="relative z-10">
        <div className="mb-9 text-center text-[14px] tracking-[0.04em] text-foreground/55">
          Queries the scientific record directly
        </div>
        <div className="marquee-mask overflow-hidden">
          <div className="marquee-track">
            {[0, 1].map((group) => (
              <div className="marquee-group" key={group} aria-hidden={group === 1}>
                {DATABASES.map((name) => (
                  <div key={`${name}-${group}`} className="flex items-center gap-11">
                    <span className="trust-wordmark">{name}</span>
                    <span className="trust-dot" aria-hidden />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ How it works ---------------------------- */

const STEPS: Array<{ n: string; title: string; body: string }> = [
  {
    n: "01",
    title: "Install.",
    body: "One package from npm. The workspace opens in your browser.",
  },
  {
    n: "02",
    title: "Ask.",
    body: "State a goal like you would to a colleague. Plan mode thinks before anything runs.",
  },
  {
    n: "03",
    title: "Run.",
    body: "The agent reads the papers, writes and runs the code, and keeps going. Critique agents attack weak claims along the way.",
  },
  {
    n: "04",
    title: "Read.",
    body: "A write-up with figures and citations, every claim linked to the run that produced it.",
  },
];

/* ------------------------------ Skills data ----------------------------- */

const SKILL_DOMAINS: Array<{ domain: string; count: number; examples: string }> = [
  { domain: "ML training", count: 52, examples: "DeepSpeed, Axolotl, Flash Attention, RL" },
  { domain: "Biology", count: 43, examples: "Biopython, ESM, single cell, clinical imaging" },
  { domain: "Databases", count: 32, examples: "ClinicalTrials, DrugBank, COSMIC, BRENDA" },
  { domain: "LLM tools", count: 31, examples: "DSPy, FAISS, CLIP, tokenizers" },
  { domain: "Chemistry", count: 23, examples: "molecular docking, DiffDock, ADMET, de novo design" },
  { domain: "Physics", count: 23, examples: "astropy, PDE solvers, Bayesian inference" },
  { domain: "Coding", count: 20, examples: "scikit-learn, NetworkX, PyMC, SHAP" },
  { domain: "Writing", count: 10, examples: "LaTeX, citations, venue templates, posters" },
  { domain: "Cloud compute", count: 10, examples: "Modal, Tinker, SkyPilot, Lambda" },
  { domain: "Data engineering", count: 10, examples: "Polars, Dask, Zarr, HDF5" },
  { domain: "ML inference", count: 9, examples: "vLLM, llama.cpp, TensorRT-LLM" },
  { domain: "Research", count: 9, examples: "hypothesis generation, peer review, grants" },
  { domain: "Visualization", count: 8, examples: "Matplotlib, Plotly, protein diagrams" },
  { domain: "Other", count: 6, examples: "lab archives, resource discovery" },
  { domain: "Quantum", count: 4, examples: "Qiskit, PennyLane, Cirq, QuTiP" },
  { domain: "Scholar evaluation", count: 2, examples: "benchmark harnesses" },
  { domain: "Document parsing", count: 1, examples: "PDF extraction" },
];

/* ---------------------------- Databases wall ---------------------------- */

const DB_GROUPS: Array<{ group: string; items: string[] }> = [
  {
    group: "Literature",
    items: ["arXiv", "bioRxiv", "PubMed", "Europe PMC", "OpenAlex", "Semantic Scholar", "Crossref"],
  },
  {
    group: "Proteins & structure",
    items: ["UniProt", "RCSB PDB", "PDBe", "AlphaFold DB", "InterPro", "STRING", "IntAct", "SIFTS"],
  },
  {
    group: "Genomics & variants",
    items: ["Ensembl", "UCSC", "NCBI Gene", "MyGene", "ClinVar", "gnomAD", "dbSNP", "MyVariant", "GTEx"],
  },
  {
    group: "Chemistry",
    items: ["PubChem", "ChEMBL", "ChEBI", "BindingDB", "SureChEMBL", "Guide to Pharmacology"],
  },
  {
    group: "Pathways & omics",
    items: [
      "KEGG", "Reactome", "WikiPathways", "GEO", "ArrayExpress", "Expression Atlas",
      "Human Protein Atlas", "Single Cell Atlas", "DepMap", "BioGRID", "Open Targets",
    ],
  },
];

/* -------------------------------- FAQ ----------------------------------- */

function FaqItem({
  q,
  a,
  isOpen,
  onToggle,
}: {
  q: string;
  a: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
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
  );
}

function FaqList({ items }: { items: Array<{ q: string; a: string }> }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
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
  );
}

/* -------------------------------- Page ---------------------------------- */

export default function Landing() {
  return (
    <div
      id="top"
      className="min-h-screen bg-background text-foreground antialiased selection:bg-primary/30 selection:text-foreground"
    >
      <Hero />

      <ProductShot />

      <DbMarquee />

      {/* --------------------------- HOW IT WORKS ------------------------- */}
      <Section seed={3} id="how">
        <SectionHeader
          eyebrow="How it works"
          title="From goal to write-up."
          sub="You state the goal. The workbench runs the loop."
        />
        <div className="mt-14 grid grid-cols-12 gap-px bg-border/40 border border-border/40">
          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 90} className="col-span-12 sm:col-span-6 xl:col-span-3 bg-background">
              <div className="h-full p-7 sm:p-8 transition-colors duration-500 hover:bg-foreground/[0.02]">
                <div className={MONO_N}>{s.n}</div>
                <h3 className={`mt-3 ${H_MED}`}>{s.title}</h3>
                <p className={`mt-3 max-w-[34ch] ${P}`}>{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ------------------------------ SKILLS ---------------------------- */}
      <Section seed={4} id="skills">
        <div className="grid grid-cols-12 gap-10 lg:gap-16">
          <div className="col-span-12 lg:col-span-4 lg:sticky lg:top-28 self-start">
            <Reveal>
              <Eyebrow className="mb-5">Skills</Eyebrow>
              <h2 className={`text-balance ${H_BIG}`}>Domain-ready on day one.</h2>
            </Reveal>
            <Reveal delay={150}>
              <p className={`mt-5 max-w-[36ch] ${P_BIG}`}>
                293 skills ship with the workbench. Each one teaches the agent a real tool,
                with its actual interface, flags, and failure modes.
              </p>
            </Reveal>
          </div>

          <div className="col-span-12 lg:col-span-8">
            <div className="border-t border-border/40">
              {SKILL_DOMAINS.map((s, i) => (
                <Reveal key={s.domain} delay={Math.min(i * 40, 320)}>
                  <div className="group grid grid-cols-[1fr_auto] sm:grid-cols-[220px_56px_1fr] items-baseline gap-x-6 py-[15px] border-b border-border/40 transition-colors duration-300 hover:bg-foreground/[0.02] px-2 -mx-2">
                    <div className="text-[17px] sm:text-[19px] tracking-[-0.01em] text-foreground/85 group-hover:text-foreground transition-colors duration-300">
                      {s.domain}
                    </div>
                    <div className="font-terminal text-[12px] tabular-nums text-foreground/45 text-right">
                      {s.count}
                    </div>
                    <div className={`col-span-2 sm:col-span-1 mt-1 sm:mt-0 ${CAPTION}`}>{s.examples}</div>
                  </div>
                </Reveal>
              ))}
              <Reveal>
                <div className="flex items-baseline justify-between py-[15px] px-2 -mx-2">
                  <span className={CAPTION}>Loaded when the work calls for them.</span>
                  <span className="font-terminal text-[12px] tabular-nums text-[hsl(var(--accent-coral))]">
                    293 total
                  </span>
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </Section>

      {/* ----------------------------- DATABASES -------------------------- */}
      <Section seed={6} id="databases">
        <SectionHeader
          eyebrow="Databases"
          title="The scientific record, as tools."
          sub="Forty-one databases the agent queries directly. No plugins to write, no glue code to maintain."
        />
        <div className="mt-14 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-px bg-border/40 border border-border/40">
          {DB_GROUPS.map((g, i) => (
            <Reveal
              key={g.group}
              delay={i * 90}
              className={`bg-background ${i === DB_GROUPS.length - 1 ? "sm:col-span-2 lg:col-span-1" : ""}`}
            >
              <div className="h-full px-6 py-7 transition-colors duration-500 hover:bg-foreground/[0.02]">
                <div className="text-[13px] tracking-[0.04em] text-foreground/45">{g.group}</div>
                <ul className="mt-4 space-y-2">
                  {g.items.map((it) => (
                    <li
                      key={it}
                      className="font-terminal text-[12.5px] text-foreground/70 hover:text-foreground transition-colors duration-200"
                    >
                      {it}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ------------------------------ MODELS ---------------------------- */}
      <Section seed={5} id="models">
        <div className="grid grid-cols-12 gap-10 lg:gap-16 items-center">
          <div className="col-span-12 lg:col-span-5">
            <Reveal>
              <Eyebrow className="mb-5">Models</Eyebrow>
              <h2 className={`text-balance ${H_BIG}`}>Any model. Your keys.</h2>
            </Reveal>
            <Reveal delay={150}>
              <p className={`mt-5 max-w-[44ch] ${P_BIG}`}>
                Anthropic, OpenAI, Google, and open-weight models through one selector.
                Requests go straight to the provider, and keys never leave your machine.
              </p>
            </Reveal>
            <Reveal delay={260}>
              <div className="mt-7 flex flex-wrap gap-2 text-[13px]">
                {["No account required", "Local models via Ollama", "Switch mid-project"].map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center px-3 py-1.5 border border-border/60 bg-background/40 backdrop-blur-[2px] text-foreground/70"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </Reveal>
          </div>
          <Reveal delay={150} className="col-span-12 lg:col-span-7">
            <div className="lg:ml-auto lg:max-w-[560px]">
              <div className="border border-border/50 bg-[hsl(28,14%,6%)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.75)]">
                <img
                  src={modelPickerShot}
                  alt="The OpenScience model selector: Anthropic, OpenAI, and Google models with live pricing and an effort control"
                  className="block w-full h-auto select-none"
                  draggable={false}
                />
              </div>
              <div className={`mt-5 flex items-center justify-between gap-4 ${CAPTION}`}>
                <span>The model selector, with live pricing per provider.</span>
              </div>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ---------------- OPEN SOURCE (red dither, centered) --------------- */}
      <section id="opensource" className="relative w-full overflow-hidden border-t border-border/40 dither-red">
        <div className="dither-content mx-auto max-w-[1400px] w-full px-6 sm:px-10 py-28 sm:py-36">
          <div className="max-w-[900px] mx-auto text-center">
            <Reveal>
              <Eyebrow className="justify-center flex mb-5 text-foreground/70">Open source</Eyebrow>
              <h2 className={`text-balance ${H_HUGE} text-foreground`}>Built to be read.</h2>
            </Reveal>
            <Reveal delay={200}>
              <p className={`mt-6 mx-auto max-w-[46ch] ${P_BIG} text-foreground/85`}>
                Apache 2.0, no strings. Every prompt, agent, and connector is in the repo,
                and the whole workbench runs on your machine. Read what it does, then
                change it.
              </p>
            </Reveal>
            <Reveal delay={320}>
              <div className="mt-10 flex flex-col items-center gap-4">
                <Cta href={GITHUB} external>Star on GitHub</Cta>
                <span className="font-terminal text-[12.5px] text-foreground/60">
                  github.com/synthetic-sciences/openscience
                </span>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ----------------------------- INSTALL ----------------------------- */}
      <Section seed={8} id="install">
        <div className="grid grid-cols-12 gap-10 lg:gap-16 items-start">
          <div className="col-span-12 lg:col-span-5">
            <Reveal>
              <Eyebrow className="mb-5">Install</Eyebrow>
              <h2 className={`text-balance ${H_BIG}`}>Up and running in a minute.</h2>
            </Reveal>
            <Reveal delay={150}>
              <p className={`mt-5 max-w-[44ch] ${P_BIG}`}>
                Install with npm or the install script. Set a provider key, and the
                workspace opens in your browser.
              </p>
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

      {/* ------------------------------- FAQ ------------------------------- */}
      <Section seed={7} id="faq">
        <div className="grid grid-cols-12 gap-10 lg:gap-16">
          <div className="col-span-12 lg:col-span-5 lg:sticky lg:top-28 self-start">
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
                  a: "An open-source AI workbench for scientific research. You give it a goal and it works the loop: literature, hypothesis, code, experiments, write-up. It runs as a local workspace in your browser and does real work in ML, biology, physics, and chemistry.",
                },
                {
                  q: "Is it free?",
                  a: "Yes. Apache 2.0, free forever with your own API keys. No account, no meter. You pay your model provider directly and nothing else.",
                },
                {
                  q: "Which models can it use?",
                  a: "Anthropic, OpenAI, Google, and dozens of other providers, plus local open-weight models. Models are routed per request, so you can switch mid-project without changing anything else.",
                },
                {
                  q: "Where does my work live?",
                  a: "On your machine. Sessions and artifacts are stored on disk, keys stay local, and requests go straight to the provider. Nothing is uploaded unless you share it.",
                },
                {
                  q: "How is it different from a coding agent?",
                  a: "It is built around the research loop rather than the ticket. A research harness with specialist agents and a critique pass, forty-one scientific databases as tools, 293 skills, and a workspace that renders molecules, genomes, and plots inline.",
                },
                {
                  q: "Can I extend it?",
                  a: "Yes. Skills, plugins, MCP servers, custom agents and commands, LSP integration, and a TypeScript SDK. If your lab has a private tool, the agent can learn it.",
                },
                {
                  q: "What is Atlas?",
                  a: "Synthetic Sciences' managed platform: curated frontier models billed from one wallet, a persistent research graph, and cloud compute. OpenScience works with Atlas but never requires it.",
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
                    Free and open source. The whole loop, on your keys.
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
                <li><a href={GITHUB} target="_blank" rel="noreferrer" className="link-underline text-foreground/70 hover:text-foreground">GitHub</a></li>
                <li><a href="https://www.npmjs.com/package/@synsci/openscience" target="_blank" rel="noreferrer" className="link-underline text-foreground/70 hover:text-foreground">npm</a></li>
                <li><a href={`${GITHUB}/releases`} target="_blank" rel="noreferrer" className="link-underline text-foreground/70 hover:text-foreground">Releases</a></li>
              </ul>
            </div>
            <div className="col-span-6 sm:col-span-4 md:col-span-2">
              <div className="text-[13px] tracking-[0.04em] text-foreground/45 mb-4">Resources</div>
              <ul className="space-y-2.5 text-[13.5px]">
                <li><a href={DOCS} target="_blank" rel="noreferrer" className="link-underline text-foreground/70 hover:text-foreground">Docs</a></li>
                <li><a href="#skills" className="link-underline text-foreground/70 hover:text-foreground">Skills</a></li>
                <li><a href="#install" className="link-underline text-foreground/70 hover:text-foreground">Install</a></li>
                <li><a href="#faq" className="link-underline text-foreground/70 hover:text-foreground">FAQ</a></li>
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
                    href="https://app.syntheticsciences.ai"
                    className="link-underline text-foreground/70 hover:text-foreground inline-flex items-center gap-1.5"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Atlas
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                      <path d="M2 8 L8 2 M4 2 L8 2 L8 6" stroke="currentColor" fill="none" />
                    </svg>
                  </a>
                </li>
                <li><a href="https://x.com/SynScience" target="_blank" rel="noreferrer" className="link-underline text-foreground/70 hover:text-foreground">X / Twitter</a></li>
              </ul>
            </div>
          </div>

          <div className="mt-14 pt-6 border-t border-border/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-[12.5px] text-foreground/45">
            <div>&copy; {new Date().getFullYear()} InkVell Inc. OpenScience is a Synthetic Sciences project. Apache 2.0.</div>
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
  );
}
