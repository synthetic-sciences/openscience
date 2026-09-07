import { useEffect, useState } from "react"
import { CHANGELOG, DOCS, GITHUB, LICENSE, SECURITY, SYNTHETIC_SCIENCES, X } from "@/data/links"

function useStars() {
  const [stars, setStars] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch("https://api.github.com/repos/synthetic-sciences/OpenScience", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { stargazers_count?: number } | null) => {
        if (typeof data?.stargazers_count !== "number") return
        setStars(
          new Intl.NumberFormat("en", { notation: "compact", compactDisplay: "short" }).format(data.stargazers_count),
        )
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  return stars
}

export function Footer() {
  const stars = useStars()
  return (
    <footer data-component="footer">
      <div data-slot="cell">
        <a href={GITHUB} target="_blank" rel="noreferrer">
          GitHub {stars ? <span>[{stars}]</span> : null}
        </a>
      </div>
      <div data-slot="cell">
        <a href={DOCS}>Docs</a>
      </div>
      <div data-slot="cell">
        <a href={CHANGELOG} target="_blank" rel="noreferrer">
          Changelog
        </a>
      </div>
      <div data-slot="cell">
        <a href={SYNTHETIC_SCIENCES} target="_blank" rel="noreferrer">
          Synthetic Sciences
        </a>
      </div>
      <div data-slot="cell">
        <a href={X} target="_blank" rel="noreferrer">
          X
        </a>
      </div>
    </footer>
  )
}

export function Legal() {
  return (
    <div data-component="legal">
      <span>
        &copy;{new Date().getFullYear()}{" "}
        <a href={SYNTHETIC_SCIENCES} target="_blank" rel="noreferrer">
          Synthetic Sciences
        </a>
      </span>
      <span>
        <a href="/privacy">Privacy</a>
      </span>
      <span>
        <a href={SECURITY} target="_blank" rel="noreferrer">
          Security
        </a>
      </span>
      <span>
        <a href={LICENSE} target="_blank" rel="noreferrer">
          Apache 2.0
        </a>
      </span>
    </div>
  )
}
