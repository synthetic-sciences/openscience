import { useId, useState, type ReactNode } from "react"

export function Faq({ question, children }: { question: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div data-slot="faq-item" {...(open ? { "data-expanded": "" } : { "data-closed": "" })}>
      <button
        type="button"
        data-slot="faq-question"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M5 11.5H19V12.5H5Z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12.5 11.5H19V12.5H12.5V19H11.5V12.5H5V11.5H11.5V5H12.5V11.5Z" fill="currentColor" />
          </svg>
        )}
        <div data-slot="faq-question-text">{question}</div>
      </button>
      {open ? (
        <div id={id} data-slot="faq-answer">
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function FaqSection({ items, title = "FAQ" }: { items: { q: string; a: ReactNode }[]; title?: string }) {
  return (
    <section data-component="faq" id="faq">
      <div data-slot="section-title">
        <h3>{title}</h3>
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.q}>
            <Faq question={item.q}>{item.a}</Faq>
          </li>
        ))}
      </ul>
    </section>
  )
}
