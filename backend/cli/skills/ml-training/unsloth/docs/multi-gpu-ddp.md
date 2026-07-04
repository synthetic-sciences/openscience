# Multi-GPU Fine-tuning with Distributed Data Parallel (DDP)

Let's assume we have multiple GPUs, and we want to fine-tune a model using all of them! To do so, the most straightforward strategy is to use Distributed Data Parallel (DDP), which creates one copy of the model on each GPU device, feeding each copy distinct samples from the dataset during training and aggregating their contributions to weight updates per optimizer step.

Why would we want to do this? Well, as we add more GPUs into the training process, we scale the number of samples our models train on per step, making each gradient update more stable and increasing our training throughput dramatically with each added GPU.

Here's a step-by-step guide on how to do this using Unsloth's command-line interface (CLI)!

**Note:** Unsloth DDP will work with any of your training scripts, not just via our CLI! More details below.

## Install Unsloth from source

We'll clone Unsloth from GitHub and install it. Please consider using a virtual environment; we like to use `uv venv --python 3.12 && source .venv/bin/activate`, but any virtual environment creation tooling will do.

```bash
git clone https://github.com/unslothai/unsloth.git
cd unsloth
pip install .
```

## Choose target model and dataset for finetuning

In this demo, we will fine-tune [Qwen/Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B) on the [yahma/alpaca-cleaned](https://huggingface.co/datasets/yahma/alpaca-cleaned) chat dataset. This is a Supervised Fine-Tuning (SFT) workload that is commonly used when attempting to adapt a base model to a desired conversational style, or improve the model's performance on a downstream task.

## Use the Unsloth CLI!

The CLI provides options for model, LoRA, and training configuration:

```bash
$ python unsloth-cli.py --help
usage: unsloth-cli.py [-h] [--model_name MODEL_NAME] [--max_seq_length MAX_SEQ_LENGTH]
                      [--dtype DTYPE] [--load_in_4bit] [--dataset DATASET]
                      [--r R] [--lora_alpha LORA_ALPHA] [--lora_dropout LORA_DROPOUT]
                      [--bias BIAS] [--use_gradient_checkpointing USE_GRADIENT_CHECKPOINTING]
                      ...

Model Options:
  --model_name MODEL_NAME         Model name to load
  --max_seq_length MAX_SEQ_LENGTH Maximum sequence length (default 2048)

LoRA Options:
  --r R                           Rank for LoRA (default 16, common: 8, 16, 32, 64, 128)
  --lora_alpha LORA_ALPHA         LoRA alpha parameter (default 16)

Training Options:
  --per_device_train_batch_size   Batch size per device (default 2)
  --gradient_accumulation_steps   Gradient accumulation steps (default 4)
```

For multi-GPU training (DDP), we use the [torchrun](https://docs.pytorch.org/docs/stable/elastic/run.html) launcher, which allows you to spin up multiple distributed training processes in single-node or multi-node settings.

### Starting the training run

```bash
# required:
#   --model_name
#   --dataset
# optional; experiment with these:
#   --learning_rate, --max_seq_length, --per_device_train_batch_size, --gradient_accumulation_steps, --max_steps
# to save the model at the end of training:
#   --save_model

torchrun --nproc_per_node=2 unsloth-cli.py \
  --model_name=Qwen/Qwen3-8B \
  --dataset=yahma/alpaca-cleaned \
  --learning_rate=2e-5 \
  --max_seq_length=2048 \
  --per_device_train_batch_size=1 \
  --gradient_accumulation_steps=4 \
  --max_steps=1000 \
  --save_model
```

If you have more GPUs, you may set `--nproc_per_node` accordingly to utilize them.

**Note:** You can use the `torchrun` launcher with any of your Unsloth training scripts, including the [scripts](https://github.com/unslothai/notebooks/tree/main/python_scripts) converted from our free Colab notebooks, and DDP will be auto-enabled when training with >1 GPU!

## Training metrics

We ran a few short rank-16 LoRA fine-tunes on [unsloth/Llama-3.2-1B-Instruct](https://huggingface.co/unsloth/Llama-3.2-1B-Instruct) on the [yahma/alpaca-cleaned](https://huggingface.co/datasets/yahma/alpaca-cleaned) dataset to demonstrate the improved training throughput when using DDP training with multiple GPUs.

### Training Loss

The loss curves match in scale and trend between single GPU (pink) and multi-GPU DDP (blue), but are a bit different since the multi-GPU training processes twice as much training data per step. This results in a slightly different training curve with less variability on a step-by-step basis.

### Training Progress

The multi-GPU DDP training progresses through an epoch of the training data in half as many steps as single GPU training. This is because each GPU can process a distinct batch (of size `per_device_train_batch_size`) per step. However, the per-step timing for DDP training is slightly slower due to distributed communication for the model weight updates. As you increase the number of GPUs, the training throughput will continue to increase ~linearly (but with a small, but increasing penalty for the distributed comms).

These same loss and training epoch progress behaviors hold for QLoRA fine-tunes, in which we loaded the base models in 4-bit precision in order to save additional GPU memory. This is particularly useful for training large models on limited amounts of GPU VRAM.
