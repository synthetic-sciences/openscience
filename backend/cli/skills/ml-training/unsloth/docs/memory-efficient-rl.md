# Memory Efficient RL

We're excited to introduce more efficient reinforcement learning (RL) in Unsloth with multiple algorithmic advancements:

* **1.2 to 1.7x increased context lengths** with no slowdown and no extra memory usage!
* **10% faster RL training runs** with revamped kernels and async data movements
* **2x faster `torch.compile` times** during model loading

Unsloth **already** increases RL training speed, context window and reduces VRAM usage by 50–90% vs. all other setups with FA2, but now [**Unsloth's Standby**](#unsloth-standby) improves this even further. Our Standby feature uniquely limits speed degradation compared to other implementations and sometimes makes training even faster!

Now, Qwen3-32B LoRA 16-bit can attain 6,144 context lengths vs 3,600 (**1.7x longer**) before on 1xH100 80GB GPU. Llama-3.1-8B QLoRA 4bit can attain 47,500 lengths vs 42,000 before (1.13x longer).

We made RL runs 10% faster through various kernel optimizations, and removed the LoRA communication chann between the CPU and GPU when switching from training to inference mode. Finally, we used custom `torch.compile` flags to make vLLM's rollout faster by 10%, and reduced compilation time by 2x.

## :sparkles:How to enable optimizations

To enable **Unsloth's Standby** feature, set the environment variable `UNSLOTH_VLLM_STANDBY` before any Unsloth import. Then set `gpu_memory_utilization = 0.95` and that's it!

```python
import os
os.environ["UNSLOTH_VLLM_STANDBY"] = "1"

from unsloth import FastLanguageModel
import torch
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "unsloth/Qwen3-8B-Base",
    max_seq_length = 2048, # Can increase for longer reasoning traces
    load_in_4bit = False, # False for LoRA 16bit
    fast_inference = True,
    max_lora_rank = 32, # Larger rank = smarter, but slower
    gpu_memory_utilization = 0.95,
)
```

## :mortar\_board:No more `gpu_memory_utilization`!

With Unsloth's new RL improvements, you NEVER have to worry about tuning or setting `gpu_memory_utilization` ever again - simply set it to 90% or 95% of GPU utilization - 100% sadly won't work since some space is needed for small tensors. Previously one had to tune it from 30% to 95% - no more now! Set it to the maximum and Unsloth will handle the rest!

## :interrobang:Why does RL use so much memory?

GRPO (and many RL variants) rely heavily on generation which is primarily powered by vLLM. But this comes comes with a steep cost since it requires constant **GPU memory for weights, activations, and the KV Cache**.

{% columns %}
{% column %}
Inference takes a lot of VRAM

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-7e25501083081b201d59f6000219cafa535d2b2d%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>
{% endcolumn %}

{% column %}
Whilst Training also uses VRAM!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-189fd45a9e7a6fa1e98d1c9646b57bd0ec48481d%2Ffig6-2.avif?alt=media" alt=""><figcaption></figcaption></figure>
{% endcolumn %}
{% endcolumns %}

This means RL needs to keep 2 sets of VRAM / memory on the GPU at the same time:

1. Inference engine (has model weights, KV cache)
2. Training engine (has model weights, activations, gradients, optimizer states)

Current RL frameworks have to split 50/50 for a 80GB GPU with 50% for inference and 50% for training. And moving weights from training mode to inference mode can take quite some time.

<table><thead><tr><th width="251.51666259765625">80GB GPU</th><th>Inference Engine (50%)</th><th>Training Engine (50%)</th></tr></thead><tbody><tr><td>Model Weights</td><td>16GB</td><td>16GB</td></tr><tr><td>KV Cache</td><td>24GB</td><td></td></tr><tr><td>Activations, Gradients, Optimizer States</td><td></td><td>24GB</td></tr></tbody></table>

Previous Unsloth versions already smartly optimizes the above, as we **share vLLM's weight space directly which removes the double memory usage of the model weights**. This frees up 16GB of space for example which can be used to increase context length or the speed of generation. Also, we don't need to do memory movements, which makes training faster.

| 80GB GPU                                 | Inference Engine (50%) | Training Engine (50%) |
| ---------------------------------------- | ---------------------- | --------------------- |
| Model Weights                            | **16GB SHARED**        | **<<< SHARED**        |
| KV Cache                                 | 24GB + 8GB= **32GB**   |                       |
| Activations, Gradients, Optimizer States |                        | 24GB + 8GB=**32GB**   |

## 🦥Unsloth Standby

But we can go further - we first note RL does inference then training then inference then training etc.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-6e9b6a2f7381de84ed6eeb0feedc566c43acf3%2F5b957843-eb58-4778-8b90-f25767c51495.png?alt=media" alt=""><figcaption></figcaption></figure>

This means the memory space for inference and training can in theory be re-used, since inference and training are separate modes - this is where [vLLM's sleep mode feature](https://docs.vllm.ai/en/latest/features/sleep_mode.html#rlhf-weight-updates) comes in, which has 2 options:

1. `level = 1` copies weights to the CPU and deletes KV cache
2. `level = 2` deletes weights and deletes KV cache

But reminder in Unsloth we share vLLM's memory space for the weights - this means we need a new way to delete the KV cache, and ignore deletion of the weights, and we call this Unsloth Standby.

| 80GB GPU                                                                                                                                                            | Inference Engine | Training Engine                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------- |
| Model Weights                                                                                                                                                       | **16GB SHARED**  | **<<< SHARED**                           |
| <p><mark style="background-color:purple;"><strong>Multi-purpose</strong></mark></p><p><mark style="background-color:purple;"><strong>64GB space</strong></mark></p> | KV Cache         | Activations, Gradients, Optimizer States |

To enable this, simply add the below to all RL / GRPO training runs before any Unsloth import:

```python
import os
os.environ["UNSLOTH_VLLM_STANDBY"] = "1"
```

## 🧪Performance Experiments

Here you will find out how we benchmarked memory usage and context length for GRPO. Note that we do **2 generations per prompt because for GRPO to work**, we need at least 2 generations for which to calculate the sample mean and varice. **Without 2 generations, the standard deviation of one sample is 0**. This causes the advantages which uses this: (reward - mean)/std **to be undefined**.

$
Z=\frac{r\_i - \mu}{\sqrt{\frac{1}{n}\sum(r\_i-\mu)^2}} \\
Z\_{n=1}=\frac{r\_1 - \mu}{\sqrt{\frac{1}{1}\sum(r\_1-\mu)^2}}=\frac{0}{0}=\text{undefined}
$

This means for GRPO specifically, a maximum context length of 6,144 for Qwen-3 32B is actually 6,144 multiplied by 2 generations ie 12,288 in length.

We provide experiments for Llama-3.1 8B on both LoRA (16bit) and QLoRA (4bit) below:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-2f83185e373186aa67bc2ce7d1814b2edb0f3ce6%2Foutput%20(10).png?alt=media" alt="" width="563"><figcaption></figcaption></figure>

**If you notice any training time differences, it isn’t much**. In our apples to apples comparison we noticed <1% training time slowdowns or even speedups which can be attributed to margin ofrror.

We also theorize speedups are possible due to reduced memory pressure, so there might be less memory cleanup on the CUDA memory allocator side.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-db26f62f9080dba942add171880537c3f516f065%2Fgpu%20mem%20cofigure.png?alt=media" alt=""><figcaption></figcaption></figure>

In the above image, you see the difference between baseline and standby mode on a single T4 GPU for Qwen 3 4B. <mark style="background-color:green;">**We can stretch the vllm's**</mark><mark style="background-color:green;">**&#x20;**</mark><mark style="background-color:green;">**`gpu_memory_utilisation`**</mark><mark style="background-color:green;">**&#x20;**</mark><mark style="background-color:green;">**to as high as 0.95 without worrying that it'd affect training**</mark>. This means you can fit higher context length sequences and more sequences can be processed. In the first case, for example, we have enough memory to fit and process 32K length sequences provided training allows where as previously, any inputs longer than 2K would potentially not fit in and end up causing OOMs (out of memory).

<table data-full-width="true"><thead><tr><th>Experiments</th><th>Config</th><th>Status</th><th>GPU Memory usage</th><th>Comments</th></tr></thead><tbody><tr><td><ol><li><a href="https://colab.research.google.com/drive/18CssBY5C0mStnLvu2Hlt4aFLoPugRG0K?usp=sharing">u0.95gen2ga1s Qwen3_(4B)-GRPO.ipynb</a></li></ol></td><td><p><code>standby True</code></p><p><code>vllm_gpu_util 0.95</code></p><p><code>num_gen 2</code></p><p><code>grad_acc_steps 2</code></p></td><td>Runs for 40 steps/ 40 minutes</td><td><p>14.5 GiB (set by vllm_gpu_util)</p><p><br></p></td><td>Enough to fit in 32K KVCache with chunk of 2-4K or say 16K KVCache + 16K chunks</td></tr><tr><td><ol start="2"><li><a href="https://colab.research.google.com/drive/1q0TOUychygfreI2wKpg51sqnRhs5cYnX?usp=sharing">u9ge2ga2s Qwen3_(4B)-GRPO.ipynb</a></li></ol></td><td><p><code>standby True</code></p><p><code>vllm_gpu_util 0.9</code></p><p><code>num_gen 2</code></p><p><code>grad_acc_steps 2</code></p></td><td>Runs 32 steps in 40 m</td><td>13.8 GiB (set by…)</td><td>Approx enough to fit in ~28K KVCache with chunk of 2-4K or say 15K KVCache + 15K chunks</td></tr><tr><td><ol start="3"><li><a href="https://colab.research.google.com/drive/12Uw8y5beLzPtx11mCWCYyh9Z_PEHHdId?usp=sharing">u9ge2ga2ns Qwen3_(4B)-GRPO.ipynb</a></li></ol></td><td><p><code>standby False</code></p><p><code>vllm_gpu_util 0.9</code></p><p><code>num_gen 2</code></p><p><code>grad_acc_steps 2</code></p></td><td>model loads but can’t train because even batch size of 1 doesn’t fit</td><td>OOM</td><td><br></td></tr><tr><td><ol start="4"><li><a href="https://colab.research.google.com/drive/1GwTlaP5CLsW-BcE1LqZWkz6S8VTWYdJ2?usp=sharing">u8ge2ga2ns Qwen3_(4B)-GRPO.ipynb</a></li></ol></td><td><p><code>standby False</code></p><p><code>vllm_gpu_util 0.8</code></p><p><code>num_gen 2</code></p><p><cad_acc_steps 2</code></p></td><td>model loads but can’t train because even batch size of 1 doesn’t fit</td><td>OOM</td><td><br></td></tr><tr><td><ol start="5"><li><a href="https://colab.research.google.com/drive/1IuSUNzEBTiURK-vbTQuRDuUl0Ya2pz2t?usp=sharing">u7ge2ga2ns Qwen3_(4B)-GRPO.ipynb</a></li></ol></td><td><p><code>standby False</code></p><p><code>vllm_gpu_util 0.7</code></p><p><code>num_gen 2</code></p><p><code>grad_acc_steps 2</code></p></td><td><p>Trains fine</p><p>28 steps take 39min</p></td><td>~15.1GiB</td><td>any input slightly longer will result in OOM on colab</td></tr><tr><td><ol start="6"><li><a href="https://colab.research.google.com/drive/1RY7HwpZ0luJT70OyLJ6zXKZQ2COdT9QJ?usp=sharing">u7gen2ga2s Qwen3_(4B)-GRPO.ipynb</a></li></ol></td><td><p><code>standby True</code></p><p><code>vllm_gpu_util 0.7</code></p><p><code>num_gen 2</code></p><p><code>grad_acc_steps 2</code></p></td><td><p>Trains fine</p><p>29 steps take 40min</p></td><td>13GiB but most of the time around 10-11GB</td><td>At tame config, we save 2GiB aka 15% memory here.<br>Can be higher for longer sequences</td></tr></tbody></table>

### H100 Experiments

| Model                | GPU                   | Seq Len | Num Generations | Grad Acc Steps |
| -------------------- | --------------------- | ------- | --------------- | -------------- |
| Qwen2.5-14B-Instruct | NVIDIA H100 80GB PCIe | 32,768  | 8               | 4              |

In our collapsible results below, you can see there is a 9GiB difference in the peak memory used (note that 90% of the time, the GPU memory usage is equal to the peak memory in our case). **To put things into perspective, using TRL and LoRA we were able to only fine-tune an 8B parameter model with a context length of 1024 at max (32x less).** Anything with higher sequence length (with similar configuration) results in the process failing with OOM.

<details>

<summary>Click for Unsloth Standby Mode vs. no Standby Benchmarks</summary>

```
Standy mode enabled:

|===========================================================================|
|                  PyTorch CUDA memory summary, device ID 0                 |
|---------------------------------------------------------------------------|
|            CUDA OOMs: 0            |        cudaMalloc retries: 0         |
|===========================================================================|
|        Metric         | Cur Usage  | Peak Usage | Tot Alloc  | Tot Freed  |
|---------------------------------------------------------------------------|
| Allocated memory      |  32249 MiB |  43042 MiB | 128336 GiB | 128305 GiB |
|       from large pool |  31415 MiB |  42165 MiB | 127204 GiB | 127173 GiB |
|       from small pool |    834 MiB |   1184 MiB |   1132 GiB |   1131 GiB |
|---------------------------------------------------------------------------|
| Active memory         |  32249 MiB |  43042 MiB | 128336 GiB | 128305 GiB |
|       from large pool |  31415 MiB |  42165 MiB | 127204 GiB | 127173 GiB |
|       from small pool |    834 MiB |   1184 MiB |   1132 GiB |   1131 GiB |
|---------------------------------------------------------------------------|
| Requested memory      |  32199 MiB |  42987 MiB | 128176 GiB | 128145 GiB |
|       from large pool |  31364 MiB |  42110 MiB | 127047 GiB | 127016 GiB |
|       from small pool |    834 MiB |   1184 MiB |   1129 GiB |   1128 GiB |
|---------------------------------------------------------------------------|
| GPU reserved memory   |  37644 MiB |  47504 MiB | 705806 MiB | 668162 MiB |
|       from large pool |  36376 MiB |  46588 MiB | 682818 MiB | 646442 MiB |
|       from small pool |   1268 MiB |   1284 MiB |  22988 MiB |  21720 MiB |
|---------------------------------------------------------------------------|
| Non-releasable memory | 713142 KiB |   4633 MiB | 103206 GiB | 103205 GiB |
|       from large pool | 525312 KiB |   4594 MiB | 101923 GiB | 101922 GiB |
|       from small pool | 187830 KiB |    250 MiB |   1283 GiB |   1283 GiB |
|---------------------------------------------------------------------------|
| Allocations           |    3460    |    4809    |   15606 K  |   15603 K  |
|       from large pool |     395    |     563    |    2812 K  |    2811 K  |
|       from small pool |    3065    |    4270    |   12794 K  |   12791 K  |
|---------------------------------------------------------------------------|
| Active allocs         |    3460    |    4809    |   15606 K  |   15603 K  |
|       from large pool |     395    |     563    |    2812 K  |    2811 K  |
|       from small pool |    3065    |    4270    |   12794 K  |   12791 K  |
|---------------------------------------------------------------------------|
| GPU reserved segments |     913    |     920    |   13260    |   12347    |
|       from large pool |     279    |     305    |    1766    |    1487    |
|       from small pool |     634    |     642    |   11494    |   10860    |
|---------------------------------------------------------------------------|
| Non-releasable allocs |     422    |     628    |    4766 K  |    4765 K  |
|       from large pool |      66    |      92    |    1290 K  |    1289 K  |
|       from small pool |     356    |     555    |    3476 K  |    3475 K  |
|---------------------------------------------------------------------------|
| Oversize allocations  |       0    |       0    |       0    |       0    |
|---------------------------------------------------------------------------|
| Oversize GPU segments |       0    |       0    |       0    |       0    |
|===========================================================================|


Without Standby:

|===========================================================================|
|                  PyTorch CUDA memory summary, device ID 0                 |
|---------------------------------------------------------------------------|
|            CUDA OOMs: 0            |        cudaMalloc retries: 0         |
|===========================================================================|
|        Metric         | Cur Usage  | Peak Usage | Tot Alloc  | Tot Freed  |
|---------------------------------------------------------------------------|
| Allocated memory      |  32711 MiB |  52084 MiB | 142756 GiB | 142724 GiB |
|       from large pool |  31877 MiB |  51207 MiB | 141499 GiB | 141467 GiB |
|       from small pool |    834 MiB |   1184 MiB |   1257 GiB |   1256 GiB |
|---------------------------------------------------------------------------|
| Active memory         |  32711 MiB |  52084 MiB | 142756 GiB | 142724 GiB |
|       from large pool |  31877 MiB |  51207 MiB | 141499 GiB | 141467 GiB |
|       from small pool |    834 MiB |   1184 MiB |   1257 GiB |   1256 GiB |
|---------------------------------------------------------------------------|
| Requested memory      |  32572 MiB |  51658 MiB | 141898 GiB | 141866 GiB |
|       from large pool |  31738 MiB |  50780 MiB | 140644 GiB | 140613 GiB |
|       from small pool |    833 MiB |   1184 MiB |   1253 GiB |   1252 GiB |
|---------------------------------------------------------------------------|
| GPU reserved memory   |  49552 MiB |  52188 MiB |  86354 MiB |  36802 MiB |
|       from large pool |  48320 MiB |  51300 MiB |  84740 MiB |  36420 MiB |
|       from small pool |   1232 MiB |   1232 MiB |   1614 MiB |    382 MiB |
|---------------------------------------------------------------------------|
| Non-releasable memory |      0 B   |      0 B   |      0 B   |      0 B   |
|       from large pool |      0 B   |      0 B   |      0 B   |      0 B   |
|       from small pool |      0 B   |      0 B   |      0 B   |      0 B   |
|---------------------------------------------------------------------------|
| Allocations           |    3460    |    4809    |   17440 K  |   17437 K  |
|       from large pool |     395    |     564    |    2742 K  |    2741 K  |
|       from small pool |    3065    |    4270    |   14698 K  |   14695 K  |
|---------------------------------------------------------------------------|
| Active allocs         |    3460    |    4809    |   17440 K  |   17437 K  |
|       from large pool |     395    |     564    |    2742 K  |    2741 K  |
|       from small pool |    3065    |    4270    |   14698 K  |   14695 K  |
|---------------------------------------------------------------------------|
| GPU reserved segments |       0    |       0    |       0    |       0    |
|       from large pool |       0    |       0    |       0    |       0    |
|       from small pool |       0    |       0    |       0    |       0    |
|---------------------------------------------------------------------------|
| Non-releasable allocs |       0    |       0    |       0    |       0    |
|       from large pool |       0    |       0    |       0    |       0    |
|       from small pool |       0    |       0    |       0    |       0    |
|---------------------------------------------------------------------------|
| Oversize allocations  |       0    |       0    |       0    |       0    |
|---------------------------------------------------------------------------|
| Oversize GPU segments |       0    |       0    |       0    |       0    |
|===========================================================================|
```

</details>

The image below shows how standby compares against non standby training with Unsloth. It is averaged over 3 runs to make sure the metrics aren’t noisy. In fact, if you zoom in close enough, you’d see that enabling standby makes it faster as well, probably due to less memory pressure as discussed before.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-2f285043ea8afa38d1082513e424662d8cd04b90%2Ftrainglobalstep.png?alt=media" alt=""><figcaption></figcaption></figure>

### Previous A100 40GB experiments

In our previous experiments on A100 40GB GPU with Qwen-2.5-3b-instruct and 8 generations per sample, we observed that without standby, the GRPO training (model loaded in 16bit, LoRA, only weights trainable), we could only fit 6K sequencngths. With our standby feature, we were able to fit 10K and beyond! **For comparison TRL can only give you context lengths of up to 1K while holding the same batch size.**

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-c7cd807b5d513b04f5f3a6219bfcea0fb12e442a%2Fqwen3%20gpu%20mem.png?alt=media" alt="" width="563"><figcaption></figcaption></figure>

## :tada:Other optimizations

We now select better compilation flags and reduce compile times by 50% or more. We also managed to dynamically patch any vLLM version to handle `gc.collect` better for backwards compatibility reasons, as inspired from this [vLLM pull request](https://github.com/vllm-project/vllm/pull/21146). This reduces compilation times from 2 minutes to under 40 seconds.

We also optimized `torch.compile` flags and tried turning on some flags - unfortunately `combo_kernels` and `multi_kernel` could not function correctly on vLLM 0.10 and Torch 2.8/2.9 nightly and `coordinate_descent_tuning` made autotuning all kernels dramatically slower. It used to compile in under a minute, but enabling it took over 13 minutes and more, with minimal performance gains.

## :books:GRPO Notebooks

All our GRPO notebooks have Unsloth Standby on by default and all optimizations! See <https://docs.unsloth.ai/get-started/unsloth-notebooks> for all our GRPO notebooks, or try the below:

* [**Qwen3 (4B)**](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen3_\(4B\)-GRPO.ipynb) **-** Advanced GRPO LoRA
* [**DeepSeek-R1-0528-Qwen3 (8B)**](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/DeepSeek_R1_0528_Qwen3_\(8B\)_GRPO.ipynb) (for multilingual usecases)
* [Gemma 3 (1B)](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Gemma3_\(1B\)-GRPO.ipynb)
* [Llama 3.2 (3B)](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Advanced_Llama3_2_\(3B\)_GRPO_LoRA.ipynb) - Advanced GRPO LoRA
* [Llama 3.1 (8B)](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.1_\(8B\)-GRPO.ipynb)
* [Phi-4 (14B)](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Phi_4_\(14B\)-GRPO.ipynb)
* [Mistral v0.3 (7B)](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Mistral_v0.3_\(7B\)-GRPO.ipynb)