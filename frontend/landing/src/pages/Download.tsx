import { useEffect, useState } from "react"
import Nav from "@/Nav"

const GITHUB = "https://github.com/synthetic-sciences/openscience"
const DOCS = "https://openscience.sh/docs"
const RELEASE = `${GITHUB}/releases/latest/download`
const NPM = "npm i -g @synsci/openscience"
const CURL = "curl -fsSL https://openscience.sh/install | bash"
const MAC = "curl -fsSL https://openscience.sh/install-desktop | bash"

const DOWNLOADS = {
  "mac-arm64": {
    platform: "mac",
    label: "macOS",
    detail: "Apple Silicon",
    kind: "Disk image",
    file: "OpenScience-mac-arm64.dmg",
  },
  "mac-x64": {
    platform: "mac",
    label: "macOS",
    detail: "Intel",
    kind: "Disk image",
    file: "OpenScience-mac-x64.dmg",
  },
  "windows-x64": {
    platform: "windows",
    label: "Windows",
    detail: "64-bit",
    kind: "Installer",
    file: "OpenScience-windows-x64.exe",
  },
  "linux-x64": {
    platform: "linux",
    label: "Linux",
    detail: "x86_64",
    kind: "AppImage",
    file: "OpenScience-linux-x64.AppImage",
  },
  "linux-arm64": {
    platform: "linux",
    label: "Linux",
    detail: "ARM64",
    kind: "AppImage",
    file: "OpenScience-linux-arm64.AppImage",
  },
} as const

type Target = keyof typeof DOWNLOADS
type Platform = (typeof DOWNLOADS)[Target]["platform"]

function detect(): Target {
  if (typeof navigator === "undefined") return "mac-arm64"

  const agent = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  if (agent.includes("win")) return "windows-x64"

  const linux = agent.includes("linux") || agent.includes("x11")
  const arm = /arm64|aarch64/.test(agent)
  if (linux) return arm ? "linux-arm64" : "linux-x64"
  return "mac-arm64"
}

const PLATFORMS = [
  { id: "mac", label: "macOS", target: "mac-arm64" },
  { id: "windows", label: "Windows", target: "windows-x64" },
  { id: "linux", label: "Linux", target: "linux-x64" },
] as const

function Mark({ size = 16 }: { size?: number }) {
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

function Copy({ command, primary = false }: { command: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false)

  if (primary) {
    return (
      <button
        type="button"
        onClick={() => {
          if (!navigator.clipboard) return
          void navigator.clipboard.writeText(command).then(
            () => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 3000)
            },
            () => setCopied(false),
          )
        }}
        className="btn-primary inline-flex min-h-14 w-full items-center justify-center gap-3 px-7 text-[15px] sm:text-[16px]"
        aria-label={`Copy installer command: ${command}`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M5.5 4V2.5h7v9H11M3.5 5.5h7v8h-7v-8Z" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span aria-live="polite">{copied ? "Copied. Open Terminal" : "Copy macOS installer"}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (!navigator.clipboard) return
        void navigator.clipboard.writeText(command).then(
          () => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          },
          () => setCopied(false),
        )
      }}
      className="group flex min-h-14 w-full items-center gap-3 border border-border/60 bg-background/60 px-4 text-left transition-colors duration-300 hover:border-foreground/30 hover:bg-foreground/[0.025] sm:px-5"
      aria-label={`Copy command: ${command}`}
    >
      <span className="shrink-0 font-terminal text-[12px] text-[hsl(var(--accent-coral))]">$</span>
      <code className="min-w-0 flex-1 break-all font-terminal text-[12px] leading-5 text-foreground/75 sm:text-[13px]">
        {command}
      </code>
      <span
        className="min-w-11 shrink-0 text-right text-[12px] text-foreground/55 transition-colors group-hover:text-foreground/75"
        aria-live="polite"
      >
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  )
}

