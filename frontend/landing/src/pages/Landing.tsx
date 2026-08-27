import { useEffect, useMemo, useRef, useState } from "react"
import workspaceShot from "@/assets/workspace.png"
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
   Every content section: Eyebrow, H_BIG, one P_BIG sub, content at mt-14.
   Product moments can break the grid when the interaction benefits. */

const H_HUGE = "text-[clamp(40px,5vw,72px)] leading-[1.02] tracking-[-0.024em]"
const H_BIG = "text-[clamp(30px,3.4vw,48px)] leading-[1.06] tracking-[-0.02em]"
const H_MED = "text-[22px] sm:text-[26px] leading-[1.14] tracking-[-0.012em]"
const P = "text-[14px] leading-[1.7] text-foreground/75"
const P_BIG = "text-[16px] sm:text-[17px] leading-[1.7] text-foreground/75"
const CAPTION = "text-[13px] leading-[1.6] text-foreground/50"
const LABEL = "text-[14px] text-muted-foreground"

const GITHUB = "https://github.com/synthetic-sciences/openscience"
const DOCS = "https://openscience.sh/docs"
const APP = "https://app.syntheticsciences.ai"
const NPM_CMD = "npm i -g @synsci/openscience"
const CURL_CMD = "curl -fsSL https://openscience.sh/install | bash"
const RELEASE = `${GITHUB}/releases/latest/download`

const DOWNLOADS = {
  "mac-arm64": {
    platform: "mac",
    label: "macOS",
    detail: "Apple Silicon",
    file: "openscience-darwin-arm64.zip",
  },
  "mac-x64": {
    platform: "mac",
    label: "macOS",
    detail: "Intel",
    file: "openscience-darwin-x64.zip",
  },
  "windows-x64": {
    platform: "windows",
    label: "Windows",
    detail: "64-bit",
    file: "openscience-windows-x64.zip",
  },
  "linux-x64": {
    platform: "linux",
    label: "Linux",
    detail: "x86_64",
    file: "openscience-linux-x64.tar.gz",
  },
  "linux-arm64": {
    platform: "linux",
    label: "Linux",
    detail: "ARM64",
    file: "openscience-linux-arm64.tar.gz",
  },
} as const

type Target = keyof typeof DOWNLOADS
type Platform = (typeof DOWNLOADS)[Target]["platform"]

const PLATFORMS = [
  { id: "mac", label: "macOS", target: "mac-arm64" },
  { id: "windows", label: "Windows", target: "windows-x64" },
  { id: "linux", label: "Linux", target: "linux-x64" },
] as const

const MODELS = [
  ["5.6 Sol", "OpenAI", "Reasoning"],
  ["5.6 Terra", "OpenAI", "Reasoning"],
  ["Opus 5", "Anthropic", "Reasoning"],
  ["Kimi K3", "Moonshot AI", "Reasoning"],
  ["GLM 5.3", "Z.AI", "Reasoning"],
  ["DeepSeek V4 Flash", "DeepSeek", "General"],
] as const

const TOOLS = [
  "AiZynthFinder",
  "AlphaFold2",
  "AlphaFold2-Multimer",
  "AutoDock Vina",
  "Biopython",
  "Boltz-2",
  "Cantera",
  "cclib",
  "cctbx_project",
  "chemdataextractor2",
  "Chemprop",
  "ChemPy",
  "CREST",
  "DeepChem",
  "DiffDock",
  "ESM-2",
  "ESMFold",
  "Evo 2",
  "Gemmi",
  "GenMol",
  "GoodVibes",
  "hplc-py",
  "lmfit-py",
  "Marker",
  "matchms",
  "Matplotlib",
  "molmass",
  "MolMM",
  "Mordred",
  "MSA Search",
  "nmrglue",
  "NWChem",
  "Open Babel",
  "OpenFold2",
  "OpenFold3",
  "OpenMM",
  "OpenMS",
  "paper-qa",
  "ProteinMPNN",
  "Psi4",
  "PubChemPy",
  "PyAlex",
  "pybaselines",
  "pymatgen",
  "PySCF",
  "Pyteomics",
  "RDKit",
  "RFdiffusion",
  "scikit-learn",
  "SciPy",
  "statsmodels",
  "Syntheseus",
  "thermo",
  "xtb",
] as const

