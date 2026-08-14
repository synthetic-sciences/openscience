# Security

## Threat model

OpenScience is an AI agent that runs locally on your machine. The agent can run shell commands, read and write files, and access the web.

### Execution sandbox

The permission system decides whether the agent may take an action. A permission prompt is not an isolation boundary by itself. OpenScience enables its execution sandbox by default and refuses to run when a native backend is unavailable unless you explicitly choose a fallback policy.

OpenScience wraps terminal and shell commands, Python/R kernels, and local compute jobs in macOS Seatbelt or Linux bubblewrap. It confines reads and writes to the session workspace and explicitly granted paths and denies network egress. Routine work can run immediately inside that verified boundary; remote jobs, kernel environment changes, project-owned extensions, and host execution still require explicit project trust. Run `openscience sandbox test`; if it does not report **Containment verified**, do not rely on that backend. Windows has no sandbox backend, and the boundary is not a full VM. Use a container or VM for hostile code.

### Server mode

Server mode is opt-in. The server binds to localhost (127.0.0.1) only and enforces a Host and Origin allowlist to block DNS-rebinding and cross-origin requests. It is not built for remote exposure. If you tunnel or reverse-proxy it yourself, securing that exposure is your responsibility, and anything the server provides in that setup is not a vulnerability.

### Out of scope

| Category                    | Why                                                                  |
| --------------------------- | -------------------------------------------------------------------- |
| Server access when opted in | If you enable server mode, API access is expected behavior.          |
| Granted-root contents       | A command may read files inside roots explicitly granted to it.      |
| Windows sandboxing          | Windows has no execution-sandbox backend yet.                        |
| LLM provider data handling  | Data you send to a provider is governed by that provider's policies. |
| MCP server behavior         | External MCP servers you configure are outside the trust boundary.   |
| Malicious config files      | You control your own config; editing it is not an attack.            |

## Supported versions

Security fixes ship in the latest release on npm (`@synsci/openscience`). Please
upgrade to the newest version before reporting — earlier versions are not patched.

| Version            | Supported |
| ------------------ | --------- |
| latest npm release | ✅        |
| older releases     | ❌        |

## Reporting a vulnerability

Please report security issues through the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/synthetic-sciences/OpenScience/security/advisories/new) form.

You will get a response with the next steps. The team will keep you updated on progress toward a fix and may ask for more detail. If you do not hear back within six business days, email security@syntheticsciences.ai.
