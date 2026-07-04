# Chat Templates

In our GitHub, we have a list of every chat template Unsloth uses including for Llama, Mistral, Phi-4 etc: [github.com/unslothai/unsloth/blob/main/unsloth/chat_templates.py](https://github.com/unslothai/unsloth/blob/main/unsloth/chat_templates.py)

## Colab chat template notebooks

* [Conversational](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.2_(1B_and_3B)-Conversational.ipynb)
* [ChatML](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3_(8B)-Ollama.ipynb)
* [Ollama](https://colab.research.google.com/drive/1WZDi7APtQ9VsvOrQSSC5DDtxq159j8iZ?usp=sharing)
* [Text Classification](https://github.com/timothelaborie/text_classification_scripts/blob/main/unsloth_classification.ipynb) by Timotheeee
* [Multiple Datasets](https://colab.research.google.com/drive/1njCCbE1YVal9xC83hjdo2hiGItpY_D6t?usp=sharing) by Flail

## Adding new tokens

Unsloth has a function called `add_new_tokens` which allows you to add new tokens to your finetune:

```python
model, tokenizer = FastLanguageModel.from_pretrained(...)
from unsloth import add_new_tokens
add_new_tokens(model, tokenizer, new_tokens = ["<CHARACTER_1>", "<THINKING>", "<SCRATCH_PAD>"])
model = FastLanguageModel.get_peft_model(...)
```

> Note: you MUST always call `add_new_tokens` before `FastLanguageModel.get_peft_model`!

## Multi turn conversations

The Alpaca dataset is single turn, but ChatGPT-style interactions are multi-turn. We introduced the `conversation_extension` parameter, which selects some random rows in your single turn dataset and merges them into 1 conversation. For example, if you set it to 3, we randomly select 3 rows and merge them into 1.

Set `output_column_name` to the prediction / output column. For Alpaca, it would be the output column.

Then use the `standardize_sharegpt` function to make the dataset in a correct format for finetuning.

## Customizable Chat Templates

We allow an optional `{INPUT}` field for the instruction, an `{OUTPUT}` field for the model's output, and an optional `{SYSTEM}` field for system prompts. Examples:

* **ChatML format** (used in OpenAI models)
* **Llama-3 template** (only works with instruct version)
* **Custom templates** for tasks like Titanic prediction

## Applying Chat Templates with Unsloth

Four simple steps:

### 1. Check supported templates

```python
from unsloth.chat_templates import CHAT_TEMPLATES
print(list(CHAT_TEMPLATES.keys()))
# ['unsloth', 'zephyr', 'chatml', 'mistral', 'llama', 'vicuna', 'alpaca',
#  'gemma', 'gemma2', 'llama-3', 'phi-3', 'phi-4', 'qwen-2.5', 'gemma-3', ...]
```

### 2. Apply the template

```python
from unsloth.chat_templates import get_chat_template
tokenizer = get_chat_template(
    tokenizer,
    chat_template = "gemma-3",  # change this to the right template name
)
```

### 3. Define formatting function

```python
def formatting_prompts_func(examples):
    convos = examples["conversations"]
    texts = [tokenizer.apply_chat_template(convo, tokenize=False, add_generation_prompt=False) for convo in convos]
    return {"text": texts}
```

### 4. Load and format dataset

```python
from datasets import load_dataset
dataset = load_dataset("repo_name/dataset_name", split="train")
dataset = dataset.map(formatting_prompts_func, batched=True)
```

If your dataset uses ShareGPT format with "from"/"value" keys:

```python
from datasets import load_dataset
dataset = load_dataset("mlabonne/FineTome-100k", split="train")

from unsloth.chat_templates import standardize_sharegpt
dataset = standardize_sharegpt(dataset)
dataset = dataset.map(formatting_prompts_func, batched=True)
```

## Using get_chat_template with ShareGPT data

```python
from unsloth.chat_templates import get_chat_template

tokenizer = get_chat_template(
    tokenizer,
    chat_template = "chatml",
    mapping = {"role": "from", "content": "value", "user": "human", "assistant": "gpt"},
    map_eos_token = True,  # Maps <|im_end|> to </s> instead
)

def formatting_prompts_func(examples):
    convos = examples["conversations"]
    texts = [tokenizer.apply_chat_template(convo, tokenize=False, add_generation_prompt=False) for convo in convos]
    return {"text": texts}

from datasets import load_dataset
dataset = load_dataset("philschmid/guanaco-sharegpt-style", split="train")
dataset = dataset.map(formatting_prompts_func, batched=True)
```

## Custom Chat Templates

You can make custom chat templates by passing a tuple of `(custom_template, eos_token)`:

```python
unsloth_template = \
    "{{ bos_token }}" \
    "{{ 'You are a helpful assistant to the user\\n' }}" \
    "{% for message in messages %}" \
        "{% if message['role'] == 'user' %}" \
            "{{ '>>> User: ' + message['content'] + '\\n' }}" \
        "{% elif message['role'] == 'assistant' %}" \
            "{{ '>>> Assistant: ' + message['content'] + eos_token + '\\n' }}" \
        "{% endif %}" \
    "{% endfor %}" \
    "{% if add_generation_prompt %}" \
        "{{ '>>> Assistant: ' }}" \
    "{% endif %}"
unsloth_eos_token = "eos_token"

tokenizer = get_chat_template(
    tokenizer,
    chat_template = (unsloth_template, unsloth_eos_token),
    mapping = {"role": "from", "content": "value", "user": "human", "assistant": "gpt"},
    map_eos_token = True,
)
```