// Compact canonical project and maker marks. They stay inline so the wall never
// depends on a third-party request at runtime.
const MARKS = {
  alphafold:
    "M15 38.438c0-3.526.725-6.25 2.175-8.175S19.563 26.25 22.988 24c-2.45-2.25-4.4-4.338-5.85-6.263-1.45-1.925-2.175-4.65-2.175-8.175v-.45c0-.2.062-.362.187-.487s.288-.188.488-.188.362.063.487.188.188.287.188.487v.45c0 .525.012 1.013.037 1.463s.075.887.15 1.312h14.963c.075-.425.125-.862.15-1.312.05-.45.075-.938.075-1.463v-.45c0-.2.062-.362.187-.487s.275-.188.45-.188c.2 0 .363.063.488.188s.187.287.187.487v.45c0 3.525-.725 6.25-2.175 8.175S27.438 21.75 25.013 24c2.425 2.225 4.362 4.313 5.812 6.263S33 34.913 33 38.438v.45c0 .2-.063.362-.188.487s-.287.188-.487.188c-.175 0-.325-.063-.45-.188s-.188-.287-.188-.487v-.45c0-.525-.025-1.013-.075-1.463-.025-.45-.075-.888-.15-1.313H16.538c-.075.425-.138.863-.188 1.313-.025.45-.037.938-.037 1.463v.45c0 .2-.063.362-.188.487s-.275.188-.45.188c-.2 0-.362-.063-.487-.188S15 39.088 15 38.888v-.45ZM18.975 18h10.05c.475-.65.9-1.325 1.275-2.025s.675-1.463.9-2.288H16.8c.225.825.512 1.588.862 2.288.375.7.813 1.375 1.313 2.025ZM24 23.1c.75-.675 1.45-1.313 2.1-1.913.65-.625 1.25-1.25 1.8-1.875h-7.838c.55.625 1.15 1.25 1.8 1.875.675.625 1.388 1.263 2.138 1.913Zm-3.9 5.588h7.8c-.55-.625-1.15-1.238-1.8-1.838-.65-.625-1.35-1.275-2.1-1.95-.75.675-1.45 1.325-2.1 1.95-.65.6-1.25 1.213-1.8 1.838Zm-3.263 5.624H31.2c-.25-.825-.55-1.587-.9-2.287s-.775-1.375-1.275-2.025h-10.05c-.5.65-.938 1.325-1.313 2.025-.35.7-.625 1.462-.825 2.287Z",
  python:
    "M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z",
  nvidia:
    "M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z",
  meta: "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973.14.604.35 1.145.636 1.621.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.942-1.664.183.3 2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843C23.624 17.993 24 16.444 24 14.41c0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.9 44.9 0 0 0-1.255-1.98c1.19-1.85 2.218-2.929 3.568-2.929zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.8-1.21 1.67-1.818 2.621-1.818z",
  pytorch:
    "M12.005 0 4.952 7.053a9.865 9.865 0 0 0 0 14.022 9.866 9.866 0 0 0 14.022 0c3.984-3.9 3.986-10.205.085-14.023l-1.744 1.743c2.904 2.905 2.904 7.634 0 10.538s-7.634 2.904-10.538 0-2.904-7.634 0-10.538l4.647-4.646.582-.665zm3.568 3.899a1.327 1.327 0 1 0 0 2.655 1.327 1.327 0 0 0 0-2.655z",
  scipy:
    "M15.697 13.496c-.784-1.072-1.982-1.519-3.694-1.88l-1.592-.375-1.201-.515c-.631-.446-1.17-1.634-1.017-2.681a3 3 0 0 1 3.386-2.526 2.962 2.962 0 0 1 1.962 1.155L15.35 9.05c1.033 1.33 2.195 1.727 3.459 1.098l.637-.27a.22.22 0 0 1 .278.087l.127.19c.097.145.3.18.486.073l1.467-1.384c.257-.22.182-.422.182-.422l-.354-.806s-.097-.193-.431-.149l-1.968.181a.327.327 0 0 0-.27.411l.071.227a.219.219 0 0 1-.129.273l-.556.235c-.582.341-1.244.123-1.686-.417l-1.943-2.58a4.421 4.421 0 0 0-2.929-1.72C9.355 3.733 7.095 5.42 6.741 7.84c-.179 1.22.187 2.375.855 3.302.485.674 1.373 1.06 1.854 1.18l2.47.637c.166.04.634.155.91.255.256.092.845.31 1.324.701.572.582.875 1.413.746 2.284a2.744 2.744 0 0 1-4.897 1.255l-1.726-2.292a2.304 2.304 0 0 0-3.222-.451l-3.632 2.71A11.002 11.002 0 0 1 0 12C0 5.798 5.133.768 11.465.768c4.715 0 8.761 2.788 10.523 6.77l.581-.27.393-1.072.411.144-.353.96.98.337-.148.402-1.095-.382-.603.277c.5 1.262.778 2.632.778 4.066 0 6.203-5.135 11.232-11.467 11.232a11.526 11.526 0 0 1-9.26-4.61l3.721-2.788a.855.855 0 0 1 1.163.19l1.826 2.455a4.186 4.186 0 0 0 2.673 1.502c2.302.322 4.439-1.273 4.773-3.563a4.14 4.14 0 0 0-.664-2.922",
} as const

