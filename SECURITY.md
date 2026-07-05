# Security

## Threat model

OpenScience is an AI agent that runs locally on your machine. The agent can run shell commands, read and write files, and access the web.

### No sandbox

OpenScience does not sandbox the agent. The permission system prompts you before the agent runs a command or writes a file, so you stay aware of what it is doing. It is not an isolation boundary. If you need real isolation, run OpenScience inside a container or a VM.

### Server mode

Server mode is opt-in. The server binds to localhost (127.0.0.1) only and enforces a Host and Origin allowlist to block DNS-rebinding and cross-origin requests. It is not built for remote exposure. If you tunnel or reverse-proxy it yourself, securing that exposure is your responsibility, and anything the server provides in that setup is not a vulnerability.

### Out of scope

| Category                    | Why                                                                  |
| --------------------------- | -------------------------------------------------------------------- |
| Server access when opted in | If you enable server mode, API access is expected behavior.          |
| Sandbox escapes             | The permission system is not a sandbox.                              |
| LLM provider data handling  | Data you send to a provider is governed by that provider's policies. |
| MCP server behavior         | External MCP servers you configure are outside the trust boundary.   |
| Malicious config files      | You control your own config; editing it is not an attack.            |

## Reporting a vulnerability

Please report security issues through the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/synthetic-sciences/OpenScience/security/advisories/new) form.

You will get a response with the next steps. The team will keep you updated on progress toward a fix and may ask for more detail. If you do not hear back within six business days, email security@syntheticsciences.ai.
