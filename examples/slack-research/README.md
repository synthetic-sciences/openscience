# Private Slack research starter

A runnable **private adapter for one Slack workspace and one runtime**. Slack is a client of OpenScience's
public HTTP API; the server owns scientific reasoning, tools, sessions and
permissions. This example imports no backend implementation and needs no Slack
SDK. It uses Bun's built-in SQLite and `fetch`.

The starter has offline tests; it has not been deployed to Slack or used for a
paid research run. It is not a multi-tenant service or a marketplace app.

## What works

- Signed `app_mention` Events API requests, acknowledged after a durable inbox
  write and before model/network work.
- An explicit allowlist maps one exact workspace/channel/user tuple to one fixed
  server project. The first accepted user owns the thread binding. Another user
  cannot reuse it, even if independently allowlisted. Slack Connect events and
  bot/subtype messages are excluded.
- `research` submits ordinary scientific prompts using `requestID=event_id`.
  Slack delivery retries and lost runtime receipts reuse the same stored input.
- SQLite retains inbox deduplication, thread/session mappings, run receipts,
  event cursors, pending decision mappings, result links, and outgoing messages.
- Polling `/runtime/snapshot` and `/runtime/events/replay` reconciles disconnects
  and retention gaps. Durable run state remains authoritative. Interrupted runs
  are reported and never restarted automatically.
- Explicit permission/question commands are bound to the same Slack principal,
  thread, session, and a fresh pending runtime request. This starter grants only
  `once` or `reject`; it cannot create persistent permission grants.
- Terminal messages link to the authenticated runtime message containing results
  and artifact references. Links are built from configured runtime URLs and
  stored in SQLite; arbitrary URLs from agent output are not posted. Files are
  not uploaded or publicly published.

## Run it

Use the repository's pinned Bun version (1.3.14). Run offline checks from the
repository root:

```bash
bun test ./examples/slack-research/app.test.ts
```

