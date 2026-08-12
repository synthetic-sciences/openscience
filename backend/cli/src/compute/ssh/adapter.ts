import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ModalAdapter } from "../modal/adapter"

export namespace SshAdapter {
  export type Scheduler = "none" | "slurm" | "pbs"

  export type Host = {
    id: string
    label: string
    host: string
    user?: string
    port?: number
    scheduler: Scheduler
    workdir?: string
    fingerprint?: string
    host_key?: string
    concurrency?: number
  }

  export type Upload = Pick<ModalAdapter.File, "path" | "canonical" | "size" | "sha256">

  export type Spec = {
    id: string
    owner: string
    root: string
    cwd: string
    command: string
    scheduler: Scheduler
    resources?: {
      cpus?: number
      gpus?: number
      memory_gb?: number
      time_minutes?: number
      partition?: string
    }
    modules?: string[]
    container?: string
    outputs: string[]
    uploads: Upload[]
  }

  export type Result = {
    state: "queued" | "running" | "done" | "cancelled" | "unknown"
    code?: number
    detail?: string
  }

  export type Manifest = {
    files: { path: string; size: number; sha256: string }[]
  }

  const SUPERVISOR = String.raw`#!/usr/bin/env python3
import ctypes
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1]).resolve()
script = pathlib.Path(sys.argv[2]).resolve()
unit = sys.argv[3] if len(sys.argv) > 3 else ""
cancelled = False
forced = False
primary = 0
code = None

def atomic(name, value):
    target = root / name
    temp = root / (name + ".tmp-" + str(os.getpid()))
    temp.write_text(str(value) + "\n", encoding="utf-8")
    os.replace(temp, target)

def identity(pid):
    stat = pathlib.Path("/proc") / str(pid) / "stat"
    if stat.is_file():
        text = stat.read_text(encoding="utf-8")
        fields = text[text.rfind(")") + 2:].split()
        return "proc:" + fields[19]
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return "ps:" + result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else ""

darwin_library = None
darwin_owner = 0
darwin_marker = "--openscience-responsibility-root"

def darwin_symbols():
    global darwin_library
    if sys.platform != "darwin":
        return None
    if darwin_library is not None:
        return darwin_library
    try:
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        library.responsibility_get_pid_responsible_for_pid.argtypes = [ctypes.c_int]
        library.responsibility_get_pid_responsible_for_pid.restype = ctypes.c_int
        library.responsibility_get_uniqueid_responsible_for_pid.argtypes = [ctypes.c_int]
        library.responsibility_get_uniqueid_responsible_for_pid.restype = ctypes.c_uint64
        library.posix_spawnattr_init.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        library.posix_spawnattr_init.restype = ctypes.c_int
        library.posix_spawnattr_setflags.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_short]
        library.posix_spawnattr_setflags.restype = ctypes.c_int
        library.responsibility_spawnattrs_setdisclaim.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_bool]
        library.responsibility_spawnattrs_setdisclaim.restype = ctypes.c_int
        library.posix_spawnattr_destroy.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        library.posix_spawnattr_destroy.restype = ctypes.c_int
        library.posix_spawn.argtypes = [
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_char_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.POINTER(ctypes.c_char_p),
        ]
        library.posix_spawn.restype = ctypes.c_int
        darwin_library = library
        return library
    except (AttributeError, OSError):
        return None

def darwin_unique(pid):
    library = darwin_symbols()
    if library is None:
        return 0
    try:
        return int(library.responsibility_get_uniqueid_responsible_for_pid(int(pid)))
    except (OverflowError, ValueError):
        return 0

def darwin_exec_root(library):
    attributes = ctypes.c_void_p()
    initialized = False
    def check(action, code):
        if code != 0:
            raise RuntimeError(action + " failed (errno " + str(code) + ")")
    try:
        check("posix_spawnattr_init", library.posix_spawnattr_init(ctypes.byref(attributes)))
        initialized = True
        check("responsibility_spawnattrs_setdisclaim", library.responsibility_spawnattrs_setdisclaim(ctypes.byref(attributes), True))
        check("posix_spawnattr_setflags", library.posix_spawnattr_setflags(ctypes.byref(attributes), 0x0040))
        executable = os.fsencode(sys.executable)
        arguments = [executable] + [os.fsencode(value) for value in sys.argv] + [os.fsencode(darwin_marker)]
        environment = [os.fsencode(key + "=" + value) for key, value in os.environ.items()]
        argv = (ctypes.c_char_p * (len(arguments) + 1))(*arguments, None)
        envp = (ctypes.c_char_p * (len(environment) + 1))(*environment, None)
        spawned = ctypes.c_int()
        check("posix_spawn(POSIX_SPAWN_SETEXEC)", library.posix_spawn(ctypes.byref(spawned), executable, None, ctypes.byref(attributes), argv, envp))
        raise RuntimeError("posix_spawn(POSIX_SPAWN_SETEXEC) returned after successful process replacement")
    finally:
        if initialized:
            library.posix_spawnattr_destroy(ctypes.byref(attributes))

def darwin_responsibility():
    global darwin_owner
    library = darwin_symbols()
    if library is None:
        return False
    if not sys.argv or sys.argv[-1] != darwin_marker:
        darwin_exec_root(library)
    responsible = int(library.responsibility_get_pid_responsible_for_pid(os.getpid()))
    owner = darwin_unique(os.getpid())
    if responsible != os.getpid() or owner <= 0:
        return False
    darwin_owner = owner
    return True

def darwin_members():
    if not darwin_owner:
        return []
    result = subprocess.run(["ps", "-axo", "pid="], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode != 0:
        return []
    found = []
    for value in result.stdout.split():
        if value.isdigit():
            pid = int(value)
            if pid != os.getpid() and darwin_unique(pid) == darwin_owner:
                found.append(pid)
    return found

def darwin_owns(pid):
    return not darwin_owner or darwin_unique(pid) == darwin_owner

def subreaper():
    if not sys.platform.startswith("linux"):
        return False
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        return False
    return True

def children(pid):
    table = {}
    proc = pathlib.Path("/proc")
    if not proc.is_dir():
        return []
    for item in proc.iterdir():
        if not item.name.isdigit():
            continue
        try:
            text = (item / "stat").read_text(encoding="utf-8")
            parent = int(text[text.rfind(")") + 2:].split()[1])
            table.setdefault(parent, []).append(int(item.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, IndexError):
            continue
    found = []
    pending = list(table.get(pid, []))
    while pending:
        child = pending.pop()
        if child in found:
            continue
        found.append(child)
        pending.extend(table.get(child, []))
    return found

def tagged():
    token = "OPENSCIENCE_JOB_ID=" + hashlib.sha256(str(root).encode()).hexdigest()
    result = subprocess.run(["ps", "eww", "-axo", "pid=,command="], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode != 0:
        return []
    found = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit() and token in fields[1]:
            found.append(int(fields[0]))
    return found

def cgroup_members():
    if not unit or not pathlib.Path("/sys/fs/cgroup").is_dir():
        return []
    result = subprocess.run(["systemctl", "--user", "show", unit, "--property=ControlGroup", "--value"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    group = result.stdout.strip()
    if result.returncode != 0 or not group.startswith("/"):
        return []
    folder = pathlib.Path("/sys/fs/cgroup") / group.lstrip("/")
    found = []
    try:
        lists = list(folder.rglob("cgroup.procs"))
    except (FileNotFoundError, PermissionError):
        return []
    for item in lists:
        try:
            found.extend(int(value) for value in item.read_text(encoding="utf-8").split())
        except (FileNotFoundError, PermissionError, ValueError):
            continue
    return sorted(set(found))

def members():
    return [pid for pid in cgroup_members() if pid != os.getpid()]

def scoped():
    return os.getpid() in cgroup_members()

def owned():
    return sorted(set(children(os.getpid()) + members() + tagged() + darwin_members()))

def send(sig):
    targets = owned()
    group_owned = False
    for pid in targets:
        try:
            if os.getpgid(pid) == primary and darwin_owns(pid):
                group_owned = True
                break
        except (ProcessLookupError, PermissionError):
            pass
    if primary and group_owned:
        try:
            os.killpg(primary, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass
    for pid in reversed(targets):
        if pid == os.getpid():
            continue
        if not darwin_owns(pid):
            continue
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass

def reap():
    global code
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return False
        if pid == 0:
            return True
        if pid == primary:
            code = os.waitstatus_to_exitcode(status)

def request(_signal, _frame):
    global cancelled
    cancelled = True

def force(_signal, _frame):
    global cancelled, forced
    cancelled = True
    forced = True

signal.signal(signal.SIGTERM, request)
signal.signal(signal.SIGINT, request)
if hasattr(signal, "SIGUSR1"):
    signal.signal(signal.SIGUSR1, force)

responsible = darwin_responsibility()
adopts = subreaper()
scope = scoped()
containment = "darwin-responsibility" if responsible else "linux-subreaper" if adopts else "systemd-scope" if scope else ""
if not containment:
    atomic("containment-error", "Direct SSH dispatch requires a verified Linux subreaper, systemd scope, or macOS responsibility root")
    raise SystemExit(125)
atomic("runtime.json", json.dumps({"pid": os.getpid(), "identity": identity(os.getpid()), "unit": unit, "subreaper": adopts, "responsibility": darwin_owner, "containment": containment}, separators=(",", ":")))
environment = dict(os.environ)
environment["OPENSCIENCE_JOB_ID"] = hashlib.sha256(str(root).encode()).hexdigest()
process = subprocess.Popen(["bash", str(script)], cwd=str(root / "work"), stdin=subprocess.DEVNULL, env=environment, start_new_session=True, close_fds=True)
primary = process.pid
started = None

while True:
    live = reap()
    extra = owned()
    if cancelled:
        if started is None:
            started = time.monotonic()
        send(signal.SIGKILL if forced or time.monotonic() - started >= 2 else signal.SIGTERM)
        if not live and not extra:
            atomic("cancelled", "1")
            raise SystemExit(0)
        time.sleep(0.02)
        continue
    if not live and not extra:
        atomic("exit", code if code is not None else 1)
        raise SystemExit(code if code is not None else 1)
    time.sleep(0.02)
`

