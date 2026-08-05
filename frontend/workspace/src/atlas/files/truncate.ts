// Five artifacts named proteomics_* are told apart by their middle and their
// suffix, never by their first ten characters — so truncate the middle and
// keep both ends.
export function middle(name: string, keep: number) {
  if (name.length <= keep) return name
  const head = Math.ceil(keep / 3)
  const tail = keep - 2 - head
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`
}
