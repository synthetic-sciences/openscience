/* How an Ace Wallet moves: a stepped balance line that drops per request
   and jumps when auto reload adds $20 at the $5 floor. An illustration of
   the mechanics, not a measurement. Drawn like sfcompute.com's price chart. */
export function WalletFigure() {
  const W = 720
  const H = 200
  const left = 44
  const right = W - 16
  const top = 16
  const bottom = H - 28
  const sy = (dollars: number) => bottom - (dollars / 25) * (bottom - top)
  /* Balance after each request over a month, with two reloads. */
  const steps = [
    20, 19.2, 18.1, 17.7, 15.9, 14.2, 13.8, 12.1, 10.4, 9.9, 8.2, 6.6, 5.4, 4.7, 24.7, 23.1, 22.4, 20.8, 19.3, 17.6,
    16.9, 15.1, 13.4, 12.8, 11.2, 9.5, 8.1, 6.9, 5.2, 4.6, 24.6,
  ]
  const sx = (index: number) => left + (index / (steps.length - 1)) * (right - left)
  const path = steps
    .map((value, index) => (index === 0 ? `M${sx(0)} ${sy(value)}` : `H${sx(index)} V${sy(value)}`))
    .join(" ")
  const weeks = ["Sep 1", "Sep 8", "Sep 15", "Sep 22", "Sep 29"]

  return (
    <figure data-component="wallet">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="A Wallet balance stepping down per request and reloading by $20 at the $5 floor"
      >
        {[5, 10, 15, 20].map((dollars) => (
          <g key={dollars}>
            <line
              x1={left}
              y1={sy(dollars)}
              x2={right}
              y2={sy(dollars)}
              stroke="var(--color-border-weak)"
              strokeDasharray={dollars === 5 ? "3 3" : undefined}
            />
            <text x={left - 8} y={sy(dollars) + 3.5} textAnchor="end" fontSize="11" fill="var(--color-text-weak)">
              ${dollars}
            </text>
          </g>
        ))}
        {weeks.map((label, index) => {
          const x = left + (index / (weeks.length - 1)) * (right - left)
          return (
            <g key={label}>
              <line x1={x} y1={top} x2={x} y2={bottom} stroke="var(--color-border-weak)" strokeDasharray="1.5 3" />
              <text x={x} y={bottom + 16} textAnchor="middle" fontSize="11" fill="var(--color-text-weak)">
                {label}
              </text>
            </g>
          )
        })}
        <line x1={left} y1={bottom + 0.5} x2={right} y2={bottom + 0.5} stroke="var(--color-text)" />
        <path d={path} fill="none" stroke="var(--color-text-strong)" strokeWidth="1.25" />
        {[14, 30].map((index) => (
          <circle
            key={index}
            cx={sx(index)}
            cy={sy(steps[index])}
            r="3.5"
            fill="var(--color-background)"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
          />
        ))}
        <text x={sx(14) + 8} y={sy(steps[14]) - 6} fontSize="11" fill="var(--color-accent)">
          auto reload +$20
        </text>
        <text x={left + 6} y={sy(5) - 5} fontSize="11" fill="var(--color-text-weak)">
          $5 reload floor
        </text>
      </svg>
      <figcaption>
        <span data-slot="fig">Fig 1.</span>
        <strong>A Wallet over a month.</strong>
        Each request settles at the provider's reported cost; below $5, auto reload adds $20 if you turned it on.
      </figcaption>
    </figure>
  )
}
