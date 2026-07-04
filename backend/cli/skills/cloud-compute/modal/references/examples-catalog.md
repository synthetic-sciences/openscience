# Modal Examples Catalog

Complete catalog of Modal's official example library with implementation notes. Each example is production-ready code you can adapt for your workloads.

**Source**: https://modal.com/docs/examples

## LLM Inference & Serving

### `llm_inference` — Deploy an OpenAI-compatible LLM service
- **GPU**: H100 or A100-80GB
- **Key pattern**: Class-based app with `@modal.enter()` for model loading, `@modal.web_server()` for OpenAI-compatible API
- **Features**: vLLM backend, streaming responses, OpenAI-compatible `/v1/chat/completions` endpoint, Volume for model weights, auto-scaling
- **When to use**: Default choice for serving any HF model as an API

### `very_large_models` — Deploy really big language models
- **GPU**: H200:4-8 or B200:4-8
- **Key pattern**: SGLang + multi-GPU tensor parallelism for models that don't fit on a single GPU
- **Features**: DeepSeek V3, Kimi-K2, GLM 4.7/5 support, multi-GPU serving, auto-scaling
- **When to use**: Serving 100B+ parameter models (DeepSeek V3, Kimi-K2, etc.)

### `ministral3_inference` — Cut Ministral 3 cold start times by 10x with snapshots
- **GPU**: Any
- **Key pattern**: Memory snapshots to pre-load model weights into container memory
- **Features**: `modal.Sandbox` snapshots, near-zero cold starts for large models
- **When to use**: When cold start latency is critical (user-facing APIs)

### `vllm_throughput` — Optimize tokens per second with vLLM
- **GPU**: H100 or A100
- **Key pattern**: Batch processing with vLLM for maximum throughput
- **Features**: Offline batch inference, throughput optimization (~30K input tok/s per H100), parallel processing
- **When to use**: Processing large datasets (evaluation, synthetic data generation)

### `sglang_low_latency` — Low-latency inference with SGLang
- **GPU**: H100:2
- **Key pattern**: SGLang runtime with speculative decoding (EAGLE-3) for optimized inference
- **Features**: Speculative decoding, low latency, dual-GPU, streaming
- **When to use**: When you need lower latency than vLLM, latency-critical applications

### `llama_cpp` — Run GGUF models with llama.cpp
- **GPU**: Optional (CPU inference supported)
- **Key pattern**: llama.cpp server on Modal
- **Features**: GGUF quantized models, CPU/GPU hybrid, low resource usage
- **When to use**: Serving quantized models, budget-friendly inference

### `trtllm_latency` — Low-latency inference with TensorRT-LLM
- **GPU**: H100
- **Key pattern**: TensorRT-LLM compiled model serving
- **Features**: Optimized kernels, lowest possible latency
- **When to use**: Production inference where every millisecond counts

### `trtllm_throughput` — High-throughput batch inference with TensorRT-LLM
- **GPU**: H100
- **Key pattern**: TensorRT-LLM for batch processing
- **Features**: Maximum tokens/sec throughput
- **When to use**: Batch processing with TensorRT optimization

## Training & Fine-Tuning

### `grpo_verl` — Train a model to solve math problems using GRPO and verl
- **GPU**: H100:8 (multi-GPU)
- **Key pattern**: verl framework for GRPO RL training
- **Features**: Math reasoning reward, multi-GPU training, Volume checkpointing
- **When to use**: RL-based training for reasoning tasks (math, logic)

### `grpo_trl` — Train a model to solve coding problems using GRPO and TRL
- **GPU**: A100 or H100
- **Key pattern**: TRL's GRPOTrainer on Modal
- **Features**: Code generation reward, sandbox-based evaluation, RL training
- **When to use**: RL-based training for code generation

### `unsloth_finetune` — Efficient LLM fine-tuning with Unsloth
- **GPU**: A100 or L40S
- **Key pattern**: Unsloth for 2x faster LoRA training
- **Features**: Memory efficient, 2x speed, QLoRA support
- **When to use**: LoRA fine-tuning when Tinker doesn't support your model

### `hp_sweep_gpt` — Train SLM with early-stopping grid search
- **GPU**: A100
- **Key pattern**: Grid search over hyperparameters with `.map()`
- **Features**: Parallel HP sweep, early stopping, Volume for checkpoints
- **When to use**: Hyperparameter optimization, training from scratch

### `long-training` — Run long, resumable training jobs
- **GPU**: A100 or H100
- **Key pattern**: Checkpointing to Volume with resume-on-preemption
- **Features**: Volume checkpointing, preemption handling, long-running jobs
- **When to use**: Multi-hour/day training runs that need fault tolerance

### `llm-finetuning` — Full LLM fine-tuning pipeline
- **GPU**: A100-80GB or H100
- **Key pattern**: End-to-end fine-tuning with evaluation
- **Features**: Data loading, training loop, evaluation, model upload
- **When to use**: Complete fine-tuning workflow on Modal

