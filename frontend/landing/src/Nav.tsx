const LINKS = [
  { id: "download", label: "Download", href: "/download" },
  { id: "docs", label: "Docs", href: "https://openscience.sh/docs" },
  { id: "github", label: "GitHub", href: "https://github.com/synthetic-sciences/openscience", external: true },
] as const

export default function Nav({ current }: { current?: "download" }) {
  return (
    <nav
      className="flex items-center gap-0.5 rounded-full border border-foreground/10 bg-background/70 px-1 text-[13.5px] font-bold tracking-[0.01em] shadow-[0_10px_32px_rgba(0,0,0,0.28)] backdrop-blur-md sm:gap-1 sm:text-[14px]"
      aria-label="Primary navigation"
    >
      {LINKS.map((link) => {
        const active = current === link.id
        return (
          <a
            key={link.id}
            href={link.href}
            className={`relative inline-flex min-h-11 items-center px-2.5 transition-colors after:absolute after:inset-x-2.5 after:bottom-1 after:h-px after:bg-[hsl(var(--accent-coral))] after:transition-transform sm:px-3 sm:after:inset-x-3 ${
              active
                ? "text-foreground after:scale-x-100"
                : "text-foreground/80 after:scale-x-0 hover:text-foreground hover:after:scale-x-100"
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
