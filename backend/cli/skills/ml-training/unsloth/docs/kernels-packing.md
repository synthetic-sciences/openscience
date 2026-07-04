# 3x Faster LLM Training with Unsloth Kernels + Packing

Unsloth now supports up to **5× faster** (typically 3x) training with our new custom **RoPE and MLP Triton kernels**, plus our new smart auto packing. Unsloth's new kernels + features not only increase training speed, but also further **reduces VRAM use (30% - 90%)** with no accuracy loss. [Unsloth GitHub](https://github.com/unslothai/unsloth)\
\
This means you can now train LLMs like [Qwen3](https://unsloth.ai/docs/models/qwen3-how-to-run-and-fine-tune)-4B not only on just **3GB VRAM**, but also 3x faster.

Our auto [**padding-free**](#padding-free-by-default) uncontaminated packing is smartly enabled for all training runs without any changes, and all fast attention backends (FlashAttention 3, xFormers, SDPA). [Benchmarks](#analysis-and-benchmarks) show training losses match non-packing runs **exactly**.

* **2.3x faster QK Rotary Embedding** fused Triton kernel with packing support
* Updated SwiGLU, GeGLU kernels with **int64 indexing for lon context**
* **2.5x to 5x faster uncontaminated packing** with xformers, SDPA, FA3 backends
* **2.1x faster padding free, 50% less VRAM**, 0% accuracy change
* Unsloth also now has improved SFT loss stability and more predictable GPU utilization.
* This new upgrade works **for all training methods** e.g. full fine-tuning, pretraining etc.

### :drum:Fused QK RoPE Triton Kernel with packing

Back in December 2023, we introduced a RoPE kernel coded up in Triton as part of our Unsloth launch. In March 2024, a community member made end to end training 1-2% faster by optimizing the RoPE kernel to allow launching a block for a group of heads. See [PR 238](https://github.com/unslothai/unsloth/pull/238).

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FewadBu05vK7zAmJRJcj6%2Frope_varlen_qk_rope_kernel_benchmark_v5.png?alt=media&#x26;token=04d277d4-c289-4943-9312-e3d3e2d60bec" alt="" width="563"><figcaption></figcaption></figure>

One issue is for each Q and K, there are 2 Triton kernels. We merged them into 1 Triton kernel now, and enabled variable length RoPE, which was imperative for padding free and packing support. This makes the RoPE kernel in micro benchmarks **2.3x faster on longer context lengths**, and 1.9x faster on shorter context lengths.

We also eliminated all clones and contiguous transpose operations, and so **RoPE is now fully inplace**, reducing further GPU memory. Note for the backward pass, we see that `sin1 = -sin1` since:

```
Q * cos + rotate_half(Q) * sin
is equivalent to
Q * cos + Q @ R * sin
where R is a rotation matrix [ 0,  I]
                             [-I,  0]
dC/dY = dY * cos + dY @ R.T * sin
where R.T is again the same  [ 0, -I]
but the minus is transposed. [ I,  0]
```

### :railway\_car:Int64 Indexing for Triton Kernels

During 500K long context training which we introduced in [500k-context-length-fine-tuning](https://unsloth.ai/docs/blog/500k-context-length-fine-tuning "mention"), we would get CUDA out of bounds errors. This was because MLP kernels for SwiGLU, GeGLU had int32 indexing which is by default in Triton and CUDA.

We can't just do `tl.program_id(0).to(tl.int64)` since training will be slightly slower due to int64 indexing. We instead make this a `LONG_INDEXING: tl.constexpr` variable so the Triton compiler can specialize this. This allows shorter and longer context runs to both run great!

{% code overflow="wrap" %}

```python
block_idx = tl.program_id(0)
if LONG_INDEXING:
    offsets = block_idx.to(tl.int64) * BLOCK_SIZE + tl.arange(0, BLOCK_SIZE).to(tl.int64)
    n_elements = tl.cast(n_elements, tl.int64)
else:
    offsets = block_idx * BLOCK_SIZE + tl.arange(0, BLOCK_SIZE)
```

{% endcode %}

### :abacus:Why is padding needed & mathematical speedup

Computers and GPUs cannot process different length datasets, so we have to pad them with 0s. This causes wastage. Assume we have a dataset of 50% short sequences S, and 50% long sequences L, then in the worst case, padding will cause token usage to be $\text{batchsize} \times L$ since the longest sequence length dominates.

By packing multiple examples into a single, long one-dimensional tensor, we can eliminate a significant amount of padding. In fact we get the below token usage:

$
\text{Token Usage} = \frac{\text{batchsize}}{2}L+\frac{\text{batchsize}}{2}S
$

By some math and algebra, we can work out the speedup via:

$
\text{Speedup} = \frac{\text{batchsize} \times L}{\frac{\text{batchsize}}{2}L+\frac{\text{batchsize}}{2}S} = 2 \frac{L}{L + S}
$

By assuming $S\rightarrow0$ then we get a 2x theoretical speedup since $2 \frac{L}{L + 0} = 2$

By changing the ratio of 50% short sequences, and assuming we have MORE short sequences, for eg 20% long sequences and 80% short sequences, we get $\frac{L}{0.2L + 0.8S}\rightarrow\frac{L}{0.2L}=5$ so 5x faster training! This means packing's speedup depends on how short rows your dataset has (the more shorter, the faster).

### :clapper:Padding-Free by Default

In addition to large throughput gains available when setting `packing = True` in your `SFTConfig` , we will **automatically use padding-free batching** in order to reduce padding waste improve throughput and increases tokens/s throughput, while resulting in the ***exact same loss*** as seen in the previous version of Unsloth.

For example for Qwen3-8B and Qwen3-32B, we see memory usage decrease by 60%, be 2x faster, and have the same exact loss and grad norm curves!

<div><figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FPATEJoJwIotXNPsYT1hu%2FW%26B%20Chart%2010_12_2025%2C%203_57_51%20am.png?alt=media&#x26;token=e31ee2cd-cd6e-4fd2-9c59-7f2148179815" alt=""><figcaption></figcaption></figure> <figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FjjnXdgPSgUxL9WNzx9wc%2FW%26B%20Chart%2010_12_2025%2C%203_58_19%20am.png?alt=media&#x26;token=54368c73-2ce1-4faa-a1f4-c82341638be3" alt=""><figcaption></figcaption></figure></div>

<div><figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FA61fgCtUj0K9dhrHCt0C%2FW%26B%20Chart%2010_12_2025%2C%203_54_40%20am.png?alt=media&#x26;token=b8472635-4b05-430e-9df1-3820ed381c3f" alt="" width="563"><figcaption></figcaption></figure> <figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FPh0Xfaup0CTz8REL6P9F%2FW%26B%20Chart%2010_12_2025%2C%203_56_38%20am.png?alt=media&#x26;token=86ed33c3-e5ac-4b71-82c3-f8f86ca79862" alt="" width="563"><figcaption></figcaption></figure> <figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2F6FKM6pkRkQX3gzQLdcIP%2FW%26B%20Chart%2010_12_2025%2C%203_55_38%20am.png?alt=media&#x26;token=48d2c1d3-e6f2-420c-8209-70ef247ce63d" alt="" width="563"><figcaption></figcaption></figure> <figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FxbhcPeELu78xh3M01xkf%2FW%26B%20Chart%2010_12_2025%2C%203_56_07%20am.png?alt=media&#x26;token=375c3f27-5af8-43e5-93eb-3818cb401f95" alt="" width="563"><figcaption></figcaption></figure></div>

### :spades:Uncontaminated Packing 2-5x faster training

Real datasets can contain different sequence lengths, so increasing the batch size to 32 for example will cause padding, making training slower and use more VRAM.

{% hint style="success" %}
In the past, increasing `batch_size` to large numbers (>32) will make training SLOWER, not faster. This was due to padding - we can now eliminate this issue via `packing = True`, and so training is FASTER!
{% endhint %}

When we pack multiple samples into a single one-dimensional tensor, we keep sequence length metadata around in order to properly mask samples, without leaking attention between samples. We also need the RoPE kernel described in [#fused-qk-rope-triton-kernel-with-packing](#fused-qk-rope-triton-kernel-with-packing "mention") to allow reset position ids.

{% columns %}
{% column width="41.66666666666667%" %}

<div align="center" data-full-width="false"><figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2F508zS4YN2sYnYjYkt8ej%2Fimage.png?alt=media&#x26;token=a05f917a-f593-4abd-a834-2f3f6652ca5a" alt="" width="563"><figcaption><p>4 examples without packing wastes space</p></figcaption></figure></div>

{% endcolumn %}

{% column width="58.33333333333333%" %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2F8azEy9wbeF2RWSWbNdma%2Fimage.png?alt=media&#x26;token=a4b96567-244a-45ed-8b18-b16074bac88c" alt=""><figcaption><p>Uncontaminated packing creates correct attention pattern</p></figcaption></figure>
{% endcolumn %}
{% endcolumns %}

By changing the ratio of 50% short sequences, and assuming we have MORE short sequences, for eg 20% long sequences and 80% long sequences, we get $\frac{L}{0.2L + 0.8S}\rightarrow\frac{L}{0.2L}=5$ so 5x faster training! This means packing's speedup depends on how short rows your dataset has (the more shorter, the faster).

### :beach:Analysis and Benchmarks

To demonstrate the various improvements when training with our new kernels and packed data, we ran fine-tuning runs with [Qwen3-32B](https://unsloth.ai/docs/models/qwen3-how-to-run-and-fine-tune), Qwen3-8B, Llama 3 8B on the `yahma/alpaca-cleaned` dataset and measured various [training loss](#padding-free-by-default) throughput and efficiency metrics. We compared our new runs vs. a standard optimized training run with our own kernels/optimizations turned on and kernels like Flash Attention 3 (FA3) enabled. We fixed `max_length = 1024` and varied the batch size in {1, 2, 4, 8, 16, 32}. This allows the maximum token count per batch to vary in {1024, 2048, 4096, 8192, 16K, 32K}.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FFfmdok7AmeretPSGlZjg%2Fnew%20rope%20kernel%20graph.png?alt=media&#x26;token=d890fd95-c8c0-4817-9ee3-18e3095cde5f" alt="" width="563"><figcaption></figcaption></figure>

The above shows how tokens per second (tokens/s) training throughput varies for new Unsloth with varying batch size. This translates into training your model on an epoch of your dataset **1.7-3x faster (sometimes even 5x or more)**! These gains will be more pronounced if there are many short sequences in your data and if you have longer training runs, as described in [#why-is-padding-needed-and-mathematical-speedup](#why-is-padding-needed-and-mathematical-speedup "mention")

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FReViERxLWBHnT8GOv0ql%2Fpacking_efficiency_by_per_device_train_batch_size.png?alt=media&#x26;token=1c4a78c7-a611-4374-ac03-94aabb1d3184" alt="" width="563"><figcaption></figcaption></figure>

The above shows the average percentage of tokens per batch that are valid (i.e., non-padding). As the batch size length grows, many more padding tokens are seen in the unpacked case, while we achieve a high packing efficiency in the packed case regardless of max sequence length.

Note that, since the batching logic trims batches to the maximum sequence length seen in the batch, when the batch size is 1, the unpacked data is all valid tokens (i.e., no padding). However, as more examples are added into the batch, padding increases on average, hitting nearly 50% padding with batch size is 8! Our sample packing implementation eliminates that waste.

<div><figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FRfzNZVz9uzDPhEe3frGe%2Funknown.png?alt=media&#x26;token=e9fe893e-6b94-4c0d-b144-ef8315067c1e" alt="" width="563"><figcaption></figcaption></figure> <figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FTHtcpIdQ0z0mGRYYBfuF%2Funknown.png?alt=media&#x26;token=ec52b2c1-1e60-4ed2-969a-d760af26be2a" alt="" width="563"><figcaption></figcaption></figure></div>

The first graph (above) plots progress on `yahma/alpaca-cleaned` with `max_length = 2048`, Unsloth new with packing + kernels (maroon) vs. Unsloth old (gray). Both are trained with `max_steps = 500`, but we plot the x-axis in wall-clock time. Notice that we train on nearly 40% of an epoch in the packed case in the same amount of steps (and only a bit more wall-clock time) that it takes to train less than 5% of an epoch in the unpacked case.

Similarly, the 2nd graph (above) plots loss from the same runs, this time plotted with training steps on the x-axis. Notice that the losses match in scale and trend, but the loss in the packing case is less variable since the model is seeing more tokens per training step.

### :sparkles:How to enable packing?

**Update Unsloth first and padding free is done by default**! So all training is immediately 1.1 to 2x faster with 30% less memory usage at least and 0 change in loss curve metric!

{% code overflow="wrap" %}

```bash
pip install --upgrade --force-reinstall --no-cache-dir --no-deps unsloth
pip install --upgrade --force-reinstall --no-cache-dir --no-deps unsloth_zoo
```

{% endcode %}

We also support Flash Attention 3 via Xformers, SDPA support, Flash Attention 2, and this works on old GPUs (Tesla T4, RTX 2080) and new GPUs like H100s, B200s etc! Sample packing works *regardless of choice of attention backend or model family*, so enjoy the same speedups previously had with these fast attention implementations!

If you want to enable explicit packing, then add `packing = True` to enable up to 5x faster training!

{% hint style="warning" %}
Note `packing=True` will change the training loss and will make the dataset number of rows truncated, since multiple short sequences are packed into 1 sequence. You might see the number of examples in the dataset shrink.

To not get different training loss numbers, simply set `packing=False` and we will enable auto padding-free, which already makes training faster!
{% endhint %}

```python
from unsloth import FastLanguageModel
from trl import SFTTrainer, SFTConfig

model, tokenizer = FastLanguageModel.from_pretrained(
    "unsloth/Qwen3-14B",
)

trainer = SFTTrainer(
    model = model,
    processing_class = tokenizer,
    train_dataset = dataset,
    args = SFTConfig(
        per_device_train_batch_size = 1,
        max_length = 4096,
        …,
        packing = True, # required to enable sample packing!
    ),
)
trainer.train()
```

All our notebooks are automatically faster (no need to do anything). See [unsloth-notebooks](https://unsloth.ai/docs/get-started/unsloth-notebooks "mention")

{% columns %}
{% column %}
Qwen3 14B faster:

{% embed url="<https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen3_(14B)-Reasoning-Conversational.ipynb>" %}
{% endcolumn %}

{% column %}
Llama 3.1 Conversational faster:

{% embed url="<https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.2_(1B_and_3B)-Conversational.ipynb>" %}
{% endcolumn %}
{% endcolumns %}
