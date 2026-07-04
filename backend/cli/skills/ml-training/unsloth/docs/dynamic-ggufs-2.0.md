# Unsloth Dynamic 2.0 GGUFs

We're excited to introduce our Dynamic v2.0 quantization method - a major upgrade to our previous quants. This new method outperforms leading quantization methods and sets new benchmarks for 5-shot MMLU and KL Divergence.

This means you can now run + fine-tune quantized LLMs while preserving as much accuracy as possible! You can run the 2.0 GGUFs on any inference engine like llama.cpp, Ollama, Open WebUI etc.

> **Sept 10, 2025 update:** You asked for tougher benchmarks, so we're showcasing Aider Polyglot results! Our Dynamic 3-bit DeepSeek V3.1 GGUF scores **75.6%**, surpassing many full-precision SOTA LLMs.

The **key advantage** of using the Unsloth package and models is our active role in **fixing critical bugs** in major models. We've collaborated directly with teams behind Qwen3, Meta (Llama 4), Mistral (Devstral), Google (Gemma 1-3) and Microsoft (Phi-3/4), contributing essential fixes that significantly boost accuracy.

## What's New in Dynamic v2.0?

* **Revamped Layer Selection for GGUFs + safetensors:** Unsloth Dynamic 2.0 now selectively quantizes layers much more intelligently and extensively. Rather than modifying only select layers, we now dynamically adjust the quantization type of every possible layer, and the combinations will differ for each layer and model.
* Current selected and all future GGUF uploads will utilize Dynamic 2.0 and our new calibration dataset. The dataset contains more than >1.5M **tokens** (depending on model) and comprise of high-quality, hand-curated and cleaned data - to greatly enhance conversational chat performance.
* Previously, our Dynamic quantization (DeepSeek-R1 1.58-bit GGUF) was effective only for MoE architectures. **Dynamic 2.0 quantization now works on all models (including MOEs & non-MoEs)**.
* **Model-Specific Quants:** Each model now uses a custom-tailored quantization scheme. E.g. the layers quantized in Gemma 3 differ significantly from those in Llama 4.
* To maximize efficiency, especially on Apple Silicon and ARM devices, we now also add Q4_NL, Q5.1, Q5.0, Q4.1, and Q4.0 formats.

## Why KL Divergence?

[Accuracy is Not All You Need](https://arxiv.org/pdf/2407.09141) showcases how pruning layers, even by selecting unnecessary ones still yields vast differences in terms of "flips". A "flip" is defined as answers changing from incorrect to correct or vice versa.

> **KL Divergence** should be the **gold standard for reporting quantization errors** as per the research paper. **Using perplexity is incorrect** since output token values can cancel out, so we must use KLD!

## Calibration Dataset Overfitting

Most frameworks report perplexity KL Divergence using a test set of Wikipedia articles. However, using the calibration dataset which is also Wikipedia related causes quants to overfit. **Also instruct models have unique chat templates, and using text only calibration datasets is not effective for instruct models** (base models yes).

We utilize Calibration_v3 and Calibration_v5 datasets for fair testing which includes some wikitext data amongst other data.

## MMLU Replication

* Replicating MMLU 5 shot was nightmarish. We **could not** replicate MMLU results for many models including Llama 3.1 (8B) Instruct, Gemma 3 (12B) due to **subtle implementation issues**.
* Llama 3.1 (8B) **tokenizes "A" and " A" (A with a space in front) as different token ids**. If we consider both spaced and non spaced tokens, we get 68.2% (+0.4%)
* Llama 3 as per Eleuther AI's LLM Harness also appends **"The best answer is"** to the question.

## Gemma 3 QAT Benchmarks

The Gemma team released two QAT (quantization aware training) versions of Gemma 3:
1. Q4_0 GGUF
2. int4 version (TorchAO int4 style)

Key results for Gemma 3 (12B):

| Metric | Value |
|--------|-------|
| MMLU 5 shot (QAT Q4_0) | **67.07%** (67.15% BF16) |
| Disk Space | 7.52GB |

KL Divergence improvements (Gemma 3 12B):

| Quant | Baseline KLD | GB | New KLD | GB |
|-------|---|---|---|---|
| IQ1_S | 1.035688 | 5.83 | 0.972932 | 6.06 |
| IQ2_XXS | 0.535764 | 7.16 | 0.521039 | 7.31 |
| Q2_K_XL | 0.229671 | 9.78 | 0.220937 | 9.95 |
| Q3_K_XL | 0.087845 | 12.51 | 0.080617 | 12.76 |
| Q4_K_XL | 0.024916 | 15.41 | 0.023701 | 15.64 |

Gemma 3 (27B) MMLU results:

| Quant | Unsloth | Unsloth + QAT | Disk Size | Efficiency |
|-------|---------|---------------|-----------|------------|
| IQ2_XXS | 59.20 | 56.57 | 7.31 | 4.32 |
| Q2_K_XL | 68.70 | 67.77 | 9.95 | 4.30 |
| Q3_K_XL | 70.87 | 69.50 | 12.76 | 3.49 |
| **Q4_K_XL** | **71.47** | **71.07** | **15.64** | **2.94** |
| **Google QAT** | | **70.64** | **17.2** | **2.65** |

Key finding: **Our dynamic 4bit version is 2GB smaller whilst having +1% extra accuracy vs the QAT version!**

## Llama 4 Bug Fixes

We helped and fixed several Llama 4 bugs:
* Llama 4 Scout changed the RoPE Scaling configuration - we helped resolve issues in llama.cpp
* Llama 4's QK Norm's epsilon should be 1e-05, not 1e-06
* QK Norm being shared across all heads was fixed (MMLU Pro increased from 68.58% to 71.53%)

### Running Llama 4 Scout

```bash
apt-get update
apt-get install pciutils build-essential cmake curl libcurl4-openssl-dev -y
git clone https://github.com/ggml-org/llama.cpp
cmake llama.cpp -B llama.cpp/build \
    -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON -DLLAMA_CURL=ON
cmake --build llama.cpp/build --config Release -j --clean-first --target llama-cli llama-gguf-split
cp llama.cpp/build/bin/llama-* llama.cpp
```

```python
import os
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id = "unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF",
    local_dir = "unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF",
    allow_patterns = ["*IQ2_XXS*"],
)
```

```bash
./llama.cpp/llama-cli \
    --model unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF/Llama-4-Scout-17B-16E-Instruct-UD-IQ2_XXS.gguf \
    --threads 32 \
    --ctx-size 16384 \
    --n-gpu-layers 99 \
    -ot ".ffn_.*_exps.=CPU" \
    --seed 3407 \
    --prio 3 \
    --temp 0.6 \
    --min-p 0.01 \
    --top-p 0.9 \
    -no-cnv \
    --prompt "<|header_start|>user<|header_end|>\n\nCreate a Flappy Bird game.<|eot|><|header_start|>assistant<|header_end|>\n\n"
```
