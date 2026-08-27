const LINKS = [
  { id: "download", label: "Download", href: "/download" },
  { id: "docs", label: "Docs", href: "https://openscience.sh/docs" },
  { id: "github", label: "GitHub", href: "https://github.com/synthetic-sciences/openscience", external: true },
] as const

export default function Nav({ current }: { current?: "download" }) {
  return (
    <nav
      className="flex items-center gap-3 text-[12px] font-bold tracking-[0.015em] text-black drop-shadow-[0_0_3px_rgba(239,232,216,0.9)] sm:gap-4 sm:text-[12.5px]"
      aria-label="Primary navigation"
    >
      {LINKS.map((link) => {
        const active = current === link.id
        return (
          <a
            key={link.id}
            href={link.href}
            className={`inline-flex min-h-11 items-center px-0.5 text-black underline underline-offset-[5px] transition-[text-decoration-color] ${
              active
                ? "decoration-2 decoration-[hsl(var(--accent-coral))]"
                : "decoration-[1px] decoration-black/60 hover:decoration-black"
            }`}
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
