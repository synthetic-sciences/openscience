# Install Unsloth via Docker

Learn how to use our Docker containers with all dependencies pre-installed for immediate installation. No setup required, just run and start training!

Unsloth Docker image: [**`unsloth/unsloth`**](https://hub.docker.com/r/unsloth/unsloth)

{% hint style="success" %}
You can now use our main Docker image `unsloth/unsloth` for Blackwell and 50-series GPUs - no separate image needed.
{% endhint %}

### ⚡ Quickstart

{% stepper %}
{% step %}
**Install Docker and NVIDIA Container Toolkit.**

Install Docker via [Linux](https://docs.docker.com/engine/install/) or [Desktop](https://docs.docker.com/desktop/) (other).\
Then install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html#installation):

<pre class="language-bash"><code class="lang-bash"><strong>export NVIDIA_CONTAINER_TOOLKIT_VERSION=1.17.8-1
</strong>sudo apt-get update &#x26;&#x26; sudo apt-get install -y \
  nvidia-container-toolkit=${NVIDIA_CONTAIR_TOOLKIT_VERSION} \
  nvidia-container-toolkit-base=${NVIDIA_CONTAINER_TOOLKIT_VERSION} \
  libnvidia-container-tools=${NVIDIA_CONTAINER_TOOLKIT_VERSION} \
  libnvidia-container1=${NVIDIA_CONTAINER_TOOLKIT_VERSION}
</code></pre>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-41cae231ed4761f844ce9836e03b17aabd7c803c%2Fnvidia%20toolkit.png?alt=media" alt=""><figcaption></figcaption></figure>
{% endstep %}

{% step %}
**Run the container.**

[**`unsloth/unsloth`**](https://hub.docker.com/r/unsloth/unsloth) is Unsloth's only Docker image. For Blackwell and 50-series GPUs, use this same image - no separate one needed.

```bash
docker run -d -e JUPYTER_PASSWORD="mypassword" \
  -p 8888:8888 -p 2222:22 \
  -v $(pwd)/work:/workspace/work \
  --gpus all \
  unsloth/unsloth
```

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-2b50d78c5d54eaf189c0a40d46c405585ea23082%2Fdocker%20run.png?alt=media" alt=""><figcaption></figcaption></figure>
{% endstep %}

{% step %}
**Access Jupyter Lab**

Go to [http://localhost:8888](http://localhost:8888/) and open Unsloth.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-828df0a668fd94025c1193c24a7f09c1d58dcbd8%2Fjupyter.png?alt=media" alt="" width="563"><figcaption></figcaption></figure>

Access the `unsloth-notebooks` tabs to see Unsloth notebooks.

<div><figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-e7a3f620a3ec5bff335632ff9b0cb422f76528a1%2FScreenshot_from_2025-09-30_21-38-15.png?alt=media" alt=""><figcaption></figcaption></figure> <figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-531882c33eb96dec24e2d7673471d6a3928a3951%2FScreenshot_from_2025-09-30_21-39-41.png?alt=media" alt=""><figcaption></figcaption></figure></div>
{% endstep %}

{% step %}
**Start training with Unsloth**

If you're new, follow our step-by-step [Fine-tuning Guide](https://unsloth.ai/docs/get-started/fine-tuning-llms-guide), [RL Guide](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide) or just save/copy any of our premade [notebooks](https://unsloth.ai/docs/get-started/unsloth-notebooks).

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fgit-blob-665f900b008991ddcd8fdabb773b292de3c41e72%2FScreenshot_from_2025-09-30_21-40-29.png?alt=media" alt=""><figcaption></figcaption></figure>
{% endstep %}
{% endstepper %}

#### 📂 Container Structure

* `/workspace/work/` — Your mounted work directory
* `/workspace/unsloth-notebooks/` — Example fine-tuning notebooks
* `/home/unsloth/` — User home directory

### 📖 Usage Ex# Full Example

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

#### Setting up SSH Key

If you don't have an SSH key pair:

```bash
# Generate new key pair
ssh-keygen -t rsa -b 4096 -f ~/.ssh/container_key

# Use the public key in docker run
-e "SSH_KEY=$(cat ~/.ssh/container_key.pub)"

# Connect via SSH
ssh -i ~/.ssh/container_key -p 2222 unsloth@localhost
```

### 🦥Why Unsloth Containers?

* **Reliable**: Curated environment with stable & maintained package versions. Just 7 GB compressed (vs. 10–11 GB elsewhere)
* **Ready-to-use**: Pre-installed notebooks in `/workspace/unsloth-notebooks/`
* **Secure**: Runs safely as a non-root user
* **Universal**: Compatible with all transformer-based models (TTS, BERT, etc.)

### ⚙️ Advanced Settings

```bash
# Generate SSH key pair
ssh-keygen-b 4096 -f ~/.ssh/container_key

# Connect to container
ssh -i ~/.ssh/container_key -p 2222 unsloth@localhost
```

| Variable           | Description                        | Default   |
| ------------------ | ---------------------------------- | --------- |
| `JUPYTER_PASSWORD` | Jupyter Lab password               | `unsloth` |
| `JUPYTER_PORT`     | Jupyter Lab port inside container  | `8888`    |
| `SSH_KEY`          | SSH public key for authentication  | `None`    |
| `USER_PASSWORD`    | Password for `unsloth` user (sudo) | `unsloth` |

```bash
-p <host_port>:<container_port>
```

* Jupyter Lab: `-p 8000:8888`
* SSH access: `-p 2222:22`

{% hint style="warning" %}
**Important**: Use volume mounts to preserve your work between container runs.
{% endhint %}

```bash
-v <local_folder>:<container_folder>
```

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

### **🔒 Security Notes**

* Container runs as non-root `unsloth` user by default
* Use `USER_PASSWORD` for sudo operations inside container