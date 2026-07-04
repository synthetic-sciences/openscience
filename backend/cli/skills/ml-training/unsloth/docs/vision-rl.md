# Vision Reinforcement Learning (VLM RL)

Unsloth now supports vision/multimodal RL with [Qwen3-VL](https://unsloth.ai/docs/models/qwen3-vl-how-to-run-and-fine-tune), [Gemma 3](https://unsloth.ai/docs/models/gemma-3-how-to-run-and-fine-tune) and more. Due to Unsloth's unique [weight sharing](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide/..#what-unsloth-offers-for-rl) and custom kernels, Unsloth makes VLM RL **1.5–2× faster,** uses **90% less VRAM**, and enables **15× longer context** lengths than FA2 setups, with no accuracy loss. This update also introduces Qwen's [GSPO](#gspo-rl) algorithm.

Unsloth can train Qwen3-VL-8B with GSPO/GRPO on a free Colab T4 GPU. Other VLMs work too, but may need larger GPUs. Gemma requires newer GPUs than T4 because vLLM [restricts to Bfloat16](https://unsloth.ai/docs/models/gemma-3-how-to-run-and-fine-tune#unsloth-fine-tuning-fixes), thus we recommend NVIDIA L4 on Colab. Our notebooks solve numerical math problems involving images and diagram* **Qwen-3 VL-8B** (vLLM inference)**:** [Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen3_VL_\(8B\)-Vision-GRPO.ipynb)
* **Qwen-2.5 VL-7B** (vLLM inference)**:** [Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen2_5_7B_VL_GRPO.ipynb) •[ Kaggle](https://www.kaggle.com/notebooks/welcome?src=https://github.com/unslothai/notebooks/blob/main/nb/Kaggle-Qwen2_5_7B_VL_GRPO.ipynb\&accelerator=nvidiaTeslaT4)
* **Gemma-3-4B** (Unsloth inference): [Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Gemma3_\(4B\)-Vision-GRPO.ipynb)

We have also added vLLM VLM integration into Unsloth natively, so all you have to do to use vLLM inference is enable the `fast_inference=True` flag when initializing the model. Special thanks to [Sinoué GAD](https://github.com/unslothai/unsloth/pull/2752) for providing the [first notebook](https://github.com/GAD-cell/vlm-grpo/blob/main/examples/VLM_GRPO_basic_example.ipynb) that made igrating VLM RL easier!

This VLM support also integrates our latest update for even more memory efficient + faster RL including our [Standby feature](https://unsloth.ai/docs/get-started/memory-efficient-rl#unsloth-standby), which uniquely limits speed degradation compared to other implementations.

{% hint style="info" %}
You can only use `fast_inference` for VLMs supported by vLLM. Some models, like Llama 3.2 Vision thus only can run without vLLM, but they still work in Unsloth.
{% endhint %}

```python
os.environ['UNSLOTH_VLLM_STANDBY'] = '1' # To enable memory efficient GRPO with vLLM
model, tokenizer = FastVisionModel.from_pretrained(
    model_name = "Qwen/Qwen2.5-VL-7B-Instruct",
    max_seq_length = 16384, #Must be this large to fit image in context
    load_in_4bit = True, # False for LoRA 16bit
    fast_inference = True, # Enable vLLM fast inference
    gpu_memory_utilization = 0.8, # Reduce if out of memory
)
```

It is also important to note, that vLLM does not support LoRA for vision/encoder layers, thus set `finetune_vision_layers = False` when loading a LoRA adapter.\
However you CAN train the vision layers as well if you use inference via transformers/Unsloth.

```python
# Add LoRA adapter to the model for parameter efficient fine tuning
model = FastVisionModel.get_peft_model(
    model,

    finetune_vision_layers     = False,# fast_inference doesn't support finetune_vision_layers yet :(
    finetune_language_layers   = True, # False if not finetuning language layers
    finetune_attention_modules = True, # False if not finetuning attention layers
    finetune_mlp_modules       = True, # False if not finetuning MLP layers

    r = lora_rank, # Choose any number > 0 ! Suggested 8, 16, 32, 64, 128
    lora_alpha = lora_rank*2, # *2 speeds up training
    use_gradient_checkpointing = "unsloth", # Reduces memory usage
    random_state = 3407,
)
```

## :butterfly:Qwen 2.5 VL Vision RL Issues and Quirks

During RL for Qwen 2.5 VL, you might see the following inference output:

{% code overflow="wrap" %}

```
 addCriterion
 <tool_call>\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n\n addCriterion\n\n 自动生成\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n addCriterion\n\n\n addCriterion\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n
```

{% endcode %}

This was [reported](https://github.com/QwenLM/Qwen2.5-VL/issues/759) as well in Qwen2.5-VL-7B-Instruct output unexpected results "addCriterion". In fact we see this as well! We tried both non Unsloth, bfloat16 and float16 machines and other things, but it appears still. For example item 165 ie `train_dataset[165]` from the [AI4Math/MathVista](https://huggingface.co/datasets/AI4Math/MathVista) dataset is below:

{% code overflow="wrap" %}

```
Figure is an overhead view of the path taken by a race car d his car collides with the racetrack wall. Just before the collision, he is traveling at speed $v_i=70 \mathrm{~m} / \mathrm{s}$ along a straight line at $30^{\circ}$ from the wall. Just after the collision, he is traveling at speed $v_f=50 \mathrm{~m} / \mathrm{s}$ along a straight line at $10^{\circ}$ from the wall. His mass $m$ is $80 \mathrm{~kg}$. The collision lasts for $14 \mathrm{~ms}$. What is the magnitude of the average force on the driver during the collision?
```

{% endcode %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-61a659529171fcc10ed6398a15912b21d6b1a076%2FUntitled.png?alt=media" alt="" width="128"><figcaption></figcaption></figure>

And then we get the above gibberish output. One could add a reward function to penalize the addition of addCriterion, or penalize gibberish outputs. However, the other approach is to train it for longer. For example only after 60 steps ish do we see the model actually learning via RL:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-5f34f66f0ac6508fd28343b16592c59b889ec5ca%2Fimage.webp?alt=media" alt=""><figcaption></figcaption></figure>

{% hint style="success" %}
Forcing `<|assistant|>` during generation will reduce the occurrences of these gibberish results as expected since this is an Instruct model, however it's still best to add a reward function to penalize bad generations, as described in the next section.
{% endhint %}

## :medal:Reward Functions to reduce gibberish

To penalize `addCriterion` and gibberish outputs, we edited the reward function to penalize too much of `addCriterion` and newlines.

```python
def formatting_reward_func(completions,**kwargs):
    import re
    thinking_pattern = f'{REASONING_START}(.*?){REASONING_END}'
    answer_pattern = f'{SOLUTION_START}(.*?){SOLUTION_END}'

    scores = []
    for completion in completions:
        score = 0
        thinking_matches = re.findall(thinking_pattern, completion, re.DOTALL)
        answer_matches = re.findall(answer_pattern, completion, re.DOTALL)
        if len(thinking_matches) == 1:
            score += 1.0
        if len(answer_matches) == 1:
            score += 1.0

        # Fix up addCriterion issues
        # See https://docs.unsloth.ai/new/vision-reinforcement-learning-vlm-rl#qwen-2.5-vl-vision-rl-issues-and-quirks
        # Penalize on excessive addCriterion and newlines
        if len(completion) != 0:
            removal = completion.replace("addCriterion", "").replace("\n", "")
            if (len(completion)-len(removal))/len(completion) >= 0.5:
                score -= 2.0

        scores.append(score)
    return scores
```

## :checkered\_flag:GSPO Reinforcement Learning

This update in addition adds GSPO ([Group Sequence Policy Optimization](https://arxiv.org/abs/2507.18071)) which is a variant of GRPO made by the Qwen team at Alibaba. They noticed that GRPO implicitly results in importance weights for each token, even though explicitly advantages do not scale or change with each token.

This lead to the creation of GSPO, which now assigns the importance on the sequence likelihood rather than the individual token likelihoods of the tokens. The difference between these two algorithms can be seen below, both from the GSPO paper from Qwen and Alibaba:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-45d743dd5dcd590626777ce09cfab61808aa8c24%2Fimage.png?alt=media" alt="" width="563"><figcaption><p>GRPO Algorithm, Source: <a href="https://arxiv.org/abs/2507.18071">Qwen</a></p></figcaption></figure>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-ee755850cbe17482ce240dde227d55c62e9a3e64%2Fimage.png?alt=media" alt="" width="563"><figcaption><p>GSPO algorithm, Source: <a href="https://arxiv.org/abs/2507.18071">Qwen</a></p></figcaption></figure>

In Equation 1, it can be seen that the advantages scale each of the rows into the token logprobs before that tensor is sumed. Essentially, each token is given the same scaling even though that scaling was given to the entire sequence rather than each individual token. A simple diagram of this can be seen below:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-b3c944808a15dde0a7ff45782f9f074993304bf1%2FCopy%20of%20GSPO%20diagram%20(1).jpg?alt=media" alt="" width="286"><figcaption><p>GRPO Logprob Ratio row wise scaled with advantages</p></figcaption></figure>

Equation 2 shows that the logprob ratios for each sequence is summed and exponentiated after the Logprob ratios are computed, and only the resulting now sequence ratios get row wise multiplied by the advantages.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-62fc5b50921e79cce155d2794201c9b96faf941e%2FGSPO%20diagram%20(1).jpg?alt=media" alt="" width="313"><figcaption><p>GSPO Sequence Ratio row wise scaled with advantages</p></figcaption></figure>

Enabling GSPO is simple, all you need to do is set the `importance_sampling_level = "sequence"` flag in the GRPO config.

```python
training_args = GRPOConfig(
    output_dir = "vlm-grpo-unsloth",
    per_device_train_batch_size = 8,
    gradient_accumulation_steps = 4,
    learning_rate = 5e-6,
    adam_beta1 = 0.9,
    adam_beta2 = 0.99,
    weight_decay = 0.1,
    warmup_ratio = 0.1,
    lr_scheduler_type = "cosine",
    optim = "adamw_8bit",
    # beta = 0.00,
    epsilon = 3e-4,
    epsilon_high = 4e-4,
    num_generations = 8,    
    max_prompt_length = 1024,
    max_completion_length = 1024,
    log_completions = False,
    max_grad_norm = 0.1,
    temperature = 0.9,
    # report_to = "none", # Set to "wandb" if you want to log to Weights & Biases
    num_train_epochs = 2, # For a quick test run, increase for full training
    report_to = "none"
    
    # GSPO is below:
    importance_sampling_level = "sequence",
    
    # Dr GRPO / GAPO etc
    loss_type = "dr_grpo",
)
```

Overall, Unsloth now with VLM vLLM fast inference enables for both 90% reduced memory usage but also 1.5-2x faster speed with GRPO and GSPO!

If you'd like to read more about reinforcement learning, check out out RL guide:

[](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide "mention")
