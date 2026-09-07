import { FaqSection } from "@/components/Faq"
import { Footer, Legal } from "@/components/Footer"
import Header from "@/components/Header"
import { useMeta } from "@/components/Meta"
import { ProviderMark, ProviderRow, PROVIDER_NAMES } from "@/components/ProviderMark"
import { WalletFigure } from "@/components/WalletFigure"
import { DASHBOARD, docs } from "@/data/links"

/* Mirrors backend/cli/src/provider/managed-catalog.ts. Keep in sync when the
   roster changes. Context and output are token counts. */
const MODELS: readonly {
  id: string
  name: string
  provider: string
  context: number
  output: number
  inputs: readonly string[]
}[] = [
  {
    id: "openai",
    name: "GPT-5.6 Sol",
    provider: "openai",
    context: 1_050_000,
    output: 128_000,
    inputs: ["text", "image", "pdf"],
  },
  {
    id: "openai",
    name: "GPT-5.6 Terra",
    provider: "openai",
    context: 1_050_000,
    output: 128_000,
    inputs: ["text", "image", "pdf"],
  },
  {
    id: "openai",
    name: "GPT-5.6 Luna",
    provider: "openai",
    context: 1_050_000,
    output: 128_000,
    inputs: ["text", "image", "pdf"],
  },
  {
    id: "anthropic",
    name: "Claude Opus 5",
    provider: "anthropic",
    context: 1_000_000,
    output: 128_000,
    inputs: ["text", "image", "pdf"],
  },
  {
    id: "anthropic",
    name: "Claude Fable 5",
    provider: "anthropic",
    context: 1_000_000,
    output: 128_000,
    inputs: ["text", "image", "pdf"],
  },
  {
    id: "anthropic",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    context: 1_000_000,
    output: 128_000,
    inputs: ["text", "image", "pdf"],
  },
  {
    id: "anthropic",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    context: 200_000,
    output: 64_000,
    inputs: ["text", "image", "pdf"],
  },
  {
    id: "gemini",
    name: "Gemini 3.1 Pro Preview",
    provider: "gemini",
    context: 1_048_576,
    output: 65_536,
    inputs: ["text", "image", "video", "audio", "pdf"],
  },
  {
    id: "gemini",
    name: "Gemini 3.7 Flash",
    provider: "gemini",
    context: 1_048_576,
    output: 65_536,
    inputs: ["text", "image", "video", "audio", "pdf"],
  },
  { id: "xai", name: "Grok 4.6", provider: "xai", context: 500_000, output: 450_000, inputs: ["text", "image", "pdf"] },
  { id: "zai", name: "GLM 5.3", provider: "zai", context: 1_310_720, output: 131_072, inputs: ["text"] },
  {
    id: "zai",
    name: "GLM 5.3 Flash",
    provider: "zai",
    context: 1_310_720,
    output: 131_072,
    inputs: ["text", "image", "video"],
  },
  {
    id: "deepseek",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    context: 1_048_576,
    output: 384_000,
    inputs: ["text"],
  },
  {
    id: "deepseek",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    context: 1_048_576,
    output: 384_000,
    inputs: ["text"],
  },
  {
    id: "qwen",
    name: "Qwen 3.8 Max",
    provider: "qwen",
    context: 1_000_000,
    output: 131_072,
    inputs: ["text", "image", "video"],
  },
  {
    id: "qwen",
    name: "Qwen 3.8 Flash Next",
    provider: "qwen",
    context: 1_000_000,
    output: 131_072,
    inputs: ["text", "image", "video"],
  },
  {
    id: "moonshotai",
    name: "Kimi K3",
    provider: "moonshotai",
    context: 1_048_576,
    output: 943_718,
    inputs: ["text", "image", "video"],
  },
  {
    id: "moonshotai",
    name: "Kimi K2.7 Code",
    provider: "moonshotai",
    context: 262_144,
    output: 235_929,
    inputs: ["text", "image"],
  },
  {
    id: "minimax",
    name: "MiniMax M3",
    provider: "minimax",
    context: 1_048_576,
    output: 512_000,
    inputs: ["text", "image", "video"],
  },
  {
    id: "meta",
    name: "Muse Spark 1.2",
    provider: "meta",
    context: 1_048_576,
    output: 943_718,
    inputs: ["text", "image", "video", "audio", "pdf"],
  },
  { id: "nvidia", name: "Nemotron 3 Ultra", provider: "nvidia", context: 262_144, output: 16_384, inputs: ["text"] },
]

