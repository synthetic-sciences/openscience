import { useEffect, useRef, useState, type ReactNode } from "react"
import heroPlate from "@/assets/hero.webp"
import { CopyStatus, useCopy } from "@/components/Copy"
import { FaqSection } from "@/components/Faq"
import { Footer, Legal } from "@/components/Footer"
import Header from "@/components/Header"
import { useMeta } from "@/components/Meta"
import { GITHUB, INSTALL_SCRIPT, NPM, NPM_SDK, RELEASES, RELEASE_DOWNLOAD, docs } from "@/data/links"

const DOWNLOADS = {
  "mac-arm64": { platform: "mac", label: "macOS (Apple Silicon)", os: "macOS", file: "OpenScience-mac-arm64.dmg" },
  "mac-x64": { platform: "mac", label: "macOS (Intel)", os: "macOS", file: "OpenScience-mac-x64.dmg" },
  "windows-x64": { platform: "windows", label: "Windows (x64)", os: "Windows", file: "OpenScience-windows-x64.exe" },
  "linux-x64": {
    platform: "linux",
    label: "Linux (x64, AppImage)",
    os: "Linux",
    file: "OpenScience-linux-x64.AppImage",
  },
  "linux-arm64": {
    platform: "linux",
    label: "Linux (ARM64, AppImage)",
    os: "Linux",
    file: "OpenScience-linux-arm64.AppImage",
  },
} as const

type Target = keyof typeof DOWNLOADS
type Platform = (typeof DOWNLOADS)[Target]["platform"]

const NOTES: Record<Platform, string> = {
  mac: "Developer ID signed and notarized. Open the DMG and drag OpenScience into Applications. Signed builds update themselves.",
  windows:
    "This installer is not yet code-signed. Windows SmartScreen may warn; Smart App Control may block it. Do not disable Windows security protections to install it.",
  linux: "Make the AppImage executable, then open it. Requires kernel 5.1 or newer.",
}

function detect(): Target {
  if (typeof navigator === "undefined") return "mac-arm64"
  const agent = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  if (agent.includes("win")) return "windows-x64"
  const linux = agent.includes("linux") || agent.includes("x11")
  const arm = /arm64|aarch64/.test(agent)
  if (linux) return arm ? "linux-arm64" : "linux-x64"
  return "mac-arm64"
}

function PlatformIcon({ platform }: { platform: Platform }) {
  if (platform === "mac") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3.5" y="4.5" width="17" height="11" rx="1" stroke="currentColor" />
        <path d="M8 19.5h8M10 15.5v4m4-4v4" stroke="currentColor" />
      </svg>
    )
  }
  if (platform === "windows") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="m3.5 5.25 7.2-.95v7.15H3.5v-6.2Zm8.45-1.12 8.55-1.12v8.44h-8.55V4.13ZM3.5 12.7h7.2v7.15l-7.2-.96V12.7Zm8.45 0h8.55v8.43l-8.55-1.12V12.7Z"
          stroke="currentColor"
        />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9.4 9.2C7.2 12.2 6.4 15.6 7.6 18.4c.5 1.2 1.9 2 4.4 2s3.9-.8 4.4-2c1.2-2.8.4-6.2-1.8-9.2"
        stroke="currentColor"
      />
      <circle cx="12" cy="6.8" r="3.2" stroke="currentColor" />
      <path d="M9.9 13.4c-.5 2.4-.1 4.3 2.1 4.3s2.6-1.9 2.1-4.3" stroke="currentColor" />
      <path d="M11 7.6h2l-1 1.1z" fill="currentColor" />
      <circle cx="10.9" cy="6.1" r=".6" fill="currentColor" />
      <circle cx="13.1" cy="6.1" r=".6" fill="currentColor" />
      <path d="M8.6 20.6H6.2M17.8 20.6h-2.4" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M12.1875 9.75L9.00001 12.9375L5.8125 9.75M9.00001 2.0625L9 12.375M14.4375 15.9375H3.5625"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      />
    </svg>
  )
}

function CliRow({ before, highlight, after = "" }: { before: string; highlight: string; after?: string }) {
  const command = `${before}${highlight}${after}`
  const { copied, copy } = useCopy(command)
  return (
    <button
      type="button"
      data-component="cli-row"
      onClick={copy}
      aria-label={`Copy: ${command}`}
      {...(copied ? { "data-copied": "" } : {})}
    >
      <code>
        {before}
        <strong>{highlight}</strong>
        {after}
      </code>
      <CopyStatus />
    </button>
  )
}

