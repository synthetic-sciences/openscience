---
name: compute
description: Chooses and runs compute for research work, local shell or kernel versus a detached compute_job on this machine, a saved SSH or Slurm host, or Modal GPUs, with the target discovered from what is actually configured, the run sized and priced before dispatch, outputs declared, metrics tracked, and long work handed to the job system instead of a blocking shell. Use when a task needs a GPU, will run longer than a few minutes, must survive the session, or asks which cloud or provider to use. Provider-specific setup lives in the cloud-compute library skills; load one only after compute_job targets shows that provider.
summary: "Pick and price the compute target; long or GPU work through compute_job, tracked."
category: core
role: support
allowed-tools: [Read, Bash, compute_job, provider_compute, experiments]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Compute

The question is never "which cloud is best"; it is "which of the targets this user has
configured fits this run, and what will it cost". Discover before you plan, size before
you dispatch, and hand anything longer than a coffee to the job system so the session,
the logs and the metrics outlive the shell.

## Rules

1. **Targets first.** `compute_job {"action":"targets"}` lists what exists: local runtime,
   saved SSH and scheduler hosts, Modal when connected. Plan only against a listed target.
   A provider skill from the library (`modal-serverless-gpu`, `runpod-gpu-cloud`,
   `lambda-gpu-cloud`, `vast-ai-gpu-cloud`, `skypilot-multi-cloud-orchestration`,
   `together-ai-inference`, `fireworks-ai-inference`, `tinker-fine-tuning`; the core index
   lists them) is loaded only when that provider is configured or the user asks to set it
   up; never plan work for compute the user does not have.
2. **Local shell for seconds, kernel for interactive state, job for everything else.** A
   command that may exceed a few minutes, needs a GPU, or must survive a disconnect goes
   through `compute_job start`, then `compute_job wait`; never a shell `sleep` loop.
3. **Size and price before dispatch.** Estimate wall-clock from a short local or scaled-down
   run, choose the smallest instance that fits memory and time, and state the estimate
   (provider, GPU, duration, price) in the approval. Remote jobs are approved against an
   immutable plan digest; `compute_job plan` previews it.
4. **Declare outputs.** Artifacts and checkpoints are relative paths under the job
   workspace, listed in the request, so they are delivered and survive. Nothing important
   is written to `/tmp` or printed only to the terminal.
5. **Track metrics.** Training and evaluation scripts import `openscience_track` (or
   `wandb`, shimmed inside a study) so curves and final numbers land in the Autoresearch
   pane and the experiments tool instead of a log to grep.
6. **Checkpoint long runs** and make them resumable from the declared checkpoint path; the
   job system can be interrupted by the user, a budget, or a kill rule.

## Choosing the target

| Run | Target |
| --- | --- |
| Seconds to two minutes, CPU, output read immediately | shell or the Python kernel |
| Minutes to hours, CPU or the local GPU | `compute_job` local |
| Needs a GPU the machine lacks, or many GPUs | Modal (`gpu` set to the exact type), or a saved SSH/Slurm host |
| Must run inside the user's cluster environment or data boundary | the saved SSH or scheduler host |
| A sweep of many short runs | one job per run through autoresearch, or one job with an internal loop when runs are seconds long |

For a Slurm or PBS host, resources (`cpus`, `gpus`, `memory_gb`, `time_minutes`,
`partition`) become the scheduler request; `modules` and `container` load the environment.
For Modal, `packages` or `image` define the environment and outbound network is off
unless enabled in Compute settings; do not submit jobs that download models or data
without checking that setting.

## Workflow

- [ ] `targets`: what exists.
- [ ] Probe: a scaled-down local run to measure time and memory per unit of work.
- [ ] Size: instance, duration, price; write the estimate.
- [ ] `plan` (remote) then `start` with name, purpose, command, cwd, artifacts, checkpoint.
- [ ] `wait`; read `logs` on failure; `artifacts` on success.

**Probe.** Ten training steps or one batch locally, timed, tells you the throughput; scale
to the full run and add 20%. Memory: a single forward and backward pass at the target
batch size. If the probe cannot run locally, read the model card or the paper for
reported throughput on the target GPU and say the estimate is second-hand.

**Pricing.** Duration × the provider's hourly rate for the instance, plus storage or egress
when relevant. Give one number and its basis; for anything over a few dollars, or any run
over an hour, state it before dispatch even under an autonomous setting.

**Failure.** `compute_job logs` first, with enough bytes to reach the traceback. Fix the
cause, not the symptom; a retry of an identical command is only justified after a
transient failure (preemption, network). Interrupted jobs resume from the checkpoint.

## Provider accounts

Credentials live in Customize → Compute. `provider_compute` reads account, inventory and
job status for TensorPool, Lambda, Prime Intellect, Vast.ai and RunPod through the host
broker, read-only. Never ask the user to paste a key into chat, never put a key in a shell
command, and never claim a run happened that the job record does not show.

## Before you hand it over

- The job's name says what it computed; its artifacts are declared and delivered.
- The estimate you gave is compared with what it actually took.
- Metrics are tracked, or the reason they could not be is stated.
