import { useState } from "react"
import { BenchmarkFigure } from "@/components/BenchmarkFigure"
import { CopyStatus, useCopy } from "@/components/Copy"
import { FaqSection } from "@/components/Faq"
import { Footer, Legal } from "@/components/Footer"
import Header from "@/components/Header"
import { useMeta } from "@/components/Meta"
import { ProviderRow } from "@/components/ProviderMark"
import Workspace from "@/components/Workspace"
import { BENCHMARKS, PRELIMINARY } from "@/data/benchmarks"
import { DOCS, GITHUB, LICENSE, SYNTHETIC_SCIENCES, docs } from "@/data/links"

/* Install command per tab. `highlight` is the part set in ink. */
const INSTALL = [
  { key: "curl", before: "curl -fsSL ", protocol: "https://", highlight: "openscience.sh/install", after: " | bash" },
  { key: "npm", before: "npm install -g ", highlight: "@synsci/openscience" },
  { key: "npx", before: "npx ", highlight: "synsci" },
] as const

function Command({ item }: { item: (typeof INSTALL)[number] }) {
  const command = `${item.before}${"protocol" in item ? item.protocol : ""}${item.highlight}${"after" in item ? item.after : ""}`
  const { copied, copy } = useCopy(command)
  return (
    <button
      type="button"
      data-slot="command"
      onClick={copy}
      aria-label={`Copy: ${command}`}
      {...(copied ? { "data-copied": "" } : {})}
    >
      <span data-slot="command-script">
        <span>{item.before}</span>
        {"protocol" in item ? <span data-slot="protocol">{item.protocol}</span> : null}
        <span data-slot="highlight">{item.highlight}</span>
        {"after" in item ? <span>{item.after}</span> : null}
      </span>
      <CopyStatus />
    </button>
  )
}

function InstallTabs() {
  const [active, setActive] = useState<(typeof INSTALL)[number]["key"]>("curl")
  const item = INSTALL.find((entry) => entry.key === active) ?? INSTALL[0]
  return (
    <section data-component="tabs" aria-label="Install options">
      <div role="tablist" aria-orientation="horizontal" data-slot="tablist">
        {INSTALL.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            id={`install-tab-${entry.key}`}
            aria-selected={entry.key === active}
            aria-controls={`install-panel-${entry.key}`}
            data-slot="tab"
            tabIndex={entry.key === active ? 0 : -1}
            onClick={() => setActive(entry.key)}
            onKeyDown={(event) => {
              const index = INSTALL.findIndex((candidate) => candidate.key === active)
              if (event.key === "ArrowRight") setActive(INSTALL[(index + 1) % INSTALL.length].key)
              if (event.key === "ArrowLeft") setActive(INSTALL[(index - 1 + INSTALL.length) % INSTALL.length].key)
            }}
          >
            {entry.key}
          </button>
        ))}
      </div>
      <div data-slot="panels">
        <pre
          id={`install-panel-${item.key}`}
          role="tabpanel"
          aria-labelledby={`install-tab-${item.key}`}
          data-slot="panel"
        >
          <Command item={item} />
        </pre>
      </div>
    </section>
  )
}

const WHAT = [
  ["Model agnostic", "Free models included, or your own keys for any provider"],
  ["Scientific databases", "UniProt, PDB, ChEMBL, PubChem, arXiv, and 37 more, as tools"],
  ["Bundled skills", "312 skills across biology, chemistry, physics, ML, and writing"],
  ["ChatGPT Plus/Pro", "Sign in with OpenAI to use the subscription you already have"],
  ["Your compute", "Run experiments on your laptop, cluster, or cloud GPUs"],
  ["Multi-session", "Run several agents in parallel on the same project"],
] as const

const RIVALS = (() => {
  const chart = BENCHMARKS[2].chart
  const names =
    chart.kind === "comparison" ? chart.rows.filter((row) => row.name !== "OpenScience").map((row) => row.name) : []
  return names.length > 1 ? `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}` : names.join("")
})()

function Arrow() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6.5 12L17 12M13 16.5L17.5 12L13 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  )
}