  const BROKER = String.raw`import hashlib, json, os, pathlib, secrets, stat, sys

root = pathlib.Path(sys.argv[1])
staging = pathlib.Path(sys.argv[2])
manifest = json.load(sys.stdin)
directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def descend(base, parts, create):
    current = os.dup(base)
    try:
        for name in parts:
            if not name or name in (".", "..") or "/" in name or "\\" in name:
                raise RuntimeError("Unsafe SSH output path component")
            try:
                child = os.open(name, directory, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
                child = os.open(name, directory, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise

rootfd = os.open(root, directory)
stagefd = os.open(staging, directory)
try:
    for item in manifest["files"]:
        parts = pathlib.PurePosixPath(item["path"]).parts
        if not parts:
            raise RuntimeError("Unsafe empty SSH output path")
        temporary = "." + parts[-1] + "." + secrets.token_hex(16) + ".openscience.tmp"
        source_parent = -1
        target_parent = -1
        source = -1
        target = -1
        try:
            try:
                source_parent = descend(stagefd, parts[:-1], False)
                source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=source_parent)
            except OSError:
                raise RuntimeError("SSH output staging changed during delivery: " + item["path"]) from None
            source_stat = os.fstat(source)
            if not stat.S_ISREG(source_stat.st_mode):
                raise RuntimeError("SSH output staging member is not a regular file: " + item["path"])
            try:
                target_parent = descend(rootfd, parts[:-1], True)
                target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_parent)
                digest = hashlib.sha256()
                size = 0
                while True:
                    chunk = os.read(source, 1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    size += len(chunk)
                    view = memoryview(chunk)
                    while view:
                        written = os.write(target, view)
                        view = view[written:]
                os.fsync(target)
                if size != item["size"] or digest.hexdigest() != item["sha256"]:
                    raise RuntimeError("SSH output copy failed integrity verification: " + item["path"])
                os.close(target)
                target = -1
                try:
                    os.link(temporary, parts[-1], src_dir_fd=target_parent, dst_dir_fd=target_parent, follow_symlinks=False)
                except FileExistsError:
                    existing = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=target_parent)
                    try:
                        existing_digest = hashlib.sha256()
                        existing_size = 0
                        while True:
                            chunk = os.read(existing, 1024 * 1024)
                            if not chunk:
                                break
                            existing_digest.update(chunk)
                            existing_size += len(chunk)
                        if existing_size != item["size"] or existing_digest.hexdigest() != item["sha256"]:
                            raise RuntimeError("Refusing to replace an existing workspace file with SSH output: " + item["path"])
                    finally:
                        os.close(existing)
                os.unlink(temporary, dir_fd=target_parent)
                os.fsync(target_parent)
            except OSError:
                raise RuntimeError("SSH output destination changed during delivery: " + item["path"]) from None
        finally:
            if source >= 0:
                os.close(source)
            if target >= 0:
                os.close(target)
            if target_parent >= 0:
                try:
                    os.unlink(temporary, dir_fd=target_parent)
                except FileNotFoundError:
                    pass
            if source_parent >= 0:
                os.close(source_parent)
            if target_parent >= 0:
                os.close(target_parent)
finally:
    os.close(stagefd)
    os.close(rootfd)
`

