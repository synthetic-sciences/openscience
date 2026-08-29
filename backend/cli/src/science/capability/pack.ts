import { CapabilityRuntime } from "./schema"
import {
  CORE_SCIENCE_CONDA_LOCKS,
  capabilityLockDigest,
  condaLockPlatform,
  condaLockSha256,
  type CondaLockHost,
  type CoreScienceCondaPlatform,
} from "./conda-locks"

export const CORE_SCIENCE_PACKAGES = [
  "biopython==1.88",
  "contourpy==1.3.3",
  "cycler==0.12.1",
  "fonttools==4.63.0",
  "joblib==1.5.3",
  "kiwisolver==1.5.1",
  "matplotlib==3.11.1",
  "narwhals==2.25.0",
  "numpy==2.5.2",
  "packaging==26.3",
  "pillow==12.3.0",
  "pyparsing==3.3.2",
  "python-dateutil==2.9.0.post0",
  "rdkit==2026.3.5",
  "scikit-learn==1.9.0",
  "scipy==1.18.1",
  "six==1.17.0",
  "threadpoolctl==3.6.0",
] as const

/**
 * Fully hashed binary-wheel lock used by both the local task environment and
 * Modal image construction. The allowlist intentionally covers only the
 * release-tested cp312 platforms: macOS arm64 and glibc Linux arm64/x64.
 * Unsupported hosts fail closed instead of compiling mutable sdists.
 */
export const CORE_SCIENCE_REQUIREMENTS =
  `biopython==1.88 --hash=sha256:43ce1fbed01c0ddb903fa426fa0f836062d973a09df15560ac8e895da24c1350 --hash=sha256:9384c30460832926e765319040d732d1252a713a05af1dd4cc8b19cb1d590439 --hash=sha256:fe2dccf88e309dc896e7c2cc974a47be7a7b96d59c7f2ffd74ffcc7cfbdebb0c
contourpy==1.3.3 --hash=sha256:4d00e655fcef08aba35ec9610536bfe90267d7ab5ba944f7032549c55a146da1 --hash=sha256:556dba8fb6f5d8742f2923fe9457dbdd51e1049c4a43fd3986a0b14a1d815fc6 --hash=sha256:92d9abc807cf7d0e047b95ca5d957cf4792fcd04e920ca70d48add15c1a90ea7
cycler==0.12.1 --hash=sha256:85cef7cff222d8644161529808465972e51340599459b8ac3ccbac5a854e0d30
fonttools==4.63.0 --hash=sha256:37dd23e621e3b0aef1baa70a303b80aaf38449632cfc8fd2a55fb285bbccfc02 --hash=sha256:58dc6bb86a78d782f00f9190ca02c119cf5bbe2807536e361e18d42019f877d8 --hash=sha256:ef3048ef05dbb552b89817713d9cac912e00d0fde4a3105c00d29e52e10c89af
joblib==1.5.3 --hash=sha256:5fc3c5039fc5ca8c0276333a188bbd59d6b7ab37fe6632daa76bc7f9ec18e713
kiwisolver==1.5.1 --hash=sha256:1798e83840c3f627246104c4d8a9639c60fa068adf9ce92b61791781fa8a68c1 --hash=sha256:34633ecf50d16187ab8e5528b7a2530f2feb4e23f300db4672538b51cfc5cd38 --hash=sha256:d27c2123977cb9269c30a49ba45f03a4323017ef693e19db4ec9dbe1299a3002
matplotlib==3.11.1 --hash=sha256:21a67b961a6d597bca54fae826cd20695ba4a6e4d05424a08da6e13e3176fd6b --hash=sha256:ba8f811b8ddfac493734d6af0b2dff96919d0c28ca0d641858dab4262777c6ea --hash=sha256:c52f7ad20ef476806ed212380b1d54d20310c8b86bdc2c9a68b51f0024a44472
narwhals==2.25.0 --hash=sha256:1f0f403e8c7e4463cde9bfe78b12fdd809e3ae3dda6d9b2f802934fb9c7a6a8f
numpy==2.5.2 --hash=sha256:3cdec01fa790a186d430433fdd4d4ffb70eed6f0eeb4bf05c8dbe2dce0a9bcb8 --hash=sha256:4bbd96c833ecc8cc069ce518078fc8c60cb9cbfb0fea5b7a803ad65035596d03 --hash=sha256:8ee9c4eeb8454b3660a8b53493563c3e121c2fc94fbd72b848ef814ed7b676a9
packaging==26.3 --hash=sha256:d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c
pillow==12.3.0 --hash=sha256:78cb2c6865a35ab8ff8b75fd122f6033b92a62c82801110e48ddd6c936a45d91 --hash=sha256:d9c7f76c0673154f044e9d78c8655fb4213f6ca31a836df48b40fe5d187717b9 --hash=sha256:ffd0c5368496f41b0944be820fcb7a838aa6e623d250b01acf2643939c3f99d7
pyparsing==3.3.2 --hash=sha256:850ba148bd908d7e2411587e247a1e4f0327839c40e2e5e6d05a007ecc69911d
python-dateutil==2.9.0.post0 --hash=sha256:a8b2bc7bffae282281c8140a97d3aa9c14da0b136dfe83f850eea9a5f7470427
rdkit==2026.3.5 --hash=sha256:74e621083f26360ae3128b2c283def72e1729c114577c58115294b1cefe0200b --hash=sha256:b75944ba959d908e97b4d68754e5950216ac08aa81faf67cfd1d7a3cb5b2bad7 --hash=sha256:d6c6b167b4c795468cdd273d35a323226dddbeb204aa34350257ad26d5dfd024
scikit-learn==1.9.0 --hash=sha256:056c92bb67ad4c28463c2f2653d9701449201e7e7a9e94e321be0f71c4fef2b8 --hash=sha256:5be45aa4a42a68a533913a6ed736cf309de2226411c79ef8d609a5456f1939b1 --hash=sha256:5e50ed4da51974e86e940690e9a3d82e729b62b5a49f7c9bac534d515d39d86f
scipy==1.18.1 --hash=sha256:3c085faa2cfa879c5141df483f836f4d691045a078224a670fa570fa01612d89 --hash=sha256:e708533e8b2ae2497d65346538a7dcc92814410b25b81432eac66de0f2af8265 --hash=sha256:f55fa87b6c612ecd6b058f167c53231b1d14e412efe361d3d6e38b3631c73218
six==1.17.0 --hash=sha256:4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274
threadpoolctl==3.6.0 --hash=sha256:43a0b8fd5a2928500110039e43a5eed8480b918967083ea48dc3ab9f13c4a7fb
`.trim()

