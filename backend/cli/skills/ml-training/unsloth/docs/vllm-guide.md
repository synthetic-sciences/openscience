# vLLM Deployment & Inference Guide

### Installing vLLM

For NVIDIA GPUs, use uv and run:

```bash
pip install --upgrade pip
pip install uv
uv pip install -U vllm --torch-backend=auto
```

For AMD GPUs, please use the nightly Docker image: `rocm/vllm-dev:nightly`

For the nightly branch for NVIDIA GPUs, run:

```bash
pip install --upgrade pip
pip install uv
uv pip install -U vllm --torch-backend=auto --extra-index-url https://wheels.vllm.ai/nightly
```

See [vLLM docs](https://docs.vllm.ai/en/stable/getting_started/installation) for more details

### Deploying vLLM models

After saving your fine-tune, you can simply do:

```bash
vllm serve unsloth/gpt-oss-120b
```

### vLLM Deployment Server Flags, Engine Arguments & Options

Some important server flags to use are at [vllm-engine-arguments](vllm-engine-arguments.md)

### Deploying Unsloth finetunes in vLLM

After fine-tuning or using our notebooks, you can save or deploy your models directly through vLLM within a single workflow. An example Unsloth finetuning script:

```python
from unsloth import FastLanguageModel
import torch
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "unsloth/gpt-oss-20b",
    max_seq_length = 2048,
    load_in_4bit = True,
)
model = FastLanguageModel.get_peft_model(model)
```

**To save to 16-bit for vLLM, use:**

```python
model.save_pretrained_merged("finetuned_model", tokenizer, save_method = "merged_16bit")
## OR to upload to HuggingFace:
model.push_to_hub_merged("hf/model", tokenizer, save_method = "merged_16bit", token = "")
```

**To save just the LoRA adapters**, either use:

```python
model.save_pretrained("finetuned_lora")
tokenizer.save_pretrained("finetuned_lora")
```

Or just use our builtin function to do that:

```python
model.save_pretrained_merged("finetuned_model", tokenizer, save_method = "lora")
## OR to upload to HuggingFace
model.push_to_hub_merged("hf/model", tokenizer, save_method = "lora", token = "")
```

To merge to 4bit to load on HuggingFace, first call `merged_4bit`. Then use `merged_4bit_forced` if you are certain you want to merge to 4bit. I highly discourage you, unless you know what you are going to do with the 4bit model (ie for DPO training for eg or for HuggingFace's online inference engine)

```python
model.save_pretrained_merged("finetuned_model", tokenizer, save_method = "merged_4bit")
## To upload to HuggingFace:
model.push_to_hub_merged("hf/model", tokenizer, save_method = "merged_4bit", token = "")
```

Then to load the finetuned model in vLLM in another terminal:

```bash
vllm serve finetuned_model
```

You might have to provide the full path if the above doesn't work ie:

```bash
vllm serve /mnt/disks/daniel/finetuned_model
```

See other content:

- [vLLM Engine Arguments](vllm-engine-arguments.md)
- [LoRA Hot Swapping Guide](lora-hot-swapping.md)