  const CONTROL = String.raw`#!/usr/bin/env python3
import glob
import hashlib
import json
import os
import pathlib
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

root = pathlib.Path(__file__).resolve().parent

def atomic(name, value):
    target = root / name
    temp = root / (name + ".tmp-" + str(os.getpid()))
    temp.write_text(str(value) + "\n", encoding="utf-8")
    os.replace(temp, target)

def own(token):
    saved = (root / "owner").read_text(encoding="utf-8").strip()
    if not token or not hashlib.sha256(token.encode()).hexdigest() == saved:
        raise RuntimeError("OpenScience SSH job ownership mismatch")

def spec():
    return json.loads((root / "spec.json").read_text(encoding="utf-8"))

def remote_id():
    return (root / "remote-id").read_text(encoding="utf-8").strip()

def response(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")

def identity(pid):
    stat = pathlib.Path("/proc") / str(pid) / "stat"
    if stat.is_file():
        try:
            text = stat.read_text(encoding="utf-8")
            return "proc:" + text[text.rfind(")") + 2:].split()[19]
        except (FileNotFoundError, ProcessLookupError, IndexError):
            return ""
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return "ps:" + result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else ""

def runtime():
    try:
        value = json.loads((root / "runtime.json").read_text(encoding="utf-8"))
        if not isinstance(value.get("pid"), int) or not isinstance(value.get("identity"), str):
            raise RuntimeError("OpenScience SSH runtime identity is invalid")
        return value
    except (FileNotFoundError, json.JSONDecodeError):
        return None

def alive(value):
    return bool(value and value.get("identity") and identity(value["pid"]) == value["identity"])

def scope_ready():
    if not shutil.which("systemd-run") or not shutil.which("systemctl"):
        return False
    name = "openscience-probe-" + str(os.getpid()) + "-" + str(time.time_ns()) + ".scope"
    result = subprocess.run(["systemd-run", "--user", "--scope", "--quiet", "--unit=" + name, "true"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return result.returncode == 0

def scope_empty(value):
    unit = value.get("unit") if value else ""
    if not unit:
        return True
    result = subprocess.run(["systemctl", "--user", "is-active", unit], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return result.stdout.strip() not in ("active", "activating", "deactivating", "reloading")

def workload(value):
    command = value["command"]
    if value.get("container"):
        command = "runtime=$(command -v apptainer || command -v singularity) || { echo 'OpenScience requires Apptainer or Singularity for this runtime image' >&2; exit 127; }; \"$runtime\" exec " + shlex.quote(value["container"]) + " bash -lc " + shlex.quote(command)
    modules = value.get("modules") or []
    if modules:
        command = "module load " + " ".join(shlex.quote(item) for item in modules) + " && " + command
    return command

def run_script(value):
    work = (root / "work").resolve()
    cwd = (work / value["cwd"]).resolve()
    if work != cwd and work not in cwd.parents:
        raise RuntimeError("OpenScience SSH job cwd escaped its staged workspace")
    cwd.mkdir(parents=True, exist_ok=True)
    command = workload(value)
    script = root / "run.sh"
    script.write_text("\n".join([
        "#!/usr/bin/env bash",
        "set +e",
        "cd " + shlex.quote(str(cwd)),
        "exec bash -lc " + shlex.quote(command),
        "",
    ]), encoding="utf-8")
    script.chmod(0o700)
    return script

def flags(value):
    resources = value.get("resources") or {}
    if value["scheduler"] == "slurm":
        result = []
        if resources.get("cpus"):
            result.append("--cpus-per-task=" + str(resources["cpus"]))
        if resources.get("gpus"):
            result.append("--gres=gpu:" + str(resources["gpus"]))
        if resources.get("memory_gb"):
            result.append("--mem=" + str(resources["memory_gb"]) + "G")
        if resources.get("time_minutes"):
            minutes = int(resources["time_minutes"])
            result.append("--time=%02d:%02d:00" % (minutes // 60, minutes % 60))
        if resources.get("partition"):
            result.append("--partition=" + resources["partition"])
        return result
    if value["scheduler"] == "pbs":
        selected = ["select=1"]
        if resources.get("cpus"):
            selected.append("ncpus=" + str(resources["cpus"]))
        if resources.get("gpus"):
            selected.append("ngpus=" + str(resources["gpus"]))
        if resources.get("memory_gb"):
            selected.append("mem=" + str(resources["memory_gb"]) + "gb")
        result = [] if len(selected) == 1 else ["-l", ":".join(selected)]
        if resources.get("time_minutes"):
            minutes = int(resources["time_minutes"])
            result += ["-l", "walltime=%02d:%02d:00" % (minutes // 60, minutes % 60)]
        if resources.get("partition"):
            result += ["-q", resources["partition"]]
        return result
    return []

def recover_scheduler(value, name):
    if value["scheduler"] == "slurm":
        live = subprocess.run(["squeue", "-h", "--name=" + name, "-o", "%A|%j"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        for line in live.stdout.splitlines():
            fields = line.strip().split("|", 1)
            if len(fields) == 2 and fields[1] == name and fields[0]:
                return "slurm:" + fields[0]
        history = subprocess.run(["sacct", "-n", "-X", "--name=" + name, "--format=JobIDRaw,JobName", "-P"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        for line in history.stdout.splitlines():
            fields = line.strip().split("|", 1)
            if len(fields) == 2 and fields[1] == name and fields[0]:
                return "slurm:" + fields[0]
        return ""
    query = subprocess.run(["qstat", "-f"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    identifier = ""
    matched = False
    for line in query.stdout.splitlines() + [""]:
        if line.startswith("Job Id:"):
            if matched and identifier:
                return "pbs:" + identifier
            identifier = line.split(":", 1)[1].strip()
            matched = False
            continue
        if "Job_Name" in line and "=" in line:
            matched = line.split("=", 1)[1].strip() == name
        if not line.strip() and matched and identifier:
            return "pbs:" + identifier
    return ""

def submit(token):
    own(token)
    if (root / "remote-id").exists():
        response({"remote_id": remote_id(), "reattached": True})
        return
    value = spec()
    script = run_script(value)
    log = root / "log"
    log.touch(mode=0o600, exist_ok=True)
    raw_name = ("os-" + value["id"])[0:63]
    name = raw_name.replace("-", "_")[0:15] if value["scheduler"] == "pbs" else raw_name
    intent = root / "intent.json"
    if intent.exists():
        saved_intent = json.loads(intent.read_text(encoding="utf-8"))
        if saved_intent.get("scheduler") != value["scheduler"] or saved_intent.get("name") != name:
            raise RuntimeError("SSH submission intent does not match the staged scheduler contract")
        if value["scheduler"] == "none":
            saved = runtime()
            if saved and (alive(saved) or (root / "exit").exists() or (root / "cancelled").exists()):
                identifier = "pid:" + str(saved["pid"])
                atomic("remote-id", identifier)
                response({"remote_id": identifier, "reattached": True})
                return
        else:
            recovered = recover_scheduler(value, name)
            if recovered:
                atomic("remote-id", recovered)
                response({"remote_id": recovered, "reattached": True})
                return
        raise RuntimeError("SSH submission intent exists but the accepted resource is not yet discoverable; retry without creating a duplicate")
    atomic("intent.json", json.dumps({"scheduler": value["scheduler"], "name": name, "created_at": time.time_ns()}, separators=(",", ":")))
    if value["scheduler"] == "slurm":
        command = ["sbatch", "--parsable", "--job-name=" + name, "--output=" + str(log), "--error=" + str(log)] + flags(value) + [str(script)]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            intent.unlink(missing_ok=True)
            raise RuntimeError("sbatch failed: " + result.stderr.strip())
        identifier = result.stdout.strip().splitlines()[-1].split(";", 1)[0]
        if not identifier:
            raise RuntimeError("sbatch returned no job id")
        identifier = "slurm:" + identifier
    elif value["scheduler"] == "pbs":
        command = ["qsub", "-N", name, "-j", "oe", "-o", str(log)] + flags(value) + [str(script)]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            intent.unlink(missing_ok=True)
            raise RuntimeError("qsub failed: " + result.stderr.strip())
        identifier = result.stdout.strip().splitlines()[-1].split()[0]
        if not identifier:
            raise RuntimeError("qsub returned no job id")
        identifier = "pbs:" + identifier
    else:
        for marker in ("runtime.json", "exit", "cancelled", "containment-error"):
            try:
                (root / marker).unlink()
            except FileNotFoundError:
                pass
        scoped = scope_ready()
        unit = "openscience-" + hashlib.sha256(value["id"].encode()).hexdigest()[0:20] + ".scope" if scoped else ""
        supervise = [sys.executable, str(root / "supervisor.py"), str(root), str(script), unit]
        command = ["systemd-run", "--user", "--scope", "--quiet", "--unit=" + unit] + supervise if scoped else supervise
        output = open(log, "ab", buffering=0)
        launcher = subprocess.Popen(command, cwd=str(root / "work"), stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        output.close()
        deadline = time.monotonic() + 10
        value = runtime()
        while (not value or not alive(value)) and time.monotonic() < deadline:
            if launcher.poll() is not None:
                break
            time.sleep(0.02)
            value = runtime()
        if not value or not alive(value):
            intent.unlink(missing_ok=True)
            detail = (root / "containment-error").read_text(encoding="utf-8").strip() if (root / "containment-error").exists() else ""
            raise RuntimeError(detail or "Direct SSH ownership supervisor did not become ready")
        identifier = "pid:" + str(value["pid"])
    atomic("remote-id", identifier)
    response({"remote_id": identifier, "reattached": False})

def slurm_result(raw_state, raw_exit):
    state = raw_state.upper().strip().split()[0].rstrip("+")
    exit_fields = raw_exit.split(":", 1)
    status = int(exit_fields[0]) if exit_fields[0].lstrip("-").isdigit() else 1
    termination = int(exit_fields[1]) if len(exit_fields) > 1 and exit_fields[1].isdigit() else 0
    if state == "CANCELLED":
        return {"state": "cancelled", "detail": raw_state}
    if state in ("PENDING", "CONFIGURING"):
        return {"state": "queued", "detail": raw_state}
    if state in ("RUNNING", "COMPLETING", "RESIZING", "SUSPENDED"):
        return {"state": "running", "detail": raw_state}
    code = 0 if state == "COMPLETED" and status == 0 and termination == 0 else status or (128 + termination if termination else 1)
    return {"state": "done", "code": code, "detail": raw_state}

def scheduler_status(identifier, value):
    raw = identifier.split(":", 1)[1]
    if identifier.startswith("slurm:"):
        live = subprocess.run(["squeue", "-h", "-j", raw, "-o", "%T"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        state = live.stdout.strip().splitlines()
        if state:
            name = state[0].upper()
            return {"state": "queued" if name in ("PENDING", "CONFIGURING") else "running", "detail": name}
        history = subprocess.run(["sacct", "-n", "-X", "-P", "-j", raw, "--format=State,ExitCode"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        rows = [line for line in history.stdout.splitlines() if line.strip()]
        if rows:
            fields = rows[0].split("|")
            return slurm_result(fields[0], fields[1] if len(fields) > 1 else "1:0")
        return {"state": "unknown", "detail": "Slurm no longer reports this job and no exit marker was found"}
    query = subprocess.run(["qstat", "-xf", raw], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if query.returncode != 0:
        query = subprocess.run(["qstat", "-f", raw], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    text = query.stdout
    match = next((line.split("=", 1)[1].strip() for line in text.splitlines() if "job_state" in line and "=" in line), "")
    code = next((line.split("=", 1)[1].strip() for line in text.splitlines() if "Exit_status" in line and "=" in line), "")
    if code.lstrip("-").isdigit():
        return {"state": "done", "code": int(code), "detail": match or "finished"}
    if match:
        return {"state": "queued" if match in ("Q", "H", "W", "T") else "running", "detail": match}
    return {"state": "unknown", "detail": "PBS no longer reports this job and no exit marker was found"}

def status(token, identifier):
    own(token)
    if identifier != remote_id():
        raise RuntimeError("OpenScience SSH remote id mismatch")
    marker = root / "exit"
    if marker.exists():
        response({"state": "done", "code": int(marker.read_text(encoding="utf-8").strip())})
        return
    if (root / "cancelled").exists():
        response({"state": "cancelled"})
        return
    value = spec()
    if identifier.startswith("slurm:") or identifier.startswith("pbs:"):
        response(scheduler_status(identifier, value))
        return
    value = runtime()
    pid = int(identifier.split(":", 1)[1])
    if not value or value["pid"] != pid:
        response({"state": "unknown", "detail": "Direct SSH runtime identity is missing"})
        return
    if not alive(value) and not scope_empty(value):
        response({"state": "running", "detail": "The systemd ownership scope is draining descendants"})
        return
    if not alive(value):
        response({"state": "unknown", "detail": "Direct SSH process ended without publishing an exit marker"})
        return
    response({"state": "running"})

def cancel(token, identifier):
    own(token)
    if identifier != remote_id():
        raise RuntimeError("OpenScience SSH remote id mismatch")
    if identifier.startswith("slurm:"):
        result = subprocess.run(["scancel", identifier.split(":", 1)[1]], stderr=subprocess.PIPE, text=True)
    elif identifier.startswith("pbs:"):
        result = subprocess.run(["qdel", identifier.split(":", 1)[1]], stderr=subprocess.PIPE, text=True)
    else:
        pid = int(identifier.split(":", 1)[1])
        value = runtime()
        if not value or value["pid"] != pid:
            raise RuntimeError("Refusing to cancel a direct SSH PID without its exact runtime identity")
        if (root / "exit").exists() and not alive(value) and scope_empty(value):
            atomic("cancelled", "1")
            response({"cancelled": True})
            return
        if (root / "cancelled").exists() and not alive(value) and scope_empty(value):
            response({"cancelled": True})
            return
        if alive(value):
            try:
                os.kill(pid, signal.SIGTERM)
                result = subprocess.CompletedProcess([], 0, "", "")
            except ProcessLookupError:
                result = subprocess.CompletedProcess([], 0, "", "")
        elif not scope_empty(value):
            result = subprocess.run(["systemctl", "--user", "kill", "--signal=TERM", "--kill-whom=all", value["unit"]], stderr=subprocess.PIPE, text=True)
        else:
            response({"cancelled": False, "detail": "Direct SSH ownership supervisor disappeared before descendant shutdown was proven"})
            return
    if result.returncode != 0:
        raise RuntimeError("Remote cancellation failed: " + result.stderr.strip())
    if identifier.startswith("slurm:") or identifier.startswith("pbs:"):
        value = spec()
        confirmed = False
        for _ in range(200):
            state = scheduler_status(identifier, value)["state"]
            if state in ("cancelled", "done"):
                confirmed = True
                break
            time.sleep(0.1)
        if not confirmed:
            response({"cancelled": False, "detail": "Scheduler did not report a terminal state after cancellation"})
            return
    else:
        for attempt in range(600):
            value = runtime()
            if (root / "cancelled").exists() and not alive(value) and scope_empty(value):
                break
            if attempt == 100 and alive(value) and hasattr(signal, "SIGUSR1"):
                os.kill(pid, signal.SIGUSR1)
            if attempt == 100 and not alive(value) and not scope_empty(value):
                subprocess.run(["systemctl", "--user", "kill", "--signal=KILL", "--kill-whom=all", value["unit"]], stderr=subprocess.DEVNULL)
            time.sleep(0.02)
        value = runtime()
        if (not (root / "cancelled").exists() and alive(value)) or alive(value) or not scope_empty(value):
            response({"cancelled": False, "detail": "Remote ownership supervisor did not prove that every descendant exited"})
            return
        if not (root / "cancelled").exists():
            atomic("cancelled", "1")
    if not (root / "cancelled").exists():
        atomic("cancelled", "1")
    response({"cancelled": True})

def logs(token, amount):
    own(token)
    file = root / "log"
    if not file.exists():
        return
    with file.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - int(amount)))
        shutil.copyfileobj(handle, sys.stdout.buffer)

def harvest(token):
    own(token)
    value = spec()
    work = (root / "work").resolve()
    files = {}
    for pattern in value.get("outputs") or []:
        for item in glob.glob(str(work / pattern), recursive=True):
            source = pathlib.Path(item).resolve()
            if not source.is_file() or (work != source and work not in source.parents):
                continue
            relative = source.relative_to(work).as_posix()
            if relative in files:
                continue
            size = source.stat().st_size
            digest = hashlib.sha256()
            with source.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            files[relative] = {"path": relative, "size": size, "sha256": digest.hexdigest()}
    ordered = [files[key] for key in sorted(files)]
    if len(ordered) > 200:
        raise RuntimeError("SSH outputs exceed the 200 file recovery limit")
    if sum(item["size"] for item in ordered) > 20 * 1024 * 1024 * 1024:
        raise RuntimeError("SSH outputs exceed the 20 GiB recovery limit")
    manifest = json.dumps({"files": ordered}, separators=(",", ":")).encode()
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        info = tarfile.TarInfo("manifest.json")
        info.size = len(manifest)
        import io
        archive.addfile(info, io.BytesIO(manifest))
        for item in ordered:
            archive.add(str(work / item["path"]), arcname="files/" + item["path"], recursive=False)

def release(token):
    own(token)
    parent = root.parent.resolve()
    target = root.resolve()
    if parent == target or parent not in target.parents:
        raise RuntimeError("Refusing unsafe SSH job release path")
    shutil.rmtree(target)
    response({"released": True})

action = sys.argv[1]
token = sys.argv[2]
if action == "__slurm": response(slurm_result(token, sys.argv[3]))
elif action == "submit": submit(token)
elif action == "status": status(token, sys.argv[3])
elif action == "cancel": cancel(token, sys.argv[3])
elif action == "log": logs(token, sys.argv[3])
elif action == "harvest": harvest(token)
elif action == "release": release(token)
else: raise RuntimeError("Unknown OpenScience SSH control action")
`