export const CORE_SCIENCE_LOCAL_LOCKS = {
  "darwin-arm64": condaLockSha256(CORE_SCIENCE_CONDA_LOCKS["osx-arm64"]),
  "linux-arm64": condaLockSha256(CORE_SCIENCE_CONDA_LOCKS["linux-aarch64"]),
  "linux-x64": condaLockSha256(CORE_SCIENCE_CONDA_LOCKS["linux-64"]),
} as const

const lockInput = {
  channels: ["conda-forge"],
  packages: ["python=3.12.11", "pip=25.1.1"],
  conda_locks: CORE_SCIENCE_CONDA_LOCKS,
  pip_packages: CORE_SCIENCE_PACKAGES,
  pip_requirements: CORE_SCIENCE_REQUIREMENTS,
}

export const CORE_SCIENCE_LOCK_DIGEST = capabilityLockDigest(lockInput)

export const CORE_SCIENCE_RUNTIME = CapabilityRuntime.parse({
  kind: "python_pack",
  pack_id: "core-science-py312-v1",
  python: "3.12.11",
  targets: ["local", "modal"],
  local_platforms: ["darwin-arm64", "linux-arm64", "linux-x64"],
  local_locks: CORE_SCIENCE_LOCAL_LOCKS,
  image: "python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7",
  lock_digest: CORE_SCIENCE_LOCK_DIGEST,
  packages: CORE_SCIENCE_PACKAGES,
  pip_requirements: CORE_SCIENCE_REQUIREMENTS,
  resources: { cpus: 1, memory_gb: 2, time_minutes: 10, gpu: "none" },
  network: { build: "package_index_only", execution: "none" },
})

export const CORE_SCIENCE_ENVIRONMENT = CORE_SCIENCE_RUNTIME.pack_id

export function capabilityPlatform(host?: CondaLockHost) {
  const current = condaLockPlatform(host)
  if (current === "osx-arm64") return "darwin-arm64" as const
  if (current === "linux-aarch64") return "linux-arm64" as const
  if (current === "linux-64") return "linux-x64" as const
  return undefined
}

export function capabilityCondaPlatform(host?: CondaLockHost): CoreScienceCondaPlatform | undefined {
  return condaLockPlatform(host)
}

export function coreScienceCondaLocks() {
  return { ...CORE_SCIENCE_CONDA_LOCKS }
}
