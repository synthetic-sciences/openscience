import { type JSX, Show } from "solid-js"
import { FONT_SERIF } from "@/styles/tokens"

interface WordmarkProps {
  size?: "sm" | "md" | "lg"
  /** Label only (no logo) for tight spaces. */
  textOnly?: boolean
  onClick?: () => void
}

export function Wordmark(props: WordmarkProps): JSX.Element {
  const size = () => props.size ?? "md"
  const px = () =>
    size() === "lg" ? { logo: 30, text: 28 } : size() === "sm" ? { logo: 22, text: 18 } : { logo: 26, text: 22 }
  return (
    <button
      onClick={props.onClick}
      class="thesis-wordmark"
      style={{
        all: "unset",
        cursor: props.onClick ? "pointer" : "default",
        display: "inline-flex",
        "align-items": "center",
        gap: size() === "sm" ? "8px" : "10px",
      }}
    >
      <Show when={!props.textOnly}>
        <img
          src="/openscience-logo.png"
          alt=""
          style={{
            width: `${px().logo}px`,
            height: `${px().logo}px`,
            "object-fit": "contain",
            "flex-shrink": 0,
          }}
        />
      </Show>
      <span
        style={{
          "font-family": FONT_SERIF,
          "font-size": `${px().text}px`,
          "font-weight": 400,
          "letter-spacing": "-0.02em",
          color: "var(--color-text)",
          "white-space": "nowrap",
        }}
      >
        OpenScience
      </span>
    </button>
  )
}
