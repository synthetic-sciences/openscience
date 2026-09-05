import { useState } from "react"
import photograph from "@/assets/lunar-lab.jpg"
import logo from "@/assets/synthetic-sciences.svg"
import { RESEARCH, WORKSPACE } from "@/data/research"
import { CONNECTORS } from "@/data/connectors"
import "./landing.css"

const GITHUB = "https://github.com/synthetic-sciences/openscience"
const DOCS = "https://openscience.sh/docs"
const COMMAND = "npm install -g @synsci/openscience"
const PHOTO = "https://www.nasa.gov/image-article/scientists-lunar-chemistry-laboratory/"
const INSTITUTIONS = [
  ["harvard", "Harvard University"],
  ["mit", "MIT"],
  ["stanford", "Stanford University"],
  ["fermilab", "Fermilab"],
  ["yale", "Yale University"],
  ["oxford", "University of Oxford"],
  ["nus", "National University of Singapore"],
  ["iit-bombay", "IIT Bombay"],
  ["iit-delhi", "IIT Delhi"],
] as const
const WORK = [
  {
    title: "Read the literature",
    description: "Find the relevant papers, compare their methods, and save the references in your project.",
    prompt: "What do we know about protein design under limited experimental data? Start with the literature.",
    heading: "Literature review",
    body: "I’ll compare the approaches, note their limitations, and put the references in a bibliography.",
    files: ["literature.md", "references.bib", "research-question.md"],
    activity: ["Search arXiv and PubMed", "Compare methods and limitations", "Save a cited research brief"],
    label: "literature.md",
    lines: [
      "# Research brief",
      "",
      "01  Structure-conditioned design",
      "02  Sequence-based approaches",
      "03  Where evidence is still missing",
      "",
      "Sources → references.bib",
    ],
  },
  {
    title: "Run the experiment",
    description: "Write and run the analysis in Python or R. Use local tools or send a job to your connected compute.",
    prompt: "Build a reproducible baseline. Keep the held-out data separate and record the environment.",
    heading: "Baseline experiment",
    body: "I’ll inspect the data and define the split before running the baseline. The code and environment will be saved together.",
    files: ["analysis.ipynb", "environment.yml", "results/"],
    activity: ["Inspect the project data", "Run the baseline analysis", "Save code, environment, and outputs"],
    label: "analysis.ipynb",
    lines: [
      "# Baseline experiment",
      "",
      "[1] Load and validate inputs",
      "[2] Define the held-out split",
      "[3] Run the baseline",
      "[4] Inspect the result",
      "",
      "Outputs → results/",
    ],
  },
  {
    title: "Write it up",
    description:
      "Draft the manuscript from your analysis. Check the references and prepare the figures for publication.",
    prompt: "Draft the methods from the actual analysis. Link each figure to its source and flag unsupported claims.",
    heading: "Manuscript review",
    body: "I’ll draft the methods from the notebook and mark any claims that the analysis doesn’t yet support.",
    files: ["manuscript.tex", "figures/", "references.bib"],
    activity: ["Draft the methods section", "Connect figures and citations", "Review claims against the evidence"],
    label: "manuscript.tex",
    lines: [
      "# Methods",
      "",
      "1. Data and inclusion criteria",
      "2. Experimental procedure",
      "3. Evaluation protocol",
      "",
      "Figures → figures/",
      "Citations → references.bib",
    ],
  },
] as const
const PROVIDERS = [
  { name: "OpenAI", note: "Use your OpenAI API key or a supported account connection.", mark: "01" },
  { name: "Anthropic", note: "Connect Anthropic and use Claude for your research sessions.", mark: "02" },
  { name: "Google", note: "Connect your Google provider credentials to work with Gemini.", mark: "03" },
  {
    name: "Open weights",
    note: "Connect compatible providers for models from DeepSeek, Moonshot, Z.AI, and more.",
    mark: "04",
  },
  {
    name: "Your local model",
    note: "Use Ollama or an OpenAI-compatible local endpoint. Keep model inference on your own hardware.",
    mark: "05",
  },
] as const
const QUESTIONS = [
  [
    "What is OpenScience?",
    "An open-source AI workbench for scientific research. It brings a research agent, papers, project files, code, notebooks, scientific tools, and writing into one local workspace.",
  ],
  [
    "Do I need an OpenScience account?",
    "No. Install OpenScience and connect the model providers and tools you want to use. You can bring your own API keys, supported provider accounts, or local models.",
  ],
  [
    "Is it free?",
    "OpenScience is open source under Apache 2.0. Model providers, hosted scientific tools, and compute services may charge for usage. Those costs depend on the services you connect.",
  ],
  [
    "Where does my research live?",
    "Your project files and local workspace stay on your computer. When you use a remote model or scientific service, the inputs needed for that request are sent to that service. You choose the providers and permissions.",
  ],
  [
    "Can I add my lab’s tools?",
    "Yes. Add your own skills, MCP servers, plugins, agents, and commands. Use the TypeScript SDK to connect private tools and research infrastructure.",
  ],
] as const
function Mark() {
  return <img className="science-mark" src={logo} width="28" height="28" alt="" aria-hidden="true" />
}

