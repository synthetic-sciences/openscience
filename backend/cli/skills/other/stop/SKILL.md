---
name: stop
description: Stop active work in the current session. Use when the user invokes /stop or asks to cancel the current turn, active compute jobs, session kernels, or all running session work.
---

# Stop active work

Cancel only the requested scope in the current session. Treat an unspecified scope as the active turn. Use `compute` for compute jobs and session kernels, or `all` when the user explicitly wants both the turn and compute stopped.

Preserve any queued draft and report exactly what was stopped.
