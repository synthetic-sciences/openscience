import { type JSX, Show } from "solid-js"
import { FONT_SANS } from "@/styles/tokens"

interface WordmarkProps {
  size?: "sm" | "md" | "lg"
  /** Label only (no logo) for tight spaces. */
  textOnly?: boolean
  onClick?: () => void
}

export function Wordmark(props: WordmarkProps): JSX.Element {
  const size = () => props.size ?? "md"
  const px = () =>
    size() === "lg" ? { logo: 30, text: 28 } : size() === "sm" ? { logo: 20, text: 14.5 } : { logo: 26, text: 22 }
  const weight = () => (size() === "sm" ? "var(--font-weight-emphasis)" : "var(--font-weight-regular)")
  const rootStyle = (): JSX.CSSProperties => ({
    all: "unset",
    cursor: props.onClick ? "pointer" : "default",
    display: "inline-flex",
    "align-items": "center",
    gap: size() === "sm" ? "7px" : "10px",
  })
  const content = () => (
    <>
      <Show when={!props.textOnly}>
        <img
          src="/openscience-logo.png"
          alt=""
          aria-hidden="true"
          style={{
            width: `${px().logo}px`,
            height: `${px().logo}px`,
            "object-fit": "contain",
            "flex-shrink": 0,
          }}
        />
      </Show>
      <span
        aria-hidden="true"
        style={{
          "font-family": FONT_SANS,
          "font-size": `${px().text}px`,
          "font-weight": weight(),
          "letter-spacing": "-0.02em",
          color: "var(--color-text)",
          "white-space": "nowrap",
        }}
      >
        OpenScience
      </span>
    </>
  )
  return (
    <Show
      when={props.onClick}
      fallback={
        <span class="atlas-wordmark" role="img" aria-label="OpenScience" style={rootStyle()}>
          {content()}
        </span>
      }
    >
      <button type="button" class="atlas-wordmark" aria-label="OpenScience" onClick={props.onClick} style={rootStyle()}>
        {content()}
      </button>
    </Show>
  )
}
