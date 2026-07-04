# Saving to Ollama

See our [Tutorial: How to Finetune Llama-3 and Use in Ollama](tutorial-llama3-ollama.md) for the complete process on how to save to [Ollama](https://github.com/ollama/ollama).

### Saving on Google Colab

You can save the finetuned model as a small 100MB file called a LoRA adapter. You can instead push to the Hugging Face hub as well if you want to upload your model! Remember to get a Hugging Face token via: <https://huggingface.co/settings/tokens> and add your token!

After saving the model, we can again use Unsloth to run the model itself! Use `FastLanguageModel` again to call it for inference!

### Exporting to Ollama

Finally we can export our finetuned model to Ollama itself! First we have to install Ollama in the Colab notebook.

Then we export the finetuned model we have to llama.cpp's GGUF formats.

Reminder to convert `False` to `True` for 1 row, and not change every row to `True`, or else you'll be waiting for a very long time! We normally suggest the first row getting set to `True`, so we can export the finetuned model quickly to `Q8_0` format (8 bit quantization). We also allow you to export to a whole list of quantization methods as well, with a popular one being `q4_k_m`.

Head over to <https://github.com/ggerganov/llama.cpp> to learn more about GGUF. We also have some manual instructions of how to export to GGUF if you want here: <https://github.com/unslothai/unsloth/wiki#manually-saving-to-gguf>

You will see a long list of text - please wait 5 to 10 minutes!

### Automatic `Modelfile` creation

The trick Unsloth provides is we automatically create a `Modelfile` which Ollama requires! This is just a list of settings and includes the chat template which we used for the finetune process! You can also print the `Modelfile` generated.

We then ask Ollama to create a model which is Ollama compatible, by using the `Modelfile`.

### Ollama Inference

And we can now call the model for inference if you want to call the Ollama server itself which is running on your own local machine / in the free Colab notebook in the background.

### Running in Unsloth works well, but after exporting & running on Ollama, the results are poor

You might sometimes encounter an issue where your model runs and produces good results on Unsloth, but when you use it on another platform like Ollama, the results are poor or you might get gibberish, endless/infinite generations or repeated outputs.

* The most common cause of this error is using an **incorrect chat template**. It's essential to use the SAME chat template that was used when training the model in Unsloth and later when you run it in another framework, such as llama.cpp or Ollama. When inferencing from a saved model, it's crucial to apply the correct template.
* You must use the correct `eos token`. If not, you might get gibberish on longer generations.
* It might also be because your inference engine adds an unnecessary "start of sequence" token (or the lack of thereof on the contrary) so ensure you check both hypotheses!
* **Use our conversational notebooks to force the chat template - this will fix most issues.**
  * Qwen-3 14B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen3_(14B)-Reasoning-Conversational.ipynb)
  * Gemma-3 4B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Gemma3_(4B).ipynb)
  * Llama-3.2 3B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.2_(1B_and_3B)-Conversational.ipynb)
  * Phi-4 14B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Phi_4-Conversational.ipynb)
  * Mistral v0.3 7B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Mistral_v0.3_(7B)-Conversational.ipynb)
  * **More notebooks in our [notebooks docs](https://unsloth.ai/docs/get-started/unsloth-notebooks)**
