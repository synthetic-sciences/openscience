import { useEffect, useState } from "react"
import { Header, Footer, GITHUB, DOCS, COMMAND } from "@/components/Site"
import "./landing.css"
import "./download.css"

const RELEASE = `${GITHUB}/releases/latest/download`

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

function Copy({ command, label }: { command: string; label: string }) {
  const [status, setStatus] = useState("")
  async function copy() {
    const copied = await navigator.clipboard?.writeText(command).then(
      () => true,
      () => false,
    )
    setStatus(copied ? "Copied to clipboard." : "Select the command to copy it manually.")
  }
  return (
    <div className="command-row">
      <span className="eyebrow">{label}</span>
      <div className="command-input">
        <span aria-hidden="true">$</span>
        <code>{command}</code>
        <button type="button" onClick={copy} aria-label={`Copy command: ${command}`}>
          {status === "Copied to clipboard." ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="command-status" role="status">
        {status}
      </p>
    </div>
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
        if (!architecture || !/arm|^(x86|x64|x86_64|amd64)$/.test(architecture)) return
        const hinted = architecture.includes("arm")
        setTarget(platform === "linux" ? (hinted ? "linux-arm64" : "linux-x64") : hinted ? "mac-arm64" : "mac-x64")
      },
      () => undefined,
    )
  }, [])

  const download = DOWNLOADS[target]

  return (
    <div id="top" className="landing download-page">
      <a className="skip-link" href="#download">
        Skip to downloads
      </a>
      <Header download />
      <main>
        <section id="download" className="download-intro section" aria-labelledby="download-title">
          <div className="download-copy">
            <h1 id="download-title">Get OpenScience.</h1>
            <p>Free, open-source software for scientific research.</p>
            <a
              className="button button-light desktop-action"
              href={`${RELEASE}/${download.file}`}
              aria-label={`Download OpenScience for ${download.label}, ${download.detail}`}
            >
              Download for {download.label} ({download.detail})
              <span className="button-dot" aria-hidden="true" />
            </a>
          </div>
          <div className="platform-downloads" aria-label="All desktop downloads">
            {PLATFORMS.map((platform) => (
              <div className="platform-card" key={platform.id}>
                <h2>
                  <PlatformMark platform={platform.id} />
                  {platform.label}
                </h2>
                <div className="platform-files">
                  {(Object.keys(DOWNLOADS) as Target[])
                    .filter((key) => DOWNLOADS[key].platform === platform.id)
                    .map((key) => (
                      <a
                        key={key}
                        href={`${RELEASE}/${DOWNLOADS[key].file}`}
                        aria-label={`Download OpenScience for ${DOWNLOADS[key].label}, ${DOWNLOADS[key].detail}`}
                      >
                        <span className="file-name">
                          <span className="selection-dot" aria-hidden="true" />
                          {DOWNLOADS[key].detail}
                        </span>
                        <span className="file-format">.{DOWNLOADS[key].file.split(".").pop()}</span>
                      </a>
                    ))}
                </div>
                <p className="platform-instructions">
                  {platform.id === "mac" && "Open the disk image and drag into Applications. Signed and notarized."}
                  {platform.id === "windows" &&
                    "Unsigned installer. Smart App Control may block it; SmartScreen may warn. Keep Windows security protections enabled."}
                  {platform.id === "linux" && "Make the AppImage executable, then open it."}
                </p>
              </div>
            ))}
          </div>
        </section>
        <section id="command-line" className="command-section paper section" aria-labelledby="command-title">
          <h2 id="command-title">Install from your terminal.</h2>
          <p className="command-description">Requires Node.js and npm.</p>
          <div className="command-steps">
            <Copy command={COMMAND} label="01 / Install" />
            <Copy command="openscience" label="02 / Run in your project folder" />
          </div>
          <a className="text-link" href={`${DOCS}/#/openscience/commands`}>
            CLI documentation
          </a>
        </section>
      </main>
      <Footer />
    </div>
  )
}
