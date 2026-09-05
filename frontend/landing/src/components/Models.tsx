import { useState } from "react"
import { MODELS } from "@/data/models"
import { Mark } from "./Site"

export default function Models() {
  const [selected, setSelected] = useState(MODELS[0])
  const [query, setQuery] = useState("")
  const matches = MODELS.filter((model) =>
    `${model.name} ${model.provider}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <figure className="model-preview" aria-label="OpenScience model picker preview">
      <figcaption className="model-preview-header">
        <span>
          <Mark />
          OpenScience
        </span>
        <span>Model picker preview</span>
      </figcaption>
      <div className="model-picker">
        <div className="picker-heading">Choose a model</div>
        <div className="picker-search">
          <input
            type="search"
            aria-label="Search models in the preview"
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <fieldset className="picker-models">
          <legend className="sr-only">Choose a model for this preview</legend>
          {matches.map((model) => (
            <label key={model.id} className="picker-row">
              <input
                type="radio"
                name="preview-model"
                value={model.id}
                checked={selected.id === model.id}
                onChange={() => setSelected(model)}
              />
              <span className="picker-option">
                <span>
                  <strong>{model.name}</strong>
                  <small>{model.provider}</small>
                </span>
                <span className="picker-selected" aria-hidden="true" />
              </span>
            </label>
          ))}
          {matches.length === 0 && (
            <p className="picker-empty" role="status">
              No models found.
            </p>
          )}
        </fieldset>
      </div>
      <div className="model-composer">
        <p>Ask about your research…</p>
        <div>
          <span>Research</span>
          <span className="composer-model" aria-live="polite">
            {selected.name}
          </span>
        </div>
      </div>
      <p className="model-preview-note">Available models depend on your connections.</p>
    </figure>
  )
}