To configure your own private Slack app, subscribe to [`app_mention`](https://docs.slack.dev/reference/events/app_mention/) with
`app_mentions:read` and grant the bot [`chat:write`](https://docs.slack.dev/reference/methods/chat.postMessage/). Invite it only to an approved
private channel. Configure its Events API URL to reach this adapter's
`/slack/events` through your own HTTPS ingress. Keep the OpenScience runtime
private. The server binds to localhost; this example does not configure ingress,
OAuth distribution, secrets hosting, or deployment.

Copy `bindings.example.json` to a private configuration file and replace all IDs
and project paths. The project must already exist on the runtime host. Event text
cannot change the configured project or runtime URL.

```bash
export SLACK_APP_ID=A_YOUR_APP_ID
export SLACK_BOT_USER_ID=U_YOUR_BOT_USER_ID
export SLACK_SIGNING_SECRET=your_signing_secret
export SLACK_BOT_TOKEN=your_bot_token
export SLACK_BINDINGS_PATH=/private/config/slack-bindings.json
export SLACK_STATE_PATH=/private/state/slack-research/state.sqlite
export OPENSCIENCE_URL=http://127.0.0.1:4096
export OPENSCIENCE_AUTH_TOKEN=your_runtime_token
# Optional: an authenticated runtime URL reachable by your Slack users.
export OPENSCIENCE_RESULT_URL=https://private-runtime.example
bun run examples/slack-research/index.ts
```

The ID placeholders above must be replaced with actual Slack IDs; IDs contain
uppercase letters/digits, not underscores. `PORT` defaults to 3100. The runtime
must advertise protocol 1.0. Startup checks that capability for each fixed
project before opening the listener. The worker polls every two seconds, serializes operations in this process, and
sends at most one outbox message per channel per tick.

Running the configured adapter can submit paid model work, execute tools under
your server's permissions, and post messages in the configured channel. The
provided tests inject local runtime and Slack transports and require no tokens.

## Commands

Mention the bot at the start of a message. Reply in the same Slack thread:

```text
@OpenScience research Inspect the dataset and reproduce the analysis.
@OpenScience status
@OpenScience cancel run_...
@OpenScience permission per_... once
@OpenScience permission per_... reject
@OpenScience answer que_... [["first answer"],["second answer"]]
@OpenScience reject que_...
```

`cancel` accepts only a run recorded for that thread. Cancellation may remain
`running` while tools settle. Pending decision messages show request IDs and
context. Replies must come from the original thread owner, remain allowlisted,
and match a request in the connected runtime's fresh snapshot. Replayed decision
events are not actionable. An identical decision whose response was lost can
recover its durable receipt; `indeterminate` is reported without reapplying it.

The server's normal model configuration and tool permissions still apply. A fixed
project binding is routing policy, **not a filesystem sandbox**. Do not share
one unrestricted runtime with mutually untrusted users. Server bearer auth is
deployment access, not per-Slack-user identity or tenant isolation. The approved
channel is the sharing destination, so everyone who can read it can see the bot's
messages. This example adds no compute budget, approval bypass, or evaluator.

## Failure and delivery semantics

The adapter follows Slack's [signed request recipe](https://docs.slack.dev/authentication/verifying-requests-from-slack/): HMAC-SHA256 over the raw body and timestamp, a five-minute freshness window, and a constant-time signature comparison. Slack's [Events API](https://docs.slack.dev/apis/events-api/) can retry deliveries; `event_id` deduplication is stored before acknowledgement.

The outgoing outbox has `pending`, `sending`, `sent`, and `indeterminate` states.
Its logical message keys prevent duplicate scheduling. A failed or interrupted
`chat.postMessage` can have delivered despite a lost acknowledgement: that entry
becomes `indeterminate` and is **not automatically resent**. This deliberately
does not claim exactly-once Slack delivery. Inspect Slack and the outbox before
any manual correction. No `client_msg_id` deduplication guarantee is assumed.

Session creation has no public idempotency key. If its result is uncertain, the
thread becomes `indeterminate`, and no research prompt is sent. An operator must
inspect runtime sessions and repair that one binding before proceeding; blindly
retrying session creation could make a second session. Prompt receipt recovery,
by contrast, uses the runtime's durable request ID and identical payload.

A `<database>.lock` file prevents two starter processes from owning the same
state. After a crash, inspect its PID and confirm the old process has stopped
before removing that exact lock. Never start a second worker on the same database.
On restart, outstanding `sending` entries become `indeterminate`. Queued commands
and pending outgoing messages whose principal binding has been removed become
`revoked` when processed. Their payloads remain in SQLite, but they cannot block
later authorized work or resume automatically if the binding is added again.
Reauthorizing a principal does not resubmit its old commands or messages. Preserve the
database, WAL and SHM files together for backup; they contain user prompts,
permission context and private result references. Do not commit them.

Useful local inspection (with your own exact database path):

```sql
SELECT id, phase FROM inbox;
SELECT key, user, project, session, phase, cursor FROM threads;
SELECT id, state, result_url FROM runs;
SELECT key, phase, slack_ts, detail FROM outbox;
```

## Tests and limits

Tests execute real SQLite persistence and request handlers, with injected local
runtime and Slack transports. They cover signature tampering/expiry, allowlist
and thread ownership, duplicate events across restart, uncertain creation and
delivery, same-ID receipt recovery, interrupted runs, cursor expiration, result
links, scoped cancellation, fresh explicit decisions, and revoked queue removal without
starving other principals. No live Slack message
or production model call is made.

This is a small working integration, not a full Slack product: it uses explicit
mention commands rather than interactive blocks, polls replay rather than holding
an SSE connection, posts receipt/status/result links rather than streaming tokens,
and has no automatic delivery reconciliation UI or automated repair of uncertain
session creation. The public runtime contract supports richer clients without
changing the agent loop.