  const RECEIVER = String.raw`import hashlib, json, os, pathlib, shutil, sys, tarfile, tempfile
root = pathlib.Path(os.path.expanduser(sys.argv[1])).resolve()
token = sys.argv[2]
owner = hashlib.sha256(token.encode()).hexdigest()
root.parent.mkdir(parents=True, exist_ok=True)
if root.exists():
    saved = (root / "owner").read_text(encoding="utf-8").strip() if (root / "owner").exists() else ""
    if saved != owner: raise RuntimeError("OpenScience SSH job ownership mismatch")
    if (root / "remote-id").exists(): raise RuntimeError("OpenScience SSH job was already submitted")
else:
    root.mkdir(mode=0o700)
    (root / "owner").write_text(owner + "\n", encoding="utf-8")
incoming = pathlib.Path(tempfile.mkdtemp(prefix="incoming-", dir=root))
try:
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as archive:
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError("Unsafe OpenScience SSH staging archive")
            target = (incoming / pathlib.Path(*name.parts)).resolve()
            if incoming.resolve() != target and incoming.resolve() not in target.parents:
                raise RuntimeError("OpenScience SSH staging archive escaped its root")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None: raise RuntimeError("OpenScience SSH staging archive is truncated")
            with target.open("wb") as output: shutil.copyfileobj(source, output)
    manifest = json.loads((incoming / "inputs.json").read_text(encoding="utf-8"))
    for item in manifest["files"]:
        file = (incoming / "work" / item["path"]).resolve()
        work = (incoming / "work").resolve()
        if work != file and work not in file.parents: raise RuntimeError("SSH input escaped its staged workspace")
        if not file.is_file() or file.stat().st_size != item["size"]: raise RuntimeError("SSH input size verification failed: " + item["path"])
        digest = hashlib.sha256()
        with file.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
        if digest.hexdigest() != item["sha256"]: raise RuntimeError("SSH input checksum verification failed: " + item["path"])
    for name in ("work", "spec.json", "control.py", "supervisor.py", "inputs.json"):
        source = incoming / name
        target = root / name
        if target.exists():
            shutil.rmtree(target) if target.is_dir() else target.unlink()
        os.replace(source, target)
    (root / "control.py").chmod(0o700)
    (root / "supervisor.py").chmod(0o700)
    print(json.dumps({"staged": True, "files": len(manifest["files"])}))
finally:
    shutil.rmtree(incoming, ignore_errors=True)
`

