# FP8 Reinforcement Learning

We're introducing FP8-precision training for RL, making FP8 GRPO now possible on **consumer GPUs** (RTX 40, 50 etc). DeepSeek-R1 demonstrated how powerful FP8 can be and with Unsloth, Qwen3-1.7B FP8 GRPO now works on just **5GB of VRAM**.

Faster RL inference is critical as it's the most compute-intensive workload in RL. We collabed with [TorchAO](https://github.com/pytorch/ao) from PyTorch to enable performance gains with no loss in accuracy.

* **\~1.4× faster** RL inference via [vLLM](https://github.com/vllm-project/vllm) • 2x longer context vs. BF16 and FP16
* **60% less VRAM** and **10× longer** context than other FP8 RL implementations
* Unsloth is the **only framework** to make FP8 RL LoRA work on consumer GPUs (e.g. NVIDIA GeForce RTX 40 and 50 Series). Also works on H100, H200, B200 etc.
* Use `load_in_fp8 = True` within `FastLanguageModel` to enable FP8 RL.
* Though Qwen3-8B fits in 16GB VRAM, free Colab NVIDIA Tesla T4 GPUs **don’t support FP8**. So our nks use **24GB L4 GPUs which fits Qwen3-14B**.

**Notebooks:** [Qwen3-8B FP8 GRPO](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen3_8B_FP8_GRPO.ipynb) and [Llama-3.2-1B FP8 GRPO](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama_FP8_GRPO.ipynb)

{% hint style="success" %}
Bonus: You’ll notice Unsloth now uses much less VRAM. We’ll share details in a new blog soon.
{% endhint %}

Our FP8 support uses Unsloth’s [weight-sharing feature](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide/memory-efficient-rl), reducing VRAM use by another **50%**, enabling **10× more** context with no accuracy loss. We use [vLLM](https://github.com/vllm-project/vllm) for fast inference and, our techniques like Unsloth [Standby](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide/memory-efficient-rl) and [Flex Attention](https://unsloth.ai/docs/models/gpt-oss-how-to-run-and-fine-tune/long-context-gpt-oss-training) to further reducese. TorchAO enables universal on the fly FP8, so Llama, Gemma, Mistral & more work. We’ve also [uploaded](#unsloth-fp8-uploads) most FP8 models (including Qwen3).

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FNhbi7jRc6zwCAeuddBBk%2Foutput(14).png?alt=media&#x26;token=80ad0712-4626-4536-aa57-29bc53b40540" alt="" width="375"><figcaption><p>Reward plot shows FP8 following the same trend as BF16</p></figcaption></figure>

### :sunflower:FP8 vs BF16 Training

Research shows that FP8 training can largely match BF16 accuracy and if you serve models in FP8, **training and serving in the same precision** helps preserve accuracy. Also FP8 vs BF16 yields 1.6x higher throughput on H100s and has 2x lower memory usage.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FApLfXUBVZSbjpPhRJG6z%2Ffp8%20f16%20quant.png?alt=media&#x26;token=77a2917f191-44a7-8597-6796fcf24ed7" alt="" width="375"><figcaption></figcaption></figure>

#### Weight scales & FP8 types

Quantized training stores a low-precision weight (e.g., FP8) plus a higher-precision scale (FP16/BF16/FP32). You approximately recover the original weight via: `original_weight ≈ quantized_weight * weight_scale`

The scale maps the weight’s range into FP8’s representable range. More scales usually improve accuracy, but scales cost extra high-precision memory, so it’s a tradeoff. [DeepSeek R1](https://arxiv.org/abs/2501.12948), for instance, mostly favors block quantization.

There are 3 common FP8 types as defined by vLLM's [llm-compressor](https://github.com/vllm-project/llm-compressor). We benchmarked Qwen3-8B on all 3 types, and also checked throughput, MMLU Pro and GQPA Diamond. We find **FP8 Block-Wise or Per-Channel (-FP8-Dynamic) is the best** in terms of accuracy and throughput.

<table><thead><tr><th width="121">Type</th><th width="225.20001220703125"></th><th width="126.40002">Throughput</th><th width="121.60003662109375">MMLU Pro</th><th>GQPA Diamond</th></tr></thead><tbody><tr><td></td><td>Bfloat16 Baseline</td><td>11,367</td><td><strong>62.04%</strong></td><td>28.79%</td></tr><tr><td>Block-wise</td><td>Scales per block (128X128)</td><td>12,041</td><td><strong>62.37%</strong></td><td><strong>29.29%</strong></td></tr><tr><td>Per-Channel</td><td>1 scale per row or column</td><td>12,963</td><td>61.89%</td><td><strong>31.82%</strong></td></tr><tr><td>Per-Tensor</td><td>1 scale for the whole tensor</td><td><strong>13,681</strong></td><td>61.83%</td><td>27.78%</td></tr></tbody></table>

### :zap:FP8 Performance Benchmarks

Unsloth FP8 RL inference via vLLM is generally 1.4x faster than BF16. You may see even more speed improvements if the model is larger!

#### Accuracy Training loss Benchmarks

We tested multiple models including Qwen3-4B, 8B, 14B, Llama 3.2 1B, 3B, Qwen3-VL-2B, Qwen3-VL 4B and many more. All were trained both in BF16 and FP8. As seen in the plots, the **loss curves during SFT for BF16 and FP8 closely track each other**. There isn’t much to choose between the two data types in terms of training loss:

{% columns %}
{% column %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FR6Hx9RtgqPXnYxvx5BbR%2FW%26B%20Chart%2025_11_2025%2C%208_54_56%20am.png?alt=media&#x26;token=d1d70d59-df00-45bb-8352-e833f9b5f3cd" alt=""><figcaption></figcaption></figure>
{% endcolumn %}

{% column %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FlUzs2uNkCyF1ulNdrVRc%2FW%26B%20Chart%2025_11_2025%2C%208_56_50%20am.png?alt=media&#x26;token=09545235-c9fa-4b76-a834-ffe0ceb8f639" alt=""><figcaption></figcaption></figure>
{% endcolumn %}
{% endcolumns %}

For GRPO specifically, due to generation differences, the goal is to see if the reward plots at least match up and not diverge (sometimes for eg Qwen3-14B runs mighnot be exactly similar)

{% columns %}
{% column width="50%" %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FeLBs5GrQb988GcrYVzpF%2FW%26B%20Chart%2025_11_2025%2C%209_00_50%20am.png?alt=media&#x26;token=59220833-33c6-4c28-abe7-b5d0d93a0a17" alt=""><figcaption></figcaption></figure>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FPqXVeofauAIr5Qngm9d2%2FW%26B%20Chart%2025_11_2025%2C%209_08_06%20am.png?alt=media&#x26;token=16498cf1-17e1-4984-b933-fe3633e19a6b" alt=""><figcaption></figcaption></figure>
{% endcolumn %}

{% column width="50%" %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FC76ql9G59SB0v3nG3pbL%2FW%26B%20Chart%2025_11_2025%2C%209_05_32%20am.png?alt=media&#x26;token=554b6fe8-c121-48a4-8b33-41f28fc38ebb" alt=""><figcaption></figcaption></figure>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FqM5NKHjOxqJv0hrzmr2B%2FW%26B%20Chart%2025_11_2025%2C%209_07_12%20am.png?alt=media&#x26;token=a7ad9eb0-0ea2-4364-982a-0875ec63459f" alt=""><figcaption></figcaption></figure>
{% endcolumn %}
{% endcolumns %}

### :shinto\_shrine:Inference = 96% of RL training

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FTvC7GqMM5XAfV8Zv2tpf%2Fimage.avif?alt=media&#x26;token=62b40c34-3111-40a9-b02a-4bfa8826402d" alt=""><figcaption></figcaption></figure>

In RL, we have to call the LLM / VLM to generate some possible candidate solutions to some run, then we score each possible solution and **reward good solutions, and penalize bad answers**. To achieve maximum efficiency, we must make inference nearly 100% of the training run. In Unsloth, we **managed to make training take only <4% of the entire RL run, with 96% being purely vLLM inference.**

For example for Qwen-3-8B, which is 1.15x faster on shorter sequence lengths, vLLM FP8 itself for inference (without training) throughput is also 1.15x faster. We see our RL run in Unsloth attains also 1.15x faster on tokens processed, showing how **training overhead is negligible in Unsloth.**

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2F105iKEPXAor00mdUPTfo%2FTokens%20Processed%20during%20RL.svg?alt=media&#x26;token=ca1c1d76-64b2-4019-91ac-7043f0ab79fd" alt=""><figcaption></figcaption></figure>

### :1234:60% less memory usage

In theory, you’d expect memory savings to roughly **equal to the model’s weight memory**, because: optimizer states are still stored in high precision and activations are also stored in high precision (for now). Our findings match the theory. For LoRA fine-tuning, we observed: **\~30 GB saved** for **Qwen3-32B, \~14 GB s** for **Qwen2.5-14B** and **\~8 GB saved** for **Qwen3-8B**

For **BF16 LoRA fine-tuning on** Qwen3-32B, we were ooming at higher batch sizes and had to shrink the batch. The **FP8 variant had no such issues**, and we could use **larger batch sizes** without OOMing.

Also reminder in Unsloth we share vLLM's memory space for the weights as introduced in [memory-efficient-rl](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide/memory-efficient-rl "mention") - we have bought this trick over to the FP8 domain!

| 80GB GPU                                                                                                                                                            | Inference Engine   | Training Engine                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------- |
| Model Weights                                                                                                                                                       | **8GB SHARED FP8** | **<<< SHARED**                           |
| <p><mark style="background-color:purple;"><strong>Multi-purpose</strong></mark></p><p><mark style="background-color:purple;"><strong>72GB space</strong></mark></p> | KV Cache           | Activations, Gradients, Optimizer States |

To enable [Unsloth Standby](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide/memory-efficient-rl) for FP8 (or BF16) RL, simply add the below to all RL / GRPO training runs before any Unsloth import:

```python
import os
os.environ["UNSLOTH_VLLM_STANDBY"] = "1"
```

### :question:How to use FP8 RL / installation

Simply update Unsloth or install Unsloth in a new virtual environment for H100, L4, RTX 50x, RTX 40x, H200s, B200s, and any NVIDIA GPU (consumer or data center grade) released after the RTX 4090.

To update Unsloth: `pip install --upgrade --force-reinstall --no-cache-dir --no-deps unsloth unsloth_zoo`Or make a new environment:

{% code overflow="wrap" %}

```bash
python -m venv unsloth_env
source unsloth_env/bin/activate

pip install unsloth vllm
pip install --pre torchao --index-url https://download.pytorch.org/whl/nightly/cu128 --force-reinstall
pip install --pre fbgemm-gpu fbgemm-gpu-genai --index-url https://download.pytorch.org/whl/cu128 --force-reinstall
pip install --upgrade numba numpy
```

{% endcode %}

Then use `load_in_fp8 = True` and you're good to go! We'll auto map the model name to the Float8 variant, or we'll on the fly convert the model to Float8!

<pre class="language-python" data-overflow="wrap"><code class="lang-python">import os
os.environ['UNSLOTH_VLLM_STANDBY'] = "1" # Unsloth standby saves 30%+ memory for RL
from unsloth import FastLanguageModel
import torch
max_seq_length = 2048 # Can increase for longer reasoning traces
lora_rank = 32 # Larger rank = smarter, but slower
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "unsloth/Qwen3-8B",
    max_seq_length = max_seq_length,
    load_in_4bit = False, # False for LoRA 16bit
    fast_inference = True, # Enable vLLM fast inference
    max_lora_rank = lora_rank,
<strong>    load_in_fp8 = True, # Float8 RL / GRPO!
</strong>)
</code></pre>

For example on a RTX 5090 (reminder to set `os.environ["UNSLOTH_VLLM_STANDBY"] = "1"` )

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FlVA3v7E5J8pHb1QKLi2V%2Fimage.png?alt=media&#x26;token=20b5329c-6ac2-479a-a4cc-2a0d74486696" alt="" width="375"><figcaption></figcaption></figure>

Then use our 2 FP8 notebooks for RL:

{% columns %}
{% column %}
**Qwen3-8B FP8 RL Colab**

{% embed url="<https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen3_8B_FP8_GRPO.ipynb>" %}
{% endcolumn %}

{% column %}
**Llama-3.2-1B-FP8 RL Colab**

{% embed url="<https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama_FP8_GRPO.ipynb>" %}
{% endcolumn %}
{% endcolumns %}

### :cd:Implementing FP8 Training

Our first reference point was `transformers`, which already supports FP8 in a couple of ways. One of them is a block-quantized matmul implementation: when a layer receives 16‑bit activations, it quantizes them and passes them to a custom FP8 matmul kernel. After wiring this up and benchmarking on an NVIDIA H100, we saw the opposite of what we wanted: fine-tuning became about **4× slower** than standard BF16 fine-tuning.

### 🔥TorchAO Collab

So we worked with the [TorchAO](https://github.com/pytorch/ao) team (huge thanks to[ Andrew](https://github.com/unslothai/unsloth/pull/3440)) to incorporate TorchAO’s FP8 support into our RL workloads and saw around **1.4× faster throughput** and up to **60% less model memory usage**. At a high level:

* We store the frozen LoRA weights in FP8.
* During the forward pass, we apply dynamic FP8 quantization to the input activations, while keeping the trainable LoRA adapters 
* These FP8 weights share the same buffers as the vLLM model weights, so there’s only a single FP8 copy of the model in memory at any time (no “double model” memory overhead).
* In the backward pass, we dequantize the LoRA weights so all gradient computation is done in BF16 for better accuracy.

This general setup works across all supported RL algorithms, including [GSPO](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide/gspo-reinforcement-learning), Dr. GRPO, PPO, and DPO.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FUir0hB7T0xBtWUTnK3aG%2Funknown.png?alt=media&#x26;token=d225cd2e-fdf4-4521-8e9f-72bd684eb9e4" alt="" width="375"><figcaption></figcaption></figure>

TorchAO provides PyTorch-native FP8 support for both training and inference, offering a variety of scaling granularities including tensorwise, row-wise, and 128x128 blockwise (prototype). TorchAO’s FP8 support can improve infereughput by up to [1.64x at 27B scale](https://huggingface.co/pytorch/gemma-3-27b-it-FP8/blob/main/README.md#results-h100-machine) with row-wise scaling granularity. For more details, visit the TorchAO [FP8 README](https://github.com/pytorch/ao/blob/main/torchao/float8/README.md).

#### TorchAO’s block-quantized FP8 matmul

We used TorchAO’s block‑quantized FP8 matmul implementation which provided:

* **80% of BF16 throughput**
* Without degrading loss or training stability

So for a while, this became our default FP8 matmul backend, until FBGEMM caught up - we know default to using FBGEMM's implementation, if your GPU supports it! The current version of Unsloth can automatically choose the best backend based on what’s installed. If you have the right packages, you don’t have to leave performance on the table 🙂

PS: We also experimented with DeepSeek’s DeepGEMM, but couldn’t get it fully integrated end‑to‑end to run clean, apples‑to‑apples comparisons.

### :bird:On the fly TorchAO FPthanks to [Andrew](https://github.com/unslothai/unsloth/pull/3440) from TorchAO, Unsloth FP8 RL also lets you quantize the model on the fly by doing quantization within the model load time and passing that on to vLLM. This way, you need not explicitly quantize the model yourself (we handle it for you). You can do this by setting `load_in_fp8 = True` in the model load arguments, and will do offline FP8 if we don't find a suitable pre-quantized checkpoint.

```python
from unsloth import FastLanguageModel
fp8_model = FastLanguageModel.from_pretrained(
    "unsloth/Llama-3.3-70B-Instruct", # Can be any model name!
    load_in_fp8 = True, # Can be "block" for block FP8, True for row FP8, False
)
```

### :tada:Unsloth FP8 uploads

For convenience, we uploaded FP8 Dynamic and FP8 Block models on Hugging Face. You can use them for FP8 training or also efficient & fast serving/deployment via [vLLM](https://unsloth.ai/docs/basics/inference-and-deployment/vllm-guide)/[SGLang](https://unsloth.ai/docs/basics/inference-and-deployment/sglang-guide) etc.

FP8 Dynamic offers slightly faster training and lower VRAM usage than FP8 Block, but with a small trade-off in accuracy. [See here](https://unsloth.ai/docs/unsloth-model-catalog#fp8) for our full list of FP8 quants, but here the most popular ones:

| Model                 | FP8 uploads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Qwen3 (2507)**      | <p>4B Instruct — <a href="https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-FP8">FP8</a><br>4B Thinking — <a href="https://huggingface.co/unsloth/Qwen3-4B-Thinking-2507-FP8">FP8</a><br>30B-A3B Instruct — <a href="https://huggingface.co/h/Qwen3-30B-A3B-Instruct-2507-FP8">FP8</a><br>30B-A3B Thinking — <a href="https://huggingface.co/unsloth/Qwen3-30B-A3B-Thinking-2507-FP8">FP8</a></p>                                                                                                                                                                                                                                                                                                                                 |
| **Qwen3-VL**          | <p>4B Instruct — <a href="https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-FP8">FP8</a><br>4B Thinking — <a href="https://huggingface.co/unsloth/Qwen3-VL-4B-Thinking-FP8">FP8</a><br>8B Instruct — <a href="https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-FP8">FP8</a><br>8B Thinking — <a href="https://huggingface.co/unsloth/Qwen3-VL-8B-Thinking-FP8">FP8</a></p>                                                                                                                                                                                                                                                                                                                                                   |
| **Llama 3.1**         | <p>8B Instruct — <a href="https://huggingface.co/unsloth/Llama-3.1-8B-Instruct-FP8-Dynamic">Dynamic</a> · <a href="https://huggingface.co/unsloth/Llama-3.1-8B-Instruct-FP8-Block">Block</a><br>8B Base — <a href="https://huggingface.co/unsloth/Llama-3.1-8B-FP8-Dynamic">Dynamic</a> · <a href="https://huggingface.co/unsloth/Llama-3.1-8B-FP8-Block">Block</a><br>70B — <a href="https://huggingface.co/unsloth/Llama-3.1-70B-FP8-Dynamic">Dynamic</a> · <a href="https://huggingface.co/unsloth/Llama-3.1-70B-FP8-Block">Block</a></p>                                                                                                                                                                                                |
| **Qwen3**             | <p>0.6B — <a href="https://huggingface.co/unslo6B-FP8">FP8</a><br>1.7B — <a href="https://huggingface.co/unsloth/Qwen3-1.7B-FP8">FP8</a><br>4B — <a href="https://huggingface.co/unsloth/Qwen3-4B-FP8">FP8</a><br>8B — <a href="https://huggingface.co/unsloth/Qwen3-8B-FP8">FP8</a><br>14B — <a href="https://huggingface.co/unsloth/Qwen3-14B-FP8">FP8</a><br>32B — <a href="https://huggingface.co/unsloth/Qwen3-32B-FP8">FP8</a></p>                                                                                                                                                                                                                                                                                         |
| **Llama 3.3**         | 70B — [Dynamic](https://huggingface.co/unsloth/Llama-3.3-70B-Instruct-FP8-Dynamic) · [Block](https://huggingface.co/unsloth/Llama-3.3-70B-Instruct-FP8-Block)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Llama 3.2**         | <p>1B Base — <a href="https://huggingface.co/unsloth/Llama-3.2-1B-FP8-Dynamic">Dynamic</a> · <a href="https://huggingface.co/unsloth/Llama-3.2-1B-FP8-Block">Block</a><br>1B Instruct — <a href="https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-FP8-Dynamic">Dynamic</a> · <a href="https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-FP8-Block">Block</a><br>3B Base — <a href="https://huggingface.co/unsloth/Llama-3.2-3B-FP8-Dynamic">Dynamic</a> · <a href="https://huggingface.co/unsloth/Llama-3.2-3B-FP8-Block">Block</a><br>3B Instruct — <a href="https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-F>Dynamic</a> · <a href="https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-FP8-Block">Block</a></p> |
| **Granite 4.0**       | <p>h-tiny — <a href="https://huggingface.co/unsloth/granite-4.0-h-tiny-FP8-Dynamic">FP8 Dynamic</a><br>h-small — <a href="https://huggingface.co/unsloth/granite-4.0-h-small-FP8-Dynamic">FP8 Dynamic</a></p>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Magistral Small**   | [FP8 Dynamic](https://huggingface.co/unsloth/Magistral-Small-2509-FP8-Dynamic) · [FP8 torchao](https://huggingface.co/unsloth/Magistral-Small-P8-torchao)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Mistral Small 3.2** | [FP8](https://huggingface.co/unsloth/Mistral-Small-3.2-24B-Instruct-2506-FP8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Gemma 3**           | <p>270m — <a href="https://huggingface.co/unsloth/gemma-3-270m-it-FP8-Dynamic">FP8</a><br>1B — <a href="https://huggingface.co/unsloth/gemma-3-1b-it-FP8-Dynamic">FP8</a><br>4B — <a href="https://huggingface.co/unsloth/gemma-3-4b-it-FP8-Dynamic">FP8</a><br>12B — <a href="https://huggingface.co/unsloth/gemma-3-12B-it-FP8-Dynamic">FP8</a><br>27B — <a href="https://huggingface.co/unsloth/gemma-3-27b-it-FP8-Dynamic">FP8</a></p>                                                                                                                                                                                                                                                                                        |

### :person\_tipping\_hand:Acknowledgements
