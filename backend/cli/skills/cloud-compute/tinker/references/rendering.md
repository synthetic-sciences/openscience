# Rendering to Tokens

Renderers convert messages ↔ tokens for training and inference.

## Getting a Renderer

```python
from tinker_cookbook.model_info import get_recommended_renderer_name
from tinker_cookbook.renderers import get_renderer
from tinker_cookbook.tokenizer_utils import get_tokenizer

model_name = "meta-llama/Llama-3.1-8B"
renderer_name = get_recommended_renderer_name(model_name)

tokenizer = get_tokenizer(model_name)
renderer = get_renderer(name=renderer_name, tokenizer=tokenizer)
```

**Renderer names:** `qwen3`, `qwen3_disable_thinking`, `qwen3_instruct`, `qwen3_vl`, `qwen3_vl_instruct`, `llama3`, `deepseekv3`, `deepseekv3_thinking`, `kimi_k2`, `gpt_oss_no_sysprompt`, `gpt_oss_low_reasoning`, `gpt_oss_medium_reasoning`, `gpt_oss_high_reasoning`, `role_colon`

## HuggingFace Compatibility

Default renderers produce **identical tokens** to HuggingFace's `apply_chat_template`:

| Renderer | HF Equivalent |
|----------|---------------|
| `qwen3` | `apply_chat_template(..., enable_thinking=True)` |
| `qwen3_disable_thinking` | `apply_chat_template(..., enable_thinking=False)` |
| `llama3` | `apply_chat_template(...)` * |
| `deepseekv3` | `apply_chat_template(...)` |

\* Llama3 omits "Cutting Knowledge Date..." preamble

## Core Methods

### build_supervised_example

For training with loss weights:

```python
from tinker_cookbook.renderers import TrainOnWhat

messages = [
    {"role": "user", "content": "What is 2+2?"},
    {"role": "assistant", "content": "4"},
]

model_input, weights = renderer.build_supervised_example(
    messages,
    train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
)
# model_input: ModelInput (token sequence)
# weights: per-token weights (0.0 = prompt, 1.0 = train)
```

**Default behavior:** If `train_on_what` is omitted, defaults to `LAST_ASSISTANT_MESSAGE`. Always specify explicitly to avoid surprises.

```python
# WRONG — silently trains only on last assistant message
model_input, weights = renderer.build_supervised_example(messages)

# RIGHT — explicitly train on all assistant messages
model_input, weights = renderer.build_supervised_example(
    messages, train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES
)
```

### build_generation_prompt

For inference:

```python
messages = [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "What is 2+2?"},
]

prompt = renderer.build_generation_prompt(messages)
# Returns ModelInput ready for sampling
```

### get_stop_sequences

```python
stop_sequences = renderer.get_stop_sequences()

sampling_params = SamplingParams(
    max_tokens=100,
    stop=stop_sequences,
)
```

### parse_response

```python
output_tokens = result.sequences[0].tokens
message, success = renderer.parse_response(output_tokens)
# {"role": "assistant", "content": "..."}
```

## TrainOnWhat Enum

```python
from tinker_cookbook.renderers import TrainOnWhat

# Train on ALL assistant messages
TrainOnWhat.ALL_ASSISTANT_MESSAGES

# Train only on LAST assistant message
TrainOnWhat.LAST_ASSISTANT_MESSAGE
```

**ALL_ASSISTANT_MESSAGES:**
```python
messages = [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi!"},  # weight=1
    {"role": "user", "content": "How are you?"},
    {"role": "assistant", "content": "Good!"},  # weight=1
]
```

**LAST_ASSISTANT_MESSAGE:**
```python
messages = [
    {"role": "user", "content": "Let me think..."},
    {"role": "assistant", "content": "..."},  # weight=0
    {"role": "user", "content": "Answer?"},
    {"role": "assistant", "content": "42"},  # weight=1
]
```

Use `LAST` for classification, reward modeling, preference learning.

## Message Formats

### Text-Only

```python
messages = [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi!"},
]
```

### Vision (Multi-Modal)

```python
messages = [
    {
        "role": "user",
        "content": [
            {"type": "image", "image": image_bytes},
            {"type": "text", "text": "What's in this image?"},
        ]
    },
    {"role": "assistant", "content": "A cat."}
]
```

## Using with conversation_to_datum

```python
from tinker_cookbook.supervised.data import conversation_to_datum

datum = conversation_to_datum(
    messages=messages,
    renderer=renderer,
    max_length=2048,
    train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
)
# Returns Datum ready for training
```

## Format Examples

### ChatML

```
<|im_start|>system
You are helpful.<|im_end|>
<|im_start|>user
What is 2+2?<|im_end|>
<|im_start|>assistant
4<|im_end|>
```

### Llama 3

```
<|begin_of_text|><|start_header_id|>system<|end_header_id|>

You are helpful.<|eot_id|><|start_header_id|>user<|end_header_id|>

What is 2+2?<|eot_id|><|start_header_id|>assistant<|end_header_id|>

4<|eot_id|>
```

**Important:** Don't construct formats manually—use renderers!

## Vision Renderers

For VLMs (Qwen3-VL):

```python
from tinker_cookbook.image_processing_utils import get_image_processor

model_name = "Qwen/Qwen3-VL-235B-A22B-Instruct"
tokenizer = get_tokenizer(model_name)
image_processor = get_image_processor(model_name)

renderer = renderers.Qwen3VLInstructRenderer(tokenizer, image_processor)

messages = [
    {
        "role": "user",
        "content": [
            {"type": "image", "image": "https://example.com/image.png"},
            {"type": "text", "text": "What is this?"},
        ]
    }
]

prompt = renderer.build_generation_prompt(messages)
```

## In Dataset Builders

`ChatDatasetBuilder` creates renderer automatically:

```python
@chz.chz
class MyDatasetBuilder(ChatDatasetBuilder):
    common_config: ChatDatasetBuilderCommonConfig

    def __call__(self):
        def map_fn(row):
            return conversation_to_datum(
                messages=messages,
                renderer=self.renderer,  # Auto-created from common_config
                max_length=self.common_config.max_length,
                train_on_what=self.common_config.train_on_what,
            )
        # ...
```

## Troubleshooting

**Wrong format:** Use `get_recommended_renderer_name(model_name)`

**High loss:** Check weights (0.0 for prompts, 1.0 for completions)

**Generation doesn't stop:** Use `renderer.get_stop_sequences()` in SamplingParams