export default function Landing() {
  const [chapter, setChapter] = useState(0)
  const [provider, setProvider] = useState(0)
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const work = WORK[chapter]
  async function copy() {
    const result = await navigator.clipboard?.writeText(COMMAND).then(
      () => true,
      () => false,
    )
    setCopied(Boolean(result))
    setFailed(!result)
  }
  return (
    <div id="top" className={`landing${paused ? " motion-paused" : ""}`}>
      <a className="skip-link" href="#research">
        Skip to content
      </a>
      <header className="site-header">
        <a className="brand" href="https://syntheticsciences.ai" aria-label="Synthetic Sciences home">
          <Mark />
          <span>Synthetic Sciences</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href={DOCS}>Docs</a>
          <a href={GITHUB}>GitHub</a>
          <a href="/download" className="nav-download">
            Get OpenScience
          </a>
        </nav>
      </header>
      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow entrance">A workbench for scientific research</p>
            <h1 id="hero-title" className="entrance">
              For the
              <br />
              beautifully
              <br />
              <span>unsolved.</span>
            </h1>
            <div className="hero-intro entrance">
              <p>
                OpenScience is a research agent that works with your papers, code, and experiments. Open source, on your
                computer.
              </p>
              <a href="/download" className="button button-light">
                Get OpenScience
              </a>
            </div>
            <a className="hero-scroll" href="#research">
              <span className="scroll-line" />
              Explore OpenScience
            </a>
          </div>
          <figure className="hero-photograph">
            <img
              src={photograph}
              alt="Researchers working with glass laboratory apparatus at NASA Ames, studying lunar samples in 1969."
              width="1041"
              height="1083"
              {...{ fetchpriority: "high" }}
            />
            <div className="photograph-brand" aria-hidden="true">
              <Mark />
              <span>OpenScience</span>
            </div>
            <figcaption>
              <span>Lunar Chemistry Laboratory</span>
              <a href={PHOTO} target="_blank" rel="noreferrer">
                NASA Ames, 1969 · NASA/J. Remmington
              </a>
            </figcaption>
          </figure>
        </section>
        <section className="institutions" aria-label="Research community">
          <div className="marquee-heading">
            <p className="eyebrow">Used by researchers at</p>
            <button className="motion-control" type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>
              {paused ? "Resume motion" : "Pause motion"}
              <span aria-hidden="true">{paused ? "▷" : "Ⅱ"}</span>
            </button>
          </div>
          <div className="marquee institution-marquee">
            <div className="marquee-track">
              {[0, 1].map((repeat) => (
                <div className="marquee-group" key={repeat} aria-hidden={repeat === 1 ? true : undefined}>
                  {INSTITUTIONS.map((institution) => (
                    <img
                      key={institution[0]}
                      data-institution={institution[0]}
                      src={`/logos/${institution[0]}.png`}
                      alt={institution[1]}
                      width="180"
                      height="48"
                      loading="lazy"
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>
        <section id="research" className="research paper section">
          <div className="section-heading">
            <p className="eyebrow">01 / The workbench</p>
          </div>
          <div className="research-heading">
            <h2>
              Stay with
              <br />
              the question.
            </h2>
            <p>
              OpenScience works in your project: reading papers, writing code, and running experiments. You can inspect
              the work as it happens and pick up where you left off.
            </p>
          </div>
          <div className="workflow-layout">
            <div
              className="chapter-list"
              role="tablist"
              aria-label="Explore the research workflow"
              aria-orientation="vertical"
            >
              {WORK.map((item, index) => (
                <button
                  id={`chapter-${index}`}
                  role="tab"
                  aria-selected={chapter === index}
                  aria-controls="work-preview"
                  tabIndex={chapter === index ? 0 : -1}
                  key={item.title}
                  className={`chapter${chapter === index ? " selected" : ""}`}
                  onClick={() => setChapter(index)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "ArrowDown"
                        ? (index + 1) % WORK.length
                        : event.key === "ArrowUp"
                          ? (index + WORK.length - 1) % WORK.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? WORK.length - 1
                              : undefined
                    if (next === undefined) return
                    event.preventDefault()
                    setChapter(next)
                    document.getElementById(`chapter-${next}`)?.focus()
                  }}
                >
                  <span className="chapter-number">0{index + 1}</span>
                  <span>
                    <strong>{item.title}</strong>
                    <span className="chapter-description">{item.description}</span>
                  </span>
                  <span className="chapter-dot" aria-hidden="true" />
                </button>
              ))}
            </div>
            <div
              id="work-preview"
              className="workspace"
              role="tabpanel"
              aria-labelledby={`chapter-${chapter}`}
              tabIndex={0}
            >
              <div className="workspace-chrome">
                <span>
                  <Mark />
                  OpenScience
                </span>
                <span>research / untitled question</span>
                <span className="workspace-status">Local workspace</span>
              </div>
              <div className="workspace-body">
                <aside className="workspace-files" aria-label="Example project files">
                  <span className="eyebrow">Project</span>
                  {work.files.map((file) => (
                    <span key={file}>↳ {file}</span>
                  ))}
                  <span className="workspace-files-bottom">+ New conversation</span>
                </aside>
                <div className="workspace-conversation" key={chapter}>
                  <span className="example-label">Illustrative workflow</span>
                  <p className="example-prompt">{work.prompt}</p>
                  <div className="example-response">
                    <Mark />
                    <h3>{work.heading}</h3>
                    <p>{work.body}</p>
                    <ul>
                      {work.activity.map((activity) => (
                        <li key={activity}>
                          <span aria-hidden="true">↳</span>
                          {activity}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="example-composer">
                    <span>Ask about this project…</span>
                    <span aria-hidden="true">↑</span>
                  </div>
                </div>
              </div>
              <div className="workspace-document">
                <div>
                  <span>{work.label}</span>
                  <span>Saved in your project</span>
                </div>
                <pre>{work.lines.join("\n")}</pre>
              </div>
            </div>
          </div>
          <div className="section-tail">
            <span>Papers, notebooks, and results saved in your project.</span>
            <a className="text-link" href={`${DOCS}/#/openscience/workspace`}>
              Explore the workspace
            </a>
          </div>
        </section>
        <section id="skills" className="capabilities section">
          <div className="section-heading">
            <p className="eyebrow">02 / Research tools</p>
            <a className="text-link" href={`${DOCS}/#/openscience/skills`}>
              Browse the skills
            </a>
          </div>
          <div className="capability-heading">
            <h2>
              Tools for
              <br />
              your kind of science.
            </h2>
            <p>
              Run an analysis, work through a simulation, or prepare a paper. OpenScience has research skills for the
              details of each field.
            </p>
          </div>
          <div className="skill-index">
            {RESEARCH.map((field, index) => (
              <details key={field.title} name="research-fields" open={index === 0}>
                <summary>
                  <span className="index-number">0{index + 1}</span>
                  <h3>{field.title}</h3>
                  <span className="skill-detail">{field.detail}</span>
                  <span className="detail-toggle" aria-hidden="true">
                    +
                  </span>
                </summary>
                <div className="field-content">
                  <div className="field-tasks">
                    {field.tasks.map((task) => (
                      <div key={task[0]}>
                        <h4>{task[0]}</h4>
                        <p>{task[1]}</p>
                      </div>
                    ))}
                  </div>
                  <div className="field-skills">
                    <span className="eyebrow">Included skills</span>
                    <div>
                      {field.skills.map((skill) => (
                        <a key={skill[0]} href={`${GITHUB}/tree/main/backend/cli/skills/${skill[1]}`}>
                          {skill[0]}
                        </a>
                      ))}
                    </div>
                  </div>
                  <div className="field-example">
                    <span className="eyebrow">Try asking</span>
                    <p>“{field.example}”</p>
                  </div>
                </div>
              </details>
            ))}
          </div>
          <div className="toolkit">
            <div className="toolkit-heading">
              <h3>In the workspace</h3>
              <p>Built-in tools for the work around the experiment.</p>
            </div>
            <div className="workspace-tools">
              {WORKSPACE.map((tool) => (
                <a key={tool[0]} href={`${GITHUB}/blob/main/backend/cli/src/tool/${tool[2]}`}>
                  <h4>{tool[0]}</h4>
                  <p>{tool[1]}</p>
                </a>
              ))}
            </div>
          </div>
          <div className="toolkit databases">
            <div className="toolkit-heading">
              <h3>Scientific databases</h3>
              <p>Search publications and retrieve records from the source.</p>
            </div>
            <div className="database-grid">
              {CONNECTORS.map((connector) => (
                <a key={connector.id} href={connector.home} target="_blank" rel="noreferrer">
                  <span className="database-logo">
                    <img src={connector.logo} alt="" width="24" height="24" loading="lazy" />
                  </span>
                  <span>{connector.name}</span>
                </a>
              ))}
            </div>
          </div>
          <div className="toolkit-note">
            <p>Add your own lab’s tools through MCP servers, plugins, and custom skills.</p>
            <a className="text-link" href={`${DOCS}/#/openscience/skills`}>
              Extend OpenScience
            </a>
          </div>
        </section>
        <section id="models" className="models paper section">
          <div className="section-heading">
            <p className="eyebrow">03 / Models</p>
            <span className="small-note">Open source. Model agnostic.</span>
          </div>
          <div className="model-layout">
            <div className="model-copy">
              <h2>
                Model
                <br />
                agnostic.
              </h2>
              <p>
                Use the model you prefer. Connect your API keys or provider account, or run a model on your machine. You
                can change models between sessions.
              </p>
              <a className="text-link" href={`${DOCS}/#/openscience/models`}>
                Find your model
              </a>
              <div className="model-note" aria-live="polite">
                <span className="eyebrow">{PROVIDERS[provider].name}</span>
                <p>{PROVIDERS[provider].note}</p>
              </div>
            </div>
            <div className="provider-list" aria-label="Model provider examples">
              {PROVIDERS.map((item, index) => (
                <button key={item.name} aria-pressed={provider === index} onClick={() => setProvider(index)}>
                  <span className="provider-number">{item.mark}</span>
                  <span>{item.name}</span>
                  <span className="provider-select" data-selected={provider === index} aria-hidden="true" />
                </button>
              ))}
              <p>Your choice of model, in the same workspace.</p>
            </div>
          </div>
          <div className="ownership">
            <div>
              <span className="eyebrow">On your computer</span>
              <h3>Your research stays with you.</h3>
              <p>
                Your files, settings, and results live on your computer. You decide which external services to connect.
              </p>
            </div>
            <div>
              <span className="eyebrow">Apache 2.0</span>
              <h3>Read the code. Change it.</h3>
              <p>
                OpenScience is open source. You can inspect how it works, contribute a fix, or adapt it for your lab.
              </p>
              <a className="text-link" href={GITHUB}>
                Build with us
              </a>
            </div>
          </div>
        </section>
        <section id="faq" className="questions section">
          <div>
            <p className="eyebrow">04 / Questions</p>
            <h2>Good to know.</h2>
            <a className="text-link" href={DOCS}>
              Read the docs
            </a>
          </div>
          <div className="faq-list">
            {QUESTIONS.map((question) => (
              <details key={question[0]}>
                <summary>
                  {question[0]}
                  <span className="detail-toggle" aria-hidden="true">
                    +
                  </span>
                </summary>
                <p>{question[1]}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="closing paper">
          <h2>
            What are you
            <br />
            working on?
          </h2>
          <a className="button button-dark" href="/download">
            Get OpenScience
          </a>
          <div className="install">
            <code>{COMMAND}</code>
            <button
              type="button"
              onClick={copy}
              aria-label={copied ? "Install command copied" : "Copy install command"}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p className="copy-feedback" role="status">
            {failed
              ? "Select the command above to copy it manually."
              : copied
                ? "Copied. Paste it into your terminal to install."
                : "Free and open source."}
          </p>
        </section>
      </main>
      <footer className="site-footer">
        <div className="footer-top">
          <div className="footer-about">
            <a className="brand" href="#top">
              <Mark />
              <span>OpenScience</span>
            </a>
            <p>
              Open-source software
              <br />
              for scientific research.
            </p>
            <a href="https://syntheticsciences.ai">By Synthetic Sciences</a>
          </div>
          {[
            {
              title: "Product",
              links: [
                ["Download", "/download"],
                ["Workspace", "#research"],
                ["Skills & tools", "#skills"],
                ["Models", "#models"],
              ],
            },
            {
              title: "Resources",
              links: [
                ["Documentation", DOCS],
                ["GitHub", GITHUB],
                ["Releases", `${GITHUB}/releases`],
                ["npm", "https://www.npmjs.com/package/@synsci/openscience"],
              ],
            },
            {
              title: "Connect",
              links: [
                ["Synthetic Sciences", "https://syntheticsciences.ai"],
                ["X / Twitter", "https://x.com/SynScience"],
                ["Contribute", `${GITHUB}/blob/main/CONTRIBUTING.md`],
                ["License", `${GITHUB}/blob/main/LICENSE`],
              ],
            },
          ].map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <span className="eyebrow">{group.title}</span>
              {group.links.map((link) => (
                <a key={link[0]} href={link[1]}>
                  {link[0]}
                </a>
              ))}
            </nav>
          ))}
        </div>
        <div className="footer-meta">
          <span>© {new Date().getFullYear()} Synthetic Sciences · OpenScience is open source.</span>
          <a href="#top">Back to top</a>
        </div>
        <a className="footer-wordmark" href="#top" aria-label="OpenScience, back to top">
          OpenScience
        </a>
      </footer>
    </div>
  )
}
