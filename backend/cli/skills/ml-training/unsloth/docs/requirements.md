# Unsloth Requirements

## System Requirements

* **Operating System**: Works on Linux and [Windows](https://docs.unsloth.ai/get-started/install-and-update/windows-installation)
* Supports NVIDIA GPUs since 2018+ including [Blackwell RTX 50](https://unsloth.ai/docs/blog/fine-tuning-llms-with-blackwell-rtx-50-series-and-unsloth) and [DGX Spark](https://unsloth.ai/docs/blog/fine-tuning-llms-with-nvidia-dgx-spark-and-unsloth)
  * [fine-tuning-llms-with-blackwell-rtx-50-series-and-unsloth](https://unsloth.ai/docs/blog/fine-tuning-llms-with-blackwell-rtx-50-series-and-unsloth "mention")
  * [fine-tuning-llms-with-nvidia-dgx-spark-and-unsloth](https://unsloth.ai/docs/blog/fine-tuning-llms-with-nvidia-dgx-spark-and-unsloth "mention")
* Minimum CUDA Capability 7.0 (V100, T4, Titan V, RTX 20 & 50, A100, H100, L40 etc) [Check your GPU!](https://developer.nvidia.com/cuda-gpus) GTX 1070, 1080 works, but is slow.
* The official [Unsloth Docker image](https://hub.docker.com/r/unsloth/unsloth) `unsloth/unsloth` is available on Docker Hub
  * [docker](https://unsloth.ai/docs/get-started/install/docker "mention")
* Unsloth works on [AMD](https://unsloth.ai/docs/get-started/fine-tuning-for-beginners/broken-reference) and [Intel](https://github.com/unslothai/unsloth/pull/2621) GPUs! Apple/Silicon/MLX is in the works
* If you have different versions of torch, transformers etc., `pip install unsloth` will automatically install all the latest versions of those libraries so you don't need to worry about version compatibility.
* Your device should have `xformers`, `torch`, `BitsandBytes` and `triton` support.

{% hint style="info" %}
Python 3.13 is now supported!
{% endhint %}

## Fine-tuning VRAM requirements:

How much GPU memory do I need for LLM fine-tuning using Unsloth?

{% hint style="info" %}
A common issue when you OOM or run out of memory is because you set your batch size too high. Set it to 1, 2, or 3 to use less VRAM.

**For context length benchmarks, see** [**here**](https://unsloth.ai/docs/basics/unsloth-benchmarks#context-length-benchmarks)**.**
{% endhint %}

Check this table for VRAM requirements sorted by model parameters and fine-tuning method. QLoRA uses 4-bit, LoRA uses 16-bit. Keep in mind that sometimes more VRAM is required depending on the model so these numbers are the absolute minimum:

| Model parameters | QLoRA (4-bit) VRAM | LoRA (16-bit) VRAM |
| ---------------- | ------------------ | ------------------ |
| 3B               | 3.5 GB             | 8 GB               |
| 7B               | 5 GB               | 19 GB              |
| 8B               | 6 GB               | 22 GB              |
| 9B               | 6.5 GB             | 24 GB              |
| 11B              | 7.5 GB             | 29 GB              |
| 14B              | 8.5 GB             | 33 GB              |
| 27B              | 22GB               | 64GB               |
| 32B              | 26 GB              | 76 GB              |
| 40B              | 30GB               | 96GB               |
| 70B              | 41 GB              | 164 GB             |
| 81B              | 48GB               | 192GB              |
| 90B              | 53GB               | 212GB              |