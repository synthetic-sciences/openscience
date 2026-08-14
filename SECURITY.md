# Security

## Threat model

OpenScience is an AI agent that runs locally on your machine. The agent can run shell commands, read and write files, and access the web.

### Execution sandbox

The permission system prompts you before the agent runs a command or writes a file, so you stay aware of what it is doing. A permission prompt is not an isolation boundary by itself, and the execution sandbox is off by default.

When enabled, OpenScience wraps shell commands and Python/R kernel code in an OS sandbox: macOS Seatbelt or Linux bubblewrap. It confines writes to the workspace and approved paths and can deny network egress. Run `openscience sandbox enable`, then `openscience sandbox test`; if the test does not report **Containment verified**, do not rely on it. Reads and local IPC remain available, Windows has no sandbox backend, and the boundary is not a full jail. Use a container or VM for hostile code.

### Server mode

Server mode is opt-in. The server binds to localhost (127.0.0.1) only and enforces a Host and Origin allowlist to block DNS-rebinding and cross-origin requests. It is not built for remote exposure. If you tunnel or reverse-proxy it yourself, securing that exposure is your responsibility, and anything the server provides in that setup is not a vulnerability.

### Out of scope

| Category                    | Why                                                                  |
| --------------------------- | -------------------------------------------------------------------- |
| Server access when opted in | If you enable server mode, API access is expected behavior.          |
| Full read isolation         | The sandbox confines writes; it does not hide readable local files.  |
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
