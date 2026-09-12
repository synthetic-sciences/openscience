import fs from "node:fs/promises"
import path from "node:path"

/**
 * The tracking SDK a training script imports. It is plain Python with no
 * dependencies, written into the job's workspace before launch so it travels
 * with the code to any target (local sandbox, SSH host, Modal container).
 *
 * Two transports. Inside a compute job the script has no network (sandboxes
 * deny sockets), so every record is one marked line on stdout that the
 * server reads back out of the job log. Outside a job, with
 * OPENSCIENCE_TRACK_URL set, records go to the server over HTTP.
 */
export namespace TrackingSDK {
  export const MARKER = "@@openscience.track "
  export const DIRECTORY = ".openscience/sdk"

  export const PYTHON = `"""openscience_track: experiment tracking for OpenScience.

Drop-in for the common wandb calls:

    import openscience_track as track
    run = track.init(project="study", name="baseline", config={"lr": 1e-3})
    for step in range(steps):
        track.log({"val_loss": loss, "lr": lr}, step=step)
    track.summary["val_loss"] = best
    track.finish()

No dependencies. Inside an OpenScience compute job every record is one
marked line on stdout; the server reads them from the job log. Elsewhere,
set OPENSCIENCE_TRACK_URL to send records over HTTP.
"""
from __future__ import annotations

import atexit
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

__all__ = ["init", "log", "finish", "log_artifact", "summary", "config", "run", "Run"]

_MARKER = "@@openscience.track "
_active = None
_lock = threading.Lock()


class _Summary(dict):
    """A dict whose writes are recorded at finish, wandb style."""


summary = _Summary()
config: dict = {}
run = None


class Run:
    def __init__(self, name, project, cfg, run_id, transport):
        self.name = name
        self.project = project
        self.config = cfg
        self.id = run_id
        self._transport = transport
        self._step = 0
        self._finished = False
        self._http_token = os.environ.get("OPENSCIENCE_TRACK_TOKEN", "")
        self._http_base = os.environ.get("OPENSCIENCE_TRACK_URL", "").rstrip("/")
        self._pending = []
        self._last_flush = time.time()
        self.summary = summary

    # ── transport ──────────────────────────────────────────────────────
    def _emit(self, record):
        record.setdefault("ts", int(time.time() * 1000))
        if self._transport == "http":
            self._pending.append(record)
            if len(self._pending) >= 200 or time.time() - self._last_flush > 0.5:
                self._flush_http()
            return
        with _lock:
            sys.stdout.write(_MARKER + json.dumps(record, separators=(",", ":"), default=str) + "\\n")
            if time.time() - self._last_flush > 1.0 or record.get("t") in ("init", "finish", "summary"):
                sys.stdout.flush()
                self._last_flush = time.time()

    def _post(self, path, payload):
        data = json.dumps(payload, default=str).encode()
        request = urllib.request.Request(
            self._http_base + path,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                **({"Authorization": "Bearer " + self._http_token} if self._http_token else {}),
            },
        )
        for delay in (0, 0.2, 0.5, 1.0):
            if delay:
                time.sleep(delay)
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    return json.loads(response.read() or b"{}")
            except urllib.error.HTTPError:
                raise
            except (OSError, urllib.error.URLError):
                continue
        return {}

    def _flush_http(self):
        if not self._pending:
            return
        batch, self._pending = self._pending, []
        self._last_flush = time.time()
        points = []
        others = []
        for record in batch:
            if record.get("t") == "log":
                for key, value in record["m"].items():
                    points.append({"key": key, "step": record["step"], "value": value, "ts": record["ts"]})
            else:
                others.append(record)
        try:
            if points:
                self._post("/experiments/ingest/runs/%s/points" % self.id, {"points": points})
            for record in others:
                if record.get("t") == "summary":
                    self._post("/experiments/ingest/runs/%s/summary" % self.id, {"summary": record["s"]})
                elif record.get("t") == "finish":
                    self._post("/experiments/ingest/runs/%s/finish" % self.id, {"status": record.get("status", "finished")})
        except Exception as error:  # tracking must never take the training down
            sys.stderr.write("openscience_track: %s\\n" % error)

    # ── api ────────────────────────────────────────────────────────────
    def log(self, metrics, step=None, commit=True):
        if self._finished:
            return
        if step is None:
            step = self._step
            self._step += 1
        else:
            self._step = max(self._step, int(step) + 1)
        clean = {}
        for key, value in dict(metrics).items():
            number = _number(value)
            if number is not None:
                clean[str(key)] = number
        if clean:
            self._emit({"t": "log", "step": step, "m": clean})

    def log_artifact(self, name, path=None):
        self._emit({"t": "artifact", "name": str(name), "path": str(path or name)})

    def finish(self, status="finished"):
        if self._finished:
            return
        self._finished = True
        if summary:
            self._emit({"t": "summary", "s": {k: _plain(v) for k, v in summary.items()}})
        self._emit({"t": "finish", "status": status})
        if self._transport == "http":
            self._flush_http()
        else:
            sys.stdout.flush()


def _number(value):
    try:
        if hasattr(value, "item"):
            value = value.item()
        if isinstance(value, bool):
            return float(value)
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _plain(value):
    number = _number(value)
    return number if number is not None else str(value)


def init(project=None, name=None, config=None, **_ignored):
    """Start a run. Extra wandb keyword arguments are accepted and ignored."""
    global _active, run
    if _active is not None and not _active._finished:
        return _active
    cfg = dict(config or {})
    globals()["config"].clear()
    globals()["config"].update(cfg)
    summary.clear()
    run_id = os.environ.get("OPENSCIENCE_RUN_ID", "")
    transport = os.environ.get("OPENSCIENCE_TRACK_TRANSPORT") or ("http" if os.environ.get("OPENSCIENCE_TRACK_URL") else "stdout")
    name = name or os.environ.get("OPENSCIENCE_RUN_NAME") or "run"
    project = project or os.environ.get("OPENSCIENCE_PROJECT") or "default"
    created = Run(name, project, cfg, run_id, transport)
    if transport == "http" and not run_id:
        try:
            response = created._post("/experiments/ingest/runs", {"name": name, "config": cfg, "project": project})
            created.id = response.get("id", "")
            created._http_token = response.get("token", created._http_token)
        except Exception as error:
            sys.stderr.write("openscience_track: could not register the run (%s); logging to stdout\\n" % error)
            created._transport = "stdout"
    created._emit({"t": "init", "name": name, "project": project, "config": cfg})
    _active = created
    run = created
    atexit.register(created.finish)
    return created


def log(metrics, step=None, commit=True):
    if _active is None:
        init()
    _active.log(metrics, step=step, commit=commit)


def log_artifact(name, path=None):
    if _active is None:
        init()
    _active.log_artifact(name, path)


def finish(status="finished"):
    if _active is not None:
        _active.finish(status)
`

