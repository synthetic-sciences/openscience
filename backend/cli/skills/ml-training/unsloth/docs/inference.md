# Unsloth Inference

Unsloth supports natively 2x faster inference. For our inference only notebook, click [here](https://colab.research.google.com/drive/1aqlNQi7MMJbynFDyOQteD2t0yVfjb9Zh?usp=sharing).

All QLoRA, LoRA and non LoRA inference paths are 2x faster. This requires no change of code or any new dependencies.

```python
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "lora_model", # YOUR MODEL YOU USED FOR TRAINING
    max_seq_length = max_seq_length,
    dtype = dtype,
    load_in_4bit = load_in_4bit,
)
FastLanguageModel.for_inference(model) # Enable native 2x faster inference
text_streamer = TextStreamer(tokenizer)
_ = model.generate(**inputs, streamer = text_streamer, max_new_tokens = 64)
```

#### NotImplementedError: A UTF-8 locale is required. Got ANSI

Sometimes when you execute a cell [this error](https://github.com/googlecolab/colabtools/issues/3409) can appear. To solve this, in a new cell, run the below:

```python
import locale
locale.getpreferredencoding = lambda: "UTF-8"
```
