import { useEffect } from "react"
import { CopyStatus, useCopy } from "@/components/Copy"
import { Footer } from "@/components/Footer"
import Header from "@/components/Header"
import { useMeta } from "@/components/Meta"
import { NUMBERS, OSB, SNAPSHOT, TRACES, type BoardRow } from "@/data/benchmark"
import { GITHUB, docs } from "@/data/links"
import boardTbsSvg from "@/data/benchmark/board-tbs.svg?raw"
import domainsSvg from "@/data/benchmark/domains.svg?raw"
import matrixSvg from "@/data/benchmark/matrix.svg?raw"
import polarSvg from "@/data/benchmark/polar.svg?raw"
import boardTb4Svg from "@/data/benchmark/board-tb4.svg?raw"
import boardBioSvg from "@/data/benchmark/board-bio.svg?raw"
import swarmSvg from "@/data/benchmark/swarm.svg?raw"
import archSvg from "@/data/benchmark/arch.svg?raw"
import skillsSvg from "@/data/benchmark/skills.svg?raw"
import connectorsSvg from "@/data/benchmark/connectors.svg?raw"
import rasterSvg from "@/data/benchmark/raster.svg?raw"
import bifurcationSvg from "@/data/benchmark/bifurcation.svg?raw"
import glyphResults from "@/data/benchmark/glyph-results.svg?raw"
import glyphLoop from "@/data/benchmark/glyph-loop.svg?raw"
import glyphBench from "@/data/benchmark/glyph-interface.svg?raw"
import glyphAgent from "@/data/benchmark/glyph-agent.svg?raw"
import glyphDelegation from "@/data/benchmark/glyph-delegation.svg?raw"
import glyphAvailability from "@/data/benchmark/glyph-availability.svg?raw"
import "./benchmark.css"
import "./benchmark-figures.css"

/* The launch post as a page of the site: the same frame as every other
   route, one reading column, and the post's figures as inline SVG generated
   from data (see src/data/benchmark.ts for where the numbers come from). */

const N = NUMBERS

function Section({ id, glyph, children }: { id: string; glyph: string; children: React.ReactNode }) {
  return (
    <h2 id={id}>
      {children}
      <span data-slot="glyph" aria-hidden dangerouslySetInnerHTML={{ __html: glyph }} />
    </h2>
  )
}

function Figure({
  n,
  svg,
  plate,
  narrow,
  children,
}: {
  n: number
  svg?: string
  plate?: React.ReactNode
  narrow?: boolean
  children: React.ReactNode
}) {
  return (
    <figure className="reveal">
      {svg ? (
        <div data-slot="plate" data-narrow={narrow ? "" : undefined} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div data-slot="plate">{plate}</div>
      )}
      <figcaption>
        <span data-slot="fl">Figure {n}.</span>
        {children}
      </figcaption>
    </figure>
  )
}

/* Figure 8: OpenScience Bench, drawn in the post's board style (its classes
   and colours come from benchmark-figures.css). */
