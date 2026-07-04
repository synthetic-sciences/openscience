# Tutorial: How to Finetune Llama-3 and Use In Ollama

By the end of this tutorial, you will create a custom chatbot by **finetuning Llama-3** with [**Unsloth**](https://github.com/unslothai/unsloth) for free. It can run locally via [**Ollama**](https://github.com/ollama/ollama) on your PC, or in a free GPU instance through [**Google Colab**](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3_\(8B\)-Ollama.ipynb). You will be able to interact with the chatbot interactively like below:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-cf9aed2029e54afbb65889b480134e6d5e1cf3a7%2FAssistant%20example.png?alt=media" alt=""><figcaption></figcaption></figure>

**Unsloth** makes finetuning much easier, and can automatically export the finetuned model to **Ollama** with integrated automatic `Modelfile` creation! If you need help, you can join our Discord server: <https://discord.com/invite/unsloth>

{% hint style="warning" %}
**If you’d like to copy or save the code, everything is available in our** [**Ollama Colab notebook**](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3_\(8B\)-Ollama.ipynb)**. You can use it directly there or adapt it for your local setup:** [**https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3\_(8B)-Ollama.ipynb**](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3_\(8B\)-Ollama.ipynb)
{% endhint %}

## 1. What is Unsloth?

[Unsloth](https://github.com/unslothai/unsloth) makes finetuning LLMs like Llama-3, Mistral, Phi-3 and Gemma 2x faster, use 70% less memory, and with no degradation in accuracy! We will be using Google Colab which provides a free GPU during this tutorial. You can access our free notebooks below:

* [Ollama Llama-3 Alpaca](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3_\(8B\)-Ollama.ipynb) (notebook which we will be usin
* [CSV/Excel Ollama Guide](https://colab.research.google.com/drive/1VYkncZMfGFkeCEgN2IzbZIKEDkyQuJAS?usp=sharing)

#### ***You will also need to login into your Google account!***

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-bca149bda83c2192982b136cfeb096999c469a2e%2FColab%20Screen.png?alt=media" alt=""><figcaption></figcaption></figure>

## 2. What is Ollama?

[Ollama ](https://github.com/ollama/ollama)allows you to run language models from your own computer in a quick and simple way! It quietly launches a program which can run a language model like Llama-3 in the background. If you suddenly want to ask the language model a question, you can simply submit a request to Ollama, and it'll quickly return the results to you! We'll be using Ollama as our inference engine!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-fd25844766001d93ed0949fc8f57957f49b1e6e5%2FOllama.png?alt=media" alt=""><figcaption></figcaption></figure>

## 3. Install Unsloth

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-4d1b1778f3c8bde62a40130d7b4395b8bb1ce90f%2FColab%20Options.png?alt=media" alt=""><figcaption></figcaption></figure>

If you have never used a Colab notebook, a quick primer on the notebook itself:

1. **Play Button at each "cell".** Click on this to run that cell's code. You must not skip any cells and you must run every cell in chronological order. If you encounter any errors, simply rerun the cell you did not run before. Another option is to click CTRL + ENTER if you don't want to click the play button.
2. **Runtime Button in the top toolbar.** You can also use this button and hit "Run all" to run the entire notebook in 1 go. This will skip all the customization steps, and can be a good first try.
3. **Connect / Reconnect T4 button.** You can click here for more advanced system statistics.

The first installation cell looks like below: Remember to click the PLAY button in the brackets \[ ]. We grab our open source Github package, and install some other packages.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-3ae88d2cf9ba1c59b13d701864750ac311a60426%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

## 4. Selecting a model to finetune

Let's now select a model for finetuning! We defaulted to Llama-3 from Meta / Facebook which was trained on a whopping 15 trillion "tokens". Assume a token is like 1 English word. That's approximately 350,000 thick Encyclopedias worth! Other popular models include Mistral, Phi-3 (trained using GPT-4 output) and Gemma from Google (13 trillion tokens!).

Unsloth supports these models and more! In fact, simply type a model from the Hugging Face model hub to see if it works! We'll error out if it doesn't work.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-4fb10a1ce3e457310c11f74ca5b6347ad556fab0%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

There are 3 other settings which you can toggle:

1. ```
   max_seq_length = 2048
   ```

   This determines the context length of the model. Gemini for example has over 1 million context length, whilst Llama-3 has 8192 context length. We allow you to select ANY number - but we recommend setting it 2048 for testing purposes. Unsloth also supports very long context finetuning, and we show we can provide 4x longer context lengths than the best.
2. ```
   dtype = None
   ```

   Keep this as None, but you can select torch.float16 or torch.bfloat16 for newer GPUs.
3. ```
   load_in_4bit = True
   ```

   We do finetuning in 4 bit quantization. This reduces memory usage by 4x, allowing us to actually do finetuning in a free 16GB memory GPU. 4 bit quantization essentially converts weights into a limited set of numbers to reduce memory usage. A drawback of this is there is a 1-2% accuracy degradation. Set this to False on larger GPUs like H100s if you want that tiny extra accuracy.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-a44ac84348a2c5973dd542866c4c6727a00b3744%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

If you run the cell, you will get some print outs of the Unsloth version, which model you are using, how much memory your GPU has, and some other statistics. Ignore this for now.

## 5. Parameters for finetuning

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-495edc79c5353f0f47c1eea58df045631bfef1e0%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Now to customize your finetune, you can edit the numbers above, but you can ignore it, since we already select quite reasonable numbers.

The goal is to change these numbers to increase accuracy, but also **counteract over-fitting**. Over-fitting is when you make the language model memorize a dataset, and not be able to answer novel new questions. We want to a final model to answer unseen questions, and not do memorization.

1. ```
   r = 16, # Choose any number > 0 ! Suggested 8, 16, 32, 64, 128
   ```

   The rank of the finetuning process. A larger number uses more memory and will be slower, but can increase accuracy on harder tasks. We normally suggest numbers like 8 (for fast finetunes), and up to 128. Too large numbers can causing over-fitting, damaging your model's quality.
2. ```
   target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj",],
   ```

   We select all modules to finetune. You can remove some to reduce memory usage and make training faster, but we highly do not suggest this. Just train on all modules!
3. ```
   lora_alpha = 16,
   ```

   The scaling factor for finetuning. A larger number will make the finetune learn more about your dataset, but can promote over-fitting. We suggest this to equal to the rank `r`, or double it.
4. ```notebook-python
   lora_dropout = 0, # Supports any, but = 0 is optimized
   ```

   Leave this as 0 for faster training! Can reduce over-fitting, but not that much.
5. ```
   bias = "none",    # Supports any, but = "none" is optimized
   ```

   Leave this as 0 for faster and less over-fit training!
6. ```
   use_gradient_checkpointing = "unsloth", # True or "unsloth" for very long context
   ```

   Options include `True`, `False` and `"unsloth"`. We suggest `"unsloth"` since we reduce memory usage by an extra 30% and support extremely long context finetunes.You can read up here: <https://unsloth.ai/blog/long-context> for more details.
7. ```
   random_state = 3407,
   ```

   The number to determine deterministic runs. Training and finetuning needs random numbers, so setting this number makes experiments reproducible.
8. ```
   use_rslora = False,  # We support rank stabilized LoRA
   ```

   Advanced feature to set the `lora_alpha = 16` automatically. You can use this if you want!
9. ```
   loftq_config = None, # And LoftQ
   ```

   Advanced feature to initialize the LoRA matrices to the top r singular vectors of the weights. Can improve accuracy somewhat, but can make memory usage explode at the start.

## 6. Alpaca Dataset

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-1d66d8714e44d90513dd87b9356eec67886ab3f7%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

We will now use the Alpaca Dataset created by calling GPT-4 itself. It is a list of 52,000 instructions and outputs which was very popular when Llama-1 was released, since it made finetuning a base LLM be competitive with ChatGPT itself.

You can access the GPT4 version of the Alpaca dataset here: <https://huggingface.co/datasets/vicgalle/alpaca-gpt4>. An older first version of the dataset is here: <https://github.com/tatsu-lab/stanford_alpaca>. Below shows some examples of the dataset:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-0dde50e386e7b245d3e8a57e10a4a81755b3769a%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

You can see there are 3 columns in each row - an instruction, and input and an output. We essentially combine each row into 1 large prompt like below. We then use this to finetune the language model, and this made it very similar to ChatGPT. We call this process **supervised instruction finetuning**.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-8b3663c5d80adcb935ff77661500f08e13c9af2d%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

## 7. Multiple columns for finetuning

But a big issue is for ChatGPT style assistants, we only allow 1 instruction / 1 prompt, and not multiple columns / inputs. For example in ChatGPT, you can see we must submit 1 prompt, and not multiple prompts.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-d90162c2685ced871f4151369aadcaee40a9c54f%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

This essentially means we have to "merge" multiple columns into 1 large prompt for finetuning to actually function!

For example the very famous Titanic dataset has many many columns. Your job was to predict whether a passenger has survived or died based on their age, passenger class, fare price etc. We can't simply pass this into ChatGPT, but rather, we have to "merge" this information into 1 large prompt.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-a2df04874bfc879182cb66c789341d49700227ea%2FMerge.png?alt=media" alt=""><figcaption></figcaption></figure>

For example, if we ask ChatGPT with our "merged" single prompt which includes all the information for that passenger, we can then ask it to guess or predict whether the passenger has died or survived.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-b3da2b36afe37469cd3962f37186e758871864a5%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Other finetuning libraries require you to manually prepare your dataset for finetuning, by merging all your columns into 1 prompt. In Unsloth, we simply provide the function called `to_sharegpt` which does this in 1 go!

To access the Titanic finetuning notebook or if you want to upload a CSV or Excel file, go here: <https://colab.research.google.com/drive/1VYkncZMfGFkeCEgN2IzbZIKEDkyQuJAS?usp=sharing>

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

## 8. Multi turn conversations

A bit issue if you didn't notice is the Alpaca dataset is single turn, whilst remember using ChatGPT was interactive and you can talk to it in multiple turns. For example, the left is what we want, but the right which is the Alpaca dataset only provides singular conversations. We want the finetuned language model to somehow learn how to do multi turn conversations just like ChatGPT.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-2a65cd74ddd03a6bcbbc9827d9d034e4879a8e6a%2Fdiff.png?alt=media" alt=""><figcaption></figcaption></figure>

So we introduced the `conversation_extension` parameter, which essentially selects some random rows in your single turn dataset, and merges them into 1 conversation! For example, if you set it to 3, we randomly select 3 rows and merge them into 1! Setting them too long can make training slower, but could make your chatbot and final finetune much better!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-2b1b3494b260f1102942d86143a885225c6a06f2%2Fcombine.png?alt=media" alt=""><figcaption></figcaption></figure>

Then set `output_column_name` to the prediction / output column. For the Alpaca dataset dataset, it would be the output column.

We then use the `standardize_sharegpt` function to just make the dataset in a correct format for finetuning! Always call this!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-7bf83bf802191bda9e417bbe45afa181e7f24f38%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

## 9. Customizable Chat Templates

We can now specify the chat template for finetuning itself. The very famous Alpaca format is below:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-59737e6dcb09fed15487d5a57c69f07cb40bb8e7%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

But remember we said this was a bad idea because ChatGPT style finetunes require only 1 prompt? Since we successfully merged all dataset columns into 1 using Unsloth, we essentially can create the below style chat template with 1 input column (instruction) and 1 output:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-d54582ae98c396d51bfb85628b46c54f2517d030%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

We just require you must put a `{INPUT}` field for the instruction and an `{OUTPUT}` field for the model's output field. We in fact allow an optional `{SYSTEM}` field as well which is useful to customize a system prompt just like in ChatGPT. For example, below are some cool examples which you can customize the chat template to be:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-cc455dc380d3d44ef136e485754964159dc773d8%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

For the ChatML format used in OpenAI models:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-15bfca9cfadf10d54b4d3f66e3050044317d62c5%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Or you can use the Llama-3 template itself (which only functions by using the instruct version of Llama-3): We in fact allow an optional `{SYSTEM}` field as well which is useful to customize a system prompt just like in ChatGPT.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-80a2ed4de2ca323ac192c513cac65e9e8bf475db%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Or in the Titanic prediction task where you had to predict if a passenger died or survived in this Colab notebook which includes CSV and Excel uploading: <https://colab.research.google.com/drive/1VYkncZMfGFkeCEgN2IzbZIKEDkyQuJAS?usp=sharing>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-20911ab305c1a10e85859c703157b80175141eb1%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

## 10. Train the model

Let's train the model now! We normally suggest people to not edit the below, unless if you want to finetune for longer steps or want to train on large batch sizes.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-f55503cea4d84b5885d0bcea0563fd716a0d2ed6%2Fimage%20(43).png?alt=media" alt=""><figcaption></figcaption></figure>

We do not normally suggest changing the parameters above, but to elaborate on some of them:

1. ```
   per_device_train_batch_size = 2,
   ```

   Increase the batch size if you want to utilize the memory of your GPU more. Also increase this to make training more smooth and make the process not over-fit. We normally do not suggest this, since this might make training actually slower due to padding issues. We normally instead ask you to increase `gradient_accumulation_steps` which just does more passes over the dataset.
2. ```
   gradient_accumulation_steps = 4,
   ```

   Equivalent to increasing the batch size above itself, but does not impact memory consumption! We normally suggest people increasing this if you want smoother training loss curves.
3. ```
   max_steps = 60, # num_train_epochs = 1,
   ```

   We set steps to 60 for faster training. For full training runs which can take hours, instead comment out `max_steps`, and replace it with `num_train_epochs = 1`. Setting it to 1 means 1 full pass over your dataset. We normally suggest 1 to 3 passes, and no more, otherwise you will over-fit your finetune.
4. ```
   learning_rate = 2e-4,
   ```

   Reduce the learning rate if you want to make the finetuning process slower, but also converge to a higher accuracy result most likely. We normally suggest 2e-4, 1e-4, 5e-5, 2e-5 as numbers to try.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-feb9b0f5763d41cecaec9a3a9cd227ad918f0ca7%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

You’ll see a log of numbers during training. This is the training loss, which shows how well the model is learning from your dataset. For many cases, a loss around 0.5 to 1.0 is a good sign, but it depends on your dataset and task. If the loss is not going down, you might need to adjust your settings. If the loss goes to 0, that could mean overfitting, so it's important to check validation too.

## 11. Inference / running the model

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob2d5f23fa62ec89e06bf20fea433f9a1e42a2fe3%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Now let's run the model after we completed the training process! You can edit the yellow underlined part! In fact, because we created a multi turn chatbot, we can now also call the model as if it saw some conversations in the past like below:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-cdf5d779635901dce7793df92531dbf3caf0fb0a%2Fimage%20(47).png?alt=media" alt=""><figcaption></figcaption></figure>

Reminder Unsloth itself provides **2x faster inference** natively as well, so always do not forget to call `FastLanguageModel.for_inference(model)`. If you want the model to output longer responses, set `max_new_tokens = 128` to some larger number like 256 or 1024. Notice you will have to wait longer for the result as well!

## 12. Saving the model

We can now save the finetuned model as a small 100MB file called a LoRA adapter like below. You can instead push to the Hugging Face hub as well if you want to upload your model! Remember to get a Hugging Face token via <https://huggingface.co/settings/tokens> and add your token!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-8c577103f7c4fe883cabaf35c8437307c6501686%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

After saving the model, we can again use Unsloth to run the model itself! Use `FastLanguageModel` again to call it for inference!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-1a1be852ca551240bdce47cf99e6ccd7d31c1326%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

## 13. Exporting to Ollama

Finally we can export our finetuned model to Ollama itself! First we have to install Ollama in the Colab notebook:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-24f9429ed4a8b3a630dc8f68dcf81555da0a80ee%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Then we export the finetuned model we have to llama.cpp's GGUF formats like below:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-56991ea7e2685bb9905af9baf2f3f685123dcdd8%2Fimage%20(52).png?alt=media" alt=""><figcaption></figcaption></figure>

Reminder to convert `False` to `True` for 1 row, and not change every row to `True`, or else you'll be waiting for a very time! We normally suggest the first row getting set to `True`, so we can export the finetuned model quickly to `Q8_0` format (8 bit quantization). We also allow you to export to a whole list of quantization methods as well, with a popular one being `q4_k_m`.

Head over to <https://github.com/ggerganov/llama.cpp> to learn more about GGUF. We also have some manual instructions of how to export to GGUF if you want here: <https://github.com/unslothai/unsloth/wiki#manually-saving-to-gguf>

You will see a long list of text like below - please wait 5 to 10 minutes!!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-271b392fdafd0e7d01c525d7a11a97ee5c34b713%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

And finally at the very end, it'll look like below:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-a554bd388fd0394dd8cdef85fd9d208bfd7feee7%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

Then, we have to run Ollama itself in the background. We use `subprocess` because Colab doesn't like asynchronous calls, but normally one just runs `ollama serve` in the terminal / command prompt.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-e431609dfc5c742f0b5ab2388dbbd0d8e15c7670%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

## 14. Automatic `Modelfile` creation

The trick Unsloth provides is we automatically create a `Modelfile` which Ollama requires! This is a just a list of settings and includes the chat template which we used for the finetune process! You can also print the `Modelfile` generated like below:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-6945ba10a2e25cfc198848c0e863001375c32c4c%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

We then ask Ollama to create a model which is Ollama compatible, by using the `Modelfile`

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-d431a64613b39d913d1780c22cde37edc6564272%2Fimage.png?alt=media" alt=""><figcaption></figcaption></figure>

## 15. Ollama Inference

And we can now call the model for inference if you want to do call the Ollama server itself which is running on your own local machine / in the free Colab notebook in the background. Remember you can edit the yellow underlined part.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-49b93efa192fdd741f3ac8484cef8c3fd7415283%2FInference.png?alt=media" alt=""><figcaption></figcaption></figure>

## 16. Interactive ChatGPT style

But to actually run the finetuned model like a ChatGPT, we have to do a bit more! First click the terminal icon![](https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-9c24108bc5152f946a7afab054974890318d2c02%2Fimage.png?alt=media) and a Terminal will pop up. It's on the left sidebar.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-2239315eff2820bf9f224975f0b184d51bd89cb7%2FWhere_Terminal.png?alt=media" alt=""><figcaption></figcaption></figure>

Then, you might have to press ENTER twice to remove some weird output in the Terminal window. Wait a few seconds and type `ollama run unsloth_model` then hit ENTER.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-e83ac484e4257eacad1c7d033811d2ece59a444c%2FTerminal_Type.png?alt=media" alt=""><figcaption></figcaption></figure>

And finally, you can interact with the finetuned model just like an actual ChatGPT! Hit CTRL + D to exit the system, and hit ENTER to converse with the chatbot!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-120703475091e1ce74a38a05949ae51af0a36f72%2FAssistant.png?alt=media" alt=""><figcaption></figcaption></figure>

## You've done it!

You've successfully finetuned a language model and exported it to Ollama with Unsloth 2x faster and with 70% less VRAM! And all this for free in a Google Colab notebook!

If you want to learn how to do reward modelling, do continued pretraining, export to vLLM or GGUF, do text completion, or learn more about finetuning tips and tricks, head over to our [Github](https://github.com/unslothai/unsloth#-finetune-for-free).

If you need any help on finetuning, you can also join our Discord server [here](https://discord.gg/unsloth). If you want help with Ollama, you can also join their server [here](https://discord.gg/ollama).

And finally, we want to thank you for reading and following this far! We hope this made you understand some of the nuts and bolts behind finetuning language models, and we hope this was useful!