  function safe(value: string) {
    return `'${value.replaceAll("'", `'\"'\"'`)}'`
  }

  function env() {
    return {
      ...Object.fromEntries(
        ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "SSH_AUTH_SOCK"].flatMap((key) =>
          process.env[key] ? [[key, process.env[key]!]] : [],
        ),
      ),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  async function collect(proc: ReturnType<typeof spawn>, timeout: number) {
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    proc.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
    const done = new Promise<{ code: number | null; error?: string }>((resolve) => {
      proc.once("error", (error) => resolve({ code: null, error: error.message }))
      proc.once("exit", (code) => resolve({ code }))
    })
    const result = await Promise.race([
      done,
      Bun.sleep(timeout).then(() => ({ code: null, error: "Connection timed out" })),
    ])
    if (proc.exitCode === null) proc.kill("SIGKILL")
    return {
      ...result,
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err).toString("utf8").trim(),
    }
  }

  async function hash(file: string) {
    const value = new Bun.CryptoHasher("sha256")
    for await (const chunk of createReadStream(file)) value.update(chunk)
    return value.digest("hex")
  }

  async function identify(keygen: string, line: string) {
    const child = spawn(keygen, ["-lf", "-", "-E", "sha256"], {
      env: env(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin?.end(`${line}\n`)
    const result = await collect(child, 5_000)
    if (result.code !== 0) throw new Error(result.stderr || "SSH host key fingerprint could not be computed")
    const digest = result.stdout.toString("utf8").match(/SHA256:[A-Za-z0-9+/=]+/)?.[0]
    if (!digest) throw new Error("SSH host key fingerprint could not be parsed")
    return digest
  }

  export function destination(host: Host) {
    const value = host.user ? `${host.user}@${host.host}` : host.host
    if (value.startsWith("-")) throw new Error("SSH destinations cannot begin with a hyphen")
    return value
  }

  export function argv(host: Host, known: string, script: string) {
    const port = host.port ? ["-p", String(host.port)] : []
    return [
      "ssh",
      "-T",
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${known}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "CheckHostIP=no",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      ...port,
      "--",
      destination(host),
      script,
    ]
  }

  export async function scan(host: Host) {
    const keyscan = Bun.which("ssh-keyscan")
    const keygen = Bun.which("ssh-keygen")
    if (!keyscan || !keygen) throw new Error("OpenSSH key utilities are required for remote compute")
    const base = ["-T", "8", ...(host.port ? ["-p", String(host.port)] : []), host.host]
    const scanned = await collect(
      spawn(keyscan, ["-t", "ed25519,ecdsa,rsa", ...base], { env: env(), stdio: ["ignore", "pipe", "pipe"] }),
      12_000,
    )
    if (scanned.code !== 0 || !scanned.stdout.length) {
      throw new Error(scanned.error || scanned.stderr || "SSH host returned no public key")
    }
    const lines = scanned.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
    const line =
      lines.find((item) => item.includes(" ssh-ed25519 ")) ??
      lines.find((item) => item.includes(" ecdsa-sha2-nistp256 ")) ??
      lines.find((item) => item.includes(" ecdsa-sha2-nistp384 ")) ??
      lines.find((item) => item.includes(" ecdsa-sha2-nistp521 ")) ??
      lines.find((item) => item.includes(" ssh-rsa ")) ??
      lines[0]
    if (!line || !/^(?:\S+)\s+(?:ssh-(?:ed25519|rsa)|ecdsa-)\S*\s+\S+/.test(line)) {
      throw new Error("SSH host key response was invalid")
    }
    return { host_key: line, fingerprint: await identify(keygen, line) }
  }

  export async function known(host: Host, root: string) {
    if (!host.host_key || !host.fingerprint) throw new Error(`Test ${host.label} once to pin its SSH host key`)
    const keygen = Bun.which("ssh-keygen")
    if (!keygen) throw new Error("OpenSSH key utilities are required for remote compute")
    const fingerprint = await identify(keygen, host.host_key)
    if (fingerprint !== host.fingerprint) {
      throw new Error(`Pinned SSH host key does not match its saved fingerprint for ${host.label}`)
    }
    const folder = path.join(root, "ssh-hosts")
    const file = path.join(folder, `${crypto.createHash("sha256").update(host.id).digest("hex")}.known_hosts`)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(file, `${host.host_key.trim()}\n`, { mode: 0o600 })
    await fs.chmod(file, 0o600)
    return file
  }

  export function invoke(
    spec: Spec,
    action: "submit" | "status" | "cancel" | "log" | "harvest" | "release",
    ...args: string[]
  ) {
    const bootstrap = `import os,sys; root=os.path.abspath(os.path.expanduser(sys.argv[1])); os.execv(sys.executable,[sys.executable,os.path.join(root,'control.py'),*sys.argv[2:]])`
    return `python3 -c ${safe(bootstrap)} ${safe(spec.root)} ${safe(action)} ${safe(spec.owner)}${args.map((value) => ` ${safe(value)}`).join("")}`
  }

  export function receive(spec: Spec) {
    return `python3 -c ${safe(RECEIVER)} ${safe(spec.root)} ${safe(spec.owner)}`
  }

  export function inspect(spec: Spec) {
    const script =
      "import json,os,sys; root=os.path.abspath(os.path.expanduser(sys.argv[1])); print(json.dumps({'exists':os.path.isfile(os.path.join(root,'control.py'))},separators=(',',':')))"
    return `python3 -c ${safe(script)} ${safe(spec.root)}`
  }

  export async function archive(spec: Spec, directory: string) {
    const root = await fs.mkdtemp(path.join(directory, `${spec.id}.ssh-stage-`))
    const work = path.join(root, "work")
    await fs.mkdir(work, { recursive: true })
    await Promise.all(
      spec.uploads.map(async (file) => {
        const current = await fs.realpath(file.canonical).catch(() => undefined)
        if (!current || current !== file.canonical || (await hash(current)) !== file.sha256) {
          throw new Error(`SSH input changed after approval: ${file.path}`)
        }
        const target = path.resolve(work, file.path)
        if (work !== target && !target.startsWith(`${work}${path.sep}`))
          throw new Error(`SSH input escaped staging: ${file.path}`)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(current, target)
        const info = await fs.stat(target)
        if (info.size !== file.size || (await hash(target)) !== file.sha256) {
          throw new Error(`SSH input staging integrity check failed: ${file.path}`)
        }
      }),
    )
    const manifest = { files: spec.uploads.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })) }
    await Promise.all([
      fs.writeFile(path.join(root, "inputs.json"), JSON.stringify(manifest), { mode: 0o600 }),
      fs.writeFile(path.join(root, "spec.json"), JSON.stringify({ ...spec, uploads: undefined, owner: undefined }), {
        mode: 0o600,
      }),
      fs.writeFile(path.join(root, "control.py"), CONTROL, { mode: 0o700 }),
      fs.writeFile(path.join(root, "supervisor.py"), SUPERVISOR, { mode: 0o700 }),
    ])
    const tar = path.join(directory, `${spec.id}.${crypto.randomUUID()}.tar`)
    const proc = Bun.spawn(["tar", "-cf", tar, "-C", root, "."], { stdout: "ignore", stderr: "pipe" })
    const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    await fs.rm(root, { recursive: true, force: true })
    if (code !== 0) {
      await fs.rm(tar, { force: true })
      throw new Error(`Could not package SSH inputs: ${error.trim()}`)
    }
    return tar
  }