function OsbBoard() {
  const rows: BoardRow[] = [...OSB.rows].sort((a, b) => b.value - a.value)
  const x0 = 184.8
  const x1 = 610
  const max = 60
  const top = 48
  const step = 24
  const H = top + rows.length * step + 16
  const X = (v: number) => x0 + ((x1 - x0) * v) / max
  return (
    <svg className="chart board" viewBox={`0 0 650 ${H}`} role="img" aria-label="OpenScience Bench results">
      <text className="ttl" x="0" y="13">
        OpenScience Bench
      </text>
      <text className="sub" x="0" y="29">
        end-to-end scientific research, pass@3 for every entry
      </text>
      {[0, 20, 40, 60].map((t) => (
        <g key={t}>
          <line className="gl" x1={X(t)} x2={X(t)} y1={top - 10} y2={top + rows.length * step - 8} />
          <text className="tk" x={X(t)} y={H - 3} textAnchor="middle">
            {t}
          </text>
        </g>
      ))}
      {rows.map((row, i) => {
        const y = top + i * step
        const mine = row.harness === "os"
        return (
          <g key={row.name}>
            <text className={mine ? "rl ours" : "rl"} x={x0 - 10} y={y + 6.5} textAnchor="end">
              {row.name} <tspan className="md">· {row.model}</tspan>
            </text>
            <rect
              className={`bar h-${row.harness}`}
              x={x0}
              y={y - 4}
              width={X(row.value) - x0}
              height={13}
              style={{ ["--i" as string]: i }}
            />
            <text className={`val h-${row.harness}`} x={X(row.value) + 6} y={y + 6.5}>
              {row.value}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

const INSTALL = [
  "npm install -g @synsci/openscience",
  "openscience ~/research/my-project",
  "",
  "# connect a model: your own key, or a local endpoint",
  "openscience keys add",
  "openscience local add",
]

function Install() {
  const { copied, copy } = useCopy(INSTALL.filter((line) => line && !line.startsWith("#")).join("\n"))
  return (
    <pre data-slot="code">
      <button
        type="button"
        onClick={copy}
        aria-label="Copy the install commands"
        {...(copied ? { "data-copied": "" } : {})}
      >
        <CopyStatus />
      </button>
      {INSTALL.map((line, i) =>
        line === "" ? (
          "\n"
        ) : line.startsWith("#") ? (
          <span key={i} data-slot="comment">
            {line}
            {"\n"}
          </span>
        ) : (
          <span key={i}>
            <span data-slot="prompt">$ </span>
            {line}
            {"\n"}
          </span>
        ),
      )}
    </pre>
  )
}

function Stat({
  value,
  unit,
  bars,
  name,
  compare,
}: {
  value: string
  unit?: string
  bars: readonly { harness: BoardRow["harness"]; width: number }[]
  name: string
  compare: React.ReactNode
}) {
  return (
    <div data-slot="stat">
      <div data-slot="value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      <div data-slot="bars" role="img" aria-label={bars.map((bar) => `${bar.harness} ${bar.width}`).join(", ")}>
        {bars.map((bar) => (
          <i key={bar.harness} data-harness={bar.harness} style={{ width: `${bar.width}%` }} />
        ))}
      </div>
      <div data-slot="bench">{name}</div>
      <div data-slot="compare">{compare}</div>
    </div>
  )
}

export default function Benchmark() {
  useMeta({
    title: "OpenScience | Benchmarks: the #1 scientific agent",
    description: `OpenScience solves ${N.tbs_pct}% of Terminal-Bench Science and ${N.tb4_pct}% of Terminal-Bench 4.0 science tasks, and averages ${N.bio_mean} on BiomniBench-DA.`,
    path: "/benchmark",
  })

  // Figures animate in once when they scroll into view; the SVG classes
  // are the launch post's, the observer is the one thing its script did.
  useEffect(() => {
    document.documentElement.classList.add("js")
    const targets = document.querySelectorAll<HTMLElement>('[data-page="benchmark"] .reveal')
    if (!("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("in"))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add("in")
          observer.unobserve(entry.target)
        }
      },
      { threshold: 0.08 },
    )
    targets.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <main id="top" data-page="benchmark">
      <div data-component="container">
        <Header current="benchmark" />

        <div data-component="content">
          <section data-slot="front">
            <header data-slot="head">
              <h1>OpenScience</h1>
              <p data-slot="sub">The #1 scientific agent, open source</p>
              <div data-slot="byline">
                <div data-slot="author">
                  <span>Ishaan Gangwani</span>
                  <a href="mailto:ishaan@syntheticsciences.ai">ishaan@syntheticsciences.ai</a>
                </div>
                <div data-slot="author">
                  <span>Aayam Bansal</span>
                  <a href="mailto:aayam@syntheticsciences.ai">aayam@syntheticsciences.ai</a>
                </div>
              </div>
              <p data-slot="affil">
                Synthetic Sciences <span aria-hidden>·</span> September 2026
              </p>
              <aside data-slot="update" role="note">
                <strong>Update · 1 October 2026</strong>
                <p>
                  Quick update on our benchmark results: we found a few issues in our eval setup, and on some benchmarks
                  our scoring wasn't a perfect comparison with the other agents. We've also seen noticeably weaker
                  performance on engineering tasks than on the physical sciences, and we're improving the harness to
                  close that gap. Once that's done, we'll rerun everything and publish the updated results.
                </p>
              </aside>
              <div data-slot="actions">
                <a href="/download" data-slot="button">
                  Download
                </a>
                <a href={GITHUB} target="_blank" rel="noreferrer">
                  GitHub
                </a>
                <a href={TRACES} target="_blank" rel="noreferrer">
                  Benchmark traces
                </a>
              </div>
            </header>

            <div data-slot="stats">
              <Stat
                value={String(N.tbs_pct)}
                unit="%"
                bars={[
                  { harness: "os", width: N.tbs_pct },
                  { harness: "codex", width: N.codex_tbs },
                ]}
                name="Terminal-Bench Science"
                compare={
                  <>
                    +{N.tbs_margin} over <span data-harness="codex">Codex</span> {N.codex_tbs}
                  </>
                }
              />
              <Stat
                value={String(N.bio_mean)}
                bars={[
                  { harness: "os", width: N.bio_mean },
                  { harness: "oth", width: N.bio_other },
                ]}
                name="BiomniBench-DA"
                compare={
                  <>
                    +{N.bio_margin} over <span data-harness="oth">{N.bio_other_short}</span> {N.bio_other}
                  </>
                }
              />
              <Stat
                value={String(N.tb4_pct)}
                unit="%"
                bars={[
                  { harness: "os", width: N.tb4_pct },
                  { harness: "cc", width: N.tb4_other },
                ]}
                name="Terminal-Bench 4.0 science"
                compare={
                  <>
                    +{N.tb4_margin} over <span data-harness="cc">Claude Code</span> {N.tb4_other}
                  </>
                }
              />
              <Stat
                value={String(OSB.rows[0].value)}
                unit="%"
                bars={[
                  { harness: "os", width: OSB.rows[0].value },
                  { harness: "cc", width: OSB.rows[1].value },
                ]}
                name="OpenScience Bench"
                compare={
                  <>
                    +{OSB.margin} over <span data-harness="cc">{OSB.other_short}</span> {OSB.rows[1].value}
                  </>
                }
              />
            </div>
          </section>

          <article data-slot="paper">
            <Section id="results" glyph={glyphResults}>
              Benchmarks for agentic scientific research
            </Section>
            <p>
              OpenScience leads every public benchmark for agentic scientific research that we have run. Each benchmark
              runs in its native environment, with its own verifiers or judge, through Harbor on Modal, and we report
              each in its own metric. Every other entry shown is from the benchmark's public leaderboard or a published
              comparison on the same tasks and grader.
              <sup data-slot="fn">
                <a href="#n2">2</a>
              </sup>
            </p>

            <h3>Terminal-Bench Science</h3>
            <p>
              Terminal-Bench Science is {N.tbs_n} long-horizon research tasks, each with its own verifier and an 8-hour
              limit, in fields from cosmological inference and spatial transcriptomics to formal proof and hydrology.
              OpenScience solves {N.tbs_pct}%. The strongest public entry, Codex with the same lead model (GPT-6 Astra),
              solves {N.codex_tbs}%; the strongest Claude Code entry ({N.cc_tbs_model}) solves {N.cc_tbs}%.
            </p>
            <Figure n={1} svg={boardTbsSvg}>
              OpenScience and all {N.lb_n} entries on the public Terminal-Bench Science leaderboard.
            </Figure>
            <p>
              The margin is largest in the life sciences, {N.life_os}% against {N.life_codex}% for Codex. Engineering,
              with nine tasks, is the one domain where Codex is ahead ({N.eng_codex}% against {N.eng_os}%).
            </p>
            <Figure n={2} svg={domainsSvg}>
              Resolution rate by scientific domain for OpenScience and the strongest Codex and Claude Code entries.
              Numbers above the rows are OpenScience's.
            </Figure>
            <p>
              OpenScience also solved {N.only_os_n} tasks, <code>{N.only_os[0]}</code> and <code>{N.only_os[1]}</code>,
              that no leaderboard entry solved in any of its {N.n_attempts} attempts.
            </p>
            <Figure n={3} svg={matrixSvg}>
              Every Terminal-Bench Science task, grouped by domain. Cell shade is the fraction of attempts that passed
              (OpenScience one, leaderboard entries three); open cells never passed. Triangles mark tasks that only
              OpenScience solved.
            </Figure>
            <Figure n={4} svg={polarSvg} narrow>
              OpenScience's wall-clock time per task (spoke length, log scale; the dashed ring is the 8-hour limit),
              ordered by time. Filled dots passed. The two tasks marked * were regraded after the run and have no
              recorded time.
            </Figure>

            <h3>Terminal-Bench 4.0</h3>
            <p>
              On the {N.tb4_n} science tasks of Terminal-Bench 4.0 OpenScience solves {N.tb4_pct}%. We scored all{" "}
              {N.lb4_n} public entries on the same tasks from their published per-trial results: the best is{" "}
              {N.tb4_other_name} at {N.tb4_other}%, and the best Codex entry reaches {N.tb4_codex}%.
            </p>
            <Figure n={5} svg={boardTb4Svg}>
              OpenScience and every public Terminal-Bench 4.0 entry on the {N.tb4_n} science tasks. Reasoning effort in
              parentheses.
            </Figure>

            <h3>BiomniBench-DA</h3>
            <p>
              BiomniBench-DA asks for open-ended analyses of published biomedical datasets. The agent may not read the
              source paper, and a Gemini 3.1 Pro judge grades the full trace against a rubric written with the paper's
              authors. Over the {N.bio_n} public tasks OpenScience averages {N.bio_mean}, with {N.bio_perfect} perfect
              scores. {N.bio_other_name} reports {N.bio_other} under the same judge, and {N.bio_third_name}{" "}
              {N.bio_third}.
            </p>
            <Figure n={6} svg={boardBioSvg}>
              OpenScience and the published BiomniBench-DA results on the same {N.bio_n} tasks and judge. The row marked
              * is OpenScience run by the BiomniBench-AI4S authors with DeepSeek V4 Pro, the model every entry below
              AIPOCH uses.
            </Figure>
            <Figure n={7} svg={swarmSvg}>
              OpenScience's score on each of the {N.bio_n} BiomniBench-DA tasks.
            </Figure>

            <Section id="openscience-bench" glyph={glyphBench}>
              OpenScience Bench
            </Section>
            <p>
              The public benchmarks each test part of the work. OpenScience Bench, our internal benchmark, measures
              end-to-end scientific research, and every entry is scored pass@3. OpenScience with GPT-6 Astra scores{" "}
              {OSB.rows[0].value}%, ahead of Claude Science with Fable 5.1 ({OSB.rows[1].value}%), K-Dense (BYOK) with
              GPT-6 Astra ({OSB.rows[2].value}%) and Codex with GPT-6 Astra ({OSB.rows[3].value}%); Grok Build with Grok
              4.7 scores {OSB.rows[4].value}%. Three of those entries run the same model, so their gap is the harness:{" "}
              {(OSB.rows[0].value - OSB.rows[2].value).toFixed(1)} points over K-Dense and{" "}
              {(OSB.rows[0].value - OSB.rows[3].value).toFixed(1)} over Codex.
            </p>
            <Figure n={8} plate={<OsbBoard />}>
              OpenScience Bench, pass@3 for every entry. The model each harness ran is after the dot.
            </Figure>

            <Section id="loop" glyph={glyphLoop}>
              How OpenScience works
            </Section>
            <p>
              At the centre is a small, general agent loop. The science lives around it: in skills, in the agent
              definitions, and in a prompt header for each model family. A few optional harness units add checks at the
              end of a turn: one re-reads a written report against the original request in a fresh context, another
              enforces the budget. A unit stays only if it improves measured outcomes.
            </p>
            <p>
              Because the loop is model-agnostic, the product is too. The science instructions are identical across
              model families, no built-in agent is tied to a model, and each lab can run the model it trusts.
            </p>
            <Figure n={9} svg={archSvg}>
              How a request moves through OpenScience. The lead agent loads skills as a task needs them, sends briefs to
              workers and gets back reports with a verification, calls tools and compute, and returns Results with their
              provenance.
            </Figure>

            <Section id="agent" glyph={glyphAgent}>
              An agent built for scientific work
            </Section>
            <p>
              Scientific work follows procedures, and OpenScience carries {N.skills_total} of them as skills in{" "}
              {N.skills_ncat} categories: how a field runs a single-cell analysis, a docking screen, a DESeq2 contrast
              or a Lean proof. The agent always sees an index and loads a skill's full text when a task needs it. Much
              of the library comes from other groups: 180 skills from K-Dense, 79 from Orchestra Research, and more from
              Hugging Face, Anthropic and NVIDIA BioNeMo.
            </p>
            <Figure n={10} svg={skillsSvg}>
              The skill library, one square per skill, grouped by category and coloured by field.
            </Figure>
            <p>
              It reaches data through {N.connectors_total} connectors to scientific databases in {N.connectors_ndom}{" "}
              domains, and literature through a tool that searches OpenAlex and arXiv and then reads the full text of
              the paper. It runs code in long-lived Python and R kernels and a shell, and sends heavier jobs to an SSH
              host, a Slurm or PBS cluster, or Modal as durable jobs that outlive the conversation. Each remote dispatch
              needs your approval.
            </p>
            <Figure n={11} svg={connectorsSvg}>
              The {N.connectors_total} database connectors, grouped by domain.
            </Figure>

            <Section id="delegation" glyph={glyphDelegation}>
              A lab of specialists
            </Section>
            <p>
              The lead agent can hand bounded tasks to seven workers in parallel: <code>explore</code>, a scout for
              literature, data and code; five domain specialists (<code>ml</code>, <code>biology</code>,{" "}
              <code>physics</code>, <code>chemistry</code>, <code>data</code>); and <code>general</code>. Workers cannot
              start other workers or publish anything. A worker's report without a verification section counts as a
              claim, and when two workers compute the same quantity independently and disagree, the disagreement is
              reported as a finding.
            </p>
            <p>
              Figure 12 shows one Terminal-Bench Science run, <code>{N.raster_task}</code>: calibrate a four-state
              aquifer model, identify miscalibrated devices, forecast all four states and design a pump-and-treat
              intervention. The lead brought in <code>{N.raster_workers[0]}</code>, <code>{N.raster_workers[1]}</code>{" "}
              and <code>{N.raster_workers[2]}</code> workers. The run took {N.raster_hours} hours and passed the task's
              verifier.
            </p>
            <Figure n={12} svg={rasterSvg}>
              Tool calls over time in one run, one row per session, labelled with the brief the lead wrote.
            </Figure>

            <div data-slot="bifurcation">
              <div dangerouslySetInnerHTML={{ __html: bifurcationSvg }} />
              <div data-slot="cap">
                Logistic map <i>x</i>
                <sub>
                  <i>n</i>+1
                </sub>{" "}
                = <i>r x</i>
                <sub>
                  <i>n</i>
                </sub>
                (1 − <i>x</i>
                <sub>
                  <i>n</i>
                </sub>
                ), 2.85 ≤ <i>r</i> ≤ 4
              </div>
            </div>

            <Section id="availability" glyph={glyphAvailability}>
              Availability
            </Section>
            <p>
              OpenScience is released under Apache 2.0. It works with your own API keys (22 provider SDKs are bundled),
              with local models through Ollama or LM Studio, or with <a href="/ace">Ace</a>, the pay-as-you-go service
              we run. Usage through your own keys or a local model is never billed through Ace.
            </p>

            <p>
              Install the <a href="/download">desktop app</a>, or use the terminal:
            </p>
            <Install />
            <p>Then describe the task as you would to a colleague:</p>
            <p data-slot="prompt">
              Inspect data/samples.csv for missing values and inconsistent labels. Keep the original data unchanged.
              Save a quality report and a plot in results/, with the code needed to reproduce them.
            </p>
            <p>
              The source is on <a href={GITHUB}>GitHub</a>, the documentation at <a href={docs("quickstart")}>docs</a>,
              and contributions are welcome.
            </p>

            <div data-slot="notes" id="notes">
              <h4>Notes</h4>
              <ol>
                <li id="n1">
                  Figures and counts are computed by the launch post's scripts from OpenScience (commit{" "}
                  <code>{SNAPSHOT.openscience}</code>), <a href={TRACES}>benchmarks-openscience</a> (commit{" "}
                  <code>{SNAPSHOT.benchmarks}</code>) and snapshots of the public leaderboards taken {SNAPSHOT.date}.
                  The build checks the recomputed scores against the benchmarks repository's README.
                </li>
                <li id="n2">
                  OpenScience runs: Terminal-Bench Science with a GPT-6 Astra lead, GPT-6 Sol workers and 8 hours per
                  task; BiomniBench-DA with GPT-6 Sol and 1 hour per task; Terminal-Bench 4.0 with a GPT-6 Astra lead
                  and GPT-5.6 Sol workers. OpenScience rows report one counted trial per task. Leaderboard entries
                  average 3 trials per task on Terminal-Bench Science and 5 on Terminal-Bench 4.0. Other entries come
                  from the <a href="https://www.terminal-bench-science.ai/">Terminal-Bench Science</a> and{" "}
                  <a href="https://www.tbench.ai/leaderboard">Terminal-Bench 4.0</a> leaderboards, the{" "}
                  <a href="https://github.com/omicverse/BiomniBench-AI4S">BiomniBench-AI4S</a> comparison (Gemini 3.1
                  Pro judge column) and{" "}
                  <a href="https://aipoch.com/blog/open-science-biomnibench-da">AIPOCH's published result</a>.
                </li>
              </ol>
            </div>

            <div data-slot="cite">
              <h4>Citation</h4>
              <pre data-slot="bib">{`@misc{gangwani2026openscience,
  title        = {OpenScience: The #1 Scientific Agent, Open Source},
  author       = {Gangwani, Ishaan and Bansal, Aayam},
  year         = {2026},
  month        = sep,
  organization = {Synthetic Sciences},
  howpublished = {\\url{https://github.com/synthetic-sciences/OpenScience}}
}`}</pre>
            </div>
          </article>
        </div>
      </div>

      <Footer />
    </main>
  )
}
