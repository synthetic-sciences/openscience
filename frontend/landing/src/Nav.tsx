const LINKS = [
  { id: "download", label: "Download", href: "/download" },
  { id: "docs", label: "Docs", href: "https://openscience.sh/docs" },
  { id: "github", label: "GitHub", href: "https://github.com/synthetic-sciences/openscience", external: true },
] as const

export default function Nav({ current }: { current?: "download" }) {
  return (
    <nav
      className="flex items-center gap-3 text-[12px] font-bold tracking-[0.015em] text-foreground sm:gap-4 sm:text-[12.5px]"
      aria-label="Primary navigation"
    >
      {LINKS.map((link) => {
        const active = current === link.id
        return (
          <a
            key={link.id}
            href={link.href}
            className="inline-flex min-h-11 items-center px-0.5 text-foreground transition-opacity hover:opacity-70"
            aria-current={active ? "page" : undefined}
            {...("external" in link ? { target: "_blank", rel: "noreferrer" } : {})}
          >
            {link.label}
          </a>
        )
      })}
    </nav>
  )
}