const HAS_MARK = new Set([
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "zai",
  "deepseek",
  "moonshotai",
  "minimax",
  "meta",
  "nvidia",
])

/* Rows grouped by provider, in roster order, so the table reads like a
   booktabs table with one provider cell spanning its models. */
const GROUPS = MODELS.reduce<{ provider: string; models: (typeof MODELS)[number][] }[]>((groups, model) => {
  const last = groups[groups.length - 1]
  if (last && last.provider === model.provider) last.models.push(model)
  else groups.push({ provider: model.provider, models: [model] })
  return groups
}, [])

function tokens(value: number) {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 2).replace(/\.?0+$/, "")}M`
  return `${Math.round(value / 1000)}K`
}

function Arrow() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6.5 12L17 12M13 16.5L17.5 12L13 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  )
}

const INCLUDED: readonly (readonly [string, string, boolean?])[] = [
  ["Managed models", "21 reviewed models from OpenAI, Anthropic, Google, xAI, and more, on validated routes"],
  ["Managed search", "Research search for the agent with no search key to manage"],
  ["Memory", "Persistent memory across your sessions and projects"],
  ["Ace-first plugins", "Exclusive integrations that land on Ace first", true],
]

const FAQ = [
  {
    q: "What is Ace?",
    a: (
      <p>
        Ace is the managed service inside OpenScience: reviewed models, research search, and memory, behind one Wallet.
        Sign in to Synthetic Sciences, add a balance, and every model in the roster is available from the model selector
        with no provider accounts to set up.
      </p>
    ),
  },
  {
    q: "What does Ace include?",
    a: (
      <p>
        Managed models on validated routes, managed research search with no search key to manage, and memory that
        persists across sessions. Ace-first plugins are coming soon. Everything else in OpenScience stays free and works
        without Ace.
      </p>
    ),
  },
  {
    q: "What makes Ace more reliable?",
    a: (
      <p>
        The same model can behave differently depending on which route serves it: quantized deployments, truncated
        context windows, and broken tool calling are common. Ace tests each model-and-route pair on scientific agent
        workloads before it enters the roster, verifies the route against the published model card, and drops routes
        that regress.
      </p>
    ),
  },
  {
    q: "Is Ace cheaper?",
    a: (
      <p>
        Ace charges what the provider reports. OpenRouter routes cost the provider's reported usage plus a 5.5% funding
        adjustment; native Anthropic, Google, and xAI routes are billed at their published standard rates. There is no
        Ace service fee. See <a href={docs("pricing")}>pricing</a>.
      </p>
    ),
  },
  {
    q: "How much does Ace cost?",
    a: (
      <p>
        Activation is free. You add a $20 pay-as-you-go balance, and each request debits the verified cost once it
        settles. A request may reserve funds while it runs; unused reservations are released, and a small request is
        never rounded up to a full cent. Card processing charges are disclosed at checkout and are separate from your
        Wallet value.
      </p>
    ),
  },
  {
    q: "What about data and privacy?",
    a: (
      <p>
        Ace requests pass through the Synthetic Sciences gateway to the provider. The gateway records the route, token
        counts, and cost so it can bill you; it does not keep your prompts or outputs unless you opt in to trace
        sharing. Read the <a href="/privacy">privacy page</a>.
      </p>
    ),
  },
  {
    q: "Can I set spend limits?",
    a: (
      <p>
        Yes. Auto reload is off until you turn it on, and when it is on you set a monthly cap. With auto reload off,
        spending stops when the balance runs out.
      </p>
    ),
  },
  {
    q: "Which Wallet pays?",
    a: (
      <p>
        The funding workspace selected in Customize → General. Balances are not pooled across workspaces, and if that
        workspace cannot pay, OpenScience does not silently switch to another one. Every managed request carries its
        funding context and the client rejects a response whose scope does not match.
      </p>
    ),
  },
  {
    q: "Can I cancel?",
    a: <p>Yes. Turn off auto reload at any time and keep using your remaining balance, or disconnect Ace entirely.</p>,
  },
  {
    q: "Can I still use my own keys?",
    a: (
      <p>
        Always. Your own provider keys, ChatGPT Plus or Pro sign-in, and local models never touch the gateway and never
        debit your Wallet. Local keys take precedence over Ace when both are configured for a provider.
      </p>
    ),
  },
]

export default function Ace() {
  useMeta({
    title: "OpenScience | Ace",
    description:
      "Ace is a reviewed roster of AI models tested and benchmarked for scientific agents, with one Wallet and transparent per-request pricing.",
    path: "/ace",
  })

  return (
    <main data-page="ace">
      <div data-component="container">
        <Header current="ace" />

        <div data-component="content">
          <section data-component="hero">
            <div data-slot="hero-copy">
              <h1>Reliable, optimized models for scientific agents</h1>
              <p>
                Ace gives you access to a handpicked set of AI models, search and memory providers that OpenScience has
                tested and benchmarked for scientific agents. No need to worry about inconsistent performance and
                quality, use validated models that work.
              </p>
              <ProviderRow />
              <a href={DASHBOARD} data-slot="button" target="_blank" rel="noreferrer">
                <span>Get started with Ace</span>
                <Arrow />
              </a>
            </div>
            <div data-slot="pricing-copy">
              <p>
                <strong>Add a $20 pay-as-you-go balance</strong> <span>(card processing fee shown at checkout)</span>
              </p>
              <p>Models, search, and memory in one Wallet. Set a monthly cap. Cancel any time.</p>
            </div>
          </section>

          <section data-component="section" id="included" data-nav="What it includes">
            <div data-slot="section-title">
              <h3>What Ace includes</h3>
              <p>One sign-in adds the managed services to OpenScience. Your own keys and local models keep working.</p>
            </div>
            <ul data-slot="list">
              {INCLUDED.map(([term, body, soon]) => (
                <li key={term}>
                  <span data-slot="marker">•</span>
                  <div>
                    <strong>{term}</strong>
                    {body}
                    {soon ? <em data-slot="soon">coming soon</em> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section data-component="section" id="how" data-nav="How it works">
            <div data-slot="section-title">
              <h3>How Ace works</h3>
              <p>Ace is built into OpenScience. Use it alongside your own keys, subscriptions, and local models.</p>
            </div>
            <ol data-slot="list">
              <li>
                <span data-slot="marker">1.</span>
                <div>
                  <strong>Sign in and add a $20 balance</strong>Customize → Models → Ace, or follow the{" "}
                  <a href={docs("gateway")}>setup instructions</a>
                </div>
              </li>
              <li>
                <span data-slot="marker">2.</span>
                <div>
                  <strong>Pay per request</strong>At the provider's <a href={docs("pricing")}>reported cost</a>, settled
                  from verified usage, with no Ace fee
                </div>
              </li>
              <li>
                <span data-slot="marker">3.</span>
                <div>
                  <strong>Auto reload, if you want it</strong>When your balance falls below $5 we add $20, up to the
                  monthly cap you set
                </div>
              </li>
            </ol>
            <WalletFigure />
          </section>

          <section data-component="section" id="models" data-nav="Models">
            <div data-slot="section-title">
              <h3>Models</h3>
              <p>
                The roster ships with the client. Rates and limits are shown in Customize → Models before you choose.
              </p>
            </div>
            <div data-component="catalog">
              <div data-component="table" data-variant="paper">
                <table>
                  <caption>
                    <strong>Table 1.</strong> The Ace roster, verified against the provider catalogs on 30 August 2026.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">Model</th>
                      <th scope="col" data-align="right">
                        Context
                      </th>
                      <th scope="col" data-align="right">
                        Max output
                      </th>
                      <th scope="col">Inputs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {GROUPS.map((group) =>
                      group.models.map((model, index) => (
                        <tr key={model.name} {...(index === 0 ? { "data-group": "" } : {})}>
                          {index === 0 ? (
                            <th scope="rowgroup" rowSpan={group.models.length}>
                              <span data-slot="model-name">
                                {HAS_MARK.has(group.provider) ? <ProviderMark id={group.provider} /> : null}
                                {PROVIDER_NAMES[group.provider] ?? group.provider}
                              </span>
                            </th>
                          ) : null}
                          <td>{model.name}</td>
                          <td data-align="right">{tokens(model.context)}</td>
                          <td data-align="right">{tokens(model.output)}</td>
                          <td>
                            <span data-slot="muted">{model.inputs.join(", ")}</span>
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <FaqSection items={FAQ} />

          <Footer />
        </div>
      </div>

      <Legal />
    </main>
  )
}
