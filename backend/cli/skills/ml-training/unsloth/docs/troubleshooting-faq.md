# Troubleshooting & FAQs

If you're still encountering any issues with versions or dependencies, please use our [Docker image](installation-docker.md) which will have everything pre-installed.

> **Try always to update Unsloth if you find any issues.**
> `pip install --upgrade --force-reinstall --no-cache-dir --no-deps unsloth unsloth_zoo`

## Fine-tuning a new model not supported by Unsloth?

Unsloth works with any model supported by `transformers`. If a model isn't in our uploads or doesn't run out of the box, it's usually still supported. Enable compatibility by setting `trust_remote_code=True`:

```python
model, tokenizer = FastVisionModel.from_pretrained(
    "./deepseek_ocr",
    load_in_4bit = False,
    auto_model = AutoModel,
    trust_remote_code = True,
    unsloth_force_compile = True,
    use_gradient_checkpointing = "unsloth",
)
```

## Running in Unsloth works well, but after exporting & running on other platforms, the results are poor

* The most common cause is using an **incorrect chat template**. Use the SAME template for training and inference.
* You must use the correct `eos token`.
* Check if your inference engine adds an unnecessary "start of sequence" token.
* **Use our conversational notebooks to force the chat template - this will fix most issues.**

## Saving to GGUF / vLLM 16bit crashes

Reduce `maximum_memory_usage`:
`model.save_pretrained(..., maximum_memory_usage = 0.5)` (default is 0.75).

## How do I manually save to GGUF?

```python
model.save_pretrained_merged("merged_model", tokenizer, save_method = "merged_16bit")
```

```bash
apt-get update
apt-get install pciutils build-essential cmake curl libcurl4-openssl-dev -y
git clone https://github.com/ggerganov/llama.cpp
cmake llama.cpp -B llama.cpp/build \
    -DBUILD_SHARED_LIBS=ON -DGGML_CUDA=ON -DLLAMA_CURL=ON
cmake --build llama.cpp/build --config Release -j --clean-first --target llama-quantize llama-cli llama-gguf-split llama-mtmd-cli
cp llama.cpp/build/bin/llama-* llama.cpp

python llama.cpp/convert_hf_to_gguf.py merged_model \
    --outfile model-F16.gguf --outtype f16 --split-max-size 50G

# For BF16:
python llama.cpp/convert_hf_to_gguf.py merged_model \
    --outfile model-BF16.gguf --outtype bf16 --split-max-size 50G

# For Q8_0:
python llama.cpp/convert_hf_to_gguf.py merged_model \
    --outfile model-Q8_0.gguf --outtype q8_0 --split-max-size 50G
```

## Why is Q8_K_XL slower than Q8_0 GGUF?

On Mac devices, BF16 might be slower than F16. Q8_K_XL upcasts some layers to BF16. We are actively changing to make F16 the default.

## How to do Evaluation

Split your dataset into training and test splits (always shuffle!):

```python
new_dataset = dataset.train_test_split(
    test_size = 0.01,
    shuffle = True,
    seed = 3407,
)
train_dataset = new_dataset["train"]
eval_dataset = new_dataset["test"]
```

```python
from trl import SFTTrainer, SFTConfig
trainer = SFTTrainer(
    args = SFTConfig(
        fp16_full_eval = True,
        per_device_eval_batch_size = 2,
        eval_accumulation_steps = 4,
        eval_strategy = "steps",
        eval_steps = 1,
    ),
    train_dataset = new_dataset["train"],
    eval_dataset = new_dataset["test"],
)
```

## How do I do Early Stopping?

```python
from trl import SFTConfig, SFTTrainer
trainer = SFTTrainer(
    args = SFTConfig(
        fp16_full_eval = True,
        per_device_eval_batch_size = 2,
        eval_accumulation_steps = 4,
        output_dir = "training_checkpoints",
        save_strategy = "steps",
        save_steps = 10,
        save_total_limit = 3,
        eval_strategy = "steps",
        eval_steps = 10,
        load_best_model_at_end = True,
        metric_for_best_model = "eval_loss",
        greater_is_better = False,
    ),
)

from transformers import EarlyStoppingCallback
early_stopping_callback = EarlyStoppingCallback(
    early_stopping_patience = 3,
    early_stopping_threshold = 0.0,
)
trainer.add_callback(early_stopping_callback)
trainer.train()
```

## Evaluation Loop - Out of Memory or crashing

Set batch size lower than 2 and use `fp16_full_eval=True` to cut memory by 1/2.

## Downloading gets stuck at 90 to 95%

```python
import os
os.environ["UNSLOTH_STABLE_DOWNLOADS"] = "1"
from unsloth import FastLanguageModel
```

## RuntimeError: CUDA error: device-side assert triggered

```python
import os
os.environ["UNSLOTH_COMPILE_DISABLE"] = "1"
os.environ["UNSLOTH_DISABLE_FAST_GENERATION"] = "1"
```

## All labels in your dataset are -100

This means `train_on_responses_only` is incorrect for that model.

For Llama 3.1/3.2/3.3:
```python
from unsloth.chat_templates import train_on_responses_only
trainer = train_on_responses_only(
    trainer,
    instruction_part = "<|start_header_id|>user<|end_header_id|>\n\n",
    response_part = "<|start_header_id|>assistant<|end_header_id|>\n\n",
)
```

For Gemma 2/3/3n:
```python
from unsloth.chat_templates import train_on_responses_only
trainer = train_on_responses_only(
    trainer,
    instruction_part = "<start_of_turn>user\n",
    response_part = "<start_of_turn>model\n",
)
```

## Unsloth is slower than expected?

`torch.compile` typically takes ~5 minutes to warm up. Measure throughput **after** it's fully loaded. To disable:

```python
import os
os.environ["UNSLOTH_COMPILE_DISABLE"] = "1"
```

## Some weights were not initialized from model checkpoint

Fix by upgrading:

```bash
pip install --upgrade --force-reinstall --no-cache-dir --no-deps unsloth unsloth_zoo
pip install --upgrade --force-reinstall --no-cache-dir --no-deps transformers timm
```

## NotImplementedError: A UTF-8 locale is required. Got ANSI

```python
import locale
locale.getpreferredencoding = lambda: "UTF-8"
```

## Citing Unsloth

```bibtex
@misc{unsloth,
  author       = {Unsloth AI and Han-Chen, Daniel and Han-Chen, Michael},
  title        = {Unsloth},
  year         = {2025},
  publisher    = {Github},
  howpublished = {\url{https://github.com/unslothai/unsloth}}
}
```
