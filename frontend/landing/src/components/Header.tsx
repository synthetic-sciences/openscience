import { useEffect, useState } from "react"
import { ASCENT, DASHBOARD, DOCS, GITHUB } from "@/data/links"

export function Wordmark() {
  return (
    <a href="/" data-slot="wordmark" aria-label="OpenScience home">
      <span data-slot="mark" aria-hidden>
        <svg focusable="false">
          <use href="/provider-logos.svg#synsci" />
        </svg>
      </span>
      OpenScience
    </a>
  )
}

const LINKS = [
  { label: "GitHub", href: GITHUB, external: true },
  { label: "Docs", href: DOCS },
  { label: "Ace", href: "/ace" },
  { label: "Ascent", href: ASCENT, external: true },
] as const

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path
        d="M12.1875 9.75L9.00001 12.9375L5.8125 9.75M9.00001 2.0625L9 12.375M14.4375 15.9375H3.5625"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      />
    </svg>
  )
}

export default function Header({ current }: { current?: "download" | "ace" | "privacy" }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", close)
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", close)
      document.body.style.overflow = ""
    }
  }, [open])

  return (
    <section data-component="top">
      <div>
        <Wordmark />
      </div>
      <nav data-component="nav-desktop" aria-label="Primary">
        <ul>
          {LINKS.map((link) => (
            <li key={link.label}>
              <a
                href={link.href}
                {...("external" in link && link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                aria-current={current && link.href === `/${current}` ? "page" : undefined}
              >
                {link.label}
              </a>
            </li>
          ))}
          <li>
            <a href={DASHBOARD} target="_blank" rel="noreferrer">
              Log in
            </a>
          </li>
          <li>
            <a href="/download" data-slot="cta-button" aria-current={current === "download" ? "page" : undefined}>
              <DownloadIcon />
              Download
            </a>
          </li>
        </ul>
      </nav>
      <nav data-component="nav-mobile" aria-label="Primary">
        <button
          type="button"
          data-component="nav-mobile-toggle"
          aria-expanded={open}
          aria-controls="nav-mobile-menu"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
          {open ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12.7071 11.9993L18.0104 17.3026L17.3033 18.0097L12 12.7064L6.6967 18.0097L5.98959 17.3026L11.2929 11.9993L5.98959 6.69595L6.6967 5.98885L12 11.2921L17.3033 5.98885L18.0104 6.69595L12.7071 11.9993Z"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M19 17H5V16H19V17Z" fill="currentColor" />
              <path d="M19 8H5V7H19V8Z" fill="currentColor" />
            </svg>
          )}
        </button>
        {open ? (
          <div id="nav-mobile-menu" data-component="nav-mobile-menu-list">
            <ul>
              <li>
                <a href="/">Home</a>
              </li>
              {LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    {...("external" in link && link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
              <li>
                <a href={DASHBOARD} target="_blank" rel="noreferrer">
                  Log in
                </a>
              </li>
              <li>
                <a href="/download">Download</a>
              </li>
            </ul>
          </div>
        ) : null}
      </nav>
    </section>
  )
}
