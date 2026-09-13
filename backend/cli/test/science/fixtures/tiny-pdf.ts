/** A minimal two-page PDF with one line of text per page, for the extractor. */
export function tinyPDF(lines: string[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => {
    objects.push(body)
    return objects.length
  }
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const pagesRef = objects.length + 1 + lines.length * 2
  const pageRefs: number[] = []
  for (const line of lines) {
    const stream = `BT /F1 12 Tf 72 720 Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    const page = add(
      `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    )
    pageRefs.push(page)
  }
  const pages = add(`<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`)
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out))
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}
