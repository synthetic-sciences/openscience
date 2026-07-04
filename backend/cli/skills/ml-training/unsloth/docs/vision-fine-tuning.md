# Vision Fine-tuning

Fine-tuning vision models enables models to excel at tasks normal LLMs won't be as good at, such as object/movement detection. **You can also train VLMs with RL.**

## Free Notebooks

* **Qwen3-VL (8B) Vision:** [Notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen3_VL_(8B)-Vision.ipynb)
* **Ministral 3** vision fine-tuning for general Q&A: [Notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Pixtral_(12B)-Vision.ipynb)
* **Gemma 3 (4B) Vision:** [Notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Gemma3_(4B)-Vision.ipynb)
* **Llama 3.2 Vision** fine-tuning for radiography: [Notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.2_(11B)-Vision.ipynb)
* **Qwen2.5 VL** fine-tuning for converting handwriting to LaTeX: [Notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen2.5_VL_(7B)-Vision.ipynb)

> It is best to ensure your dataset has images of all the same size/dimensions. Use dimensions of 300-1000px to ensure your training does not take too long.

## Disabling Vision / Text-only fine-tuning

You can select which parts of the model to finetune:

```python
model = FastVisionModel.get_peft_model(
    model,
    finetune_vision_layers     = True,  # False if not finetuning vision layers
    finetune_language_layers   = True,  # False if not finetuning language layers
    finetune_attention_modules = True,  # False if not finetuning attention layers
    finetune_mlp_modules       = True,  # False if not finetuning MLP layers
    r = 16,
    lora_alpha = 16,
    lora_dropout = 0,
    bias = "none",
    random_state = 3407,
    use_rslora = False,
    loftq_config = None,
    target_modules = "all-linear",
    modules_to_save=["lm_head", "embed_tokens"],
)
```

## Vision Data Collator

We have a special data collator just for vision datasets:

```python
from unsloth.trainer import UnslothVisionDataCollator
from trl import SFTTrainer, SFTConfig

trainer = SFTTrainer(
    model = model,
    tokenizer = tokenizer,
    data_collator = UnslothVisionDataCollator(model, tokenizer),
    train_dataset = dataset,
    args = SFTConfig(...),
)
```

Arguments for the data collator:

```python
class UnslothVisionDataCollator:
    def __init__(
        self,
        model,
        processor,
        max_seq_length  = None,
        formatting_func = None,
        resize = "min",     # Can be (10, 10) or "min" or "max"
        ignore_index = -100,
        train_on_responses_only = False,
        instruction_part = None,
        response_part    = None,
        force_match      = True,
        num_proc         = None,
        completion_only_loss = True,
        pad_to_multiple_of = None,
        resize_dimension = 0,   # can be 0, 1, 'max' or 'min'
        snap_to_patch_size = False,
    )
```

## Vision Fine-tuning Dataset

The dataset format for vision fine-tuning:

```python
[
    {"role": "user",
     "content": [{"type": "text", "text": instruction}, {"type": "image", "image": image}]},
    {"role": "assistant",
     "content": [{"type": "text", "text": answer}]},
]
```

Example formatting function:

```python
instruction = "You are an expert radiographer. Describe accurately what you see in this image."

def convert_to_conversation(sample):
    conversation = [
        {"role": "user",
         "content": [
            {"type": "text", "text": instruction},
            {"type": "image", "image": sample["image"]}]},
        {"role": "assistant",
         "content": [
            {"type": "text", "text": sample["caption"]}]},
    ]
    return {"messages": conversation}
```

## Multi-image training

For multi-image VLM training (e.g., Qwen3-VL), swap:

```python
# Instead of:
ds_converted = ds.map(convert_to_conversation)

# Use:
ds_converted = [convert_to_conversation(sample) for sample in dataset]
```

Using map kicks in dataset standardization and arrow processing rules which can be strict and more complicated to define.

## Training on assistant responses only for vision models

For vision models, use the extra arguments as part of `UnslothVisionDataCollator`:

```python
UnslothVisionDataCollator(
    model, tokenizer,
    train_on_responses_only = True,
    instruction_part = "<|start_header_id|>user<|end_header_id|>\n\n",
    response_part = "<|start_header_id|>assistant<|end_header_id|>\n\n",
)
```
