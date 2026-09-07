import { Footer, Legal } from "@/components/Footer"
import Header from "@/components/Header"
import { useMeta } from "@/components/Meta"
import { DASHBOARD, GITHUB, REPORT_VULNERABILITY, SECURITY, docs } from "@/data/links"

const UPDATED = "7 September 2026"
const CONTACT = "privacy@syntheticsciences.ai"

/* One continuous document, set like opencode.ai's legal pages: a single prose
   column, headings a step above the body, no boxes or tables. */
export default function Privacy() {
  useMeta({
    title: "OpenScience | Privacy",
    description:
      "What OpenScience keeps on your machine, what leaves it, what Synthetic Sciences collects, and how to turn trace sharing off or delete your data.",
    path: "/privacy",
  })

  return (
    <main data-page="privacy">
      <div data-component="container">
        <Header current="privacy" />

        <div data-component="content">
          <article data-component="document">
            <h1>Privacy</h1>
            <p data-slot="meta">
              Last updated {UPDATED}. Applies to OpenScience and the Synthetic Sciences services it can connect to.
            </p>

            <p>
              OpenScience is a local application. Your projects, sessions, credentials, and results stay on your
              machine, and prompts leave it only for the model provider and the scientific services you choose to call.
              If you sign in to Synthetic Sciences, we receive what an account and a Wallet require, we log the routing
              and cost of managed requests so we can bill you, and we log session traces to improve the agent. Trace
              sharing is on by default. You can turn it off from your account at any time, and everything we hold about
              you can be deleted. This page describes each of those flows in the order data moves.
            </p>

            <h2 id="scope">What this page covers</h2>
            <p>
              The OpenScience software (the command line tool, the browser workspace, and the desktop app), the
              openscience.sh website, and the Synthetic Sciences account services that OpenScience can connect to:
              sign-in, the Wallet, Ace managed models, managed research search, and trace sharing. It does not cover the
              model providers, scientific databases, or other services you connect. Each of those is governed by its own
              policy.
            </p>

            <h2 id="local">What stays on your machine</h2>
            <p>
              Everything durable is local. The agent runs as a server bound to your loopback address with a Host and
              Origin allowlist, and there is no remote mode. The data root defaults to <code>~/.openscience</code> and
              can be moved. It holds your sessions, messages, and tool outputs as files; your artifacts, figures, and
              the provenance graph that links each result to the code and sources that produced it; your provider keys,
              connector credentials, and OAuth tokens, encrypted at rest and never uploaded to us; and a per-inference
              manifest of hashes for the system prompt, instructions, and tool schemas, so a result can be traced to the
              exact configuration that produced it. The agent reads and writes your project files only inside the
              workspace and the paths you grant.
            </p>
            <p>
              Shell commands, Python and R kernels, and local compute jobs run inside macOS Seatbelt or Linux bubblewrap
              when containment is on, with network egress denied. Known credential patterns are redacted from tool
              output before it is written into a session. The full picture is in the{" "}
              <a href={docs("security")}>security documentation</a>.
            </p>

            <h2 id="leaves">What leaves your machine</h2>
            <p>
              Requests go directly from your machine to the service you invoked. None of them pass through Synthetic
              Sciences unless you chose a managed route.
            </p>
            <ul>
              <li>
                <strong>Your model provider</strong> receives prompts, attached files, tool outputs, and the system
                prompt on every model call, under that provider's policy.
              </li>
              <li>
                <strong>Scientific databases and connectors</strong> receive the query the agent issues, for example a
                UniProt accession or a literature search, when a tool calls them, under each service's terms.
              </li>
              <li>
                <strong>MCP servers, compute backends, and publishing targets you configure</strong> receive whatever
                the tool you approved needs, including any files it uploads, when you approve the action.
              </li>
              <li>
                <strong>GitHub</strong> receives a request for release metadata when OpenScience checks for updates.
              </li>
              <li>
                <strong>Synthetic Sciences</strong> receives account identity, Wallet activity, managed requests, and
                session traces, only while you are signed in, under this page.
              </li>
            </ul>
            <p>
              Your own provider keys, a ChatGPT Plus or Pro sign-in, local models, Python and R, SSH compute, and your
              own Modal account never touch Synthetic Sciences.
            </p>

            <h2 id="account">What Synthetic Sciences collects</h2>
            <p>
              Signing in creates a device key bound to your account and, if you choose one, an organization workspace.
              From then on we hold four kinds of record.
            </p>
            <p>
              <strong>Account.</strong> Your email, sign-in identity, workspaces, and the devices you have approved. You
              can revoke any device from the dashboard.
            </p>
            <p>
              <strong>Wallet.</strong> Purchases, holds, settlements, and promotional credits, recorded in
              micro-dollars. Card details are handled by our payment processor and never reach our servers.
            </p>
            <p>
              <strong>Managed requests.</strong> For Ace and managed research search we record the route, provider,
              model, token counts, and cost of each request, and the funding context it ran under. This content-free
              usage record is what your usage charts and invoices are built from. The request body passes through to the
              provider and is kept only as part of a session trace, under the rules below.
            </p>
            <p>
              <strong>Shared credentials.</strong> If your workspace shares provider credentials, OpenScience refreshes
              an encrypted, short-lived overlay of them. Your local keys are never uploaded, and a local key always wins
              over a shared one.
            </p>

            <h2 id="traces">Session traces</h2>
            <p>
              A trace is the full trajectory of a session: your prompts, the model's reasoning and answers, every tool
              call with its inputs and outputs, and the route and model that served each step. Traces are how we find
              where the agent goes wrong and how we build the benchmarks on the home page. Trace sharing is on by
              default while you are signed in, and you can turn it off at any time.
            </p>
            <p>While sharing is on, five rules apply.</p>
            <ul>
              <li>
                Batches are uploaded compressed and authenticated with your device key, and each delivery carries an
                idempotent id, so a retry can never duplicate an event.
              </li>
              <li>
                Before anything is stored, the ingest path recursively redacts credential-shaped keys and known secret
                formats: provider keys, cloud tokens, and personal access tokens.
              </li>
              <li>
                Raw trace events are kept for 30 days and then purged. A content-free usage projection of route, model,
                token counts, and cost outlives that window.
              </li>
              <li>
                Access to raw traces is limited to security and super-admin roles with a fresh second factor, and every
                access is audited.
              </li>
              <li>
                Each stored event carries the hash of its canonical payload and a receipt id, so you can check what we
                received against what your client sent.
              </li>
            </ul>

            <h2 id="controls">Turning sharing off</h2>
            <p>
              Trace sharing is a versioned preference on your account. The current disclosure version is named in the
              preference itself, so if we ever change what a trace contains, your earlier choice does not carry over
              silently and you are asked again.
            </p>
            <p>
              Three switches control it. <strong>Analytics</strong> covers content-free usage: routes, models, token
              counts, and timings. <strong>Research content</strong> covers the prompts, outputs, and tool payloads
              themselves; complete trace sharing requires both this and analytics, and the server rejects a request that
              sets one without the other. <strong>User-owned routes</strong> decides whether sessions that ran on your
              own keys, a ChatGPT sign-in, a local model, or a custom endpoint are included at all, independently of the
              other two.
            </p>
            <p>
              Change any of them from your{" "}
              <a href={DASHBOARD} target="_blank" rel="noreferrer">
                Synthetic Sciences account
              </a>
              . Turning sharing off is enforced across every device signed in to the account, and the client will not
              upload again until you turn it back on.
            </p>

            <h2 id="deletion">Deletion and retention</h2>
            <p>
              You can delete your account data from the dashboard. Deletion removes raw traces, ingest receipts, the
              usage projection, and aggregates in one transaction, and records a durable opt-out so a client that was
              offline at the time cannot re-upload later. The deletion request and the consent history are kept as
              compliance records; they contain no research content. Independently of deletion, raw trace events expire
              after 30 days, and Wallet and billing records are kept for as long as the law requires us to keep
              financial records.
            </p>

            <h2 id="website">This website</h2>
            <p>
              openscience.sh sets no cookies and runs no third-party analytics. Fonts are served from this domain. The
              only cross-origin request the site makes is to GitHub's public API, from your browser, to show the
              repository's star count in the footer. The site is hosted on Vercel, whose edge network keeps standard
              request logs.
            </p>

            <h2 id="security">Security</h2>
            <p>
              Local credentials are encrypted at rest. The local server accepts connections only from your machine. Ace
              requests carry their funding context, and the client rejects any response whose scope does not match, so a
              personal device key can never spend an organization's funds. Our full threat model is in{" "}
              <a href={SECURITY} target="_blank" rel="noreferrer">
                SECURITY.md
              </a>
              . Please report vulnerabilities through the{" "}
              <a href={REPORT_VULNERABILITY} target="_blank" rel="noreferrer">
                GitHub security advisory form
              </a>
              .
            </p>

            <h2 id="changes">Changes and contact</h2>
            <p>
              This page is versioned in the{" "}
              <a href={`${GITHUB}/tree/main/frontend/landing`} target="_blank" rel="noreferrer">
                OpenScience repository
              </a>
              , so every change is public and dated. Material changes to trace collection also bump the consent version,
              which means you are asked again before anything new is collected. Questions or requests about your data:{" "}
              <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
            </p>
          </article>

          <Footer />
        </div>
      </div>

      <Legal />
    </main>
  )
}
