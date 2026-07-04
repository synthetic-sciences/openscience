# RL Reward Hacking

The ultimate goal of RL is to maximize some reward (say speed, revenue, some metric). But RL can **cheat.** When the RL algorithm learns a trick or exploits something to increase the reward, without actually doing the task at end, this is called "**Reward Hacking**".

It's the reason models learn to modify unit tests to pass coding challenges, and these are critical blockers for real world deployment. Some other good examples are from [Wikipedia](https://en.wikipedia.org/wiki/Reward_hacking).

<div align="center"><figure><img src="https://i.pinimg.com/originals/55/e0/1b/55e01b94a9c5546b61b59ae300811c83.gif" alt="" width="188"><figcaption></figcaption></figure></div>

**Can you counter reward hacking? Yes!** In our [free gpt-oss RL notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/gpt-oss-\(20B\)-GRPO.ipynb) we explore how to counter reward hacking in a code generation setting and showcase tangible solutions to common error modes. We saw the model edit the timing function, outsource to other libraries, cache the results, and outright cheat. After countering, the result is our model generates genuinely optimized matrix multiplication kernels, not clever cheats.

## :trophy: Reward Hacking Overview

Some common examples of reward hacking during RL include:

#### Laziness

RL learns to use Numpy, Torch, other libraries, which calls optimized CUDA kernels. We can stop the RL algorithm from calling optimized code by inspecting if the generated code imports other non standard Python libraries.

#### Caching & Cheating

RL learns to cache the result of the output and RL learns to find the actual output by inspecting Python global variables.

We can stop the RL algorithm from using cached data by wiping the cache with a large fake matrix. We also have to benchmark carefully with multiple loops and turns.

#### Cheating
