# Linux compatibility: runtime versus complete product

OpenScience packages a Bun runtime plus native process/sandbox helpers. Running
the CLI binary is necessary, but not sufficient, to establish that a Linux
distribution supports the complete product. Desktop packaging has additional
Electron and system-library requirements.

The currently pinned [Bun 1.3.14 installation guide](https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/installation.mdx)
documents glibc 2.17 or newer and kernel 3.10 as a runtime floor (5.6 or newer is
recommended). This is upstream runtime guidance, not a completed OpenScience
CentOS 7 certification. Issue #188 remains an explicit legacy-platform request;
we do not claim support for glibc below 2.17.

The release matrix provides glibc and musl CLI archives, plus x64 baseline
variants for CPUs without AVX2. `baseline` changes CPU compatibility; it does not
lower glibc requirements. A musl build is not a promise that native helpers or the
desktop shell will run on an arbitrary older distribution. Do not replace the
host's system libc to make an installer run.

For a compatibility report, include:

```sh
openscience --version
uname -m
uname -r
ldd --version
```

Also include the exact asset/package name, distribution version, and the full
startup error, with private paths or account details redacted. Distinguish a CLI
startup failure from a desktop-shell failure and from sandbox admission. Never
disable process ownership, credential isolation, or sandbox checks merely to
make an unsupported platform pass.

Before expanding support, verify the exact packaged candidate on that platform:
startup and server health, native helper loading, Bash descendant cleanup,
filesystem permissions, and sandbox admission. A container shares its host
kernel, so testing old userspace on a modern runner does not prove old-kernel
behavior. Prefer a maintained host with current security updates; retain the
legacy issue until that evidence exists.
