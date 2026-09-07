import { useState } from "react"

export function useCopy(text: string) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => setCopied(false),
    )
  }
  return { copied, copy }
}

export function CopyStatus() {
  return (
    <div data-component="copy-status" aria-hidden>
      <svg data-slot="copy" viewBox="0 0 16 16" fill="none">
        <path d="M5.5 5.5V2.5h8v8h-3M2.5 5.5h8v8h-8z" stroke="currentColor" strokeWidth="1" />
      </svg>
      <svg data-slot="check" viewBox="0 0 16 16" fill="none">
        <path d="m3 8.5 3.2 3L13 4.5" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </div>
  )
}
