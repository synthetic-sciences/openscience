"""OpenAI-compatible loopback fixture. No model, credentials, or remote calls."""

import json
import platform
import shlex
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

COMMAND = "python -c " + shlex.quote(
    "import json, pathlib; "
    "data=json.loads(pathlib.Path('fixture-input.json').read_text()); "
    "result={'value':data['a']*data['b'],'cwd':str(pathlib.Path.cwd())}; "
    "pathlib.Path('fixture-result.json').write_text(json.dumps(result)); "
    "print(json.dumps(result))"
)


class Provider(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
        self.wfile.write(b"local deterministic fixture\n")

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        names = [tool["function"]["name"] for tool in body.get("tools", [])]
        has_result = any(message.get("role") == "tool" for message in body["messages"])
        use_tool = "bash" in names and not has_result
        with Path("/logs/agent/fixture-provider.jsonl").open("a") as stream:
            stream.write(
                json.dumps(
                    {
                        "path": self.path,
                        "model": body.get("model"),
                        "stream": body.get("stream"),
                        "tools": names,
                        "has_tool_result": has_result,
                        "emitted_tool": use_tool,
                    }
                )
                + "\n"
            )
        message = {"role": "assistant", "content": "Native fixture completed."}
        reason = "stop"
        if use_tool:
            # Exercise providers that report stop despite a local tool call.
            # Its result must still reach the model before final completion.
            message = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_native_fixture",
                        "type": "function",
                        "function": {
                            "name": "bash",
                            "arguments": json.dumps(
                                {
                                    "command": COMMAND,
                                    "description": "Calculate the local native fixture result",
                                }
                            ),
                        },
                    }
                ],
            }
        usage = {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15}
        base = {"id": "chatcmpl-native-fixture", "created": 1, "model": "fixture-model"}
        if body.get("stream"):
            if use_tool:
                message["tool_calls"][0]["index"] = 0
            chunks = [
                {
                    **base,
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": message, "finish_reason": None}],
                },
                {
                    **base,
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
                    "usage": usage,
                },
            ]
            payload = (
                "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                + "data: [DONE]\n\n"
            ).encode()
            content_type = "text/event-stream"
        else:
            payload = json.dumps(
                {
                    **base,
                    "object": "chat.completion",
                    "choices": [
                        {"index": 0, "message": message, "finish_reason": reason}
                    ],
                    "usage": usage,
                }
            ).encode()
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    Path("/logs/agent/fixture-environment.json").write_text(
        json.dumps(
            {
                "architecture": platform.machine(),
                "python": platform.python_version(),
                "cwd": str(Path.cwd()),
                "network_interfaces": {
                    item.name: {"flags": int((item / "flags").read_text(), 16)}
                    for item in Path("/sys/class/net").iterdir()
                    if (item / "flags").is_file()
                },
                "ipv4_routes": Path("/proc/net/route").read_text(),
                "ipv6_routes": Path("/proc/net/ipv6_route").read_text(),
            },
            indent=2,
        )
    )
    ThreadingHTTPServer(("127.0.0.1", 8765), Provider).serve_forever()
