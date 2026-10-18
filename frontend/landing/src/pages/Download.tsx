import { useEffect, useState } from "react"
import { AppleLogoIcon, DownloadSimpleIcon, LinuxLogoIcon, WindowsLogoIcon } from "@phosphor-icons/react"
import { CopyStatus, useCopy } from "@/components/Copy"
import { FaqSection } from "@/components/Faq"
import { Footer } from "@/components/Footer"
import Header from "@/components/Header"
import { useMeta } from "@/components/Meta"
import { INSTALL_SCRIPT, RELEASES, RELEASE_DOWNLOAD, docs } from "@/data/links"

const DOWNLOADS = {
  "mac-arm64": {
    platform: "mac",
    label: "Apple silicon",
    os: "macOS",
    format: ".dmg",
    file: "OpenScience-mac-arm64.dmg",
  },
  "mac-x64": { platform: "mac", label: "Intel", os: "macOS", format: ".dmg", file: "OpenScience-mac-x64.dmg" },
  "windows-x64": {
    platform: "windows",
    label: "Windows x64",
    os: "Windows",
    format: ".exe",
    file: "OpenScience-windows-x64.exe",
  },
  "linux-x64": {
    platform: "linux",
    label: "x64",
    os: "Linux",
    format: ".AppImage",
    file: "OpenScience-linux-x64.AppImage",
  },
  "linux-arm64": {
    platform: "linux",
    label: "ARM64",
    os: "Linux",
    format: ".AppImage",
    file: "OpenScience-linux-arm64.AppImage",
  },
} as const

type Target = keyof typeof DOWNLOADS

const PLATFORMS = [
  { name: "macOS", icon: AppleLogoIcon, requirement: "macOS 12 or later", targets: ["mac-arm64", "mac-x64"] },
  { name: "Windows", icon: WindowsLogoIcon, requirement: "Windows 10 or later", targets: ["windows-x64"] },
  { name: "Linux", icon: LinuxLogoIcon, requirement: "AppImage", targets: ["linux-x64", "linux-arm64"] },
] satisfies { name: string; icon: typeof AppleLogoIcon; requirement: string; targets: Target[] }[]

function detect(): Target {
  if (typeof navigator === "undefined") return "mac-arm64"
  const agent = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  if (agent.includes("win")) return "windows-x64"
  if (agent.includes("linux") || agent.includes("x11")) return /arm64|aarch64/.test(agent) ? "linux-arm64" : "linux-x64"
  return "mac-arm64"
}

function CliRow({ label, command }: { label: string; command: string }) {
  const { copied, copy } = useCopy(command)
  return (
    <div data-component="cli-install">
      <span data-slot="method">{label}</span>
      <button
        type="button"
        data-component="cli-row"
        onClick={copy}
        aria-label={`Copy: ${command}`}
        {...(copied ? { "data-copied": "" } : {})}
      >
        <code>{command}</code>
        <CopyStatus />
      </button>
      <span className="sr-only" role="status">
        {copied ? `${label} command copied` : ""}
      </span>
    </div>
  )
}

const FAQ = [
  {
    q: "Which download should I pick?",
    a: (
      <p>
        On a Mac, choose Apple silicon for M1 and newer chips, or Intel for older models. You can check your chip in
        About This Mac. Most Windows and Linux computers use x64; choose ARM64 for a Linux computer with an ARM
        processor.
      </p>
    ),
  },
  {
    q: "Do I need the desktop app?",
    a: (
      <p>
        No. The command line install opens the same workspace in your browser. The desktop app gives it a dedicated
        window.
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
        The macOS app updates automatically. For Windows and Linux, download the latest version here. On the command
        line, run <code>npm update -g @synsci/openscience</code> or rerun the install script.
      </p>
    ),
  },
  {
    q: "What are the system requirements?",
    a: (
      <p>
        macOS 12 or newer, Windows 10 or 11 (x64), or Linux with kernel 3.10 or newer and glibc 2.17 or newer.
        Additional command line builds are available on the{" "}
        <a href={RELEASES} target="_blank" rel="noreferrer">
          releases page
        </a>
        .
      </p>
    ),
  },
  {
    q: "Need help installing?",
    a: (
      <p>
        Open the macOS disk image and drag OpenScience into Applications. On Linux, make the AppImage executable, then
        open it. Windows may show a warning or block the installer. See the{" "}
        <a href={docs("installation")}>installation guide</a> for help.
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

  // Starts on the prerendered default; the visitor's platform is detected after hydration.
  const [target, setTarget] = useState<Target>("mac-arm64")

  useEffect(() => {
    const detected = detect()
    setTarget(detected)
    const platform = DOWNLOADS[detected].platform
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
        if (!architecture || !/arm|^(x86|x64|x86_64|amd64)$/.test(architecture)) return
        const arm = architecture.includes("arm")
        setTarget(platform === "linux" ? (arm ? "linux-arm64" : "linux-x64") : arm ? "mac-arm64" : "mac-x64")
      },
      () => undefined,
    )
  }, [])

  const download = DOWNLOADS[target]

  return (
    <main data-page="download" id="top">
      <div data-component="container">
        <Header current="download" />
        <div data-component="content">
          <section data-component="download-hero" aria-labelledby="download-title">
            <span data-slot="app-mark" aria-hidden="true">
              <svg focusable="false">
                <use href="/provider-logos.svg#synsci" />
              </svg>
            </span>
            <h1 id="download-title">Download OpenScience</h1>
            <p>The open-source workbench for scientific research.</p>
            <div data-slot="download-primary">
              <a
                href={`${RELEASE_DOWNLOAD}/${download.file}`}
                data-slot="button"
                aria-label={`Download for ${download.os}, ${download.label}`}
              >
                <DownloadSimpleIcon size={22} aria-hidden="true" />
                Download for {download.os}
              </a>
              <a href="#platforms" data-slot="download-version">
                {download.label} <span aria-hidden="true">↗</span>
              </a>
            </div>
          </section>

          <section data-component="platforms" id="platforms" aria-label="Downloads for every platform">
            {PLATFORMS.map((platform) => (
              <article data-component="platform" key={platform.name}>
                <platform.icon size={36} weight="regular" aria-hidden="true" />
                <h2>{platform.name}</h2>
                <p>{platform.requirement}</p>
                <div data-slot="platform-downloads">
                  {platform.targets.map((key) => {
                    const item = DOWNLOADS[key]
                    return (
                      <a key={key} href={`${RELEASE_DOWNLOAD}/${item.file}`}>
                        <span className="sr-only">Download OpenScience for {item.os}: </span>
                        <span>{item.label}</span>
                        <span data-slot="file-format">{item.format}</span>
                        <DownloadSimpleIcon size={18} aria-hidden="true" />
                      </a>
                    )
                  })}
                </div>
              </article>
            ))}
          </section>

          <section data-component="download-section" id="terminal" aria-labelledby="terminal-title">
            <h2 id="terminal-title">Prefer the terminal?</h2>
            <p>Install OpenScience and open the workspace in your browser.</p>
            <div data-component="terminal-commands">
              <CliRow label="curl" command={`curl -fsSL ${INSTALL_SCRIPT} | bash`} />
              <CliRow label="npm" command="npm install -g @synsci/openscience" />
              <CliRow label="npx" command="npx synsci" />
            </div>
          </section>
        </div>
        <FaqSection items={FAQ} />
      </div>
      <Footer />
    </main>
  )
}