const TOOL_MARKS = {
  AlphaFold2: "alphafold",
  "AlphaFold2-Multimer": "alphafold",
  "MSA Search": "nvidia",
  SciPy: "scipy",
} as const

const PROTEIN = new Set<string>([
  "AlphaFold2",
  "AlphaFold2-Multimer",
  "Biopython",
  "Boltz-2",
  "DeepChem",
  "DiffDock",
  "ESM-2",
  "ESMFold",
  "Evo 2",
  "GenMol",
  "MolMM",
  "MSA Search",
  "OpenFold2",
  "OpenFold3",
  "ProteinMPNN",
  "RFdiffusion",
])
const CHEMISTRY = new Set<string>([
  "AiZynthFinder",
  "AutoDock Vina",
  "Cantera",
  "cclib",
  "cctbx_project",
  "chemdataextractor2",
  "Chemprop",
  "CREST",
  "GoodVibes",
  "NWChem",
  "Open Babel",
  "OpenMM",
  "Psi4",
  "RDKit",
  "xtb",
])
const DATA = new Set<string>(["Gemmi", "Marker", "Matplotlib", "OpenMS", "scikit-learn", "Syntheseus"])

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

function PlatformMark({ platform }: { platform: Platform }) {
  if (platform === "mac") {
    return (
      <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
        <rect x="3.5" y="4.5" width="17" height="11" rx="1" stroke="currentColor" />
        <path d="M8 19.5h8M10 15.5v4m4-4v4" stroke="currentColor" />
      </svg>
    )
  }
  if (platform === "windows") {
    return (
      <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
        <path
          d="m3.5 5.25 7.2-.95v7.15H3.5v-6.2Zm8.45-1.12 8.55-1.12v8.44h-8.55V4.13ZM3.5 12.7h7.2v7.15l-7.2-.96V12.7Zm8.45 0h8.55v8.43l-8.55-1.12V12.7Z"
          stroke="currentColor"
        />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
      <path
        d="M7 17.5c0-2.7 2.25-4.5 5-4.5s5 1.8 5 4.5M9 8.5C9 6.57 10.34 5 12 5s3 1.57 3 3.5S13.66 12 12 12 9 10.43 9 8.5Z"
        stroke="currentColor"
      />
      <path d="m7.5 16-2 3m11-3 2 3M9.25 7.5 7.5 5m7.25 2.5L16.5 5" stroke="currentColor" />
    </svg>
  )
}

function DownloadSection() {
  const [target, setTarget] = useState<Target>("mac-arm64")

  useEffect(() => {
    const agent = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
    if (agent.includes("win")) return setTarget("windows-x64")
    const platform = agent.includes("linux") || agent.includes("x11") ? "linux" : "mac"
    const arm = /arm64|aarch64/.test(agent)
    setTarget(platform === "linux" ? (arm ? "linux-arm64" : "linux-x64") : "mac-arm64")

    const data = (
      navigator as Navigator & {
        userAgentData?: { getHighEntropyValues: (hints: string[]) => Promise<{ architecture?: string }> }
      }
    ).userAgentData
    if (!data?.getHighEntropyValues) return

    void data.getHighEntropyValues(["architecture"]).then(
      (value) => {
        const architecture = value.architecture?.toLowerCase()
        if (!architecture) return
        const hinted = architecture.includes("arm")
        setTarget(platform === "linux" ? (hinted ? "linux-arm64" : "linux-x64") : hinted ? "mac-arm64" : "mac-x64")
      },
      () => undefined,
    )
  }, [])

  const download = DOWNLOADS[target]
  const options = (Object.keys(DOWNLOADS) as Target[]).filter((item) => DOWNLOADS[item].platform === download.platform)

  return (
    <section id="install" className="relative w-full overflow-hidden border-t border-border/40">
      <div className="absolute inset-0 graticule opacity-[0.035]" />
      <div className="relative z-10 mx-auto w-full max-w-[1120px] px-6 py-20 sm:px-10 sm:py-24">
        <Reveal>
          <div className="text-center">
            <Eyebrow className="mb-5">The current release</Eyebrow>
            <h2 className={`text-balance ${H_HUGE}`}>Download OpenScience.</h2>
            <p className={`mx-auto mt-5 max-w-[45ch] ${P_BIG}`}>Your research workspace, on your computer.</p>
          </div>
        </Reveal>

        <Reveal delay={150}>
          <div className="mx-auto mt-9 flex max-w-[540px] flex-col items-center">
            <a
              href={`${RELEASE}/${download.file}`}
              className="btn-primary inline-flex min-h-14 w-full items-center justify-center gap-3 px-7 text-[16px] sm:min-w-[460px]"
              aria-label={`Download OpenScience for ${download.label}, ${download.detail}`}
            >
              <svg width="15" height="16" viewBox="0 0 15 16" fill="none" aria-hidden>
                <path d="M7.5 1v9m0 0L11 6.5M7.5 10 4 6.5M1 14.5h13" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              Download for {download.label} ({download.detail})
            </a>
            <span className={`mt-3 ${CAPTION}`}>Latest release · free and open source</span>
          </div>
        </Reveal>

        <Reveal delay={220}>
          <div className="mx-auto mt-12 max-w-[920px]">
            <div
              className="grid grid-cols-3 gap-px border border-border/55 bg-border/55"
              aria-label="Choose your operating system"
            >
              {PLATFORMS.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setTarget(item.target)}
                  className={`flex min-h-14 items-center justify-center gap-2.5 bg-background px-3 text-[13px] transition-colors duration-300 ${
                    item.id === download.platform
                      ? "bg-foreground/[0.08] text-foreground"
                      : "text-foreground/45 hover:bg-foreground/[0.035] hover:text-foreground/75"
                  }`}
                  aria-pressed={item.id === download.platform}
                >
                  <PlatformMark platform={item.id} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>

            <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2">
              {options.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setTarget(item)}
                  className={`relative flex min-h-11 items-center px-2 text-[12.5px] transition-colors ${
                    item === target
                      ? "text-foreground after:absolute after:inset-x-0 after:-bottom-0.5 after:h-px after:bg-[hsl(var(--accent-coral))]"
                      : "text-foreground/55 hover:text-foreground/80"
                  }`}
                  aria-pressed={item === target}
                >
                  {DOWNLOADS[item].detail}
                </button>
              ))}
            </div>

            <div
              id="terminal"
              className="mt-7 grid border border-border/55 bg-background/75 lg:grid-cols-[0.75fr_1.25fr]"
            >
              <div className="border-b border-border/55 p-6 text-left lg:border-b-0 lg:border-r sm:p-8">
                <Eyebrow className="mb-4">Command line</Eyebrow>
                <h3 className={H_MED}>Prefer the terminal?</h3>
                <p className={`mt-3 max-w-[32ch] ${P}`}>Install once, then run OpenScience from any project.</p>
                <a
                  href={`${GITHUB}/releases`}
                  target="_blank"
                  rel="noreferrer"
                  className="link-underline mt-5 inline-block text-[12.5px] text-foreground/45 hover:text-foreground"
                >
                  All releases
                </a>
              </div>
              <div className="flex flex-col justify-center gap-3 p-6 sm:p-8">
                <CopyChip cmd={NPM_CMD} className="w-full justify-start" />
                <CopyChip cmd={CURL_CMD} className="w-full justify-start" />
              </div>
            </div>
          </div>
        </Reveal>
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
    <div className="model-stage overflow-hidden border border-border/55 bg-[hsl(28,14%,5%)] shadow-[0_30px_90px_-30px_rgba(0,0,0,0.75)]">
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

