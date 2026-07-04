# Unsloth Docs
Train your own model with Unsloth, an open-source framework for LLM fine-tuning and reinforcement learning.

At Unsloth, our mission is to make AI as accurate and accessible as possible. Train and deploy DeepSeek, gpt-oss, Llama, TTS, Qwen, Gemma LLMs 2x faster with 70% less VRAM.

Our docs will guide you through running & training your own model locally.

Get started
Our GitHub

Cover
Faster MoE is here!

Train MoE LLMs 12x faster with less VRAM.

Cover
GLM-5

Run the new SOTA open model.

Cover
Qwen3-Coder-Next

Run & fine-tune the new 80B coding model.

Cover
Kimi K2.5

Run the SOTA open model locally.

Cover
GLM-4.7-Flash

Run & fine-tune the powerful 30B model.

Cover
Embedding Fine-tuning

You can now train embedding models!

🧬
Fine-tuning Guide
📒
Unsloth Notebooks
🔮
All Our Models
🚀
LLM Tutorials Directory
🦥 Why Unsloth?
We directly collab with teams behind gpt-oss, Qwen3, Llama 4, Mistral, Gemma 1–3 and Phi-4, where we’ve fixed critical bugs that greatly improvecy.

Unsloth streamlines local training, evaluation, and deployment with Ollama, llama.cpp and vLLM.

Unsloth is the only training framework to support models like: vision, TTS, embedding, RL while remaining customizable with flexible chat templates, dataset formatting and ready-to-use notebooks.

⭐ Key Features
Supports full-finetuning, pretraining, 4-bit, 16-bit and 8-bit training.

Supports all types models: TTS, embedding, multimodal, and more.

Most efficient reinforcement learning (RL) library, using 80% less VRAM. Supports GRPO, GSPO etc.

0% loss in accuracy - no quantization or approximation methods - all exact.

MultiGPU works already but a much better version is coming!

Unsloth supports Linux, Windows, WSL, NVIDIA and AMD & Intel. See: Unsloth Requirements

Quickstart
Install locally with pip (recommended) for Linux or WSL devices:


Copy
pip install unsloth
Use our official Docker image: unsloth/unsloth. Read our Docker guide.

For Windows install instructions, see here.

📥
Installation
Neleases
What is Fine-tuning and RL? Why?
Fine-tuning an LLM customizes its behavior, enhances domain knowledge, and optimizes performance for specific tasks. By fine-tuning a pre-trained model (e.g. Llama-3.1-8B) on a dataset, you can:

Update Knowledge: Introduce new domain-specific information.

Customize Behavior: Adjust the model’s tone, personality, or response style.

Optimize for Tasks: Improve accuracy and relevance for specific use cases.

Reinforcement Learning (RL) is where an "agent" learns to make decisions by interacting with an environment and receiving feedback in the form of rewards or penalties.

Action: What the model generates (e.g. a sentence).

Reward: A signal indicating how good or bad the model's action was (e.g. did the response follow instructions? was it helpful?).

Environment: The scenario or task the model is working on (e.g. answering a user’s question).

Example fine-tuning or RL use-cases:

Enables LLMs to predict if a headline impacts a company positively or negatively.n use historical customer interactions for more accurate and custom responses.

Fine-tune LLM on legal texts for contract analysis, case law research, and compliance.

You can think of a fine-tuned model as a specialized agent designed to do specific tasks more effectively and efficiently. Fine-tuning can replicate all of RAG's capabilities, but not vice versa.

🤔
FAQ + Is Fine-tuning Right For Me?
💡
Reinforcement Learning Guide