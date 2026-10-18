import { Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"

export function StudyFraming(props: {
  study: { id: string; question?: string; hypothesis?: string }
  save: (input: { question: string; hypothesis: string }) => Promise<void>
}) {
  const [state, setState] = createStore({ editing: false, busy: false, question: "", hypothesis: "", error: "" })
  createEffect(
    on(
      () => props.study.id,
      () => setState({ editing: false, busy: false, error: "" }),
      { defer: true },
    ),
  )
  const save = async () => {
    if (state.busy) return
    const id = props.study.id
    setState({ busy: true, error: "" })
    await props
      .save({ question: state.question.trim(), hypothesis: state.hypothesis.trim() })
      .then(() => {
        if (props.study.id === id) setState({ editing: false })
      })
      .catch(() => {
        if (props.study.id === id)
          setState({ error: "Could not save the research question and hypothesis. Please retry." })
      })
      .finally(() => {
        if (props.study.id === id) setState({ busy: false })
      })
  }
  return (
    <section aria-label="Research question and hypothesis">
      <Show
        when={state.editing}
        fallback={
          <>
            <dl class="ar-facts">
              <div>
                <dt>Research question</dt>
                <dd>{props.study.question || "Not recorded"}</dd>
              </div>
              <div>
                <dt>Hypothesis</dt>
                <dd>{props.study.hypothesis || "Not recorded"}</dd>
              </div>
            </dl>
            <Button
              size="small"
              variant="secondary"
              onClick={() =>
                setState({
                  editing: true,
                  question: props.study.question ?? "",
                  hypothesis: props.study.hypothesis ?? "",
                  error: "",
                })
              }
            >
              Edit question and hypothesis
            </Button>
          </>
        }
      >
        <form
          class="ar-framing"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label>
            Research question
            <textarea
              value={state.question}
              maxLength={4000}
              disabled={state.busy}
              onInput={(event) => setState("question", event.currentTarget.value)}
            />
          </label>
          <label>
            Hypothesis
            <textarea
              value={state.hypothesis}
              maxLength={4000}
              disabled={state.busy}
              onInput={(event) => setState("hypothesis", event.currentTarget.value)}
            />
          </label>
          <Button type="submit" size="small" disabled={state.busy}>
            Save
          </Button>
          <Button
            type="button"
            size="small"
            variant="ghost"
            disabled={state.busy}
            onClick={() => setState({ editing: false, error: "" })}
          >
            Cancel
          </Button>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
          </Show>
        </form>
      </Show>
    </section>
  )
}