  export function parse<T>(buffer: Buffer): T {
    const text = buffer.toString("utf8").trim()
    if (!text) throw new Error("SSH control command returned no response")
    return JSON.parse(text.split("\n").at(-1)!) as T
  }

  export async function slurm(state: string, exit = "1:0"): Promise<Result> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-slurm-state-"))
    const script = path.join(root, "control.py")
    try {
      await fs.writeFile(script, CONTROL, { mode: 0o700 })
      const proc = spawn("python3", [script, "__slurm", state, exit], { stdio: ["ignore", "pipe", "pipe"] })
      const result = await collect(proc, 5_000)
      if (result.code !== 0) throw new Error(result.stderr || "Slurm state parser failed")
      return parse<Result>(result.stdout)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }

  async function member(archive: string, name: string, target?: string) {
    const output = target ? await fs.open(target, "w", 0o600) : undefined
    try {
      const proc = spawn("tar", ["-xOf", archive, "--", name], {
        stdio: ["ignore", output?.fd ?? "pipe", "pipe"],
      })
      const chunks: Buffer[] = []
      const errors: Buffer[] = []
      proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
      proc.stderr?.on("data", (chunk: Buffer) => errors.push(chunk))
      const code = await new Promise<number | null>((resolve) => {
        proc.once("error", () => resolve(null))
        proc.once("exit", resolve)
      })
      if (code !== 0)
        throw new Error(Buffer.concat(errors).toString("utf8").trim() || `SSH output archive is missing ${name}`)
      return Buffer.concat(chunks)
    } finally {
      await output?.close().catch(() => undefined)
    }
  }

