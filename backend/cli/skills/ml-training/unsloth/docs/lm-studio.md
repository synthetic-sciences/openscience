# Deploying models to LM Studio

You can run and deploy your fine-tuned LLM directly in LM Studio. [LM Studio](https://lmstudio.ai/) enables easy running and deployment of **GGUF** models (llama.cpp format).

You can use our [LM Studio notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/FunctionGemma_(270M)-LMStudio.ipynb) or follow the instructions below:

1. **Export your Unsloth fine-tuned model to `.gguf`**
2. **Import / download the GGUF into LM Studio**
3. **Load it in Chat** (or run it behind an OpenAI-compatible local API)

### 1) Export to GGUF (from Unsloth)

If you already exported a `.gguf`, skip to **Importing into LM Studio**.

```python
# Save locally (creates GGUF artifacts in the folder)
model.save_pretrained_gguf("my_model_gguf", tokenizer, quantization_method = "q4_k_m")
# model.save_pretrained_gguf("my_model_gguf", tokenizer, quantization_method = "q8_0")
# model.save_pretrained_gguf("my_model_gguf", tokenizer, quantization_method = "f16")

# Or push GGUF to the Hugging Face Hub
model.push_to_hub_gguf("hf_username/my_model_gguf", tokenizer, quantization_method = "q4_k_m")
```

> `q4_k_m` is usually the default for local runs.
> `q8_0` is the optimum for near full precision quality.
> `f16` is largest / slowest, but original unquantized precision.

### 2) Import the GGUF into LM Studio

#### CLI Import (lms import)

LM Studio provides a CLI called `lms` that can import a local `.gguf` into LM Studio's models folder.

**Import a GGUF file:**

```bash
lms import /path/to/model.gguf
```

**Keep the original file (copy instead of move):**

```bash
lms import /path/to/model.gguf --copy
```

**Keep the model where it is (symlink):**

This is helpful for large models stored on a dedicated drive.

```bash
lms import /path/to/model.gguf --symbolic-link
```

**Skip prompts and choose the target namespace yourself:**

```bash
lms import /path/to/model.gguf --user-repo my-user/my-finetuned-models
```

**Dry-run (shows what will happen):**

```bash
lms import /path/to/model.gguf --dry-run
```

After importing, the model should appear in LM Studio under **My Models**.

#### From Hugging Face

If you pushed your GGUF repo to Hugging Face, you can download it directly from within LM Studio.

**Option A: Use LM Studio's in-app downloader**

1. Open LM Studio
2. Go to the **Discover** tab
3. Search for `hf_username/repo_name` (or paste the Hugging Face URL)
4. Download the quant you want (e.g. `Q4_K_M`)

**Option B: Use the CLI downloader**

```bash
# Download from HF by repo name
lms get hf_username/my_model_gguf

# Pick a quantization with @
lms get hf_username/my_model_gguf@Q4_K_M
```

#### Manual Import (folder structure)

If you don't want to use the CLI, you can place the `.gguf` file into LM Studio's expected model directory structure.

LM Studio expects models to look like this:

```
~/.lmstudio/models/
└── publisher/
    └── model/
        └── model-file.gguf
```

Example:

```
~/.lmstudio/models/
└── my-name/
    └── my-finetune/
        └── my-finetune-Q4_K_M.gguf
```

Then open LM Studio and check **My Models**.

### 3) Load and chat in LM Studio

1. Open LM Studio -> **Chat**
2. Open the **model loader**
3. Select your imported model
4. (Optional) adjust load settings (GPU offload, context length, etc.)
5. Chat normally in the UI

### 4) Serve your fine-tuned model as a local API (OpenAI-compatible)

LM Studio can serve your loaded model behind an OpenAI-compatible API (handy for apps like Open WebUI, custom agents, scripts, etc.).

#### GUI (Developer tab)

1. Load your model in LM Studio
2. Go to the **Developer** tab
3. Start the local server
4. Use the shown base URL (default is typically `http://localhost:1234`)

#### CLI (lms load + lms server start)

**1) List available models:**

```bash
lms ls
```

**2) Load your model (optional flags):**

```bash
lms load <model-identifier> --gpu=auto --context-length=8192
```

Notes:
* `--gpu=1.0` means "try to offload 100% to GPU"
* You can set a stable identifier:

```bash
lms load <model-identifier> --identifier="my-finetuned-model"
```

**3) Start the server:**

```bash
lms server start --port 1234
```

**Quick test: list models**

```bash
curl http://localhost:1234/v1/models
```

**Python example (OpenAI SDK):**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:1234/v1",
    api_key="lm-studio",  # LM Studio may not require a real key; this is a common placeholder
)

resp = client.chat.completions.create(
    model="model-identifier-from-lm-studio",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello! What did I fine-tune you to do?"},
    ],
    temperature=0.7,
)

print(resp.choices[0].message.content)
```

**cURL example (chat completions):**

```bash
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model-identifier-from-lm-studio",
    "messages": [
      {"role": "user", "content": "Say this is a test!"}
    ],
    "temperature": 0.7
  }'
```

> **Debugging tip:** If you're troubleshooting formatting/templates, you can inspect the raw prompt LM Studio sends to the model by running: `lms log stream`

### Troubleshooting

#### Model runs in Unsloth, but LM Studio output is gibberish / repeats

This is almost always a **prompt template / chat template mismatch**.

LM Studio will **auto-detect** the prompt template from the GGUF metadata when possible, but custom or incorrectly-tagged models may need a manual override.

**Fix:**

1. Go to **My Models** -> click the gear next to your model
2. Find **Prompt Template** and set it to match the template you trained with
3. Alternatively, in the Chat sidebar: enable the **Prompt Template** box (you can force it to always show)

#### LM Studio doesn't show my model in "My Models"

* Prefer `lms import /path/to/model.gguf`
* Or confirm the file is in the correct folder structure: `~/.lmstudio/models/publisher/model/model-file.gguf`

#### OOM / slow performance

* Use a smaller quant (ex: `Q4_K_M`)
* Reduce context length
* Adjust GPU offload (LM Studio "Per-model defaults" / load settings)

### More resources

* [LM Studio + Unsloth blog post](https://lmstudio.ai/blog/functiongemma-unsloth) (FunctionGemma walkthrough)
* LM Studio [Import Models docs](https://lmstudio.ai/docs/app/advanced/import-model)
* LM Studio [Prompt Template docs](https://lmstudio.ai/docs/app/advanced)
* LM Studio [OpenAI-compatible API docs](https://lmstudio.ai/docs/developer/openai-compat)
