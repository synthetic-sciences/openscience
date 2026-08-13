import { For, Show, type JSX } from "solid-js"
import { captured, type ExecutionRecord } from "@/atlas/ExecutionHistoryAPI"
import { kernelMemoryLabel } from "@/atlas/kernel-runtime"

const statusLabel = (value: ExecutionRecord["status"]) => value.charAt(0).toUpperCase() + value.slice(1)

const duration = (run: ExecutionRecord) => {
  const value = captured(run.timing.duration_ms)
  if (value === undefined) return "Duration not captured"
  if (value < 1_000) return `${value} ms`
  const seconds = value / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

const language = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (normalized === "python") return "Python"
  if (normalized === "r") return "R"
  return value || "Execution"
}

const result = (run: ExecutionRecord) => {
  const summary = run.result.summary.trim()
  if (summary) return summary
  const error = run.result.error.trim()
  if (error) return error.split("\n")[0]
  const output = run.result.stdout
    .trim()
    .split("\n")
    .findLast((line) => line.trim())
  if (output) return output
  if (run.status === "succeeded") return "Completed without text output"
  if (run.status === "running") return "Running"
  return statusLabel(run.status)
}

const logs = (run: ExecutionRecord) =>
  [
    run.result.stdout.trim() ? `stdout\n${run.result.stdout.trim()}` : "",
    run.result.stderr.trim() ? `stderr\n${run.result.stderr.trim()}` : "",
    run.result.error.trim() ? `error\n${run.result.error.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

const fileCount = (run: ExecutionRecord) => run.files.length + run.artifacts.length

export function ExecutionCard(props: { run: ExecutionRecord }): JSX.Element {
  const code = () => captured(props.run.code)?.trim()
  const output = () => logs(props.run)
  const environment = () => captured(props.run.environment.name)
  const interpreter = () => captured(props.run.environment.interpreter)
  const resources = () => captured(props.run.resources)

  return (
    <article class="activity-card execution-card" data-execution-id={props.run.id} data-state={props.run.status}>
      <header class="activity-card__header">
        <div class="activity-card__identity">
          <span class="activity-card__kind">{language(props.run.language)}</span>
          <div class="kernel-card__copy">
            <strong>{result(props.run)}</strong>
            <span>
              Run {props.run.sequence} · {duration(props.run)}
              <Show when={props.run.result.output_count > 0}>
                {` · ${props.run.result.output_count} ${props.run.result.output_count === 1 ? "output" : "outputs"}`}
              </Show>
              <Show when={fileCount(props.run) > 0}>
                {` · ${fileCount(props.run)} ${fileCount(props.run) === 1 ? "file" : "files"}`}
              </Show>
              <Show when={props.run.environment.restart_boundary}> · Fresh runtime</Show>
            </span>
          </div>
        </div>
        <Show when={props.run.status !== "succeeded"}>
          <span class="activity-card__status" data-tone={props.run.status}>
            {statusLabel(props.run.status)}
          </span>
        </Show>
      </header>

      <div class="activity-card__disclosures">
        <Show when={code()}>
          {(value) => (
            <Disclosure label="Code">
              <pre>
                <code>{value()}</code>
              </pre>
            </Disclosure>
          )}
        </Show>
        <Show when={output()}>
          {(value) => (
            <Disclosure label="Logs">
              <pre>{value()}</pre>
            </Disclosure>
          )}
        </Show>
        <Show when={fileCount(props.run) > 0}>
          <Disclosure label="Files">
            <ul class="execution-card__files">
              <For each={props.run.files}>
                {(file) => (
                  <li>
                    <span>{file.path}</span>
                    <small>{kernelMemoryLabel(file.size)}</small>
                  </li>
                )}
              </For>
              <For each={props.run.artifacts}>
                {(artifact) => (
                  <li>
                    <span>{artifact.label}</span>
                    <small>{artifact.kind}</small>
                  </li>
                )}
              </For>
            </ul>
          </Disclosure>
        </Show>
        <Disclosure label="Run details" quiet>
          <dl class="activity-card__facts">
            <Fact label="Environment" value={environment() ?? "Not captured"} />
            <Fact
              label="Interpreter"
              value={interpreter() ? `${interpreter()!.name} · ${interpreter()!.binary}` : "Not captured"}
            />
            <Fact
              label="Resources"
              value={
                resources()
                  ? [
                      resources()!.memory_bytes === undefined
                        ? undefined
                        : `${kernelMemoryLabel(resources()!.memory_bytes)} memory`,
                      resources()!.cpu_percent === undefined
                        ? undefined
                        : `${(resources()!.cpu_percent! / 100).toFixed(1)} CPU cores`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Captured without a reading"
                  : "Not captured"
              }
            />
            <Fact label="Provenance" value={props.run.provenance_id ?? "Not recorded yet"} mono />
            <Show when={captured(props.run.environment.kernel_id)}>
              {(value) => <Fact label="Runtime" value={value()} mono />}
            </Show>
          </dl>
        </Disclosure>
      </div>
    </article>
  )
}

function Disclosure(props: { label: string; quiet?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <details class="activity-disclosure" data-quiet={props.quiet ? "true" : undefined}>
      <summary>{props.label}</summary>
      <div class="activity-disclosure__body">{props.children}</div>
    </details>
  )
}

function Fact(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd data-mono={props.mono ? "true" : undefined}>{props.value}</dd>
    </div>
  )
}
