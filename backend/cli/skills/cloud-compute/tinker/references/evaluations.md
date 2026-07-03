# Evaluations

## Inline Evals (During Training)

Add evaluations that run periodically during training.

### Supervised Fine-Tuning

```python
blueprint = chz.Blueprint(train.Config).apply({
    "model_name": model_name,
    "dataset_builder": dataset_builder,
    "evaluator_builders": [my_evaluator],           # Runs every eval_every steps
    "infrequent_evaluator_builders": [heavy_eval],   # Runs every infrequent_eval_every steps
    "eval_every": 8,
    "infrequent_eval_every": 50,
})
```

### RL Training

```python
blueprint = chz.Blueprint(train.Config).apply({
    "model_name": model_name,
    "dataset_builder": builder,
    "evaluator_builders": [sampling_eval],  # SamplingClientEvaluator instances
    "eval_every": 5,
})
```

## Offline Evals with Inspect AI

Run standard evaluations on checkpoints using the Inspect AI library:

```bash
MODEL_PATH=tinker://YOUR_MODEL_PATH_HERE
python -m tinker_cookbook.eval.run_inspect_evals \
    model_path=$MODEL_PATH \
    model_name=MODEL_NAME \
    tasks=inspect_evals/ifeval,inspect_evals/mmlu_0_shot \
    renderer_name=RENDERER_NAME
```

### Creating Custom Inspect AI Tasks

```python
import tinker
from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.model import GenerateConfig as InspectAIGenerateConfig
from inspect_ai.model import Model as InspectAIModel
from inspect_ai.scorer import model_graded_qa
from inspect_ai.solver import generate
from tinker_cookbook.eval.inspect_utils import InspectAPIFromTinkerSampling

QA_DATASET = MemoryDataset(
    name="qa_dataset",
    samples=[
        Sample(input="What is the capital of France?", target="Paris"),
        Sample(input="What is the capital of Italy?", target="Rome"),
    ],
)

service_client = tinker.ServiceClient()
sampling_client = service_client.create_sampling_client(
    base_model="meta-llama/Llama-3.1-8B-Instruct"
)

api = InspectAPIFromTinkerSampling(
    renderer_name="llama3",
    model_name="meta-llama/Llama-3.1-8B-Instruct",
    sampling_client=sampling_client,
    verbose=False,
)

GRADER_MODEL = InspectAIModel(api=api, config=InspectAIGenerateConfig())

@task
def example_lm_as_judge() -> Task:
    return Task(
        name="llm_as_judge",
        dataset=QA_DATASET,
        solver=generate(),
        scorer=model_graded_qa(
            instructions="Grade strictly. Respond 'GRADE: C' if correct or 'GRADE: I' otherwise.",
            partial_credit=False,
            model=GRADER_MODEL,
        ),
    )
```

Inspect also supports any OpenAI-compatible API (e.g., openrouter) as the grader model.

## Custom SamplingClientEvaluator

Lower-level abstraction with fine-grained control:

```python
from typing import Any, Callable
import tinker
from tinker import types
from tinker_cookbook import renderers
from tinker_cookbook.evaluators import SamplingClientEvaluator
from tinker_cookbook.tokenizer_utils import get_tokenizer

class CustomEvaluator(SamplingClientEvaluator):
    def __init__(
        self,
        dataset: Any,
        grader_fn: Callable[[str, str], bool],
        model_name: str,
        renderer_name: str,
    ):
        self.dataset = dataset
        self.grader_fn = grader_fn
        tokenizer = get_tokenizer(model_name)
        self.renderer = renderers.get_renderer(name=renderer_name, tokenizer=tokenizer)

    async def __call__(self, sampling_client: tinker.SamplingClient) -> dict[str, float]:
        sampling_params = types.SamplingParams(
            max_tokens=100,
            temperature=0.7,
            top_p=1.0,
            stop=self.renderer.get_stop_sequences(),
        )

        num_correct = 0
        for datum in self.dataset:
            model_input = self.renderer.build_generation_prompt(
                [renderers.Message(role="user", content=datum["input"])]
            )
            r = await sampling_client.sample_async(
                prompt=model_input, num_samples=1, sampling_params=sampling_params
            )
            tokens = r.sequences[0].tokens
            response = self.renderer.parse_response(tokens)[0]
            if self.grader_fn(response["content"], datum["output"]):
                num_correct += 1

        return {"accuracy": num_correct / len(self.dataset)}
```

### Usage

```python
import asyncio

QA_DATASET = [
    {"input": "What is the capital of France?", "output": "Paris"},
    {"input": "What is the capital of Germany?", "output": "Berlin"},
]

def grader_fn(response: str, target: str) -> bool:
    return target.lower() in response.lower()

evaluator = CustomEvaluator(
    dataset=QA_DATASET,
    grader_fn=grader_fn,
    renderer_name="llama3",
    model_name="meta-llama/Llama-3.1-8B-Instruct",
)

service_client = tinker.ServiceClient()
sampling_client = service_client.create_sampling_client(
    base_model="meta-llama/Llama-3.1-8B-Instruct"
)

async def main():
    result = await evaluator(sampling_client)
    print(result)  # {"accuracy": 1.0}

asyncio.run(main())
```

## Evaluation Strategy

| Stage | Method | When |
|-------|--------|------|
| During SFT | `evaluator_builders` | Every N training steps |
| During RL | `evaluator_builders` (SamplingClientEvaluator) | Every N iterations |
| After training | `run_inspect_evals` CLI | On final checkpoint |
| Custom tasks | Custom `SamplingClientEvaluator` | Any time with sampling client |
| LLM-as-judge | Inspect AI with `model_graded_qa` | When automated grading needed |