const FAQ = [
  {
    q: "What is OpenScience?",
    a: (
      <p>
        OpenScience is an open-source AI co-scientist. Give it a goal and it reads the literature, forms a hypothesis,
        writes and runs code, runs experiments on your compute, queries the major scientific databases, and writes up
        the result. It runs as a workspace in your browser, as a desktop app, or headless from the command line.
      </p>
    ),
  },
  {
    q: "How do I use OpenScience?",
    a: (
      <p>
        The easiest way to get started is to read the <a href={docs("quickstart")}>quickstart</a>. Install it, open a
        project folder, connect a model, and describe the research task you want to work through.
      </p>
    ),
  },
  {
    q: "Do I need extra AI subscriptions to use OpenScience?",
    a: (
      <p>
        Not necessarily. OpenScience includes free models so you can start immediately, without creating a provider
        account. For frontier models, <a href="/ace">Ace</a> gives you a reviewed roster with one Wallet. OpenScience
        also works with every popular provider, including OpenAI, Anthropic, Google, and xAI, using your own keys, and
        with <a href={docs("local-models")}>local models</a> through Ollama or LM Studio.
      </p>
    ),
  },
  {
    q: "Can I use my existing AI subscriptions with OpenScience?",
    a: (
      <p>
        Yes. Sign in with OpenAI to use your ChatGPT Plus or Pro account, and connect other eligible provider sign-ins
        from Customize → Models. <a href={docs("models")}>Learn more</a>.
      </p>
    ),
  },
  {
    q: "Can I only use OpenScience in the browser?",
    a: (
      <p>
        No. There is a <a href="/download">desktop app</a> for macOS, Windows, and Linux, a headless{" "}
        <code>openscience run</code> for containers and CI, and an Agent Client Protocol server for editors. See{" "}
        <a href={docs("sessions")}>sessions</a> and <a href={docs("commands")}>commands</a>.
      </p>
    ),
  },
  {
    q: "How much does OpenScience cost?",
    a: (
      <p>
        OpenScience is 100% free to use and licensed under Apache 2.0. It comes with free models. There may be
        additional costs if you use <a href="/ace">Ace</a> or connect a paid provider; those charges are the provider's,
        not ours.
      </p>
    ),
  },
  {
    q: "What about data and privacy?",
    a: (
      <p>
        Sessions, files, credentials, and results stay on your machine. Prompts leave it only for the model provider you
        choose. If you sign in to Synthetic Sciences, we receive your account and Wallet activity, and you can opt in to
        share session traces to improve the agent. Sharing is off by default, versioned, and can be turned off or
        deleted at any time. Read the <a href="/privacy">privacy page</a>.
      </p>
    ),
  },
  {
    q: "Is OpenScience open source?",
    a: (
      <p>
        Yes. The source is public on <a href={GITHUB}>GitHub</a> under the <a href={LICENSE}>Apache 2.0 License</a>, so
        anyone can use, modify, or contribute to it. File issues, submit pull requests, add connectors and skills, or
        build on the TypeScript SDK.
      </p>
    ),
  },
  {
    q: "What is Ascent?",
    a: (
      <p>
        Ascent is a second client from Synthetic Sciences, currently invite-only. Learn more at{" "}
        <a href="https://tryascent.ai" target="_blank" rel="noreferrer">
          tryascent.ai
        </a>
        .
      </p>
    ),
  },
]

export default function Landing() {
  useMeta({
    title: "OpenScience | The open-source AI workbench for scientific research",
    description:
      "OpenScience is the open-source AI co-scientist. Free models included or connect any model from any provider, including Claude, GPT, Gemini and more.",
    path: "/",
  })

  return (
    <main data-page="openscience">
      <div data-component="container">
        <Header />

        <div data-component="content">
          <section data-component="hero">
            <a data-slot="backed" href={SYNTHETIC_SCIENCES} target="_blank" rel="noreferrer">
              <svg data-slot="yc" viewBox="0 0 24 24" aria-hidden focusable="false">
                <rect width="24" height="24" fill="#F26625" />
                <path d="M7 5.5h2.6l2.4 4.7 2.4-4.7H17l-3.9 7.1v5.9h-2.2v-5.9z" fill="#fff" />
              </svg>
              Backed by Y Combinator
            </a>
            <div data-slot="hero-copy">
              <h1>The open-source AI workbench for scientific research</h1>
              <p>
                One workspace for literature, code, experiments, compute, and results.
                <span data-slot="br" />
                Free models included, or bring Claude, GPT, Gemini and any other provider.
              </p>
            </div>

            <div data-slot="installation">
              <InstallTabs />
            </div>
          </section>

          <Workspace />

          <section data-component="section" id="what" data-nav="What it is">
            <div data-slot="section-title">
              <h3>What is OpenScience?</h3>
              <p>OpenScience is an open-source agent that reads papers, writes code, and runs experiments with you.</p>
            </div>
            <ul data-slot="list">
              {WHAT.map(([term, body]) => (
                <li key={term}>
                  <span data-slot="marker">•</span>
                  <div>
                    <strong>{term}</strong>
                    {body}
                  </div>
                </li>
              ))}
            </ul>
            <a href={DOCS} data-slot="button">
              <span>Read docs</span>
              <Arrow />
            </a>
          </section>

          <section data-component="section" id="benchmarks" data-nav="Benchmarks">
            <div data-slot="section-title">
              <h3>The state-of-the-art AI co-scientist</h3>
              <div>
                <p>
                  {PRELIMINARY ? "In preliminary runs, " : ""}OpenScience scores{" "}
                  <strong>{BENCHMARKS[0].score.toFixed(1)}%</strong> on {BENCHMARKS[0].name}, on the cost-per-task
                  frontier; <strong>{BENCHMARKS[1].score.toFixed(1)}%</strong> on {BENCHMARKS[1].name}, above the
                  baseline harness on every model we tried; and <strong>{BENCHMARKS[2].score.toFixed(1)}%</strong> on{" "}
                  {BENCHMARKS[2].name}, ahead of {RIVALS}.
                </p>
              </div>
              <div data-component="benchmarks">
                {BENCHMARKS.map((benchmark, index) => (
                  <BenchmarkFigure key={benchmark.id} benchmark={benchmark} index={index + 1} />
                ))}
              </div>
            </div>
          </section>

          <section data-component="ace-cta" id="ace" data-nav="Ace">
            <div data-slot="ace-cta-copy">
              <h3>Access reliable, optimized models for scientific agents</h3>
              <p>
                Ace gives you a handpicked set of models that OpenScience has tested and benchmarked for scientific
                agents, plus managed search and memory, behind one Wallet. No provider accounts, no inconsistent
                performance across routes.
              </p>
              <ProviderRow />
              <a href="/ace" data-slot="button-light">
                <span>Learn about Ace</span>
                <Arrow />
              </a>
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