export default function Download() {
  const [target, setTarget] = useState<Target>(detect)

  useEffect(() => {
    const title = document.title
    const copy = "Download OpenScience for macOS, Windows, or Linux, or install it from the command line."
    const metas = [
      { selector: 'meta[name="description"]', key: "name", value: "description", content: copy },
      { selector: 'meta[property="og:title"]', key: "property", value: "og:title", content: "Download OpenScience" },
      { selector: 'meta[property="og:description"]', key: "property", value: "og:description", content: copy },
      {
        selector: 'meta[property="og:url"]',
        key: "property",
        value: "og:url",
        content: "https://openscience.sh/download",
      },
      { selector: 'meta[name="twitter:title"]', key: "name", value: "twitter:title", content: "Download OpenScience" },
      { selector: 'meta[name="twitter:description"]', key: "name", value: "twitter:description", content: copy },
    ] as const
    const nodes = metas.map((item) => {
      const found = document.querySelector<HTMLMetaElement>(item.selector)
      const node = found ?? document.createElement("meta")
      const previous = node.getAttribute("content")

      if (!found) {
        node.setAttribute(item.key, item.value)
        document.head.append(node)
      }
      node.content = item.content
      return { found, node, previous }
    })
    const canonicalNode = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    const canonical = canonicalNode ?? document.createElement("link")
    const previousCanonical = canonical.getAttribute("href")

    if (!canonicalNode) {
      canonical.rel = "canonical"
      document.head.append(canonical)
    }

    document.title = "Download OpenScience"
    canonical.href = "https://openscience.sh/download"

    return () => {
      document.title = title

      nodes.forEach((item) => {
        if (!item.found) {
          item.node.remove()
          return
        }
        if (item.previous === null) {
          item.node.removeAttribute("content")
          return
        }
        item.node.content = item.previous
      })

      if (!canonicalNode) canonical.remove()
      if (canonicalNode && previousCanonical === null) canonical.removeAttribute("href")
      if (canonicalNode && previousCanonical !== null) canonical.href = previousCanonical
    }
  }, [])

  useEffect(() => {
    const platform = DOWNLOADS[detect()].platform
    if (platform === "windows") return
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
    <div
      id="top"
      className="relative min-h-screen overflow-hidden bg-background text-foreground antialiased selection:bg-primary/30 selection:text-foreground"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[720px] graticule opacity-[0.055]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(ellipse_at_top,hsl(var(--accent-coral)/0.065),transparent_58%)]" />

      <header className="relative z-20 mx-auto flex h-20 w-full max-w-[1180px] items-center justify-center px-6 sm:px-10">
        <a
          href="/"
          className="absolute left-6 inline-flex min-h-11 items-center gap-2.5 text-foreground sm:left-10"
          aria-label="OpenScience home"
        >
          <Mark />
          <span className="hidden font-display text-[21px] leading-none tracking-tight sm:inline">openscience</span>
        </a>
        <Nav current="download" />
      </header>

      <main className="relative z-10">
        <section className="mx-auto w-full max-w-[1180px] px-6 pb-20 pt-16 sm:px-10 sm:pb-28 sm:pt-24">
          <div className="mx-auto max-w-[900px] text-center">
            <div className="rise text-[13px] tracking-[0.045em] text-foreground/55">The current release</div>
            <h1 className="rise mt-6 text-balance text-[clamp(48px,7vw,92px)] leading-[0.96] tracking-[-0.035em] [animation-delay:90ms]">
              Download OpenScience.
            </h1>
            <p className="rise mx-auto mt-6 max-w-[36ch] text-[16px] leading-7 text-foreground/60 [animation-delay:180ms] sm:text-[18px]">
              Your research workspace, on your computer.
            </p>

            <div className="rise mx-auto mt-9 max-w-[560px] [animation-delay:270ms]">
              {download.platform === "mac" ? (
                <>
                  <Copy command={MAC} primary />
                  <div className="mt-3 text-[12.5px] leading-5 text-foreground/55">
                    Verified installer · detects your Mac · no Security Settings
                  </div>
                  <div className="mt-7 border border-border/60 bg-background/60 p-4 text-left sm:p-5">
                    <div className="text-[13px] text-foreground">Finish in Terminal</div>
                    <ol className="mb-4 mt-3 grid gap-2 text-[12.5px] leading-5 text-foreground/55">
                      <li>
                        <span className="mr-2 text-[hsl(var(--accent-coral))]">1.</span>Open Terminal from Spotlight.
                      </li>
                      <li>
                        <span className="mr-2 text-[hsl(var(--accent-coral))]">2.</span>Paste the copied command and
                        press Return.
                      </li>
                      <li>
                        <span className="mr-2 text-[hsl(var(--accent-coral))]">3.</span>OpenScience verifies, installs,
                        and launches automatically.
                      </li>
                    </ol>
                    <Copy command={MAC} />
                  </div>
                  <details className="group mt-5 border-t border-border/50 pt-4 text-left">
                    <summary className="min-h-11 cursor-pointer list-none py-3 text-center text-[12.5px] text-foreground/55 hover:text-foreground/80">
                      Manual disk image
                    </summary>
                    <div className="border border-border/50 bg-background/40 p-4 text-[12.5px] leading-5 text-foreground/55">
                      <p>
                        The disk image is ad-hoc signed and cannot be notarized without an Apple Developer ID. macOS
                        will require approval in Privacy &amp; Security. Use the installer above to avoid that screen.
                      </p>
                      <a
                        href={`${RELEASE}/${download.file}`}
                        className="mt-3 inline-flex min-h-11 items-center text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground/60"
                        aria-label={`Download the manual disk image for ${download.label}, ${download.detail}`}
                      >
                        Download for {download.detail}
                      </a>
                    </div>
                  </details>
                </>
              ) : (
                <>
                  <a
                    href={`${RELEASE}/${download.file}`}
                    className="btn-primary inline-flex min-h-14 w-full items-center justify-center gap-3 px-7 text-[15px] sm:text-[16px]"
                    aria-label={`Download OpenScience for ${download.label}, ${download.detail}`}
                  >
                    <svg width="15" height="16" viewBox="0 0 15 16" fill="none" aria-hidden>
                      <path d="M7.5 1v9m0 0L11 6.5M7.5 10 4 6.5M1 14.5h13" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                    Download for {download.label} ({download.detail})
                  </a>
                  <div className="mt-3 text-[12.5px] leading-5 text-foreground/55">
                    {download.kind} · latest release · free and open source
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="mx-auto mt-14 max-w-[780px] border-y border-border/55">
            <div className="grid grid-cols-3" role="group" aria-label="Choose your operating system">
              {PLATFORMS.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setTarget(item.target)}
                  className={`relative flex min-h-14 items-center justify-center gap-2.5 px-3 text-[13px] transition-colors duration-300 after:absolute after:bottom-0 after:h-px after:bg-[hsl(var(--accent-coral))] after:transition-all ${
                    item.id === download.platform
                      ? "bg-foreground/[0.045] text-foreground after:inset-x-4"
                      : "text-foreground/55 after:inset-x-1/2 hover:bg-foreground/[0.025] hover:text-foreground/80"
                  }`}
                  aria-pressed={item.id === download.platform}
                >
                  <PlatformMark platform={item.id} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            <div
              className="flex min-h-14 flex-wrap items-center justify-center gap-1 border-t border-border/40 px-4"
              role="group"
              aria-label={`Choose ${download.label} architecture`}
            >
              {options.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setTarget(item)}
                  className={`min-h-11 px-4 text-[12.5px] transition-colors ${
                    item === target ? "text-foreground" : "text-foreground/55 hover:text-foreground/80"
                  }`}
                  aria-pressed={item === target}
                >
                  {DOWNLOADS[item].detail}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section id="terminal" className="border-t border-border/40">
          <div className="mx-auto grid w-full max-w-[1060px] gap-9 px-6 py-20 sm:px-10 sm:py-24 lg:grid-cols-[0.72fr_1.28fr] lg:items-center lg:gap-16">
            <div>
              <div className="text-[13px] tracking-[0.045em] text-foreground/55">Command line</div>
              <h2 className="mt-4 text-[clamp(30px,4vw,48px)] leading-[1.04] tracking-[-0.025em]">Two commands.</h2>
              <p className="mt-4 max-w-[30ch] text-[15px] leading-7 text-foreground/55">
                Install once, then open any project.
              </p>
            </div>
            <div className="space-y-3">
              <Copy command={NPM} />
              <Copy command={CURL} />
            </div>
          </div>
        </section>

        <section className="border-y border-border/40 bg-foreground/[0.012]">
          <div className="mx-auto w-full max-w-[1060px] px-6 py-16 sm:px-10 sm:py-20">
            <h2 className="sr-only">Quick start</h2>
            <div className="grid gap-px border-y border-border/45 bg-border/45 sm:grid-cols-3">
              {[
                [
                  "01",
                  "Install",
                  download.platform === "mac"
                    ? "Copy the verified installer, paste it in Terminal, and OpenScience launches automatically."
                    : "Open the download and follow your operating system's install prompt.",
                ],
                ["02", "Connect", "Sign in or choose your own model provider during onboarding."],
                ["03", "Research", "Open a project and start your first research session."],
              ].map((step) => (
                <div key={step[0]} className="min-h-[150px] bg-background px-6 py-7 sm:px-7">
                  <div className="font-terminal text-[10px] tracking-[0.12em] text-[hsl(var(--accent-coral)/0.8)]">
                    {step[0]}
                  </div>
                  <h3 className="mt-5 text-[22px] leading-none">{step[1]}</h3>
                  <p className="mt-3 text-[13.5px] leading-6 text-foreground/60">{step[2]}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 mx-auto w-full max-w-[1180px] px-6 py-10 sm:px-10">
        <div className="flex flex-col items-start justify-between gap-5 text-[12.5px] text-foreground/55 sm:flex-row sm:items-center">
          <div>&copy; {new Date().getFullYear()} Synthetic Sciences. Apache 2.0.</div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <a href="/" className="inline-flex min-h-11 items-center hover:text-foreground">
              Home
            </a>
            <a href={DOCS} className="inline-flex min-h-11 items-center hover:text-foreground">
              Docs
            </a>
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center hover:text-foreground"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