### `flan_t5_finetune` — Fine-tune Flan-T5
- **GPU**: A10G or L40S
- **Key pattern**: Seq2seq model fine-tuning
- **Features**: Flan-T5 training, evaluation
- **When to use**: Seq2seq tasks (summarization, translation, Q&A)

### `diffusers_lora_finetune` — Custom pet art from Flux with Hugging Face and Gradio
- **GPU**: A100-80GB
- **Key pattern**: Diffusers LoRA training for image generation
- **Features**: Image LoRA, custom datasets, Flux models, Gradio UI
- **When to use**: Fine-tuning image generation models

## Multimodal & Vision

### `flux` — Serve diffusion models fast with torch.compile
- **GPU**: A100 or H100
- **Key pattern**: torch.compile for optimized image generation
- **Features**: Compilation cache, fast generation, various Flux variants
- **When to use**: Fast image generation with Flux models

### `image_to_image` — Edit images with Flux Kontext
- **GPU**: A100 or H100
- **Key pattern**: Image-to-image with Flux Kontext
- **Features**: Image editing, style transfer
- **When to use**: Image editing tasks

### `image_to_video` — Animate images with LTX-Video
- **GPU**: A100 or H100
- **Key pattern**: Image animation pipeline
- **Features**: Image-to-video generation
- **When to use**: Creating video from static images

### `ltx` — Generate video clips with LTX-Video
- **GPU**: A100 or H100
- **Key pattern**: Text-to-video generation
- **Features**: LTX-Video model, video clips
- **When to use**: Text-to-video generation

### `text_to_image` — Stable Diffusion CLI/API/UI
- **GPU**: A10G or L40S
- **Key pattern**: Stable Diffusion serving with multiple interfaces
- **Features**: CLI, REST API, Gradio UI
- **When to use**: Standard text-to-image generation

### `finetune_yolo` — Fine-tune and serve YOLO models
- **GPU**: T4 or A10G
- **Key pattern**: YOLO training + serving pipeline
- **Features**: Object detection, model serving
- **When to use**: Computer vision / object detection

### `segment_anything` — Segment Anything Model
- **GPU**: A10G
- **Key pattern**: SAM inference
- **Features**: Zero-shot segmentation
- **When to use**: Image segmentation tasks

### `comfyapp` — Run Flux on ComfyUI as an API
- **GPU**: A100 or H100
- **Key pattern**: ComfyUI workflow as API
- **Features**: ComfyUI, workflow automation, Flux
- **When to use**: Complex image generation pipelines via ComfyUI

### `blender_video` — Build a 3D render farm with Blender
- **GPU**: Optional (CPU rendering supported)
- **Key pattern**: Parallel rendering with Blender on Modal
- **Features**: 3D rendering, frame parallelism, render farm
- **When to use**: Distributed 3D rendering, animation pipelines

## Audio & Speech

### `llm-voice-chat` — Voice chat with LLMs
- **GPU**: A10G or L40S
- **Key pattern**: Real-time voice interaction with WebSocket
- **Features**: Moshi model, WebSocket streaming, real-time audio
- **When to use**: Voice chatbot / real-time audio interaction

### `streaming_kyutai_stt` — Transcribe speech with Kyutai STT
- **GPU**: L4 or A10G
- **Key pattern**: Streaming speech-to-text
- **Features**: Real-time transcription, Kyutai STT, low latency
- **When to use**: Real-time transcription (live captions, dictation)

### `music-video-gen` — Star in custom music videos
- **GPU**: A100 or H100
- **Key pattern**: Multi-model pipeline (image gen + video gen + audio)
- **Features**: Music video generation, multi-model orchestration
- **When to use**: Creative AI pipelines combining audio, image, and video generation

### `generate_music` — Make music with ACE-Step
- **GPU**: A10G or L40S
- **Key pattern**: Music generation pipeline
- **Features**: ACE-Step model, music generation
- **When to use**: AI music generation

### `chatterbox_tts` — Generate speech with Chatterbox
- **GPU**: A10G
- **Key pattern**: Text-to-speech pipeline
- **Features**: Chatterbox TTS, voice synthesis
- **When to use**: Text-to-speech generation

### `batched_whisper` — High throughput batched transcription
- **GPU**: A10G or L40S
- **Key pattern**: Batch Whisper with `@modal.batched()`
- **Features**: Dynamic batching, high throughput, parallel processing
- **When to use**: Transcribing large audio datasets

### `fine_tune_asr` — Fine-tune Whisper to recognize new words
- **GPU**: A10G or A100
- **Key pattern**: Whisper fine-tuning pipeline
- **Features**: Custom vocabulary, domain-specific ASR
- **When to use**: Adapting Whisper to domain-specific terminology

