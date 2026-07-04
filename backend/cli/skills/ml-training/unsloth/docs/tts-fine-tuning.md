# Text-to-Speech (TTS) Fine-tuning Guide

Fine-tuning TTS models allows them to adapt to your specific dataset, use case, or desired style and tone. The goal is to customize these models to clone voices, adapt speaking styles and tones, support new languages, handle specific tasks and more. We also support **Speech-to-Text (STT)** models like OpenAI's Whisper.

With Unsloth, you can fine-tune **any** TTS model (`transformers` compatible) 1.5x faster with 50% less memory than other implementations with Flash Attention 2.

Unsloth supports any `transformers` compatible TTS model. Even if we don't have a notebook or upload for it yet, it's still supported e.g., try fine-tuning Dia-TTS or Moshi.

> Zero-shot cloning captures tone but misses pacing and expression, often sounding robotic and unnatural. Fine-tuning delivers far more accurate and realistic voice replication.

## Fine-tuning Notebooks

We've also uploaded TTS models (original and quantized) to our [Hugging Face page](https://huggingface.co/collections/unsloth/text-to-speech-tts-models-68007ab12522e96be1e02155).

| Model | Notebook |
|-------|----------|
| Sesame-CSM (1B) | [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Sesame_CSM_(1B)-TTS.ipynb) |
| Orpheus-TTS (3B) | [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Orpheus_(3B)-TTS.ipynb) |
| Whisper Large V3 (STT) | [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Whisper.ipynb) |
| Spark-TTS (0.5B) | [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Spark_TTS_(0_5B).ipynb) |
| Llasa-TTS (1B) | [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llasa_TTS_(1B).ipynb) |
| Oute-TTS (1B) | [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Oute_TTS_(1B).ipynb) |

> If you notice that the output duration reaches a maximum of 10 seconds, increase `max_new_tokens = 125` from its default value of 125. Since 125 tokens corresponds to 10 seconds of audio, you'll need to set a higher value for longer outputs.

## Choosing and Loading a TTS Model

For TTS, smaller models are often preferred due to lower latency and faster inference. Fine-tuning a model under 3B parameters is often ideal.

### Sesame-CSM (1B) Details

CSM-1B is a base model, while Orpheus-ft is fine-tuned on 8 professional voice actors, making voice consistency the key difference. CSM requires audio context for each speaker to perform well, whereas Orpheus-ft has this consistency built in.

### Orpheus-TTS (3B) Details

Orpheus is pre-trained on a large speech corpus and excels at generating realistic speech with built-in support for emotional cues like laughs and sighs. Its architecture makes it one of the easiest TTS models to utilize and train as it can be exported via llama.cpp meaning it has great compatibility across all inference engines.

### Loading the models

Because voice models are usually small in size, you can train the models using LoRA 16-bit or full fine-tuning FFT:

```python
from unsloth import FastModel

model_name = "unsloth/orpheus-3b-0.1-pretrained"
model, tokenizer = FastModel.from_pretrained(
    model_name,
    load_in_4bit=False  # use 4-bit precision (QLoRA)
)
```

## Preparing Your Dataset

At minimum, a TTS fine-tuning dataset consists of **audio clips and their corresponding transcripts** (text).

**Option 1: Using Hugging Face Datasets library:**

```python
from datasets import load_dataset, Audio

dataset = load_dataset("MrDragonFox/Elise", split="train")
print(len(dataset), "samples")  # ~1200 samples in Elise

# Ensure all audio is at 24 kHz sampling rate (Orpheus's expected rate)
dataset = dataset.cast_column("audio", Audio(sampling_rate=24000))
```

Orpheus supports tags like `<laugh>`, `<chuckle>`, `<sigh>`, `<cough>`, `<sniffle>`, `<groan>`, `<yawn>`, `<gasp>`, etc. For example: `"I missed you <laugh> so much!"`.

**Option 2: Preparing a custom dataset:**

* Organize audio clips (WAV/FLAC files) in a folder.
* Create a CSV or TSV file with columns for file path and transcript:

```
filename,text
0001.wav,Hello there!
0002.wav,<sigh> I am very tired.
```

```python
from datasets import Audio
dataset = load_dataset("csv", data_files="mydata.csv", split="train")
dataset = dataset.cast_column("filename", Audio(sampling_rate=24000))
```

## Fine-Tuning TTS with Unsloth

### Step 1: Load the Model and Dataset

```python
from unsloth import FastLanguageModel
import torch

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "unsloth/orpheus-3b-0.1-ft",
    max_seq_length = 2048,
    dtype = None,
    load_in_4bit = False,
)

from datasets import load_dataset
dataset = load_dataset("MrDragonFox/Elise", split = "train")
```

### Step 2: Set up training arguments and Trainer

```python
from transformers import TrainingArguments, Trainer, DataCollatorForSeq2Seq
from unsloth import is_bfloat16_supported

trainer = Trainer(
    model = model,
    train_dataset = dataset,
    args = TrainingArguments(
        per_device_train_batch_size = 1,
        gradient_accumulation_steps = 4,
        warmup_steps = 5,
        max_steps = 60,
        learning_rate = 2e-4,
        fp16 = not is_bfloat16_supported(),
        bf16 = is_bfloat16_supported(),
        logging_steps = 1,
        optim = "adamw_8bit",
        weight_decay = 0.01,
        lr_scheduler_type = "linear",
        seed = 3407,
        output_dir = "outputs",
        report_to = "none",
    ),
)
```

### Step 3: Train and Save

```python
trainer.train()

model.save_pretrained("lora_model")
tokenizer.save_pretrained("lora_model")
```

## Fine-tuning Voice models vs. Zero-shot voice cloning

Zero-shot voice cloning captures the general **tone and timbre** of a speaker's voice, but it doesn't reproduce the full expressive range. You lose details like speaking speed, phrasing, vocal quirks, and the subtleties of prosody.

If you just want a different voice and are fine with the same delivery patterns, zero-shot is usually good enough. But the speech will still follow the **model's style**, not the speaker's.

For anything more personalized or expressive, you need training with methods like LoRA to truly capture how someone speaks.
