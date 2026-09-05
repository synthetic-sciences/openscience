import { useState } from "react"
import photograph from "@/assets/lunar-lab.jpg"
import { RESEARCH } from "@/data/research"
import { CONNECTORS } from "@/data/connectors"
import { Header, Footer, Mark, GITHUB } from "@/components/Site"
import Ace from "@/components/Ace"
import Models from "@/components/Models"
import "./landing.css"

const FEATURED = new Set([
  "pubmed",
  "arxiv",
  "openalex",
  "uniprot",
  "rcsb-pdb",
  "ensembl",
  "pubchem",
  "chembl",
  "opentargets",
  "geo",
  "gtex",
  "depmap",
])
const DATABASES = [
  ...CONNECTORS.filter((item) => FEATURED.has(item.id)),
  ...CONNECTORS.filter((item) => !FEATURED.has(item.id)),
]
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
    "OpenScience is open source under Apache 2.0. Bring your own provider access or use local models. Ace is an optional pay-as-you-go service for managed models and search. Connected providers and compute services may charge separately.",
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
export default function Landing() {
  const [expanded, setExpanded] = useState(false)
  const [chapter, setChapter] = useState(0)
  const [paused, setPaused] = useState(false)
  const work = WORK[chapter]
  return (
    <div id="top" className={`landing home-page${paused ? " motion-paused" : ""}`}>
      <a className="skip-link" href="#research">
        Skip to content
      </a>
      <Header />
      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title" className="entrance">
              A workbench
              <br />
              for scientific
              <br />
              research.
            </h1>
            <div className="hero-intro entrance">
              <p>Open source, on your computer.</p>
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
        <section id="research" className="research paper section" aria-labelledby="research-title">
          <div className="research-heading">
            <h2 id="research-title">
              Your research
              <br />
              workspace.
            </h2>
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
                </div>
                <pre>{work.lines.join("\n")}</pre>
              </div>
            </div>
          </div>
        </section>
        <section id="skills" className="capabilities section" aria-labelledby="skills-title">
          <div className="capability-heading">
            <h2 id="skills-title">Research tools.</h2>
          </div>
          <div className="skill-index">
            {RESEARCH.map((field) => (
              <details key={field.title} name="research-fields">
                <summary>
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
        </section>
        <section id="databases" className="databases paper section" aria-labelledby="databases-title">
          <div className="toolkit-heading">
            <h2 id="databases-title">Scientific databases.</h2>
            <button
              className="database-more"
              type="button"
              aria-expanded={expanded}
              aria-controls="database-grid"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show fewer" : `+${DATABASES.length - FEATURED.size} more`}
            </button>
          </div>
          <div className="database-grid" id="database-grid">
            {DATABASES.slice(0, expanded ? DATABASES.length : FEATURED.size).map((connector) => (
              <a key={connector.id} href={connector.home} target="_blank" rel="noreferrer">
                <span className="database-logo">
                  <img src={connector.logo} alt="" width="24" height="24" loading="lazy" />
                </span>
                <span>{connector.name}</span>
              </a>
            ))}
          </div>
        </section>
        <section id="models" className="models section">
          <div className="model-layout">
            <div className="model-copy">
              <h2>
                Model
                <br />
                agnostic.
              </h2>
              <p>Connect your API keys, use a supported provider account, or run a model on your own machine.</p>
            </div>
            <Models />
          </div>
        </section>
        <Ace />
        <section id="faq" className="questions section">
          <div>
            <h2>Good to know.</h2>
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
          <h2>Get OpenScience.</h2>
          <a className="button button-dark" href="/download">
            Download <span className="button-dot" aria-hidden="true" />
          </a>
        </section>
      </main>
      <Footer />
    </div>
  )
}
