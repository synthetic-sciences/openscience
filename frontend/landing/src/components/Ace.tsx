import { DOCS } from "./Site"

export default function Ace() {
  return (
    <div id="ace" className="ace-offer">
      <div className="ace-copy">
        <p className="eyebrow">Optional / Pay as you go</p>
        <h3>OpenScience Ace.</h3>
        <p>
          Use managed models and research search with one Wallet. Sign in with Synthetic Sciences, choose a model, and
          get to work. No individual provider keys to set up.
        </p>
        <div className="ace-actions">
          <a className="button button-dark" href="https://app.syntheticsciences.ai/billing">
            Get Ace <span className="button-dot" aria-hidden="true" />
          </a>
          <a className="text-link" href={`${DOCS}/#/openscience/pricing`}>
            How pricing works
          </a>
        </div>
      </div>
      <div className="ace-terms">
        <div className="ace-price">
          <span>$20</span>
          <p>
            per automatic
            <br />
            Wallet reload
          </p>
        </div>
        <dl>
          <div>
            <dt>Enable Ace</dt>
            <dd>$0</dd>
          </div>
          <div>
            <dt>Usage</dt>
            <dd>Pay as you go</dd>
          </div>
          <div>
            <dt>Automatic reload</dt>
            <dd>$20 when below $5</dd>
          </div>
          <div>
            <dt>Monthly subscription</dt>
            <dd>None</dd>
          </div>
        </dl>
        <p className="ace-fineprint">
          While Ace is on, the reload adds $20 to your purchased Wallet balance. Payment-processing fees are disclosed
          separately before payment. Set a monthly usage limit or turn off future reloads in your account.
        </p>
      </div>
    </div>
  )
}