function Row({
  icon,
  label,
  detail,
  href,
  action,
  external,
}: {
  icon: ReactNode
  label: string
  detail?: string
  href: string
  action: string
  external?: boolean
}) {
  return (
    <div data-component="download-row">
      <div data-component="download-info">
        <span data-slot="icon">{icon}</span>
        <span>
          {label}
          {detail ? <small>{detail}</small> : null}
        </span>
      </div>
      <a href={href} data-component="action-button" {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        {action}
      </a>
    </div>
  )
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M10 14 20 4m0 0h-6m6 0v6M18 13v6H5V6h6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

const FAQ = [
  {
    q: "Which download should I pick?",
    a: (
      <p>
        The button at the top chooses for your operating system and CPU. Apple Silicon Macs (M1 and newer) use the arm64
        disk image; Intel Macs use x64. On Linux, most laptops and servers are x64; Raspberry Pi and most cloud ARM
        instances are arm64.
      </p>
    ),
  },
  {
    q: "Do I need the desktop app?",
    a: (
      <p>
        No. The command line install opens the same workspace in your browser, and works anywhere Node.js runs. The
        desktop app adds a native window, deep links, and signed self-updates on macOS.
      </p>
    ),
  },
  {
    q: "Do I need an AI subscription to start?",
    a: (
      <p>
        No. OpenScience includes free models. You can also connect <a href="/ace">Ace</a>, your own provider keys, a
        ChatGPT Plus or Pro sign-in, or <a href={docs("local-models")}>local models</a>.
      </p>
    ),
  },
  {
    q: "How do updates work?",
    a: (
      <p>
        Signed macOS builds verify and install their own updates. On the command line, run{" "}
        <code>npm update -g @synsci/openscience</code> or rerun the install script. Every release is cut from{" "}
        <code>main</code> after a full rehearsal at the same commit, so a tag always matches tested source.
      </p>
    ),
  },
  {
    q: "What are the system requirements?",
    a: (
      <p>
        macOS 12 or newer, Windows 10 or 11 (x64), or Linux with kernel 5.1 or newer and glibc 2.17 or newer. musl
        builds of the command line tool are published separately on the{" "}
        <a href={RELEASES} target="_blank" rel="noreferrer">
          releases page
        </a>
        .
      </p>
    ),
  },
  {
    q: "Where are the checksums?",
    a: (
      <p>
        Every release ships a <code>checksums.txt</code> alongside its assets on GitHub. The install script verifies the
        checksum before installing, and the macOS bootstrap verifies the app's code signature as well.
      </p>
    ),
  },
]

export default function Download() {
  useMeta({
    title: "OpenScience | Download",
    description: "Download OpenScience for macOS, Windows, and Linux, or install it from the command line.",
    path: "/download",
  })

  const [target, setTarget] = useState<Target>(detect)
  const chosen = useRef(false)

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
        if (!architecture || chosen.current || !/arm|^(x86|x64|x86_64|amd64)$/.test(architecture)) return
        const arm = architecture.includes("arm")
        setTarget(platform === "linux" ? (arm ? "linux-arm64" : "linux-x64") : arm ? "mac-arm64" : "mac-x64")
      },
      () => undefined,
    )
  }, [])

  const download = DOWNLOADS[target]

  return (
    <main data-page="download">
      <div data-component="container">
        <Header current="download" />

        <div data-component="content">
          <div data-component="download-hero">
            <div data-component="hero-plate">
              <img src={heroPlate} alt="" width="255" height="255" />
            </div>
            <div data-component="hero-text">
              <h1>Download OpenScience Desktop</h1>
              <p>Available for macOS, Windows, and Linux</p>
              <a
                href={`${RELEASE_DOWNLOAD}/${download.file}`}
                data-slot="button"
                aria-label={`Download OpenScience for ${download.label}`}
              >
                <DownloadIcon />
                Download for {download.os}
              </a>
              <p data-slot="hero-note">
                {download.label}. {NOTES[download.platform]}
              </p>
            </div>
          </div>

          <div data-component="download-section">
            <div data-component="section-label">
              OpenScience Terminal
              <span>Opens the workspace in your browser</span>
            </div>
            <div data-component="section-content">
              <CliRow before="curl -fsSL " highlight={INSTALL_SCRIPT} after=" | bash" />
              <CliRow before="npm install -g " highlight="@synsci/openscience" />
              <CliRow before="npx " highlight="synsci" />
            </div>
          </div>

          <div data-component="download-section">
            <div data-component="section-label">
              OpenScience Desktop
              <span>Native window, signed updates</span>
            </div>
            <div data-component="section-content">
              {(Object.keys(DOWNLOADS) as Target[]).map((key) => {
                const item = DOWNLOADS[key]
                return (
                  <div
                    key={key}
                    onClick={() => {
                      chosen.current = true
                      setTarget(key)
                    }}
                  >
                    <Row
                      icon={<PlatformIcon platform={item.platform} />}
                      label={item.label}
                      href={`${RELEASE_DOWNLOAD}/${item.file}`}
                      action="Download"
                    />
                  </div>
                )
              })}
            </div>
          </div>

          <div data-component="download-section">
            <div data-component="section-label">
              OpenScience Integrations
              <span>Editors, agents, and code</span>
            </div>
            <div data-component="section-content">
              <Row
                icon={<LinkIcon />}
                label="Agent Client Protocol"
                detail="openscience acp, for editors"
                href={docs("commands")}
                action="Docs"
              />
              <Row
                icon={<LinkIcon />}
                label="MCP server"
                detail="openscience mcp"
                href={docs("commands")}
                action="Docs"
              />
              <Row
                icon={<LinkIcon />}
                label="TypeScript SDK"
                detail="@synsci/sdk"
                href={NPM_SDK}
                action="npm"
                external
              />
              <Row
                icon={<LinkIcon />}
                label="Harbor / Terminal-Bench adapter"
                detail="headless openscience run"
                href={`${GITHUB}/tree/main/tooling/harbor`}
                action="GitHub"
                external
              />
              <Row
                icon={<LinkIcon />}
                label="Command line package"
                detail="@synsci/openscience"
                href={NPM}
                action="npm"
                external
              />
            </div>
          </div>
        </div>

        <FaqSection items={FAQ} />

        <Footer />
      </div>

      <Legal />
    </main>
  )
}
