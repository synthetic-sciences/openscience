# Install Unsloth via Docker (Extended)

Unsloth Docker image: [**`unsloth/unsloth`**](https://hub.docker.com/r/unsloth/unsloth)

> You can now use our main Docker image `unsloth/unsloth` for Blackwell and 50-series GPUs - no separate image needed.

## Quickstart

### Step 1: Install Docker and NVIDIA Container Toolkit

Install Docker via [Linux](https://docs.docker.com/engine/install/) or [Desktop](https://docs.docker.com/desktop/) (other).
Then install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html#installation):

```bash
export NVIDIA_CONTAINER_TOOLKIT_VERSION=1.17.8-1
sudo apt-get update && sudo apt-get install -y \
  nvidia-container-toolkit=${NVIDIA_CONTAINER_TOOLKIT_VERSION} \
  nvidia-container-toolkit-base=${NVIDIA_CONTAINER_TOOLKIT_VERSION} \
  libnvidia-container-tools=${NVIDIA_CONTAINER_TOOLKIT_VERSION} \
  libnvidia-container1=${NVIDIA_CONTAINER_TOOLKIT_VERSION}
```

### Step 2: Run the container

```bash
docker run -d -e JUPYTER_PASSWORD="mypassword" \
  -p 8888:8888 -p 2222:22 \
  -v $(pwd)/work:/workspace/work \
  --gpus all \
  unsloth/unsloth
```

### Step 3: Access Jupyter Lab

Go to http://localhost:8888 and open Unsloth. Access the `unsloth-notebooks` tabs to see Unsloth notebooks.

### Step 4: Start training

Follow our [Fine-tuning Guide](datasets.md), [RL Guide](tutorial-grpo.md) or use any premade notebooks.

## Container Structure

* `/workspace/work/` - Your mounted work directory
* `/workspace/unsloth-notebooks/` - Example fine-tuning notebooks
* `/home/unsloth/` - User home directory

## Full Example

```bash
docker run -d -e JUPYTER_PORT=8000 \
  -e JUPYTER_PASSWORD="mypassword" \
  -e "SSH_KEY=$(cat ~/.ssh/container_key.pub)" \
  -e USER_PASSWORD="unsloth2024" \
  -p 8000:8000 -p 2222:22 \
  -v $(pwd)/work:/workspace/work \
  --gpus all \
  unsloth/unsloth
```

## Setting up SSH Key

```bash
# Generate new key pair
ssh-keygen -t rsa -b 4096 -f ~/.ssh/container_key

# Use the public key in docker run
-e "SSH_KEY=$(cat ~/.ssh/container_key.pub)"

# Connect via SSH
ssh -i ~/.ssh/container_key -p 2222 unsloth@localhost
```

## Why Unsloth Containers?

* **Reliable**: Curated environment with stable & maintained package versions. Just 7 GB compressed
* **Ready-to-use**: Pre-installed notebooks in `/workspace/unsloth-notebooks/`
* **Secure**: Runs safely as a non-root user
* **Universal**: Compatible with all transformer-based models (TTS, BERT, etc.)

## Advanced Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `JUPYTER_PASSWORD` | Jupyter Lab password | `unsloth` |
| `JUPYTER_PORT` | Jupyter Lab port inside container | `8888` |
| `SSH_KEY` | SSH public key for authentication | `None` |
| `USER_PASSWORD` | Password for `unsloth` user (sudo) | `unsloth` |

Port mapping: `-p <host_port>:<container_port>`
* Jupyter Lab: `-p 8000:8888`
* SSH access: `-p 2222:22`

> **Important**: Use volume mounts to preserve your work between container runs.

## Security Notes

* Container runs as non-root `unsloth` user by default
* Use `USER_PASSWORD` for sudo operations inside container
* SSH access requires public key authentication