  async function install(root: string, staging: string, files: Manifest["files"]) {
    const proc = spawn("python3", ["-c", BROKER, root, staging], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const errors: Buffer[] = []
    proc.stderr?.on("data", (chunk: Buffer) => errors.push(chunk))
    proc.stdin?.end(JSON.stringify({ files }))
    const code = await new Promise<number | null>((resolve) => {
      proc.once("error", () => resolve(null))
      proc.once("exit", resolve)
    })
    if (code === 0) return
    const detail = Buffer.concat(errors)
      .toString("utf8")
      .trim()
      .split("\n")
      .at(-1)
      ?.replace(/^RuntimeError: /, "")
    throw new Error(detail || "SSH output installation broker failed")
  }

  export async function deliver(archive: string, root: string) {
    const parsed: unknown = JSON.parse((await member(archive, "manifest.json")).toString("utf8"))
    const manifest = parsed as Partial<Manifest>
    if (!Array.isArray(manifest.files)) throw new Error("SSH output archive has no valid manifest")
    const files = manifest.files.map((item) => {
      if (
        !item ||
        typeof item.path !== "string" ||
        !item.path ||
        path.posix.isAbsolute(item.path) ||
        item.path.split("/").some((part) => !part || part === "." || part === "..") ||
        typeof item.size !== "number" ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      ) {
        throw new Error("SSH output archive manifest is invalid")
      }
      return item
    })
    if (files.length > 200 || new Set(files.map((item) => item.path)).size !== files.length) {
      throw new Error("SSH output archive manifest has too many or duplicate files")
    }
    if (files.reduce((sum, item) => sum + item.size, 0) > 20 * 1024 * 1024 * 1024) {
      throw new Error("SSH outputs exceed the 20 GiB recovery limit")
    }
    const staging = await fs.mkdtemp(path.join(path.dirname(archive), "ssh-delivery-"))
    try {
      for (const item of files) {
        const staged = path.resolve(staging, item.path)
        if (staging !== staged && !staged.startsWith(`${staging}${path.sep}`)) {
          throw new Error(`SSH output escaped local staging: ${item.path}`)
        }
        await fs.mkdir(path.dirname(staged), { recursive: true })
        await member(archive, `files/${item.path}`, staged)
        const info = await fs.stat(staged)
        if (info.size !== item.size || (await hash(staged)) !== item.sha256) {
          throw new Error(`SSH output failed integrity verification: ${item.path}`)
        }
      }
      await install(root, staging, files)
      return files.map((item) => ({ ...item, modified_at: new Date().toISOString() }))
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }
}
