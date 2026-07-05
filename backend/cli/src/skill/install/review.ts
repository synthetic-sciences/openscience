import type { SkillEntry } from "./fetcher"

export interface Rejection {
  name: string
  reason: string
}
export interface Warning {
  name: string
  file: string
  line: number
  snippet: string
  pattern: string
}
export interface RegexPassResult {
  rejected: Rejection[]
  warnings: Warning[]
}

// ── Layer 1 — auto-reject ───────────────────────────────────────────────────

const DESCRIPTION_INJECTION = [
  /always run this skill/i,
  /must always run/i,
  /ignore\s+(prior|previous|above)\s+instructions/i,
]
const CATASTROPHIC = [
  // Bare rm -rf / or /* — no path suffix
  /\brm\s+-rf\s+\/(\*)?(\s|$)/,
  // Fork bomb
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  // Common reverse-shell oneliners
  /bash\s+-i\s+>&\s+\/dev\/tcp\//,
  /nc\s+-e\s+\/bin\/(sh|bash)/,
]

/** Layer 1: catastrophic patterns. Any hit rejects the whole skill. */
export function runtimeRegexPass(manifest: SkillEntry[]): RegexPassResult {
  const rejected: Rejection[] = []
  for (const skill of manifest) {
    const desc = extractDescription(skill.content)
    let matched = false
    for (const re of DESCRIPTION_INJECTION) {
      if (re.test(desc)) {
        rejected.push({ name: skill.name, reason: `description matches ${re}` })
        matched = true
        break
      }
    }
    if (matched) continue
    const bodies = [
      { file: "SKILL.md", content: skill.content },
      ...skill.scripts.map((s) => ({ file: s.path, content: s.content })),
    ]
    outer: for (const { file, content } of bodies) {
      for (const re of CATASTROPHIC) {
        const match = content.match(re)
        if (match) {
          rejected.push({
            name: skill.name,
            reason: `${file} matches catastrophic pattern ${re} (${match[0].trim()})`,
          })
          break outer
        }
      }
    }
  }
  return { rejected, warnings: [] }
}

// ── Layer 2 — classifier-injection pre-filter (auto-reject) ─────────────────

const CLASSIFIER_INJECTION: { re: RegExp; label: string }[] = [
  { re: /respond\s+with\s+verdict\s*:?\s*(pass|safe|approve)/i, label: "respond with verdict: pass" },
  { re: /output\s*:?\s*\{[^}]*"verdict"\s*:\s*"pass"/i, label: "structured pass output" },
  { re: /ignore.*(prior|previous|above).*(instructions|prompt)/i, label: "ignore prior instructions" },
  { re: /this\s+is\s+a\s+(safety|security)\s+(audit|test).*(approve|pass)/i, label: "audit-bypass appeal" },
  { re: /act\s+as.*?(auditor|reviewer).*?(pass|approve)/i, label: "audit-roleplay" },
  { re: /the\s+correct\s+verdict\s+is.*(safe|pass)/i, label: "verdict steering" },
]

/** Layer 2: classifier-targeted injection. Hits reject the skill before
 *  the classifier ever sees its content. */
export function classifierInjectionRegexPass(manifest: SkillEntry[]): RegexPassResult {
  const rejected: Rejection[] = []
  for (const skill of manifest) {
    const haystacks = [skill.content, ...skill.scripts.map((s) => s.content)]
    outer: for (const text of haystacks) {
      for (const { re, label } of CLASSIFIER_INJECTION) {
        if (re.test(text)) {
          rejected.push({ name: skill.name, reason: `classifier-injection (${label})` })
          break outer
        }
      }
    }
  }
  return { rejected, warnings: [] }
}

// ── Layer 4 — warnings ──────────────────────────────────────────────────────

const SUSPICIOUS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+-rf\s+(~|\$HOME|\/home(\b|\/))/, label: "home-dir rm -rf" },
  { re: /\bcurl\b[^\n|]*\|\s*(sh|bash)\b/, label: "curl | sh" },
  { re: /\bwget\b[^\n|]*\|\s*(sh|bash)\b/, label: "wget | sh" },
  { re: /~\/\.ssh\b/, label: "~/.ssh read" },
  { re: /~\/\.aws\b/, label: "~/.aws read" },
  { re: /~\/\.kube\/config\b/, label: "~/.kube/config read" },
  { re: /\beval\s+(?:\$\(|`)/, label: "eval $(...)" },
  { re: /\bbase64\b[^\n|]*-d[^\n|]*\|\s*(sh|bash)\b/, label: "base64 -d | sh" },
]

/** Layer 4: suspicious patterns. Hits become warnings only — user decides. */
export function suspiciousRegexPass(manifest: SkillEntry[]): RegexPassResult {
  const warnings: Warning[] = []
  for (const skill of manifest) {
    const files: { file: string; content: string }[] = [
      { file: "SKILL.md", content: skill.content },
      ...skill.scripts.map((s) => ({ file: s.path, content: s.content })),
    ]
    for (const { file, content } of files) {
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const { re, label } of SUSPICIOUS) {
          if (re.test(line)) {
            warnings.push({
              name: skill.name,
              file,
              line: i + 1,
              snippet: line.trim(),
              pattern: label,
            })
          }
        }
      }
    }
  }
  return { rejected: [], warnings }
}

function extractDescription(skillMd: string): string {
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return ""
  const line = fmMatch[1].split("\n").find((l) => l.trim().startsWith("description:"))
  if (!line) return ""
  return line.replace(/^\s*description:\s*/, "").trim()
}
