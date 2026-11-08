/**
 * Readable dollar amounts for summaries: cents from one cent up ($0.24, $1,250.00), two significant
 * digits below a cent ($0.0012) so small charges never read as $0.00. Show exact values separately
 * (a title or an audit row) where precision matters.
 */
export function formatUsd(dollars: number, locale = "en-US") {
  const small = dollars !== 0 && Math.abs(dollars) < 0.01
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    ...(small ? { maximumSignificantDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }).format(dollars)
}

/** Exact dollar amount with every stored digit, for tooltips and audit rows. */
export function exactUsd(dollars: number, locale = "en-US") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 9,
  }).format(dollars)
}
