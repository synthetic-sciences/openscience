import { ArrowUpIcon, ArrowUpRightIcon } from "@phosphor-icons/react"
import { CHANGELOG, DOCS, GITHUB, SECURITY, SYNTHETIC_SCIENCES, X } from "@/data/links"

const GROUPS = [
  {
    title: "OpenScience",
    links: [
      { label: "Download", href: "/download" },
      { label: "Workspace", href: "/#workspace" },
      { label: "Ace", href: "/ace" },
      { label: "GitHub", href: GITHUB, external: true },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Docs", href: DOCS },
      { label: "Changelog", href: CHANGELOG, external: true },
      { label: "Install the CLI", href: "/download#terminal" },
      { label: "FAQ", href: "/#faq" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Synthetic Sciences", href: SYNTHETIC_SCIENCES, external: true },
      { label: "Privacy policy", href: "/privacy" },
      { label: "Security", href: SECURITY, external: true },
      { label: "X", href: X, external: true },
    ],
  },
]

export function Footer() {
  return (
    <footer data-component="footer" role="contentinfo">
      <div data-slot="footer-inner">
        <div data-slot="footer-top">
          <div data-slot="footer-brand">
            <a href="/" data-slot="footer-home" aria-label="OpenScience home">
              <svg aria-hidden="true" focusable="false">
                <use href="/provider-logos.svg#synsci" />
              </svg>
              OpenScience
            </a>
            <p>
              An open-source workbench
              <br />
              for scientific research.
            </p>
          </div>
          {GROUPS.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <h2>{group.title}</h2>
              <ul>
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href} {...("external" in link ? { target: "_blank", rel: "noreferrer" } : {})}>
                      {link.label}
                      {"external" in link ? <ArrowUpRightIcon size={13} aria-hidden="true" /> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div data-slot="footer-bottom">
          <span>
            &copy; <span suppressHydrationWarning>{new Date().getFullYear()}</span> InkVell Inc. (dba{" "}
            <a href={SYNTHETIC_SCIENCES} target="_blank" rel="noreferrer">
              Synthetic Sciences
            </a>
            )
          </span>
          <a href="#top" data-slot="back-to-top">
            Back to top <ArrowUpIcon size={16} aria-hidden="true" />
          </a>
        </div>
        <div data-slot="footer-wordmark" aria-hidden="true">
          OpenScience
        </div>
      </div>
    </footer>
  )
}
