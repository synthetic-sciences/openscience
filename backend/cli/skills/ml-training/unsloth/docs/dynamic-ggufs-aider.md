# Unsloth Dynamic GGUFs on Aider Polyglot

We're showcasing how Unsloth Dynamic GGUFs makes it possible to quantize LLMs like DeepSeek-V3.1 (671B) down to just **1-bit** or **3-bit**, and still be able to outperform SOTA models like **GPT-4.5, GPT-4.1** (April 2025) and **Claude-4-Opus** (May 2025).

## Key Results

* Our **1-bit** Unsloth Dynamic GGUF shrinks DeepSeek-V3.1 from **671GB to 192GB (-75% size)** and no-thinking mode greatly outperforms GPT-4.1, GPT-4.5, and DeepSeek-V3-0324.
* **3-bit** Unsloth DeepSeek-V3.1 (thinking) GGUF: Outperforms Claude-4-Opus-20250514 (thinking).
* **5-bit** Unsloth DeepSeek-V3.1 (non-thinking) GGUF: Matches Claude-4-Opus-20250514 (non-thinking) performance.
* Unsloth Dynamic GGUFs perform consistently better than other non-Unsloth Dynamic imatrix GGUFs.
* Other non-Unsloth 1-bit and 2-bit DeepSeek-V3.1 quantizations either failed to load or produced gibberish.

## Reasoning Model Aider Benchmarks

| Model | Accuracy |
|-------|----------|
| GPT-5 | 86.7 |
| Gemini 2.5 Pro (June) | 83.1 |
| o3 | 76.9 |
| DeepSeek V3.1 | 76.1 |
| **(3 bit) DeepSeek V3.1 Unsloth** | **75.6** |
| Claude-4-Opus (May) | 72 |
| o4-mini (High) | 72 |
| DeepSeek R1 0528 | 71.4 |
| **(2 bit) DeepSeek V3.1 Unsloth** | **66.7** |
| Claude-3.7-Sonnet (Feb) | 64.9 |
| **(1 bit) DeepSeek V3.1 Unsloth** | **57.8** |
| DeepSeek R1 | 56.9 |

## Non-Reasoning Model Aider Benchmarks

| Model | Accuracy |
|-------|----------|
| DeepSeek V3.1 | 71.6 |
| Claude-4-Opus (May) | 70.7 |
| **(5 bit) DeepSeek V3.1 Unsloth** | **70.7** |
| **(4 bit) DeepSeek V3.1 Unsloth** | **69.7** |
| **(3 bit) DeepSeek V3.1 Unsloth** | **68.4** |
| **(2 bit) DeepSeek V3.1 Unsloth** | **65.8** |
| Qwen3 235B A22B | 59.6 |
| Kimi K2 | 59.1 |
| **(1 bit) DeepSeek V3.1 Unsloth** | **55.7** |
| DeepSeek V3-0324 | 55.1 |
| GPT-4.1 (April, 2025) | 52.4 |
| ChatGPT 4o (March, 2025) | 45.3 |
| GPT-4.5 | 44.9 |

## Dynamic Quantization Methodology

**Dynamic 1 bit makes important layers in 8 or 16 bits and un-important layers in 1,2,3,4,5 or 6bits.**

In Nov 2024, our 4-bit Dynamic Quants showcased how you could largely restore QLoRA fine-tuning & model accuracy by just **selectively quantizing layers**. We later applied this to DeepSeek-R1's MoE architecture, where we quantized some layers to as low as 1-bit and important layers to higher bits.

## Comparison to Other Quants

| Quant | Quant Size (GB) | Unsloth Accuracy % | Comparison Accuracy % |
|-------|-----------------|--------------------|-----------------------|
| TQ1_0 | 170 | 50.7 | |
| IQ1_M | 206 | 55.7 | |
| IQ2_XXS | 225 | 61.2 | |
| IQ2_M | 235 | 64.3 | |
| Q2_K_XL | 255 | 65.8 | |
| IQ3_XXS | 279 | 66.8 | |
| Q3_K_XL | 300 | 68.4 | |
| IQ4_XS | 357 | 69.2 | |
| Q4_K_XL | 387 | 69.7 | |
| Q5_K_XL | 484 | 70.7 | |
| IQ2_XXS | 164 | | 43.6 |
| IQ2_M | 215 | | 56.6 |
| Q2_K_L | 239 | | 64.0 |
| IQ3_XXS | 268 | | 65.6 |
| Q3_K_S | 293 | | 65.2 |
| IQ4_XS | 360 | | 66.3 |
| Q4_K_M | 409 | | 67.7 |
| Q5_K_M | 478 | | 68.9 |

## Dynamic Quantization Ablations

We did ablations to confirm our calibration dataset and dynamic methodology works. Key finding: `attn_k_b` and other tensors in DeepSeek V3.1 are highly important / sensitive to quantization and should be left in higher precision to retain accuracy!

## Chat Template Bug Fixes

During testing we found some lower bit quants not enclosing `<think> </think>` properly. We had to change llama.cpp's minja usage:

```
# From:
{%- set content = content.split("</think>", 1)[1] -%}

# To:
{%- set splitted = content.split("</think>") -%}
{%- set content = splitted[1:] | join("</think>") -%}
```

## Run DeepSeek V3.1 Dynamic Quants

```bash
apt-get update
apt-get install pciutils build-essential cmake curl libcurl4-openssl-dev -y
git clone https://github.com/ggml-org/llama.cpp
cmake llama.cpp -B llama.cpp/build \
    -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON -DLLAMA_CURL=ON
cmake --build llama.cpp/build --config Release -j --clean-first --target llama-quantize llama-cli llama-gguf-split llama-mtmd-cli llama-server
cp llama.cpp/build/bin/llama-* llama.cpp
```

```bash
export LLAMA_CACHE="unsloth/DeepSeek-V3.1-GGUF"
./llama.cpp/llama-cli \
    -hf unsloth/DeepSeek-V3.1-GGUF:Q2_K_XL \
    --jinja \
    --n-gpu-layers 99 \
    --temp 0.6 \
    --top_p 0.95 \
    --min_p 0.01 \
    --ctx-size 8192 \
    --seed 3407 \
    -ot ".ffn_.*_exps.=CPU"
```
