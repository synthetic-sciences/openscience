 # Datasets Guide

## What is a Dataset?

For LLMs, datasets are collections of data that can be used to train our models. In order to be useful for training, text data needs to be in a format that can be tokenized. You'll also learn how to [use datasets inside of Unsloth](#applying-chat-templates-with-unsloth).

One of the key parts of creating a dataset is your [chat template](https://unsloth.ai/docs/basics/chat-templates) and how you are going to design it. Tokenization is also important as it breaks text into tokens, which can be words, sub-words, or characters so LLMs can process it effectively. These tokens are then turned into embeddings and are adjusted to help the model understand the meaning and context.

### Data Format

To enable the process of tokenization, datasets need to be in a format that can be read by a tokenizer.

<table data-full-width="false"><thead><tr><th>Format</th><th>Description</th><th>Training Type</th></tr></thead><tbody><tr><td>Raw Corpus</td><td>Raw text from a source such as a website, book, or article.</td><td>Continued Pretraining (CPT)</td></tr><tr><td>Instruct</td><td>Instructions for the model to follow and an example of the output to aim for.</td><td>Supervised fine-tuning (SFT)</td></tr><tr><td>Conversation</td><td>Multiple-turn conversation between a user and an AI assistant.</td><td>Supervised fine-tuning (SFT)</td></tr><tr><td>RLHF</td><td>Conversation between a user and an AI assistant, with the assistant's responses being ranked by a script, another model or human evaluator.</td><td>Reinforcement Learning (RL)</td></tr></tbody></table>

{% hint style="info" %}
It's worth noting that different styles of format exist for each of these types.
{% endhint %}

## Getting Started

Before we format our data, we want to identify the following:

{% stepper %}
{% step %} <mark style="color:green;">Purpose of dataset</mark>

Knowing the purpose of the dataset will help us determine what data we need and format to use.

The purpose could be, adapting a model to a new task such as summarization or improving a model's ability to role-play a specific character. For example:

* Chat-based dialogues (Q\&A, learn a new language, customer support, conversations).
* Structured tasks ([classification](https://colab.research.google.com/github/timothelaborie/text_classification_scripts/blob/main/unsloth_classification.ipynb), summarization, generation tasks).
* Domain-specific data (medical, finance, technical).
  {% endstep %}

{% step %} <mark style="color:green;">Style of output</mark>

The style of output will let us know what sources of data we will use to reach our desired output.

For example, the type of output you want to achieve could be JSON, HTML, text or code. Or perhaps you want it to be Spanish, English or German etc.
{% endstep %}

{% step %} <mark style="color:green;">Data source</mark>

When we know the purpose and style of the data we need, we need to analyze the quality and [quantity](#how-big-should-my-dataset-be) of the data. Hugging Face and Wikipedia are great sources of datasets and Wikipedia is especially useful if you are looking to train a model to learn a language.

The Source of data can be a CSV file, PDF or even a website. You can also [synthetically generate](#synthetic-data-generation) data but extra care is required to make sure each example is high quality and relevant.
{% endstep %}
{% endstepper %}

{% hint style="success" %}
One of the best ways to create a better dataset is by combining it with a more generalized dataset from Hugging Face like ShareGPT to make your model smarter and diverse. You could also add [synthetically generated data](#synthetic-data-generation).
{% endhint %}

## Formatting the Data

When we have identified the relevant criteria, and collected the necessary data, we can then format our data into a machine readable format that is ready for training.

### Common Data Formats for LLM Training

For [**continued pretraining**](https://unsloth.ai/docs/basics/continued-pretraining), we use raw text format without specific structure:

```json
  "text": "Pasta carbonara is a traditional Roman pasta dish. The sauce is made by mixing raw eggs with grated Pecorino Romano cheese and black pepper. The hot pasta is then tossed with crispy guanciale (cured pork cheek) and the egg mixture, creating a creamy sauce from the residual heat. Despite popular belief, authentic carbonara never contains cream or garlic. The dish likely originated in Rome in the mid-20th century, though its exact origins are debated..."
```

This format preserves natural language flow and allows the model to learn from continuous text.

If we are adapting a model to a new task, and intend for the model to output text in a single turn based on a specific set of instructions, we can use **Instruction** format in [Alpaca style](https://docs.unsloth.ai/basics/tutorial-how-to-finetune-llama-3-and-use-in-ollama#id-6.-alpaca-dataset)

```json
"Instruction": "Task we want the model to perform."

"Input": "Optional, but useful, it will essentially be the user's query."

"Output": "The expected result of the task and the output of the model."
```

When we want multiple turns of conversation we can use the ShareGPT format:

```json
{
  "conversations": [
    {
      "from": "human",
      "value": "Can you help me make pasta carbonara?"
    },
    {
      "from": "gpt",
      "value": "Would you like the traditional Roman recipe, or a simpler version?"
    },
    {
      "from": "human",
      "value": "The traditional version please"
    },
    {
      "from": "gpt",
      "value": "The authentic Roman carbonara uses just a few ingredients: pasta, guanciale, eggs, Pecorino Romano, and black pepper. Would you like the detailed recipe?"
    }
  ]
}
```

The template format uses the "from"/"value" attribute keys and messages alternates between `human`and `gpt`, allowing for natural dialogue flow.

The other common format is OpenAI's ChatML format and is what Hugging Face defaults to. This is probably the most used format, and alternates between `user` and `assistant`

```
{
  "messages": [
    {
      "role": "user",
      "content": "What is 1+1?"
    },
    {
      "role": "assistant",
      "content": "It's 2!"
    },
  ]
}
```

### Applying Chat Templates with Unsloth

For datasets that usually follow the common chatml format, the process of preparing the dataset for training or finetuning, consists of four simple steps:

* Check the chat templates that Unsloth currently supports:\\

  ```
  from unsloth.chat_templates import CHAT_TEMPLATES
  print(list(CHAT_TEMPLATES.keys()))
  ```

  \
  This will print out the list of templates currently supported by Unsloth. Here is an example output:\\

  ```
  ['unsloth', 'zephyr', 'chatml', 'mistral', 'llama', 'vicuna', 'vicuna_old', 'vicuna old', 'alpaca', 'gemma', 'gemma_chatml', 'gemma2', 'gemma2_chatml', 'llama-3', 'llama3', 'phi-3', 'phi-35', 'phi-3.5', 'llama-3.1', 'llama-31', 'llama-3.2', 'llama-3.3', 'llama-32', 'llama-33', 'qwen-2.5', 'qwen-25', 'qwen25', 'qwen2.5', 'phi-4', 'gemma-3', 'gemma3']
  ```

  \\
* Use `get_chat_template` to apply the right chat template to your tokenizer:\\

  ```
  from unsloth.chat_templates import get_chat_template

  tokenizer = get_chat_template(
      tokenizer,
      chat_template = "gemma-3", # change this to the right chat_template name
  )
  ```

  \\
* Define your formatting function. Here's an example:\\

  ```
  def formatting_prompts_func(examples):
     convos = examples["conversations"]
     texts = [tokenizer.apply_chat_template(convo, tokenize = False, add_generation_prompt = False) for convo in convos]
     return { "text" : texts, }
  ```

  \
  \
  This function loops through your dataset applying the chat template you defined to each sample.\\
* Finally, let's load the dataset and apply the required modifications to our dataset: \\

  ```
  # Import and load dataset
  from datasets import load_dataset
  dataset = load_dataset("repo_name/dataset_name", split = "train")

  # Apply the formatting function to your dataset using the map method
  dataset = dataset.map(formatting_prompts_func, batched = True,)
  ```

  \
  If your dataset uses the ShareGPT format with "from"/"value" keys instead of the ChatML "role"/"content" format, you can use the `standardize_sharegpt` function to convert it first. The revised code will now look as follows:\
  \\

  ```
  # Import dataset
  from datasets import load_dataset
  dataset = load_dataset("mlabonne/FineTome-100k", split = "train")

  # Convert your dataset to the "role"/"content" format if necessary
  from unsloth.chat_templates import standardize_sharegpt
  dataset = standardize_sharegpt(dataset)

  # Apply the formatting function to your dataset using the map method
  dataset = dataset.map(formatting_prompts_func, batched = True,)
  ```

### Formatting Data Q\&A

<mark style="color:green;">**Q:**</mark> How can I use the Alpaca instruct format?

<mark style="color:green;">**A:**</mark> If your dataset is already formatted in the Alpaca format, then follow the formatting steps as shown in the Llama3.1 [notebook ](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.1_\(8B\)-Alpaca.ipynb#scrollTo=LjY75GoYUCB8). If you need to convert your data to the Alpaca format, one approach is to create a Python script to process your raw data. If you're working on a summarization task, you can use a local LLM to generate instructions and outputs for each example.

<mark style="color:green;">**Q:**</mark> Should I always use the standardize\_sharegpt method?

<mark style="color:green;">**A:**</mark> Only use the standardize\_sharegpt method if your target dataset is formatted in the sharegpt format, but your model expect a ChatML format instead.

\ <mark style="color:green;">**Q:**</mark> Why not use the apply\_chat\_template function that comes with the tokenizer.

<mark style="color:green;">**A:**</mark> The `chat_template` attribute when a model is first uploaded by the original model owners sometimes contains errors and may take time to be updated. In contrast, at Unsloth, we thoroughly check and fix any errors in the `chat_template` for every model when we upload the quantized versions to our repositories. Additionally, our `get_chat_template` and `apply_chat_template` methods offer advanced data manipulation features, which are fully documented on our Chat Templates documentation [page](https://docs.unsloth.ai/basics/chat-templates).

<mark style="color:green;">**Q:**</mark> What if my template is not currently supported by Unsloth?

<mark style="color:green;">**A:**</mark> Submit a feature request on the unsloth github issues [forum](https://github.com/unslothai/unsloth). As a temporary workaround, you could also use the tokenizer's own apply\_chat\_template function until your feature request is approved and merged.

## Synthetic Data Generation

You can also use any local LLM like Llama 3.3 (70B) or OpenAI's GPT 4.5 to generate synthetic data. Generally, it is better to use a bigger like Llama 3.3 (70B) to ensure the highest quality outputs. You can directly use inference engines like vLLM, Ollama or llama.cpp to generate synthetic data but it will require some manual work to collect it and prompt for more data. There's 3 goals for synthetic data:

* Produce entirely new data - either from scratch or from your existing dataset
* Diversify your dataset so your model does not [overfit](https://unsloth.ai/docs/get-started/lora-hyperparameters-guide#avoiding-overfitting-and-underfitting) and become too specific
* Augment existing data e.g. automatically structure your dataset in the correct chosen format

### Synthetic Dataset Notebook

We collaborated with Meta to launch a free notebook for creating Synthetic Datasets automatically using local models like Llama 3.2. [Access the notebook here.](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Meta_Synthetic_Data_Llama3_2_\(3B\).ipynb)

What the notebook does:

* Auto-parses PDFs, websites, YouTube videos and more
* Uses Meta’s Synthetic Data Kit + Llama 3.2 (3B) to generate QA pairs
* Cleans and filters the data automatically
* Fine-tunes the dataset with Uloth + Llama
* Notebook is fully done locally with no API calling necessary

### Using a local LLM or ChatGPT for synthetic data

Your goal is to prompt the model to generate and process QA data that is in your specified format. The model will need to learn the structure that you provided and also the context so ensure you at least have 10 examples of data already. Examples prompts:

* **Prompt for generating more dialogue on an existing dataset**:

  <pre data-overflow="wrap"><code><strong>Using the dataset example I provided, follow the structure and generate conversations based on the examples.
  </strong></code></pre>
* **Prompt if you no have dataset**:

  {% code overflow="wrap" %}

  ```
  Create 10 examples of product reviews for Coca-Coca classified as either positive, negative, or neutral.
  ```

  {% endcode %}
* **Prompt for a dataset without formatting**:

  {% code overflow="wrap" %}

  ```
  Structure my dataset so it is in a QA ChatML format for fine-tuning. Then generate 5 synthetic data examples with the same topic and format.
  ```

  {% endcode %}

It is recommended to check the quality of generated data to remove or improve on irrelevant or poor-quality responses. Depending on your dataset it may also have to be balanced in many areas so your model does not overfit. You can then feed this cleaned dataset back into your LLM to regenerate data, now with even more guidance.

## Dataset FAQ + Tips

### How big should my dataset be?

We generally recommend using a bare minimum of at least 100 rows of data for fine-tuning to achieve reasonable results. For optimal performance, a dataset with over 1,000 rows is preferable, and in this case, more data usually leads to better outcomes. If your dataset is too small you can also add synthetic data or add a dataset from Hugging Face to diversify it. However, the effectiveness of your fine-tuned model depends heavily on the quality of the dataset, so be sure to thoroughly clean and prepare your data.

### How should I structure my dataset if I want to fine-tune a reasoning model?

If you want to fine-tune a model that already has reasoning capabilities like the distilled versions of DeepSeek-R1 (e.g. DeepSeek-R1-Distill-Llama-8B), you will need to still follow question/task and answer pairs however, for your answer you will need to change the answer so it includes reasoning/chain-of-thought process and the steps it took to derive the answer.\
\
For a model that does not have reasoning and you want to train it so that it later encompasses reasoning capabilities, you will need to utilize a standard dataset but this time without reasoning in its answers. This is training process is known as [Reinforcement Learning and GRPO](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide).

### Multiple datasets

If you have multiple datasets for fine-tuning, you can either:

* Standardize the format of all datasets, combine them into a single dataset, and fine-tune on this unified dataset.
* Use the [Multiple Datasets](https://colab.research.google.com/drive/1njCCbE1YVal9xC83hjdo2hiGItpY_D6t?usp=sharing) notebook to fine-tune on multiple datasets directly.

### Can I fine-tune the same model multiple times?

You can fine-tune an already fine-tuned model multiple times, but it's best to combine all the datasets and perform the fine-tuning in a single process instead. Training an already fine-tuned model can potentially alter the quality and knowledge acquired during the previous fine-tuning process.

## Using Datasets in Unsloth

### Alpaca Dataset

See an example of using the Alpaca dataset inside of Unsloth on Google Colab:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-1d66d8714e44d90513dd87b9356eec67886ab3f7%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

We will now use the Alpaca Dataset created by calling GPT-4 itself. It is a list of 52,000 instructions and outputs which was very popular when Llama-1 was released, since it made finetuning a base LLM be competitive with ChatGPT itself.

You can access the GPT4 version of the Alpaca dataset [here](https://huggingface.co/datasets/vicgalle/alpaca-gpt4.). Below shows some examples of the dataset:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-0dde50e386e7b245d3e8a57e10a4a81755b3769a%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

You can see there are 3 columns in each row - an instruction, and input and an output. We essentially combine each row into 1 large prompt like below. We then use this to finetune the language model, and this made it very similar to ChatGPT. We call this process **supervised instruction finetuning**.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-8b3663c5d80adcb935ff77661500f08e13c9af2d%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

### Multiple columns for finetuning

But a big issue is for ChatGPT style assistants, we only allow 1 instruction / 1 prompt, and not multiple columns / inputs. For example in ChatGPT, you can see we must submit 1 prompt, and not multiple prompts.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-d90162c2685ced871f4151369aadcaee40a9c54f%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

This essentially means we have to "merge" multiple columns into 1 large prompt for finetuning to actually function!

For example the very famous Titanic dataset has many many columns. Your job was to predict whether a passenger has survived or died based on their age, passenger class, fare price etc. We can't simply pass this into ChatGPT, but rather, we have to "merge" this information into 1 large prompt.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-a2df04874bfc879182cb66c789341d49700227ea%2FMerge.png?alt=media" alt=""><figcaption></figcaption></figure>

For example, if we ask ChatGPT with our "merged" single prompt which includes all the information for that passenger, we can then ask it to guess or predict whether the passenger has died or survived.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-b3da2b36afe37469cd3962f37186e758871864a5%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Other finetuning libraries require you to manually prepare your dataset for finetuning, by merging all your columns into 1 prompt. In Unsloth, we simply provide the function called `to_sharegpt` which does this in 1 go!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-62b94dc44f2e343020d31de575f52eb22be4b0fc%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Now this is a bit more complicated, since we allow a lot of customization, but there are a few points:

* You must enclose all columns in curly braces `{}`. These are the column names in the actual CSV / Excel file.
* Optional text components must be enclosed in `[[]]`. For example if the column "input" is empty, the merging function will not show the text and skip this. This is useful for datasets with missing values.
* Select the output or target / prediction column in `output_column_name`. For the Alpaca dataset, this will be `output`.

For example in the Titanic dataset, we can create a large merged prompt format like below, where each column / piece of text becomes optional.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-e6228cf6e5c0bb4e4b45e6f3e045910d567c33d2%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

For example, pretend the dataset looks like this with a lot of missing data:

| Embarked | Age | Fare |
| -------- | --- | ---- |
| S        | 23  |      |
|          | 18  | 7.25 |

Then, we do not want the result to be:

1. The passenger embarked from S. Their age is 23. Their fare is **EMPTY**.
2. The passenger embarked from **EMPTY**. Their age is 18. Their fare is $7.25.

Instead by optionally enclosing columns using `[[]]`, we can exclude this information entirely.

1. \[\[The passenger embarked from S.]] \[\[Their age is 23.]] \[\[Their fare is **EMPTY**.]]
2. \[\[The passenger embarked from **EMPTY**.]] \[\[Their age is 18.]] \[\[Their fare is $7.25.]]

becomes:

1. The passenger embarked from S. Their age is 23.
2. Their age is 18. Their fare is $7.25.

### Multi turn conversations

A bit issue if you didn't notice is the Alpaca dataset is single turn, whilst remember using ChatGPT was interactive and you can talk to it in multiple turns. For example, the left is what we want, but the right which is the Alpaca dataset only provides singular conversations. We want the finetuned language model to somehow learn how to do multi turn conversations just like ChatGPT.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-2a65cd74ddd03a6bcbbc9827d9d034e4879a8e6a%2Fdiff.png?alt=media" alt=""><figcaption></figcaption></figure>

So we introduced the `conversation_extension` parameter, which essentially selects some random rows in your single turn dataset, and merges them into 1 conversation! For example, if you set it to 3, we randomly select 3 rows and merge them into 1! Setting them too long can make training slower, but could make your chatbot and final finetune much better!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-2b1b3494b260f1102942d86143a885225c6a06f2%2Fcombine.png?alt=media" alt=""><figcaption></figcaption></figure>

Then set `output_column_name` to the prediction / output column. For the Alpaca dataset dataset, it would be the output column.

We then use the `standardize_sharegpt` function to just make the dataset in a correct format for finetuning! Always call this!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-7bf83bf802191bda9e417bbe45afa181e7f24f38%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

## Vision Fine-tuning

The dataset for fine-tuning a vision or multimodal model also includes image inputs. For example, the [Llama 3.2 Vision Notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.2_\(11B\)-Vision.ipynb#scrollTo=vITh0KVJ10qX) uses a radiography case to show how AI can help medical professionals analyze X-rays, CT scans, and ultrasounds more efficiently.

We'll be using a sampled version of the ROCO radiography dataset. You can access the dataset [here](https://www.google.com/url?q=https%3A%2F%2Fhuggingface.co%2Fdatasets%2Funsloth%2FRadiology_mini). The dataset includes X-rays, CT scans and ultrasounds showcasing medical conditions and diseases. Each image has a caption written by experts describing it. The goal is to finetune a VLM to make it a useful analysis tool for medical professionals.

Let's take a look at the dataset, and check what the 1st example shows:

```
Dataset({
    features: ['image', 'image_id', 'caption', 'cui'],
    num_rows: 1978
})
```

| Image                                                                                                                                                                                                                                  | Caption                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-97d4489827403bd4795494f33d01a10979788c30%2Fxray.png?alt=media" alt="" data-size="original"> | Panoramic radiography shows an osteolytic lesion in the right posterior maxilla with resorption of the floor of the maxillary sinus (arrows). |

To format the dataset, all vision finetuning tasks should be formatted as follows:

```python
[
{ "role": "user",
  "content": [{"type": "text",  "text": instruction}, {"type": "image", "image": image} ]
},
{ "role": "assistant",
  "content": [{"type": "text",  "text": answer} ]
},
]
```

We will craft an custom instruction asking the VLM to be an expert radiographer. Notice also instead of just 1 instruction, you can add multiple turns to make it a dynamic conversation.

```notebook-python
instruction = "You are an expert radiographer. Describe accurately what you see in this image."

def convert_to_conversation(sample):
    conversation = [
        { "role": "user",
          "content" : [
            {"type" : "text",  "text"  : instruction},
            {"type" : "image", "image" : sample["image"]} ]
        },
        { "role" : "assistant",
          "content" : [
            {"type" : "text",  "text"  : sample["caption"]} ]
        },
    ]
    return { "messages" : conversation }
pass
```

Let's convert the dataset into the "correct" format for finetuning:

```notebook-python
converted_dataset = [convert_to_conversation(sample) for sample in dataset]
```

The first example is now structured like below:

```notebook-python
converted_dataset[0]
```

{% code overflow="wrap" %}

```
{'messages': [{'role': 'user',
   'content': [{'type': 'text',
     'text': 'You are an expert radiographer. Describe accurately what you see in this image.'},
    {'type': 'image',
     'image': <PIL.PngImagePlugin.PngImageFile image mode=L size=657x442>}]},
  {'role': 'assistant',
   'content': [{'type': 'text',
     'text': 'Panoramic radiography shows an osteolytic lesion in the right posterior maxilla with resorption of the floor of the maxillary sinus (arrows).'}]}]}
```

{% endcode %}

Before we do any finetuning, maybe the vision model already knows how to analyse the images? Let's check if this is the case!

```notebook-python
FastVisionModel.for_inference(model) # Enable for inference!

image = dataset[0]["image"]
instruction = "You are an expert radiographer. Describe accurately what you see in this image."

messages = [
    {"role": "user", "content": [
        {"type": "image"},
        {"type": "text", "text": instruction}
    ]}
]
input_text = tokenizer.apply_chat_template(messages, add_generation_prompt = True)
inputs = tokenizer(
    image,
    input_text,
    add_special_tokens = False,
    return_tensors = "pt",
).to("cuda")

from transformers import TextStreamer
text_streamer = TextStreamer(tokenizer, skip_prompt = True)
_ = model.generate(**inputs, streamer = text_streamer, max_new_tokens = 128,
                   use_cache = True, temperature = 1.5, min_p = 0.1)
```

And the result:

```
This radiograph appears to be a panoramic view of the upper and lower dentition, specifically an Orthopantomogram (OPG).

* The panoramic radiograph demonstrates normal dental structures.
* There is an abnormal area on the upper right, represented by an area of radiolucent bone, corresponding to the antrum.

**Key Observations**

* The bone between the left upper teeth is relatively radiopaque.
* There are two large arrows above the image, suggesting the need for a closer examination of this area. One of the arrows is in a left-sided position, and the other is in the right-sided position. However, only
```