## Sandboxes & Code Execution

### `agent` — Sandbox a LangGraph agent's code
- **GPU**: T4 or A10G
- **Key pattern**: LangGraph agent with Modal Sandbox for code execution
- **Features**: GPU sandbox, LangGraph, tool use, file access
- **When to use**: Building coding agents that need to execute code

### `coding_agent` - Run a background coding agent
- **GPU**: Optional
- **Key pattern**: a coding agent running in a Modal Sandbox
- **Features**: Background coding agent, sandbox isolation, persistent sessions
- **When to use**: Deploying autonomous coding agents in sandboxes

### `modal-vibe` — Deploy vibe coding at scale
- **GPU**: Optional
- **Key pattern**: React frontend + LLM + Modal Sandboxes for scalable AI coding platform
- **Features**: Code execution at scale, React UI, LLM integration, sandbox isolation
- **When to use**: Building scalable AI-powered coding platforms

### `safe_code_execution` — Run Node.js, Ruby, and more in a Sandbox
- **GPU**: Optional
- **Key pattern**: Multi-language sandboxed code execution at scale
- **Features**: Secure execution, Node.js/Ruby/Python, scaling, multi-language
- **When to use**: Building coding platforms, code evaluation systems, multi-language sandboxes

### `simple_code_interpreter` — Build a stateful, sandboxed code interpreter
- **GPU**: Optional
- **Key pattern**: Stateful sandbox with session persistence
- **Features**: Jupyter-like sessions, state persistence, file I/O
- **When to use**: Interactive code interpreter (like ChatGPT Code Interpreter)

### `jupyter_sandbox` — Run a sandboxed Jupyter notebook
- **GPU**: Optional
- **Key pattern**: Jupyter notebook in Modal Sandbox
- **Features**: Jupyter server, file access, isolated execution
- **When to use**: Providing sandboxed Jupyter environments

### `anthropic_computer_use` — Control a sandboxed computer with an LLM
- **GPU**: Optional
- **Key pattern**: Virtual desktop in sandbox controlled by LLM
- **Features**: Computer use, screenshot, mouse/keyboard control
- **When to use**: Computer use / GUI automation agents

## RAG & Embeddings

### `chat_with_pdf_vision` — RAG Chat with PDFs
- **GPU**: A10G or L40S
- **Key pattern**: Vision-based PDF parsing + RAG
- **Features**: PDF parsing, multimodal embeddings, chat interface
- **When to use**: Document Q&A, PDF chatbots

### `amazon_embeddings` — Embed millions of documents with TEI
- **GPU**: A10G or L40S
- **Key pattern**: HuggingFace Text Embeddings Inference (TEI) for bulk embedding
- **Features**: High throughput, batch processing, `.map()` parallelism
- **When to use**: Large-scale embedding generation

### `mongodb-search` — Turn satellite images into vectors and store them in MongoDB
- **GPU**: T4 or A10G
- **Key pattern**: Image embedding + MongoDB Atlas vector search + GeoJSON
- **Features**: Satellite image embeddings, MongoDB Atlas, vector + geospatial search
- **When to use**: Image search with geospatial queries, visual similarity + location

### `potus_speech_qanda` — Retrieval-Augmented Generation (RAG) for Q&A
- **GPU**: None (CPU)
- **Key pattern**: Basic RAG pipeline with OpenAI
- **Features**: Document indexing, question answering
- **When to use**: Simple RAG setup with OpenAI

## Web Apps & Endpoints

### `basic_web` — Serving web endpoints
- **GPU**: None (CPU)
- **Key pattern**: FastAPI + `@modal.asgi_app()` / `@modal.fastapi_endpoint()`
- **Features**: REST API, ASGI/WSGI support, auto-scaling
- **When to use**: Learning Modal web endpoints, simple APIs

### `serve_streamlit` — Deploy Streamlit apps
- **GPU**: Optional
- **Key pattern**: `@modal.web_server()` for Streamlit
- **Features**: Streamlit, interactive dashboards
- **When to use**: Data apps, ML demos with Streamlit

### `fasthtml_app` — FastHTML applications
- **GPU**: None (CPU)
- **Key pattern**: FastHTML on Modal
- **Features**: FastHTML, lightweight web apps
- **When to use**: Simple web applications

### `mcp_server_stateless` — Deploy a stateless MCP with FastMCP
- **GPU**: Optional
- **Key pattern**: FastMCP server on Modal
- **Features**: MCP protocol, tool serving, stateless
- **When to use**: Deploying MCP tool servers

### `webrtc_yolo` — Serverless WebRTC with YOLO detection
- **GPU**: T4 or A10G
- **Key pattern**: WebRTC + YOLO on Modal
- **Features**: Real-time video, object detection, WebRTC
- **When to use**: Real-time video processing apps