  /** A wandb module that forwards to openscience_track, so scripts written
   * for wandb run unchanged when this directory precedes the real package on
   * PYTHONPATH. Enabled per study; never imposed on ordinary compute jobs. */
  export const WANDB_SHIM = `"""wandb-compatible shim backed by openscience_track."""
from openscience_track import *  # noqa: F401,F403
from openscience_track import init as _init, log, finish, summary, config, Run  # noqa: F401
import openscience_track as _track


def init(*args, **kwargs):
    return _init(*args, **kwargs)


def __getattr__(name):
    if name == "run":
        return _track.run
    raise AttributeError(name)


class Table:  # tables are not tracked; keep scripts importing wandb.Table alive
    def __init__(self, *args, **kwargs):
        self.data = kwargs.get("data") or (args[1] if len(args) > 1 else [])
        self.columns = kwargs.get("columns") or (args[0] if args else [])


def Image(*args, **kwargs):  # noqa: N802
    return None


def login(*args, **kwargs):
    return True
`

  /** Write the SDK into a workspace and return the PYTHONPATH entries. */
  export async function materialize(workspace: string, options: { shim: boolean }) {
    const root = path.join(workspace, DIRECTORY)
    await fs.mkdir(path.join(root, "openscience_track"), { recursive: true })
    await fs.writeFile(path.join(root, "openscience_track", "__init__.py"), PYTHON)
    const entries = [DIRECTORY]
    if (options.shim) {
      await fs.mkdir(path.join(root, "shim"), { recursive: true })
      await fs.writeFile(path.join(root, "shim", "wandb.py"), WANDB_SHIM)
      entries.push(`${DIRECTORY}/shim`)
    }
    return entries
  }

  /** The shell prefix that makes a command's Python find the SDK and know
   * its run. Relative PYTHONPATH entries resolve against the job's cwd on
   * every target. */
  export function prefix(input: { runID: string; name: string; entries: string[]; slot?: number }) {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    const exports = [
      `PYTHONPATH="${input.entries.join(":")}\${PYTHONPATH:+:$PYTHONPATH}"`,
      `OPENSCIENCE_RUN_ID=${quote(input.runID)}`,
      `OPENSCIENCE_RUN_NAME=${quote(input.name)}`,
      `OPENSCIENCE_TRACK_TRANSPORT=stdout`,
      `PYTHONUNBUFFERED=1`,
      ...(input.slot !== undefined ? [`CUDA_VISIBLE_DEVICES=${input.slot}`] : []),
    ]
    return `export ${exports.join(" ")}`
  }

  export function wrap(command: string, input: { runID: string; name: string; entries: string[]; slot?: number }) {
    return `${prefix(input)}\n${command}`
  }
}
