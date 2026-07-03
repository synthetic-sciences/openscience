# Troubleshooting

## Connection Problems

### "WebSocket connection failed"
- **Cause**: Bridge notebook stopped or tunnel URL expired
- **Fix**: Re-run the bridge cells in Colab to get a fresh URL

### "Connection timeout after 30 seconds"
- **Cause**: Firewall blocking WebSocket connections, or Colab VM is unresponsive
- **Fix**: Try a different network. Check if Colab runtime is still active.

### "Connection closed during execution"
- **Cause**: Colab disconnected the session (idle timeout or resource limits)
- **Fix**: Run the keep-alive cell. Upgrade to Colab Pro for longer sessions.

### Bridge notebook won't start
- **Cause**: Colab Free tier quota exhausted
- **Fix**: Wait for quota reset (resets daily) or upgrade to Pro.

## Training Problems

### CUDA Out of Memory (OOM)
- Reduce `batch_size` to 1
- Reduce `max_seq_length` (try 1024 or 512)
- Reduce `lora_rank` (try 8 instead of 16)
- Use `quantization="4bit"` (default)
- For GRPO: reduce `num_generations` to 2

### Training is very slow
- Check GPU: `colab_status detail=gpu` — ensure a GPU is connected
- If using T4, training 8B+ models will be slower than A100
- Ensure `packing=True` for SFT (default in templates)
- Check for CPU bottleneck: `colab_status detail=full`

### "ModuleNotFoundError: No module named 'unsloth'"
- The `colab_finetune` tool installs Unsloth automatically
- If running manual code, first run: `!pip install unsloth`

### Dataset loading fails
- Verify the dataset ID exists on HuggingFace
- For gated datasets, authenticate: `!huggingface-cli login`
- For local datasets, upload to Colab first with `colab_execute`

### Loss is NaN or not decreasing
- Reduce learning rate (try 1e-5 for GRPO, 5e-5 for SFT)
- Check dataset format matches the template expectations
- Ensure the dataset isn't empty: `colab_execute code="print(len(dataset))"`

## Colab-Specific Issues

### "You have exhausted your GPU quota"
- Colab Free limits GPU usage per day/week
- **Fix**: Wait for reset, or use Colab Pro

### Runtime disconnects after ~30 minutes
- Run the keep-alive cell in the bridge notebook
- Interact with the Colab tab occasionally (Colab detects browser activity)

### "Cannot connect to GPU backend"
- Colab may be overloaded — try again later
- Change runtime type and change back (Runtime → Change runtime type)

### Files disappear after disconnect
- Colab VMs are ephemeral — files are deleted when the runtime stops
- Save important files to Google Drive or push to HuggingFace Hub
- Use `push_to_hub` parameter in `colab_finetune` to auto-upload

## Enterprise (Vertex AI) Issues

### "Not authenticated"
- Run `/connect google-colab` to authenticate with Google OAuth

### "Insufficient quota"
- Check GCP quotas in the Cloud Console
- Request quota increase for the desired GPU type and region

### "Vertex AI API not enabled"
- Enable the API: `gcloud services enable aiplatform.googleapis.com`
