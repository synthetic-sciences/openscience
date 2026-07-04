# Qwen3-Coder-Next: How to Run Locally

Qwen releases Qwen3-Coder-Next, an 80B MoE model (3B active parameters) with **256K context** for fast agentic coding and local use. It is comparable to the performance of models with 10–20× more active parameters.

It runs on **46GB RAM**/VRAM/unified memory (85GB for 8-bit), is non-reasoning for ultra-quick code responses. The model excels at long-horizon reasoning, complex tool use, and recovery from execution failures.

{% hint style="success" %}
**Feb 4 update:** `llama.cpp` fixed a bug correcting the calculation for `vectorized key_gdiff.` This fixes previous looping and output issues. We updated the GGUFs - please **re-download** and **UPDATE** `llama.cpp` for better outputs.
{% endhint %}

We introduce new MXFP4 quants for great quality and speed and you’ll also learn to run the model on Codex & Claude Code.

Qwen3-Coder-Next Unsloth [Dynamic GGUFs](https://unsloth.ai/docs/basics/unsloth-dynamic-2.0-ggufs) to run: [unsloth/Qwen3-Coder-Next-GGUF](htthuggingface.co/unsloth/Qwen3-Coder-Next-GGUF)

<a href="#run-qwen3-coder-next" class="button primary">Run GGUF Tutorial</a><a href="#improving-generation-speed" class="button secondary">Codex & Claude Code</a><a href="#fp8-qwen3-coder-next-in-vllm" class="button secondary">FP8 vLLM Tutorial</a>

### ⚙️ Usage Guide

Don't have 46GB RAM or unified memory? No worries you can run our smaller quants like 3-bit. It is best to have the model size = to the sum of your compute ( **`disk space + RAM + VRAM ≥ size of quant).`** If your quant fully fits on your device, expect 20+ tokens/s. If it doesn't fit, it'll still work by offloading but it will be slower.

To achieve optimal performance, Qwen recommends these settings:

* <mark style="background-color:blue;">`Temperature = 1.0`</mark>
* `Top_P = 0.95`
* `Top_K = 40`
* `Min_P = 0.01` (llama.cpp's default is 0.05)

Supports up to `262,144` context natively but you can set it to `32,768` tokens for less memory use.

### 🖥️ Run Qwen3-Coder-Next

Depending e-case you will need to use different settings. Because this guide uses 4-bit, you will need around 46GB RAM/unified memory. We recommend using at least 3-bit precision for best performance.

{% hint style="success" %}
**Feb 4 update:** `llama.cpp` fixed a bug correcting the calculation for `vectorized key_gdiff.` This fixes previous looping and output issues. We updated the GGUFs - please **re-download** and **UPDATE** `llama.cpp` for better outputs.
{% endhint %}

{% hint style="info" %}
NOTE: This model supports only non-thinking mode and does not generate `<think></think>` blocks in its output. So specifying `enable_thinking=False` is no longer required.
{% endhint %}

#### Llama.cpp Tutorial (GGUF):

Instructions to run in llama.cpp (note we will be using 4-bit to fit most devices):

{% stepper %}
{% step %}
Obtain the latest `llama.cpp` on [GitHub here](https://github.com/ggml-org/llama.cpp). You can follow the build instructions below as well. Change `-DGGML_CUDA=ON` to `-DGGML_CUDA=OFF` if you don't have a GPU or just want CPU inference.

{% code overflow="wrap" %}

```bash
apt-get update
apt-get install pciutils build-essential cmake curl libcurl4-openssl-dev -y
git clone https://github.com/ggml-org/llama.cpp
cmake llama.cpp -B llama.cpp/build \
    -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON
cmake --build llama.cpp/build --config Release -j --clean-first --target llama-cli llama-mtmd-cli llama-server llama-gguf-split
cp llama.cpp/build/bin/llama-* llama.cpp
```

{% endcode %}
{% endstep %}

{% step %}
You can directly pull from Hugging Face. You can increase the context to 256K if your RAM/VRAM can fit it. Using `--fit on` will also auto determine the context length.

You can use the recommended parameters: `temperature=1.0`, `top_p=0.95`, `top_k=40`

```bash
./llama.cpp/llama-cli \
    -hf unsloth/Qwen3-Coder-Next-GGUF:UD-Q4_K_XL \
    --jinja --ctx-size 16384 \
    --temp 1.0 --top-p 0.95 --min-p 0.01 --top-k 40 --fit on
```

{% endstep %}

{% step %}
Download the model via (after installing `pip install huggingface_hub`). You can choose `UD-Q4_K_XL` or other quantized versions.

{% code overflow="wrap" %}

```bash
pip install -U huggingface_hub
hf download unsloth/Qwen3-Coder-Next-GGUF \
    --local-dir unsloth/Qwen3-Coder-Next-GGUF \
    --include "*UD-Q4_K_XL*"
```

{% endcode %}
{% endstep %}

{% step %}
Then run the model in conversation mode:

{% code overflow="wrap" %}

```bash
./llama.cpp/llama-cli \
    --model unsloth/Qwen3-Coder-Next-GGUF/Qwen3-Coder-Next-UD-Q4_K_XL.gguf \
    --fit on \
    --seed 3407 \
    --temp 1.0 \
    --top-p 0.95 \
    --min-p 0.01 \
    --top-k 40 \
    --jinja
```

{% endcode %}

Also, adjust **context window** as required, up to `262,144`

{% hint style="info" %}
NOTE: This model supports only non-thinking mode and does not generate `<think></think>` blocks in its output. So specifying `enable_thinking=False` is no longer required.
{% endhint %}
{% endstep %}
{% endstepper %}

### 🦙Llama-server serving & deployment

To deploy Qwen3-Coder-Next for production, we e `llama-server` In a new terminal say via tmux. Then, deploy the model via:

{% code overflow="wrap" %}

```bash
./llama.cpp/llama-server \
    --model unsloth/Qwen3-Coder-Next-GGUF/Qwen3-Coder-Next-UD-Q4_K_XL.gguf \
    --alias "unsloth/Qwen3-Coder-Next" \
    --fit on \
    --seed 3407 \
    --temp 1.0 \
    --top-p 0.95 \
    --min-p 0.01 \
    --top-k 40 \
    --port 8001 \
    --jinja
```

{% endcode %}

Then in a new terminal, after doing `pip install openai`, we can run the model:

{% code overflow="wrap" %}

```python
from openai import OpenAI
import json
openai_client = OpenAI(
    base_url = "http://127.0.0.1:8001/v1",
    api_key = "sk-no-key-required",
)
completion = openai_client.chat.completions.create(
    model = "unsloth/Qwen3-Coder-Next",
    messages = [{"role": "user", "content": "Create a Flappy Bird game in HTML"},],
)
print(completion.choices[0].message.content)
```

{% endcode %}

Which will output:

{% columns %}
{% column width="66.66666666666666%" %}
{% code overflow="wrap" expandable="true" %}

````markdown
Here is a complete, working Flappy Bird game contained in a single file.

I have used **HTML5 Canvas** for the graphics and **JavaScript** for the physics (gravity, collision detection, and scoring). No external images or downloads are required; the game draws the bird and pipes using code.

### How to run this:
1.  Copy the code block below.
2.  Create a new file on your computer named `game.html`.
3.  Paste the code into that file and save it.
4.  Double-click `game.html` to open it in your web browser.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Simple Flappy Bird</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background-color: #333;
            font-family: 'Courier New', Courier, monospace;
            color: white;
        }

        h1 {
            margin-bottom: 10px;
        }

        #game-container {
            position: relative;
            box-shadow: 0 0 20px rgba(0,0,0,0.5);
        }

        canvas {
            display: block;
            background-color: #70c5ce; /* Sky blue */
            border: 4px solid #000;
        }

        #ui-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none; /* Let clicks pass through to canvas */
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            text-align: center;
        }

        .message {
            background: rgba(255, 255, 255, 0.8);
            padding: 20px;
            border-radius: 10px;
            color: #333;
        }

        #score-board {
            position: absolute;
            top: 20px;
            width: 100%;
            text-align: center;
            font-size: 40px;
            font-weight: bold;
            color: white;
            text-shadow: 2px 2px 0 #000;
            z-index: 10;
        }
    </style>