### `fastrtc_flip_webcam` — WebRTC quickstart with FastRTC
- **GPU**: Optional
- **Key pattern**: FastRTC framework on Modal
- **Features**: WebRTC, fast setup, real-time communication
- **When to use**: Getting started with WebRTC on Modal

### `webscraper` — Simple web scraper
- **GPU**: None (CPU)
- **Key pattern**: Web scraping with parallel processing
- **Features**: Scraping, data collection, parallelism
- **When to use**: Web scraping and data collection tasks

## Data & Infrastructure

### `s3_bucket_mount` — Parallel processing of Parquet files on S3
- **GPU**: None (CPU)
- **Key pattern**: `modal.CloudBucketMount` for S3 access
- **Features**: S3 as filesystem, Parquet processing, parallel reads
- **When to use**: Processing data from S3, large datasets

### `cloud_bucket_mount_loras` — Create a LoRA Playground with Modal, Gradio, and S3
- **GPU**: A10G or L40S
- **Key pattern**: S3 bucket mount for LoRA weight management
- **Features**: LoRA weights on S3, Gradio UI, dynamic model loading
- **When to use**: Managing and serving multiple LoRA adapters

### `dbt_duckdb` — Build your own data warehouse with DuckDB, DBT, and Modal
- **GPU**: None (CPU)
- **Key pattern**: Data pipeline with DuckDB + DBT
- **Features**: Data warehouse, ETL, analytics
- **When to use**: Building data pipelines and warehouses

### `doc_ocr_jobs` — Document OCR job queue
- **GPU**: Optional
- **Key pattern**: `modal.Queue` for job processing
- **Features**: Job queue, OCR, async processing
- **When to use**: Document processing pipelines

### `doc_ocr_webapp` — Serve a Document OCR web app
- **GPU**: Optional
- **Key pattern**: OCR web app with file upload
- **Features**: Web UI, OCR, file processing
- **When to use**: OCR web applications with user-facing interface

### `hackernews_alerts` — Deploy a Hacker News Slackbot
- **GPU**: None (CPU)
- **Key pattern**: `modal.Cron` + Slack integration
- **Features**: Scheduled jobs, Slack webhooks, web scraping
- **When to use**: Scheduled data collection + notifications

### `discord_bot` — Deploy and run a Discord bot
- **GPU**: None (CPU)
- **Key pattern**: Discord.py on Modal
- **Features**: Discord bot, persistent service
- **When to use**: Discord bot deployment

### `db_to_sheet` — Sync databases and APIs to a Google Sheet
- **GPU**: None (CPU)
- **Key pattern**: Scheduled ETL to Google Sheets
- **Features**: Database sync, Google Sheets API, scheduled jobs
- **When to use**: Automated reporting, database-to-spreadsheet sync

### `cron_datasette` — Publish explorable data with SQLite and Datasette
- **GPU**: None (CPU)
- **Key pattern**: SQLite + Datasette on Modal
- **Features**: Data exploration, SQLite, Datasette UI
- **When to use**: Publishing explorable datasets

### `algolia_indexer` — Build docsearch with an Algolia crawler
- **GPU**: None (CPU)
- **Key pattern**: Web crawling + Algolia indexing
- **Features**: Documentation search, web crawling, Algolia
- **When to use**: Building search indexes for documentation sites

## Computational Biology

### `chai1` — Fold proteins with Chai-1
- **GPU**: A100 or H100
- **Key pattern**: Protein folding pipeline
- **Features**: Chai-1 model, protein structure prediction
- **When to use**: Protein folding / structural biology

### `boltz_predict` — Fold proteins with Boltz-2
- **GPU**: A100 or H100
- **Key pattern**: Boltz-2 protein structure prediction
- **Features**: Latest protein folding model
- **When to use**: Protein structure prediction

### `esm3` — Build a protein folding dashboard
- **GPU**: A100
- **Key pattern**: ESM3 protein language model with visualization
- **Features**: Protein embeddings, sequence analysis, dashboard UI
- **When to use**: Protein sequence analysis, structural biology dashboards

## Networking & Connectivity

### `modal_tailscale` — Add Modal Apps to your VPN with Tailscale
- **GPU**: None
- **Key pattern**: Tailscale VPN integration with Modal containers
- **Features**: VPN access, private networking, Tailscale
- **When to use**: Connecting Modal containers to private networks

### `pushgateway` — Publish custom metrics with Prometheus Pushgateway
- **GPU**: None
- **Key pattern**: Prometheus metrics from Modal functions
- **Features**: Custom metrics, Prometheus, monitoring
- **When to use**: Observability and metrics collection from Modal workloads

## Reinforcement Learning

### `grpo_verl` — GRPO math training with verl
- See Training & Fine-Tuning section above

### `grpo_trl` — GRPO coding training with TRL
- See Training & Fine-Tuning section above
