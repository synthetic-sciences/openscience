import logo from "@/assets/synthetic-sciences.svg"

export const GITHUB = "https://github.com/synthetic-sciences/openscience"
export const DOCS = "https://openscience.sh/docs"
export const COMMAND = "npm install -g @synsci/openscience"

export function Mark() {
  return <img className="science-mark" src={logo} width="28" height="28" alt="" aria-hidden="true" />
}

export function Header({ download = false }: { download?: boolean }) {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="OpenScience home">
        <Mark />
        <span>Synthetic Sciences</span>
      </a>
      <nav aria-label="Primary navigation">
        <a href={DOCS}>Docs</a>
        <a href={GITHUB}>GitHub</a>
        <a href="/download" className="nav-download" aria-current={download ? "page" : undefined}>
          Get OpenScience
        </a>
      </nav>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <div className="footer-about">
          <a className="brand" href="/">
            <Mark />
            <span>OpenScience</span>
          </a>
          <p>
            Open-source software
            <br />
            for scientific research.
          </p>
          <a href="https://syntheticsciences.ai">By Synthetic Sciences</a>
        </div>
        {[
          {
            title: "Product",
            links: [
              ["Download", "/download"],
              ["Workspace", "/#research"],
              ["Skills & tools", "/#skills"],
              ["Models", "/#models"],
              ["OpenScience Ace", "/#ace"],
            ],
          },
          {
            title: "Resources",
            links: [
              ["Documentation", DOCS],
              ["GitHub", GITHUB],
              ["Releases", `${GITHUB}/releases`],
              ["npm", "https://www.npmjs.com/package/@synsci/openscience"],
            ],
          },
          {
            title: "Connect",
            links: [
              ["Synthetic Sciences", "https://syntheticsciences.ai"],
              ["X / Twitter", "https://x.com/SynScience"],
              ["Contribute", `${GITHUB}/blob/main/CONTRIBUTING.md`],
              ["License", `${GITHUB}/blob/main/LICENSE`],
            ],
          },
        ].map((group) => (
          <nav key={group.title} aria-label={group.title}>
            <span className="eyebrow">{group.title}</span>
            {group.links.map((link) => (
              <a key={link[0]} href={link[1]}>
                {link[0]}
              </a>
            ))}
          </nav>
        ))}
      </div>
      <div className="footer-meta">
        <span>© {new Date().getFullYear()} Synthetic Sciences · OpenScience is open source.</span>
        <a href="#top">Back to top</a>
      </div>
      <a className="footer-wordmark" href="#top" aria-label="OpenScience, back to top">
        OpenScience
      </a>
    </footer>
  )
}