</head>
<body>

    <h1>Flappy Bird Clone</h1>
    
    <div id="game-container">
        <div id="score-board">0</div>
        <canvas id="birdCanvas" width="320" height="480"></canvas>
        
        <div id="ui-layer">
            <div id="start-screen" class="message">
                <h2>Ready to Fly?</h2>
                <p>Press <strong>Space</strong> or <strong>Click</strong> to Jump</p>
                <p>Press Space to Start</p>
            </div>
            <div id="game-over-screen" class="message" style="display: none;">
                <h2>Game Over</h2>
                <p>Score: <span id="final-score">0</span></p>
                <p>Best: <span id="best-score">0</span></p>
                <p>Press <strong>Space</strong> to Restart</p>
            </div>
        </div>
    </div>

    <script>
        // --- Configuration ---
        const canvas = document.getElementById('birdCanvas');
        const ctx = canvas.getContext('2d');
        const scoreElement = document.getElementById('score-board');
        const startScreen = document.getElementById('start-screen');
        const gameOverScreen = document.getElementById('game-over-screen');
        const finalScoreSpan = document.getElementById('final-score');
        const bestScoreSpan = document.getElementById('best-score');

        // Game Variables
        let frames = 0;
        let score = 0;
        let highScore = localStorage.getItem('flappyHighScore') || 0;
        let gameState = 'START'; // START, PLAYING, GAMEOVER
        const gravity = 0.25;
        const speed = 2; // Speed of pipes moving left

        // --- The Bird Object ---
        const bird = {
            x: 50,
            y: 150,
            width: 30,
            height: 30,
            velocity: 0,
            jumpStrength: 4.5,
            radius: 15,
            draw: function() {
                ctx.fillStyle = "#FFD700"; // Gold color
                ctx.beginPath();
                ctx.arc(this.x + this.radius, this.y + this.radius, this.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.stroke();

                // Eye
                ctx.fillStyle = "white";
                ctx.beginPath();
                ctx.arc(this.x + this.radius + 5, this.y + this.radius - 5, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = "black";
                ctx.beginPath();
                ctx.arc(this.x + this.radius + 7, this.y + this.radius - 5, 2, 0, Math.PI * 2);
                ctx.fill();
                
                // Beak
                ctx.fillStyle = "orange";
                ctx.beginPath();
                ctx.moveTo(this.x + this.radius + 10, this.y + this.radius);
                ctx.lineTo(this.x + this.radius + 20, this.y + this.radius + 5);
                ctx.lineTo(this.x + this.radius + 10, this.y + this.radius + 10);
                ctx.fill();
                ctx.stroke();
            },
            update: function() {
                this.velocity += gravity;
                this.y += this.velocity;

                // Floor Collision
                if (this.y + this.height >= canvas.height) {
                    this.y = canvas.height - this.height;
                    gameOver();
                }
                
                // Ceiling Collision (Optional: prevents flying over pipes)
                if (this.y < 0) {
                    this.y = 0;
                    this.velocity = 0;
                }
            },
            jump: function() {
                this.velocity = -this.jumpStrength;
            },
            reset: function() {
                this.y = 150;
                this.velocity = 0;
            }
        };

        // --- The Pipes Array ---
        const pipes = {
            position: [],
            width: 50,
            gap: 120, // Space between top and bottom pipe
            dx: 2, // Movement speed

            draw: function() {
                for (let i = 0; i < this.position.length; i++) {
                    let p = this.position[i];
                    let topY = p.y;
                    let bottomY = p.y + this.gap;

                    ctx.fillStyle = "#228B22"; // Forest Green

                    // Top Pipe
                    ctx.fillRect(p.x, 0, this.width, topY);
                    ctx.strokeRect(p.x, 0, this.width, topY);

                    // Bottom Pipe
                    ctx.fillRect(p.x, bottomY, this.width, canvas.height - bottomY);
                    ctx.strokeRect(p.x, bottomY, this.width, canvas.height - bottomY);
                }
            },

            update: function() {
                // Add new pipe every 120 frames (approx 2 seconds)
                if (frames % 120 === 0) {
                    // Random height for top pipe
                    // Min height 50, Max height canvas - gap - 50
                    let maxY = canvas.height - this.gap - 50;
                    let randomY = Math.floor(Math.random() * (maxY - 50 + 1) + 50);
                    
                    this.position.push({
                        x: canvas.width,
                        y: randomY
                    });
                }

                for (let i = 0; i < this.position.length; i++) {
                    let p = this.position[i];
                    p.x -= this.dx;

                    // Collision Detection
                    // Logic: Check if bird X is within pipe X range
                    if (bird.x + bird.width > p.x && bird.x < p.x + this.width) {
                        // Logic: Check if bird Y is hitting Top Pipe OR Bottom Pipe
                        if (bird.y < p.y || bird.y + bird.height > p.y + this.gap) {
                            gameOver();
                        }
                    }

                    // Score Update (when bird passes pipe)
                    if (p.x + this.width < bird.x && !p.passed) {
                        score++;
                        scoreElement.innerText = score;
                        p.passed = true;
                    }

                    // Remove pipes that have gone off screen
                    if (p.x + this.width <= 0) {
                        this.position.shift();
                        // Decrement i because array length changed
                        i--; 
                    }
                }
            },
            
            reset: function() {
                this.position = [];
            }
        };

        // --- Background (Clouds/Grass) ---
        const background = {
            draw: function() {
                // Draw Grass
                ctx.fillStyle = "#7cfc00"; // Lawn Green
                ctx.fillRect(0, canvas.height - 20, canvas.width, 20);
                ctx.beginPath();
                ctx.moveTo(0, canvas.height - 20);
                ctx.lineTo(canvas.width, canvas.height - 20);
                ctx.stroke();
            }
        };

        // --- Game Control Functions ---

        function loop() {
            // Clear Canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw Background
            background.draw();

            if (gameState === 'START') {
                bird.draw();
                // Draw a ground line
                ctx.fillStyle = "#ded895";
                ctx.fillRect(0, canvas.height - 10, canvas.width, 10);
            } 
            else if (gameState === 'PLAYING') {
                bird.update();
                bird.draw();
                pipes.update();
                pipes.draw();
                frames++;
            } 
            else if (gameState === 'GAMEOVER') {
                pipes.draw();
                bird.draw();
                // Don't update frames or position, just freeze
            }

            requestAnimationFrame(loop);
        }

        function startGame() {
            gameState = 'PLAYING';
            startScreen.style.display = 'none';
            gameOverScreen.style.display = 'none';
            score = 0;
            frames = 0;
            scoreElement.innerText = score;
            bird.reset();
            pipes.reset();
        }

        function gameOver() {
            gameState = 'GAMEOVER';
            
            // Update High Score
            if (score > highScore) {
                highScore = score;
                localStorage.setItem('flappyHighScore', highScore);
            }

            finalScoreSpan.innerText = score;
            bestScoreSpan.innerText = highScore;
            gameOverScreen.style.display = 'block';
        }

        // --- Input Handling ---

        function handleInput(e) {
            // Prevent default scrolling behavior for Space
            if (e.type === 'keydown' && e.code === 'Space') {
                e.preventDefault();
            }

            if (e.code === 'Space' || e.type === 'mousedown' || e.type === 'touchstart') {
                switch (gameState) {
                    case 'START':
                        startGame();
                        bird.jump();
                        break;
                    case 'PLAYING':
                        bird.jump();
                        break;
                    case 'GAMEOVER':
                        startGame();
                        bird.jump();
                        break;
                }
            }
        }

        window.addEventListener('keydown', handleInput);
        canvas.addEventListener('mousedown', handleInput);
        canvas.addEventListener('touchstart', handleInput);

        // Initialize
        loop();

    </script>
</body>
</html>
```

### Features in this version:
1.  **Physics:** Realistic gravity and jumping mechanics.
2.  **Collision Detection:** The game ends if you hit the pipes, the floor, or the ceiling.
3.  **Scoring System:** You get 1 point for every pipe you pass.
4.  **High Score:** Uses your browser's LocalStorage to remember your best score even if you refresh the page.
5.  **Responsive Controls:** Works with the **Spacebar**, **Mouse Click**, or **Touch** (for mobile devices).
6.  **Graphics:** The bird is drawn with code (including an eye and beak) and the pipes have borders, so no broken image links will occur.
````

{% endcode %}

We extracted the HTML and ran it, and the example Flappy Bird game it generated worked well!
{% endcolumn %}

{% column width="33.33333333333334%" %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2F7ATJWz7O4jMxpVI6I1Wk%2Fimage.png?alt=media&#x26;token=a81548fa-843b-499d-9db6-6f215ad5fb99" alt=""><figcaption></figcaption></figure>
{% endcolumn %}
{% endcolumns %}

### 👾 OpenAI Codex & Claude Code <a href="#improving-generation-speed" id="improving-generation-speed"></a>

To run the model via local coding agentic workloads, you can [follow our guide](https://unoth.ai/docs/basics/claude-codex). Just change the model name '[GLM-4.7-Flash](https://unsloth.ai/docs/models/glm-4.7-flash)' to 'Qwen3-Coder-Next' and ensure you follow the correct Qwen3-Coder-Next parameters and usage instructions. Use the `llama-server` we just set up just then.

{% content-ref url="../basics/claude-codex" %}
[claude-codex](https://unsloth.ai/docs/basics/claude-codex)
{% endcontent-ref %}

After following the instructions for Claude Code for example you will see:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fup2DMSMPjNR8BM9pgR0v%2Fimage.png?alt=media&#x26;token=152e9ee0-2491-4379-af18-8fca0789b19d" alt="" width="563"><figcaption></figcaption></figure>

We can then ask say `Create a Python game for Chess` :

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2F9TfMAoKSdMpb8OHKNnHH%2Fimage.png?alt=media&#x26;token=771df3aa-91ab-4c1e-8676-1830058001ca" alt="" width="563"><figcaption></figcaption></figure>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FWP3lI5mQW2EHB79qqgDz%2Fimage.png?alt=media&#x26;token=55cf3189-e100-419c-a615-024b45948284" alt="" width="563"><figcaption></figcaption></figure>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2Fn8DZddDODQZGCP8giKYY%2Fimage.png?alt=media&#x26;token=996c8cb9-d199-4045-90f0-408690e02667" alt="" width="563"><figcaption></figcaption></figure>

If you see `API Error: 400 {"error":{"code":400,"message":"request (16582 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":16582,"n_ctx":16384}}` that means you need to increase the context length or see [#how-to-fit-long-context-256k-to-1m](#how-to-fit-long-context-256k-to-1m "mention")

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FP6anV1XewSWIovaH3f7c%2Fimage.png?alt=media&#x26;token=285a540b-f6fc-4541-b807-bf4f6dc3807b" alt=""><figcaption></figcaption></figure>

### 🎱 FP8 Qwen3-Coder-Next in vLLM

You can now use our new [FP8 Dynamic quant](https://huggingface.co/unsloth/Qwen3-Coder-Next-FP8-Dynamic) of the model for premium and fast inference. First install vLLM from nightly. Change `--extra-index-url https://wheels.vllm.ai/nightly/cu130` to your CUDA version found via `nvidia-smi` - only `cu129` and `cu130` are currently supported.

{% code overflow="wrap" %}

```bash
# Install uv if you don't have it for faster environment installs
curl -LsSf https://astral.sh/uv/install.sh | sh

# Make a new Python environment - not needed if you want to change your whole system
uv venv unsloth_fp8 --python 3.12 --seed
source unsloth_fp8/bin/activate

uv pip install --upgrade --force-reinstall vm --torch-backend=auto --extra-index-url https://wheels.vllm.ai/nightly/cu130
uv pip install --upgrade --force-reinstall git+https://github.com/huggingface/transformers.git
uv pip install --force-reinstall numba
```

{% endcode %}

Then serve [Unsloth's dynamic FP8 version](https://huggingface.co/unsloth/Qwen3-Coder-Next-FP8-Dynamic) of the model. You can also enable FP8 to reduce KV cache memory usage by 50% by adding `--kv-cache-dtype fp8` We served it on on 4 GPUs, but if you have 1 GPU, use `CUDA_VISIBLE_DEVICES='0'` and set `--tensor-parallel-size 1` or remove this argument. Use `tmux` to launch the below in a new terminal then CTRL+B+D - use `tmux attach-session -t0` to return back to it.

```bash
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False
CUDA_VISIBLE_DEVICES='0,1,2,3' vllm serve unsloth/Qwen3-Coder-Next-FP8-Dynamic \
    --served-model-name unsloth/Qwen3-Coder-Next \
    --tensor-parallel-size 4 \
    --tool-call-parser qwen3_coder \
    --enable-auto-tool-choice \
    --dtype bfloat16 \
    --seed 3407 \
    --max-model-len 200000 \
    --gpu-memory-utilization 0.93 \
    --port 8001
```

You should see something like below. See [#tool-calling-with-qwen3-coder-next](#tool-calling-with-qwen3-coder-next "mention") for how to actually use Qwen3-Coder-Next using the OpenAI API and tool calling - this works for vLLM and llama-server.

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FxRdgnzg1gz3lBLPvftRx%2Fimage.png?alt=media&#x26;token=4f43796b-397f-4ffb-86d2-68afd14994f9" alt=""><figcaption></figcaption></figure>

### :wrench:Tool Calling with Qwen3-Coder-Next

In a new terminal, we create some tools like adding 2 numbers, executing Python code, executing Linux functions and much more:

{% code expandable="true" %}

```python
import json, subprocess, random
from typing import Any
def add_number(a: float | str, b: float | str) -> float:
    return float(a) + float(b)
def multiply_number(a: float | str, b: float | str) -> float:
    return float(a) * float(b)
def substract_number(a: float | str, b: float | str) -> float:
    return float(a) - float(b)
def write_a_story() -> str:
    return random.choice([
        "A long time ago in a galaxy far far away...",
        "There were 2 friends who loved sloths and code...",
        "The world was ending because every sloth evolved to have superhuman intelligence...",
        "Unbeknownst to one friend, the other accidentally coded a program to evolve sloths...",
    ])
def terminal(command: str) -> str:
    if "rm" in command or "sudo" in command or "dd" in command or "chmod" in command:
        msg = "Cannot execute 'rm, sudo, dd, chmod' commands since they are dangerous"
        print(msg); return msg
    print(f"Executing terminal command `{command}`")
    try:
        return str(subprocess.run(command, capture_output = True, text = True, shell = True, check = True).stdout)
    except subprocess.CalledProcessError as e:
        return f"Command failed: {e.stderr}"
def python(code: str) -> str:
    data = {}
    exec(code, data)
    del data["__builtins__"]
    return str(data)
MAP_FN = {
    "add_number": add_number,
    "multiply_number": multiply_number,
    "substract_number": substract_number,
    "write_a_story": write_a_story,
    "terminal": terminal,
    "python": python,
}
tools = [
    {
        "type": "function",
        "function": {
            "name": "add_number",
            "description": "Add two numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {
                        "type": "string",
                        "description": "The first number.",
                    },
                    "b": {
                        "type": "string",
                        "description": "The second number.",
                    },
                },
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "multiply_number",
            "description": "Multiply two numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {
                        "type": "string",
                        "description": "The first number.",
                    },
                    "b": {
                        "type": "string",
                        "description": "The second number.",
                    },
                },
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "substract_number",
            "description": "Substract two numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {
                        "type": "string",
                        "description": "The first number.",
                    },
                    "b": {
                        "type": "string",
                        "description": "The second number.",
                    },
                },
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_a_story",
            "description": "Writes a random story.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "terminal",
            "description": "Perform operations from the terminal.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command you wish to launch, e.g `ls`, `rm`, ...",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "python",
            "description": "Call a Python interpreter with some Python code that will be ran.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The Python code to run",
                    },
                },
                "required": ["code"],
            },
        },
    },
]
```

{% endcode %}

We then use the below functions (copy and paste and execute) which will parse the function calls automatically and call the OpenAI endpoint for any model:

{% code overflow="wrap" expandable="true" %}

```python
from openai import OpenAI
def unsloth_inference(
    messages,
    temperature = 1.0,
    top_p = 0.95,
    top_k = 40,
    min_p = 0.01,
    repetition_penalty = 1.0,
):
    messages = messages.copy()
    openai_client = OpenAI(
        base_url = "http://127.0.0.1:8001/v1",
        api_key = "sk-no-key-required",
    )
    model_name = next(iter(openai_client.models.list())).id
    print(f"Using model = {model_name}")
    has_tool_calls = True
    original_messages_len = len(messages)
    while has_tool_calls:
        print(f"Current messages = {messages}")
        response = openai_client.chat.completions.create(
            model = model_name,
            messages = messages,
            temperature = temperature,
            top_p = top_p,
            tools = tools if tools else None,
            tool_choice = "auto" if tools else None,
            extra_body = {"top_k": top_k, "min_p": min_p, "repetition_penalty" :repetition_penalty,}
        )
        tool_calls = response.choices[0].message.tool_calls or []
        content = response.choices[0].message.content or ""
        tool_calls_dict = [tc.to_dict() for tc in tool_calls] if tool_calls else tool_calls
        messages.append({"role": "assistant", "tool_calls": tool_calls_dict, "content": content,})
        for tool_call in tool_calls:
            fx, args, _id = tool_call.function.name, tool_call.function.arguments, tool_call.id
            out = MAP_FN[fx](**json.loads(args))
            messages.append({"role": "tool", "tool_call_id": _id, "name": fx, "content": str(out),})
        else:
            has_tool_calls = False
    return messages
```

{% endcode %}

Now we'll showcase multiple methods of running tool-calling for many different use-cases below:

#### Execute generated Python code

{% code overflow="wrap" %}

```python
messages = [{
    "role": "user",
    "content": [{"type": "text", "text": "Create a Fibonacci function in Python and find fib(20)."}],
}]
unsloth_inference(messages, temperature = 1.0, top_p = 0.95, top_k = 40, min_p = 0.00)
```

{% endcode %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2F7fY3LSeNCjHXNjBwQkbI%2Fimage.png?alt=media&#x26;token=50eba62e-f8b2-424a-833b-be56696b4710" alt=""><figcaption></figcaption></figure>

#### Execute arbitrary terminal functions

{% code overflow="wrap" %}

```python
messages = [{
    "role": "user",
    "content": [{"type": "text", "text": "Write 'I'm a happy Sloth' to a file, then print it back to me."}],
}]
messages = unsloth_inference(messages, temperature = 1.0, top_p = 1.0, top_k = 40, min_p = 0.00)
```

{% endcode %}

We confirm the file was created and it was!

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FabplwVbEMlsCEJTmxzSA%2Fimage.png?alt=media&#x26;token=eb27f30a-c91e-4aec-8fb0-f4a35921d3db" alt=""><figcaption></figcaption></figure>

See [tool-calling-guide-for-local-llms](https://unsloth.ai/docs/basics/tool-calling-guide-for-local-llms "mention") for more examples for tool calling.

### 🛠️ Improving generation speed <a href="#improving-generation-speed" id="improving-generation-speed"></a>

{% hint style="success" %}
If using vLLM / SGLang, try using our FP8-Dynamic quants which can boost throughput by 25% or more! See [#fp8-qwen3-coder-next-in-vllm](#fp8-qwen3-coder-next-in-vllm "mention")
{% endhint %}

If you have more VRAM, you can try offloading more MoE layers, or offloading whole layers themselves.

Normally, `-ot ".ffn_.*_exps.=CPU"` offloads all MoE layers to the CPU! This effectively allows you to fit all non MoE layers on 1 GPU, improving generation speeds. You can customize the regex expression to fit more layers if you have more GPU capacity.

If you have a bit more GPU memory, try `-ot ".ffn_(up|down)_exps.=CPU"` This offloads up and down projection MoE layers.

Try `-ot ".ffn_(up)_exps.=CPU"` if you have even more GPU memory. This offloads only up projection MoE layers.

You can also customize the regex, for example `-ot "\.(6|7|8|9|[0-9][0-9]|[0-9][0-9][0-9])\.ffn_(gate|up|down)_exps.=CPU"` means to offload gate, up and down MoE layers but only from the 6th layer onwards.

The [latest llama.cpp release](httpsithub.com/ggml-org/llama.cpp/pull/14363) also introduces high throughput mode. Use `llama-parallel`. Read more about it [here](https://github.com/ggml-org/llama.cpp/tree/master/examples/parallel). You can also **quantize the KV cache to 4bits** for example to reduce VRAM / RAM movement, which can also make the generation process faster. The [next section](#how-to-fit-long-context-256k-to-1m) talks about KV cache quantization.

### 📐How to fit long context <a href="#how-to-fit-long-context-256k-to-1m" id="how-to-fit-long-context-256k-to-1m"></a>

To fit longer context, you can use **KV cache quantization** to quantize the K and V caches to lower bits. This can also increase generation speed due to reduced RAM / VRAM data movement. The allowed options for K quantization (default is `f16`) include the below.

`--cache-type-k f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1`

You should use the `_1` variants for somewhat increased accuracy, albeit it's slightly slower. For eg `q4_1, q5_1` So try out `--che-type-k q4_1`

You can also quantize the V cache, but you will need to **compile llama.cpp with Flash Attention** support via `-DGGML_CUDA_FA_ALL_QUANTS=ON`, and use `--flash-attn` to enable it. After installing Flash Attention, you can then use `--cache-type-v q4_1`&#x20;

If you are using our Dynamic FP8 quants [#fp8-qwen3-coder-next-in-vllm](#fp8-qwen3-coder-next-in-vllm "mention")then using FP8 KV cache quantization can make context length support double approximately. Add `--kv-cache-dtype fp8`

### :triangular\_ruler:Benchmarks

Qwen3-Coder-Next is the best performing model for its size, and its performance is comparable to models with 10–20× more active parameters.

<table data-full-width="true"><thead><tr><th>Benchmark</th><th align="right">Qwen3-Coder-Next (80B)</th><th align="right">DeepSeek-V3.2 (671B)</th><th align="right">GLM-4.7 (358B)</th><th align="right">MiniMax M2.1 (229B)</th></tr></thead><tbody><tr><td>SWE-Bench Verified (w/ SWE-Agent)</td><td align="right">70.6</td><td align="right0.2</td><td align="right">74.2</td><td align="right">74.8</td></tr><tr><td>SWE-Bench Multilingual (w/ SWE-Agent)</td><td align="right">62.8</td><td align="right">62.3</td><td align="right">63.7</td><td align="right">66.2</td></tr><tr><td>SWE-Bench Pro (w/ SWE-Agent)</td><td align="right">44.3</td><td align="right">40.9</td><td align="right">40.6</td><td align="right">34.6</td></tr><tr><td>Terminal-Bench 2.0 (w/ Terminus-2 json)</td><td align="right">36.2</td><td align="right">39.3</td><td align="right">37.1</td><td align="right">32.6</td></tr><tr><td>Aider</td><td align="right">66.2</td><td align="right">69.9</td><td align="right">52.1</td><td align="right">61.0</td></tr></tbody></table>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2F0M7glBoWyRQjHUgaVEev%2Fbenchmarks.png?alt=media&#x26;token=d215bbcb-358e-41c4-9f27-66df8d3d94d8" alt=""><figcaption></figcaption></figure>

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FKxPCUD7NhqHFwFcsmgfb%2Fswebench_pro.png?alt=media&#x26;token=eb895603-6176-43d4-aa4d-9d127ef61381" alt="" width="563"><figcaption></figcaption></figure>
