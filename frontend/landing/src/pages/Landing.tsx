import { useState } from "react"
import photograph from "@/assets/lunar-lab.jpg"
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
    description:
      "Follow a question through papers, datasets, and primary sources. Keep the evidence beside the conversation.",
    prompt: "What do we know about protein design under limited experimental data? Start with the literature.",
    heading: "A good question starts with the evidence.",
    body: "Search the literature, compare methods, and collect the sources worth reading closely.",
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
    title: "Work through the experiment",
    description:
      "Move from the method to code, notebooks, and scientific tools. Run the work and keep the outputs in your project.",
    prompt: "Build a reproducible baseline. Keep the held-out data separate and record the environment.",
    heading: "Make the method something you can run.",
    body: "Write the analysis, inspect the outputs, and work through the result with your files and terminal in reach.",
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
    title: "Bring it to the page",
    description:
      "Turn the work into a manuscript, with figures, citations, and the underlying analysis still close at hand.",
    prompt: "Draft the methods from the actual analysis. Link each figure to its source and flag unsupported claims.",
    heading: "Write with the work still in view.",
    body: "Assemble the manuscript from your project. Review the claims, revisit the evidence, and refine the figures.",
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
const SKILLS = [
  {
    title: "Molecular biology",
    detail: "Sequences, structures, and the questions between them.",
    tools: "Biopython · Scanpy · scvi-tools · AnnData",
    text: "Work with biological sequences, single-cell data, and experimental workflows, with domain-specific procedures available to the agent.",
  },
  {
    title: "Chemistry & materials",
    detail: "From a molecule to its properties.",
    tools: "RDKit · DeepChem · pymatgen · molecular dynamics",
    text: "Prepare molecules, explore chemical properties, and work through materials simulations with specialist research skills.",
  },
  {
    title: "Machine learning",
    detail: "Build the baseline. Understand the result.",
    tools: "PyTorch · Transformers · DeepSpeed · PEFT",
    text: "Train, fine-tune, and evaluate models. Keep the experiment configuration, code, and analysis together.",
  },
  {
    title: "Data & statistics",
    detail: "Look closely at what the data says.",
    tools: "Polars · statsmodels · PyMC · scikit-learn",
    text: "Clean datasets, fit statistical models, and test assumptions before turning an analysis into a claim.",
  },
  {
    title: "Papers & publication",
    detail: "Make the work legible to the next person.",
    tools: "LaTeX · Zotero · literature review · scientific writing",
    text: "Find and manage citations, draft manuscripts, and prepare figures with the project's evidence close at hand.",
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
function Arrow() {
  return (
    <span aria-hidden="true" className="arrow">
      ↗
    </span>
  )
}
function Mark() {
  return (
    <svg className="science-mark" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" />
      <ellipse cx="12" cy="12" rx="9" ry="3.5" stroke="currentColor" transform="rotate(-40 12 12)" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  )
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
          <a href="#research" className="nav-research">
            The workbench
          </a>
          <a href={DOCS}>
            Docs <Arrow />
          </a>
          <a href={GITHUB}>
            GitHub <Arrow />
          </a>
          <a href="/download" className="nav-download">
            Get OpenScience <span aria-hidden="true">↓</span>
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
                Meet OpenScience. An open-source home for your research, from the first question to the final footnote.
              </p>
              <a href="/download" className="button button-light">
                Start your research <Arrow />
              </a>
              <span className="hero-platforms">macOS, Windows & Linux</span>
            </div>
            <a className="hero-scroll" href="#research">
              <span className="scroll-line" />A closer look <span aria-hidden="true">↓</span>
            </a>
          </div>
          <figure className="hero-photograph">
            <img
              src={photograph}
              alt="Researchers working with glass laboratory apparatus at NASA Ames, studying lunar samples in 1969."
              width="1041"
              height="1083"
              fetchPriority="high"
            />
            <div className="photograph-brand" aria-hidden="true">
              <Mark />
              <span>OpenScience</span>
            </div>
            <figcaption>
              <span>Curiosity is a human thing.</span>
              <a href={PHOTO} target="_blank" rel="noreferrer">
                NASA Ames, 1969 · NASA/J. Remmington ↗
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
            <span className="small-note">A place to think. And do.</span>
          </div>
          <div className="research-heading">
            <h2>
              Stay with
              <br />
              the question.
            </h2>
            <p>
              The paper leads to a dataset. The dataset leads to an experiment. The experiment changes the question.
              <br />
              <br />
              Keep the whole thread in one workspace.
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
                  <span className="chapter-arrow" aria-hidden="true">
                    ↗
                  </span>
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
                  <span className="workspace-files-bottom">+ Your next question</span>
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
                    <span>Follow the next question…</span>
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
            <span>Your files. Your terminal. Your train of thought.</span>
            <a className="text-link" href={`${DOCS}/#/openscience/workspace`}>
              Explore the workspace <Arrow />
            </a>
          </div>
        </section>
        <section id="skills" className="capabilities section">
          <div className="section-heading">
            <p className="eyebrow">02 / A working scientist’s toolkit</p>
            <a className="text-link" href={`${DOCS}/#/openscience/skills`}>
              Explore the skills <Arrow />
            </a>
          </div>
          <div className="capability-heading">
            <h2>
              Go where
              <br />
              the work takes you.
            </h2>
            <p>
              Follow a question across disciplines with hundreds of research skills and direct access to scientific
              data.
            </p>
          </div>
          <div className="capability-counts">
            <div>
              <strong>
                300<span>+</span>
              </strong>
              <span>bundled research skills</span>
            </div>
            <div>
              <strong>{CONNECTORS.length}</strong>
              <span>scientific data sources</span>
            </div>
            <div>
              <strong>10</strong>
              <span>experimental BioNeMo integrations</span>
            </div>
          </div>
          <div className="skill-index">
            {SKILLS.map((skill, index) => (
              <details key={skill.title}>
                <summary>
                  <span className="index-number">0{index + 1}</span>
                  <h3>{skill.title}</h3>
                  <span className="skill-detail">{skill.detail}</span>
                  <span className="detail-toggle" aria-hidden="true">
                    +
                  </span>
                </summary>
                <div className="skill-expanded">
                  <p>{skill.text}</p>
                  <span>{skill.tools}</span>
                </div>
              </details>
            ))}
          </div>
          <div className="bionemo">
            <div>
              <p className="eyebrow">A closer look / NVIDIA BioNeMo</p>
              <h3>
                From sequence
                <br />
                to structure.
              </h3>
              <p>Protein design, molecular docking, and biological models, connected to the same research workspace.</p>
              <a href={`${GITHUB}/tree/main/backend/cli/src/science/capability/manifests`} className="text-link">
                See the scientific-tool catalog <Arrow />
              </a>
            </div>
            <div className="bionemo-index">
              <div className="bionemo-label">
                <span>Available adapters</span>
                <span>Experimental</span>
              </div>
              {[
                ["Boltz-2", "Structure & affinity"],
                ["DiffDock", "Molecular docking"],
                ["Evo 2", "DNA generation"],
                ["RFdiffusion", "Protein backbones"],
                ["ProteinMPNN", "Sequence design"],
              ].map((tool) => (
                <div className="bionemo-row" key={tool[0]}>
                  <span>{tool[0]}</span>
                  <span>{tool[1]}</span>
                </div>
              ))}
              <p>
                Also GenMol, MolMIM, MSA Search, OpenFold2, and OpenFold3. Requires your NVIDIA API key and service
                access. These integrations are experimental, not release-verified.
              </p>
            </div>
          </div>
        </section>
        <section className="source-strip" aria-label="Scientific data sources">
          <div className="marquee-heading">
            <p className="eyebrow">Connected to the scientific record</p>
            <a href={`${DOCS}/#/openscience/skills`} className="text-link">
              All {CONNECTORS.length} sources <Arrow />
            </a>
          </div>
          <div className="marquee source-marquee">
            <div className="marquee-track">
              {[0, 1].map((repeat) => (
                <div className="marquee-group" key={repeat} aria-hidden={repeat === 1 ? true : undefined}>
                  {CONNECTORS.map((connector) => (
                    <a
                      key={connector.id}
                      href={connector.home}
                      tabIndex={repeat === 1 ? -1 : undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img src={connector.logo} width="25" height="25" alt="" loading="lazy" />
                      <span>{connector.name}</span>
                      <span className="source-plus" aria-hidden="true">
                        +
                      </span>
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>
        <section id="models" className="models paper section">
          <div className="section-heading">
            <p className="eyebrow">03 / Your choice, all the way down</p>
            <span className="small-note">Open source. Model agnostic.</span>
          </div>
          <div className="model-layout">
            <div className="model-copy">
              <h2>
                Good science
                <br />
                keeps its
                <br />
                options open.
              </h2>
              <p>
                Choose the model that fits the work. Use your own keys, connect a provider account, or run a model
                locally. Switch as your research changes.
              </p>
              <a className="text-link" href={`${DOCS}/#/openscience/models`}>
                Find your model <Arrow />
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
                  <span className="provider-select" aria-hidden="true">
                    {provider === index ? "↗" : "+"}
                  </span>
                </button>
              ))}
              <p>One workspace. No single-model commitment.</p>
            </div>
          </div>
          <div className="ownership">
            <div>
              <span className="eyebrow">Local by design</span>
              <h3>The project is yours.</h3>
              <p>
                Your files, settings, and results live on your computer. You decide which external services to connect.
              </p>
            </div>
            <div>
              <span className="eyebrow">Open by conviction</span>
              <h3>So is the code.</h3>
              <p>Inspect it. Change it. Make it work for your lab. OpenScience is released under Apache 2.0.</p>
              <a className="text-link" href={GITHUB}>
                Build with us <Arrow />
              </a>
            </div>
          </div>
        </section>
        <section id="faq" className="questions section">
          <div>
            <p className="eyebrow">04 / A few useful answers</p>
            <h2>
              Before
              <br />
              you begin.
            </h2>
            <a className="text-link" href={DOCS}>
              Read the docs <Arrow />
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
          <p className="eyebrow">For the next thing you want to understand.</p>
          <h2>
            Make room
            <br />
            for discovery.
          </h2>
          <a className="button button-dark" href="/download">
            Get OpenScience <Arrow />
          </a>
          <div className="install">
            <code>{COMMAND}</code>
            <button
              type="button"
              onClick={copy}
              aria-label={copied ? "Install command copied" : "Copy install command"}
            >
              {copied ? "Copied ✓" : "Copy ↗"}
            </button>
          </div>
          <p className="copy-feedback" role="status">
            {failed
              ? "Select the command above to copy it manually."
              : copied
                ? "Copied. Paste it into your terminal to install."
                : "Free & open source · Bring your curiosity."}
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
              A workbench for the work
              <br />
              of understanding.
            </p>
            <a href="https://syntheticsciences.ai">
              By Synthetic Sciences <Arrow />
            </a>
          </div>
          {[
            {
              title: "Product",
              links: [
                ["Download", "/download"],
                ["The workbench", "#research"],
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
          <a href="#top">Back to top ↑</a>
        </div>
        <a className="footer-wordmark" href="#top" aria-label="OpenScience, back to top">
          OpenScience
        </a>
      </footer>
    </div>
  )
}
