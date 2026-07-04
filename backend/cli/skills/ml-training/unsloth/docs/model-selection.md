# What Model Should I Use for Fine-tuning?

## Llama, Qwen, Mistral, Phi or?

When preparing for fine-tuning, one of the first decisions you'll face is selecting the right model. Here's a step-by-step guide to help you choose:

{% stepper %}
{% step %}
**Choose a model that aligns with your usecase**

* E.g. For image-based training, select a vision model such as *Llama 3.2 Vision*. For code datasets, opt for a specialized model like *Qwen Coder 2.5*.
* **Licensing and Requirements**: Different models may have specific licensing terms and [system requirements](https://unsloth.ai/docs/fine-tuning-for-beginners/unsloth-requirements#system-requirements). Be sure to review these carefully to avoid compatibility issues.
  {% endstep %}

{% step %}
**Assess your storage, compute capacity and dataset**

* Use our [VRAM guideline](https://unsloth.ai/docs/fine-tuning-for-beginners/unsloth-requirements#approximate-vram-requirements-based-on-model-parameters) to determine the VRAM requirements for the model you�re considering.
* Your dataset will reflect the type of model you will use and amount of time it will take to train
  {% endstep %}

{% step %}
**Select a Model and Parameters**

* We recommend using the latest model for the best performance and capabilities. For instance, as of January 2025, the leading 70B model is *Llama 3.3*.
* You can stay up to date by exploring our [model catalog](https://unsloth.ai/docs/get-started/unsloth-model-catalog) to find the newest and relevant options.
  {% endstep %}

{% step %}
**Choose Between Base and Instruct Models**

Further details below:
{% endstep %}
{% endstepper %}

## Instruct or Base Model?

When preparing for fine-tuning, one of the first decisions you'll face is whether to use an instruct model or a base model.

### Instruct Models

Instruct models are pre-trained with built-in instructions, making them ready to use without any fine-tuning. These models, including GGUFs and others commonly available, are optimized for direct usage and respond effectively to prompts right out of the box. Instruct models work with conversational chat templates like ChatML or ShareGPT.

### **Base Models**

Base models, on the other hand, are the original pre-trained versions without instruction fine-tuning. These are specifically designed for customization through fine-tuning, allowing you to adapt them to your unique needs. Base models are compatible with instruction-style templates like [Alpaca or Vicuna](https://unsloth.ai/docs/basics/chat-templates), but they generally do not support conversational chat templates out of the box.

### Should I Choose Instruct or Base?

The decision often depends on the quantity, quality, and type of your data:

* **1,000+ Rows of Data**: If you have a large dataset with over 1,000 rows, it's generally best to fine-tune the base model.
* **300–1,000 Rows of High-Quality Data**: With a medium-sized, high-quality dataset, fine-tuning the base or instruct model are both viable options.
* **Less than 300 Rows**: For smaller datasets, the instrucmodel is typically the better choice. Fine-tuning the instruct model enables it to align with specific needs while preserving its built-in instructional capabilities. This ensures it can follow general instructions without additional input unless you intend to significantly alter its functionality.
* For information how how big your dataset should be, [see here](https://unsloth.ai/docs/get-started/datasets-guide#how-big-should-my-dataset-be)

## Fine-tuning models with Unsloth

You can change the model name to whichever model you like by matching it with model's name on Hugging Face e.g. 'unsloth/llama-3.1-8b-unsloth-bnb-4bit'.

We recommend starting with **Instruct models**, as they allow direct fine-tuning using conversational chat templates (ChatML, ShareGPT etc.) and require less data compared to **Base models** (which uses Alpaca, Vicuna etc). Learn more about the differences between [instruct and base models here](#instruct-or-base-model).

* Model names ending in **`unsloth-bnb-4bit`** indicate they are [**Unsloth dynamic 4-bit**](https://unsloth.ai/blog/dynamic-4bit) **quants**. These models consume slightly more VRAM than standard BitsAndBytes 4-bit models but offer significantly higher accuracy.
* If a model name ends with just **`bnb-4bit`**, without "unsloth", it refers to a standard BitsAndBytes 4-bit quantization.
* Models with **no suffix** are in their original **16-bit or 8-bit formats**. While they are the original models from the official model creators, we sometimes include important fixes - such as chat template or tokenizer fixes. So it's recommended to use our versions when available.

### Experimentation is Key

{% hint style="info" %}
We recommend experimenting with both models when possible. Fine-tune each one and evaluate the outputs to see which aligns better with your goals.