function ProjectContextVisual() {
  return (
    <div className="overflow-hidden border border-border/55 bg-[hsl(28,14%,5%)] shadow-[0_30px_90px_-35px_rgba(0,0,0,0.8)]">
      <div className="flex items-center justify-between border-b border-border/55 px-5 py-3.5 sm:px-6">
        <span className="text-[12px] text-foreground/50">project / context</span>
        <span className="flex items-center gap-2 font-terminal text-[9px] tracking-[0.08em] text-foreground/35">
          <span className="size-1.5 rounded-full bg-[hsl(92,36%,56%)]" /> INDEXED
        </span>
      </div>

      <div className="grid min-h-[390px] md:grid-cols-[230px_1fr]">
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
              <div className="mt-1 text-[11px] text-foreground/35">Evidence stays linked from source to claim.</div>
            </div>
            <span className="font-terminal text-[9px] tracking-[0.06em] text-foreground/35">
              6 SOURCES · 3 ARTIFACTS
            </span>
          </div>

          <div className="mt-3">
            {[
              ["PAPER", "held-out-cohort.pdf", "cited in manuscript.md", "12 passages"],
              ["DATA", "study.csv", "used by analysis.ipynb", "2.4 MB"],
              ["RUN", "model-summary.csv", "supports result §3", "verified"],
              ["NOTE", "lab-notes.md", "linked to methods", "local"],
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

function ToolLogo({ tool }: { tool: string }) {
  const brand = TOOL_MARKS[tool as keyof typeof TOOL_MARKS]
  if (brand) {
    return (
      <span className="tool-logo" data-logo={brand} aria-hidden>
        <svg viewBox={brand === "alphafold" ? "0 0 48 48" : "0 0 24 24"} className="size-[19px]" fill="currentColor">
          <path d={MARKS[brand]} />
        </svg>
      </span>
    )
  }

  const kind = PROTEIN.has(tool) ? "protein" : CHEMISTRY.has(tool) ? "chemistry" : DATA.has(tool) ? "data" : "atom"

  if (kind === "protein") {
    return (
      <span className="tool-logo" data-logo={kind} aria-hidden>
        <svg viewBox="0 0 24 24" className="size-5" fill="none">
          <path d="M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9" stroke="currentColor" />
          <path d="M8.8 6h6.4M8.4 12h7.2M8.8 18h6.4" stroke="currentColor" opacity=".55" />
        </svg>
      </span>
    )
  }

  if (kind === "chemistry") {
    return (
      <span className="tool-logo" data-logo={kind} aria-hidden>
        <svg viewBox="0 0 24 24" className="size-5" fill="none">
          <path
            d="M9 3h6M10 3v6l-5.2 8.6A2.2 2.2 0 0 0 6.7 21h10.6a2.2 2.2 0 0 0 1.9-3.4L14 9V3"
            stroke="currentColor"
          />
          <path d="M7.7 16h8.6" stroke="currentColor" opacity=".55" />
          <circle cx="10" cy="13.5" r=".8" fill="currentColor" />
        </svg>
      </span>
    )
  }

  if (kind === "data") {
    return (
      <span className="tool-logo" data-logo={kind} aria-hidden>
        <svg viewBox="0 0 24 24" className="size-5" fill="none">
          <path d="M4 19h16M6 16l3-4 3 2 5-7 2 2" stroke="currentColor" />
          <circle cx="9" cy="12" r="1" fill="currentColor" />
          <circle cx="17" cy="7" r="1" fill="currentColor" />
        </svg>
      </span>
    )
  }

  return (
    <span className="tool-logo" data-logo={kind} aria-hidden>
      <svg viewBox="0 0 24 24" className="size-5" fill="none">
        <circle cx="12" cy="12" r="2" fill="currentColor" />
        <ellipse cx="12" cy="12" rx="9" ry="4" stroke="currentColor" />
        <ellipse cx="12" cy="12" rx="9" ry="4" stroke="currentColor" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="4" stroke="currentColor" transform="rotate(120 12 12)" />
      </svg>
    </span>
  )
}

function ToolWall() {
  return (
    <ul className="tool-wall grid grid-cols-2 gap-px bg-border/45 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {TOOLS.map((tool) => (
        <li
          key={tool}
          title={tool}
          className="group relative flex min-h-[58px] min-w-0 items-center gap-2.5 overflow-hidden bg-[hsl(28,14%,7%)] px-3 py-3 text-[10.5px] text-foreground/60 transition-colors duration-300 hover:bg-foreground/[0.065] hover:text-foreground sm:px-4 sm:py-3.5 sm:text-[11.5px]"
        >
          <ToolLogo tool={tool} />
          <span className="min-w-0 break-words leading-[1.35] [overflow-wrap:anywhere]">{tool}</span>
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

      <DownloadSection />

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
          <SectionHeader
            eyebrow="Research context"
            title="The project is the context."
            sub="Papers, data, code, notes, and prior runs stay linked from source to result."
          />

          <Reveal delay={140} className="mt-14">
            <ProjectContextVisual />
          </Reveal>

          <Reveal delay={220} className="mt-20">
            <div className="tool-field overflow-hidden border border-border/55 p-5 sm:p-8">
              <div className="mb-8 text-center">
                <Eyebrow className="mb-3">Scientific tools</Eyebrow>
                <h3 className="text-[clamp(24px,2.6vw,36px)] leading-[1.08] tracking-[-0.018em] text-foreground">
                  54 tools. Ready when the task calls.
                </h3>
                <p className={`mx-auto mt-3 max-w-[40ch] ${P}`}>
                  The research stack, available from the same workspace.
                </p>
              </div>
              <ToolWall />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ----------------------- MODEL FREEDOM ------------------------- */}
      <section id="models" className="relative w-full overflow-hidden border-t border-border/40">
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-24 sm:px-10 sm:py-32">
          <SectionHeader
            eyebrow="Model freedom"
            title="Pick the right model."
            sub="One selector. Every model you connect."
          />
          <Reveal delay={150} className="mt-14">
            <ModelRouteVisual />
          </Reveal>
          <Reveal delay={220}>
            <p className={`mt-5 ${CAPTION}`}>Ace · eligible ChatGPT access · your provider keys · local models</p>
          </Reveal>
        </div>
      </section>

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

      {/* ------------------------------ ACE --------------------------- */}
      <Section seed={9} id="ace">
        <SectionHeader
          eyebrow="OpenScience Ace"
          title="Add $20. Use it when you need it."
          sub="OpenScience and your account are free. Ace is pay as you go, with no fixed monthly charge."
        />

        <Reveal delay={160} className="mt-14">
          <div className="grid gap-px border border-border/55 bg-border/55 lg:grid-cols-[0.8fr_1.2fr]">
            <div className="bg-background p-7 sm:p-10">
              <div className={LABEL}>Starting balance</div>
              <div className="mt-5 font-display text-[clamp(50px,7vw,78px)] leading-none tracking-[-0.03em]">$20</div>
              <div className={`mt-4 ${CAPTION}`}>20 credits of purchased balance · 1 credit = $1</div>
              <div className="mt-8 w-fit border border-border/70 px-3 py-1.5 font-terminal text-[10px] tracking-[0.08em] text-foreground/55">
                PAY AS YOU GO
              </div>
            </div>
            <div className="flex flex-col bg-background p-7 sm:p-10">
              <div className="divide-y divide-border/45 border-y border-border/45">
                {[
                  "Models and enhanced research search",
                  "Every charge in Billing and Usage",
                  "Local models, your own keys, and eligible ChatGPT access stay separate",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-3 py-4 text-[14px] text-foreground/75">
                    <span className="text-[hsl(var(--accent-coral))]">✓</span>
                    {item}
                  </div>
                ))}
              </div>
              <div className="mt-8">
                <Cta href={`${APP}/billing`}>Open billing</Cta>
              </div>
            </div>
          </div>
          <p className={`mt-4 max-w-[64ch] ${CAPTION}`}>
            Any processing fee is shown before payment. Your remaining balance stays available.
          </p>
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
                  a: "An open-source AI workbench for scientific research. You give it a goal and it works through literature, hypotheses, code, experiments, critique, and a write-up in one local workspace.",
                },
                {
                  q: "How is it different from a coding agent?",
                  a: "It is organized around evidence and the research loop rather than a ticket. The agent plans what would change its mind, runs the analysis, preserves artifacts, and challenges claims before writing them up.",
                },
                {
                  q: "Which models can it use?",
                  a: "Use frontier providers, open-weight models, local models, eligible ChatGPT access, or Ace. Local, provider-account, and ChatGPT-backed use does not debit the Ace wallet.",
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
                  a: "Open Settings for connected accounts and model access, or use the Synthetic Sciences dashboard to manage Ace, receipts, and devices.",
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
