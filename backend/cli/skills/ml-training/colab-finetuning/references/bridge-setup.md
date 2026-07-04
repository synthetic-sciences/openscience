# Bridge Notebook Setup

## How the Bridge Works

The bridge notebook creates a WebSocket tunnel from a Google Colab runtime to your local machine:

```
openscience CLI ←→ WebSocket ←→ Cloudflare Tunnel ←→ Jupyter Server (on Colab GPU)
```

1. A Jupyter notebook server starts on the Colab VM (port 8888)
2. `jupyter_http_over_ws` extension enables WebSocket connections
3. `cloudflared` creates a public tunnel URL
4. openscience connects via WebSocket and sends Jupyter kernel messages

## Step-by-Step Setup

### 1. Generate the Bridge Notebook
```
Use colab_notebook tool with workflow="bridge"
```
This creates `openscience-bridge.ipynb` in your project directory.

### 2. Upload to Google Colab
- Go to [colab.research.google.com](https://colab.research.google.com)
- File → Upload notebook → select `openscience-bridge.ipynb`

### 3. Select GPU Runtime
- Runtime → Change runtime type
- Hardware accelerator: GPU
- GPU type: T4 (free) or A100 (pro)

### 4. Run All Cells
Run cells in order:
1. **GPU check** — confirms GPU is available
2. **Install dependencies** — installs `jupyter_http_over_ws`
3. **Install cloudflared** — downloads the tunnel binary
4. **Start bridge** — starts Jupyter + tunnel, prints WebSocket URL

### 5. Copy the URL
The output will show:
```
============================================================
SYNSC BRIDGE READY
============================================================

Paste this URL into openscience:

  wss://random-name.trycloudflare.com/api/kernels/default/channels?token=...

============================================================
```

### 6. Connect from openscience
```
Use colab_connect tool with connection_url="wss://..."
```

### 7. Keep Alive
Run the keep-alive cell to prevent Colab from disconnecting due to inactivity.

## Security

- The bridge uses a random token for authentication
- The Cloudflare tunnel URL is unique and expires when the notebook stops
- No Google account credentials are transmitted through the bridge
- The tunnel is read/write — anyone with the URL can execute code on the Colab VM
- **Do not share the WebSocket URL**
