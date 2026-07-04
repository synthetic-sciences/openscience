# Troubleshooting Inference

### Running in Unsloth works well, but after exporting & running on other platforms, the results are poor

You might sometimes encounter an issue where your model runs and produces good results on Unsloth, but when you use it on another platform like Ollama or vLLM, the results are poor or you might get gibberish, endless/infinite generations or repeated outputs.

* The most common cause of this error is using an **incorrect chat template**. It's essential to use the SAME chat template that was used when training the model in Unsloth and later when you run it in another framework, such as llama.cpp or Ollama. When inferencing from a saved model, it's crucial to apply the correct template.
* You must use the correct `eos token`. If not, you might get gibberish on longer generations.
* It might also be because your inference engine adds an unnecessary "start of sequence" token (or the lack of thereof on the contrary) so ensure you check both hypotheses!
* **Use our conversational notebooks to force the chat template - this will fix most issues.**
  * Qwen-3 14B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen3_(14B)-Reasoning-Conversational.ipynb)
  * Gemma-3 4B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Gemma3_(4B).ipynb)
  * Llama-3.2 3B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.2_(1B_and_3B)-Conversational.ipynb)
  * Phi-4 14B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Phi_4-Conversational.ipynb)
  * Mistral v0.3 7B Conversational notebook [Open in Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Mistral_v0.3_(7B)-Conversational.ipynb)
  * **More notebooks in our [notebooks repo](https://github.com/unslothai/notebooks).**

### Saving to `safetensors`, not `bin` format in Colab

We save to `.bin` in Colab so it's like 4x faster, but set `safe_serialization = None` to force saving to `.safetensors`. So `model.save_pretrained(..., safe_serialization = None)` or `model.push_to_hub(..., safe_serialization = None)`

### If saving to GGUF or vLLM 16bit crashes

You can try reducing the maximum GPU usage during saving by changing `maximum_memory_usage`.

The default is `model.save_pretrained(..., maximum_memory_usage = 0.75)`. Reduce it to say 0.5 to use 50% of GPU peak memory or lower. This can reduce OOM crashes during saving.
