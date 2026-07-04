# GLM-4.7-Flash: How To Run Locally

GLM-4.7-Flash is Z.ai’s new 30B MoE reasoning model built for local deployment, delivering best-in-class performance for coding, agentic workflows, and chat. It uses \~3.6B parameters, supports 200K context, and leads SWE-Bench, GPQA, and reasoning/chat benchmarks.

GLM-4.7-Flash runs on **24GB RAM**/VRAM/unified memory (32GB for full precision), and you can now fine-tune with Unsloth. To run GLM 4.7 Flash with vLLM, see [#glm-4.7-flash-in-vllm](#glm-4.7-flash-in-vllm "mention")

{% hint style="success" %}
Jan 21 update: `llama.cpp` fixed a bug specifying the wrong `scoring_func`: `"softmax"` (should be `"sigmoid"`). This caused looping and poor outputs. We updated the GGUFs - please re-download the model for much better outputs.

You can now use Z.ai’s recommended parameters and get great results:

* **For general use-case:** `--temp 1.0 --top-p 0.95`
* **For tool-calling:** `--temp 0.7 --top-p 1.0`
* **Repeat penalty:** Disable it, or set `--repeat-penalty 1.Jan 22: Faster inference is here as the FA fix for CUDA is now merged.
{% endhint %}

<a href="#run-glm-4.7-flash" class="button primary">Running Tutorial</a><a href="#fine-tuning-glm-4.7-flash" class="button secondary">Fine-tuning</a>

GLM-4.7-Flash GGUF to run: [unsloth/GLM-4.7-Flash-GGUF](https://huggingface.co/unsloth/GLM-4.7-Flash-GGUF)

### ⚙️ Usage Guide

After speaking with the Z.ai's team, they recommend using their GLM-4.7 sampling parameters:

| Default Settings (Most Tasks)                                      | Terminal Bench, SWE Bench Verified                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| <mark style="background-color:green;">**temperature = 1.0**</mark> | <mark style="background-color:green;">**temperature = 0.7**</mark> |
| <mark style="background-color:green;">**top\_p = 0.95**</mark>     | <mark style="background-color:green;">**top\_p = 1.0**</mark>      |epeat penalty = disabled or 1.0                                   | repeat penalty = disabled or 1.0                                   |

* For general use-case:  `--temp 1.0 --top-p 0.95`
* For tool-calling:  `--temp 0.7 --top-p 1.0`
* If using llama.cpp, set `--min-p 0.01` as llama.cpp's default is 0.05
* Sometimes you'll need to experiment what numbers work best for your use-case.

{% hint style="warning" %}
For now, we **don’t recommend** running this GGUF with **Ollama** due to potential chat template compatibility issues. The GGUF works well on llama.cpp (or backends e.g. LM Studio, Jan).

**Remember to disable repeat penalty! Or set** `--repeat-penalty 1.0`
{% endhint %}

* **Maximum context window:** `202,752`
* Use `--jinja` for llama.cpp variants

### 🖥️ Run GLM-4.7-Flash

Depending on your use-case you will need to use different settings. Some GGUFs end up similar in size because the model architecture (like [gpt-oss](https://unsloth.ai/docs/models/gpt-oss-how-to-run-and-fine-tune)) has dins not divisible by 128, so parts can’t be quantized to lower bits.

Because this guide uses 4-bit, you will need around 18GB RAM/unified memory. We recommend using at least 4-bit precision for best performance.

{% hint style="warning" %}
For now, we **don’t recommend** running this GGUF with **Ollama** due to potential chat template compatibility issues. The GGUF works well on llama.cpp (or backends e.g. LM Studio, Jan).

**Remember to disable repeat penalty! Or set** `--repeat-penalty 1.0`
{% endhint %}

#### Llama.cpp Tutorial (GGUF):

Instructions to run in llama.cpp (note we will be using 4-bit to fit most devices):

{% stepper %}
{% step %}
Obtain the latest `llama.cpp` on [GitHub here](https://github.com/ggml-org/llama.cpp). You can follow the build instructions below as well. Change `-DGGML_CUDA=ON` to `-DGGML_CUDA=OFF` if you don't have a GPU or just want CPU inference.

{% code overflow="wrap" %}

```bash
apt-get update
apt-get install pciutils build-essential cmake curl libcurl4-openssl-dev it clone https://github.com/ggml-org/llama.cpp
cmake llama.cpp -B llama.cpp/build \
    -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON
cmake --build llama.cpp/build --config Release -j --clean-first --target llama-cli llama-mtmd-cli llama-server llama-gguf-split
cp llama.cpp/build/bin/llama-* llama.cpp
```

{% endcode %}
{% endstep %}

{% step %}
You can directly pull from Hugging Face. You can increase the context to 200K as your RAM/VRAM allows.

You can also try Z.ai's recommended GLM-4.7 sampling parameters:

* For general use-case:  `--temp 1.0 --top-p 0.95`
* For tool-calling:  `--temp 0.7 --top-p 1.0`
* **Remember to disable repeat penalty!**

Follow this for **general instruction** use-cases:

```bash
./llama.cpp/llama-cli \
    -hf unsloth/GLM-4.7-Flash-GGUF:UD-Q4_K_XL \
    --jinja --ctx-size 16384 \
    --temp 1.0 --top-p 0.95 --min-p 0.01 --fit on
```

Follow this for **tool-calling** use-cases:

```bash
./llama.cpp/llama-cli \
    -hf unsloth/GLM-4.7-Flash-GGUF:UD-Q4_K_XL \
    --jinja --ctx-size 16384 \
    --temp 0.7 --top-p 1.0 --min-p 0.01 --fit on
```

{% endstep %}

{% step %}
Download the model via (after installing `pip install huggingface_hub`). You can choose `UD-Q4_K_XL` or other quantized versions.

{% code overflow="wrap" %}

```bash
pip install -U huggingface_hub
hf download unsloth/GLM-4.7-Flash-GGUF \
    --local-dir unsloth/GLM-4.7-Flash-GGUF \
    --include "*UD-Q2_K_XL*"
```

{% endcode %}
{% endstep %}

{% step %}
Then run the model in conversation mode:

{% code overflow="wrap" %}

```bash
./llama.cpp/llama-cli \
    --model unsloth/GLM-4.7-Flash-GGUF/GLM-4.7-Flash-UD-Q4_K_XL.gguf \
    --ctx-size 16384 \
    --fit on \
    --seed 3407 \
    --temp 1.0 \
    --top-p 0.95 \
    --min-p 0.01 \
    --jinja
```

{% endcode %}

Also, adjust **context window** as required, up to `202752`
{% endstep %}
{% endstepper %}

### :loop:Reducing repetition and looping

{% hint style="success" %}
**JAN 21 UPDATE: llama.cpp fixed a bug specifying the wrong** `"scoring_func": "softmax"` **that caused looping and poor outputs (should be sigmoid) We updated the GGUFs. Please re-download the model for much better outputs.**
{% endhint %}

This means you can now use Z.ai's recommended parameters and get great results:

* For general use-case:  `--temp 1.0 --top-p 0.95`
* For tool-calling:  `--temp 0.7 --top-p 1.0`
* If using llama.cpp, set `--min-p 0.01` as llama.cpp's default is 0.05
* **Remember to disable repeat penalty! Or set** `--repeat-penalty 1.0`

We added `"scoring_func": "sigmoid"` to `config.json` for the main model - [see](https://huggingface.co/unsloth/GLM-4.7-Flash/commit/3fd53b491e04f707f307aef2f70f8a7520511e6d).

{% hint style="warning" %}
For now, we **don’t recommend** running this GGUF with **Ollama** due to potential chat template compatibility issues. The GGUF works well on llama.cpp (or backends e.g. LM Studio, Jan).
{% endhint %}

### :bird:Flappy Bird Example with UD-Q4\_K\_XL

As an example, we did the following long conversation by using UD-Q4\_K\_XL via `./llama.cpp/llama-cli model unsloth/GLM-4.7-Flash-GGUF/GLM-4.7-Flash-UD-Q4_K_XL.gguf --fit on --temp 1.0 --top-p 0.95 --min-p 0.01 --jinja` :

```
Hi
What is 2+2
Create a Python Flappy Bird game
Create a totally different game in Rust
Find bugs in both
Make the 1st game I mentioned but in a standalone HTML file
Find bugs and show the fixed game
```

which rendered the following Flappy Bird game in HTML form:

<details>

<summary>Flappy Bird Game in HTML (Expandable)</summary>

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Flappy Bird Fixed</title>
    <style>
        body {
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background-color: #222;
            font-family: 'Arial', sans-serif;
            overflow: hidden;
            user-select: none;
            -webkit-user-select: none;
            touch-action: none; /* Prevents zoom on mobile */
        }

        #game-container {
            position: relative;
            box-shadow: 0 0 20px rgba(0,0,0,0.5);
        }

        canvas {
            background-color: #87CEEB;
            display: block;
            border-radius: 4px;
        }

        /* UI Overlays */
        #ui-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            text-align: center;
        }

        #score-display {
            position: absolute;
            top: 40px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 48px;
            font-weight: bold;
            color: white;
            text-shadow: 3px 3px 0 #000;
            z-index: 10;
            font-family: 'Courier New', Courier, monospace;
        }

        #start-screen, #game-over-screen {
            background: rgba(0, 0, 0, 0.7);
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            color: white;
            pointer-events: auto; /* Allow clicks */
            cursor: pointer;
        }

        h1 { margin: 0 0 10px 0; font-size: 60px; text-shadow: 4px 4px 0 #000; line-height: 1; }
        p { font-size: 22px; margin: 10px 0; color: #ddd; }
        
        .btn {
            background: linear-gradient(to bottom, #ffeb3b, #fbc02d);
            border: 3px solid #fff;
            color: #333;
            padding: 15px 40px;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
            border-radius: 8px;
            box-shadow: 0 6px 0 #c49000, 0 10px 10px rgba(0,0,0,0.3);
            text-transform: uppercase;
            transition: all 0.1s;
            margin-top: 10px;
        }

        .btn:active {
            transform: translateY(4px);
            box-shadow: 0 2px 0 #c49000, 0 4px 4px rgba(0,0,0,0.3);
        }

        .score-board {
            background: #ded895;
            border: 2px solid #543847;
            padding: 20px 40px;
            border-radius: 10px;
            box-shadow: 4px 4px 0 #543847;
            margin-bottom: 30px;
            display: none;
            border: 4px solid #543847;
        }
        
        .score-board h2 { margin: 0 0 5px 0; color: #e86101; font-size: 40px; }
        .score-board span { font-size: 20px; color: #543847; display: block; text-align: center; }

    </style>
</head>
<body>

    <div id="game-container">
        <canvas id="gameCanvas" width="400" height="600"></canvas>
        
        <div id="score-display">0</div>

        <div id="ui-layer">
            <div id="start-screen">
                <h1>FLAPPY<br>BIRD</h1>
                <p>Tap or Press Space to Start</p>
                <button class="btn" style="display:none;" id="touch-instruction">Click to Start</button>
            </div>

            <div id="game-over-screen">
                <h1>GAME OVER</h1>
                <div class="score-board" id="score-board">
                    <h2>Score: <span id="final-score">0</span></h2>
                </div>
                <button class="btn" id="restart-btn">Try Again</button>
            </div>
        </div>
    </div>

<script>
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');

    // --- Constants ---
    const GRAVITY = 0.35; // Slightly harder gravity for better feel
    const JUMP_STRENGTH = -6.5;
    const PIPE_GAP = 180;
    const PIPE_WIDTH = 60;
    const PIPE_SPEED = 2.5;
    const PIPE_SPAWN_RATE = 100;

    // --- State ---
    let frames = 0;
    let score = 0;
    let isGameOver = false;
    let isPlaying = false;
    let gameLoopId;

    const ui = {
        startScreen: document.getElementById('start-screen'),
        gameOverScreen: document.getElementById('game-over-screen'),
        scoreDisplay: document.getElementById('score-display'),
        scoreBoard: document.getElementById('score-board'),
        finalScore: document.getElementById('final-score'),
        restartBtn: document.getElementById('restart-btn')
    };

    const bird = {
        x: 80,
        y: 150,
        radius: 12, // Fixed radius
        velocity: 0,
        
        draw: function() {
            // Rotate bird based on velocity for visual flair
            let angle = Math.min(Math.PI / 4, Math.max(-Math.PI / 4, (this.velocity * 0.1)));
            
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.rotate(angle);
            
            // Draw Body
            ctx.fillStyle = '#FFD700';
            ctx.beginPath();
            ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
            ctx.fill();
            
            // Eye
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(4, -4, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'black';
            ctx.beginPath();
            ctx.arc(6, -4, 2, 0, Math.PI * 2);
            ctx.fill();
            
            // Wing
            ctx.fillStyle = '#FFA500';
            ctx.beginPath();
            ctx.arc(-4, 4, 5, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        },

        update: function() {
            this.velocity += GRAVITY;
            this.y += this.velocity;
        },

        jump: function() {
            this.velocity = JUMP_STRENGTH;
        },

        reset: function() {
            this.y = 150;
            this.velocity = 0;
        }
    };

    let pipes = [];

    function createPipe() {
        const minHeight = 50;
        const maxPos = canvas.height - PIPE_GAP - minHeight;
        const topHeight = Math.floor(Math.random() * (maxPos - minHeight + 1)) + minHeight;
        
        pipes.push({
            x: canvas.width,
            topHeight: topHeight,
            bottomY: topHeight + PIPE_GAP,
            width: PIPE_WIDTH,
            passed: false
        });
    }

    function drawPipes() {
        ctx.fillStyle = '#2ecc71';
        ctx.strokeStyle = '#27ae60';
        ctx.lineWidth = 2;
        
        pipes.forEach(pipe => {
            // Top Pipe
            ctx.fillRect(pipe.x, 0, pipe.width, pipe.topHeight);
            ctx.strokeRect(pipe.x, 0, pipe.width, pipe.topHeight);
            
            // Bottom Pipe
            ctx.fillRect(pipe.x, pipe.bottomY, pipe.width, canvas.height - pipe.bottomY);
            ctx.strokeRect(pipe.x, pipe.bottomY, pipe.width, canvas.height - pipe.bottomY);

            // Cap
            const capH = 20;
            ctx.fillStyle = '#27ae60'; 
            ctx.fillRect(pipe.x - 2, pipe.topHeight - capH, pipe.width + 4, capH);
            ctx.fillRect(pipe.x - 2, pipe.bottomY, pipe.width + 4, capH);
        });
    }

    function updatePipes() {
        if (frames % PIPE_SPAWN_RATE === 0) createPipe();

        for (let i = 0; i < pipes.length; i++) {
            let p = pipes[i];
            p.x -= PIPE_SPEED;

            // --- FIXED COLLISION DETECTION ---
            // Treat bird as a circle of radius 'bird.radius'
            // Pipe is a rect: x, x+w, y_top, y_bottom
            let birdLeft = bird.x - bird.radius;
            let birdRight = bird.x + bird.radius;
            let birdTop = bird.y - bird.radius;
            let birdBottom = bird.y + bird.radius;

            // Horizontal Overlap
            if (birdRight > p.x && birdLeft < p.x + p.width) {
                // Vertical Overlap (Hit Top Pipe OR Hit Bottom Pipe)
                if (birdTop < p.topHeight || birdBottom > p.bottomY) {
                    gameOver();
                }
            }

            // --- FIXED SCORING ---
            // If pipe is off screen to the left, and hasn't been scored
            if (p.x + p.width < 0 && !p.passed) {
                score++;
                p.passed = true;
                ui.scoreDisplay.innerText = score;
            }

            if (p.x < -60) {
                pipes.shift();
                i--;
            }
        }
    }

    function checkCollisions() {
        // Floor
        if (bird.y + bird.radius >= canvas.height) {
            gameOver();
        }
        // Ceiling
        if (bird.y - bird.radius <= 0) {
            bird.y = bird.radius;
            bird.velocity = 0;
        }
    }

    function drawBackground() {
        // Clear
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Floor
        ctx.fillStyle = '#654321';
        ctx.fillRect(0, canvas.height - 10, canvas.width, 10);
        
        // Clouds
        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        for(let i=0; i<4; i++) {
            let x = (frames * 0.5 + i * 150) % (canvas.width + 100) - 50;
            let y = (i * 40) + 20;
            let scale = 1 + (Math.sin(frames * 0.02 + i) * 0.1);
            let size = 30 * scale;
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.arc(x + 20*scale, y - 10*scale, size * 1.2, 0, Math.PI * 2);
            ctx.arc(x + 40*scale, y, size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function update() {
        if (!isPlaying) return;
        bird.update();
        updatePipes();
        checkCollisions();
        frames++;
    }

    function draw() {
        drawBackground();
        drawPipes();
        bird.draw();
    }

    function loop() {
        update();
        draw();
        if (isPlaying || !isGameOver) {
            gameLoopId = requestAnimationFrame(loop);
        }
    }

    function startGame() {
        isPlaying = true;
        isGameOver = false;
        
        // UI
        ui.startScreen.style.display = 'none';
        ui.gameOverScreen.style.display = 'none';
        ui.scoreBoard.style.display = 'none';
        
        // Logic
        bird.reset();
        pipes = [];
        score = 0;
        frames = 0;
        ui.scoreDisplay.innerText = '0';
        
        loop();
    }

    function gameOver() {
        isPlaying = false;
        isGameOver = true;
        cancelAnimationFrame(gameLoopId);
        
        ui.finalScore.innerText = score;
        ui.gameOverScreen.style.display = 'flex';
        ui.scoreBoard.style.display = 'block';
    }

    // --- Input Handling ---

    function handleInput(e) {
        if (e.type === 'keydown' && e.code === 'Space') e.preventDefault();

        if (isPlaying) {
            bird.jump();
        } else if (!isGameOver) {
            // Click on start screen (or any click if game hasn't started)
            startGame();
        }
    }

    // Keyboard
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') handleInput(e);
    });

    // Mouse / Touch
    window.addEventListener('mousedown', handleInput);
    window.addEventListener('touchstart', (e) => {
        // Prevent zoom/scroll
        // e.preventDefault(); 
        handleInput(e);
    }, {passive: false});

    // UI Interactions
    ui.restartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startGame();
    });
    
    // Allow clicking the Game Over overlay to restart
    ui.gameOverScreen.addEventListener('mousedown', (e) => {
        if(e.target === ui.gameOverScreen) startGame();
    });
    ui.gameOverScreen.addEventListener('touchstart', (e) => {
        if(e.target === ui.gameOverScreen) {
            e.preventDefault();
            startGame();
        }
    });

    // Initial Draw
    drawBackground();
    bird.reset();
    bird.draw();

</script>
</body>
</html>
```

</details>

And we took some screenshots (4bit works):

<div align="left"><figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FJ85uzHPDWinaXPe6kWyU%2Fimage.png?alt=media&#x26;token=6547f49d-2544-4c48-a7d5-5c1c67d34a87" alt="" width="188"><figcaption></figcaption></figure> <figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FHAc2SjNLo1OsyAC4dArm%2Fimage.png?alt=media&#x26;token=87d4bfea-4ac9-41ef-be1c-1e51664d30b1" alt="" width="188"><figcaption></figcaption></figure></div>

### 🦥 Fine-tuning GLM-4.7-Flash

Unsloth now supports fine-tuning of GLM-4.7-Flash, however you will need to use `transformers v5`. The 30B model does not fit on a free Colab GPU; however, you can use our notebook. 16-bit LoRA fine-tuning of GLM-4.7-Flash will use around **60GB VRAM**:

* [GLM-4.7-Flash SFT LoRA notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/GLM_Flash_A100\(80GB\).ipynb)

{% hint style="warning" %}
You may encounter out of memory sometimes when using A100 40GB VRAM. You will need to use H100/A100 80GB VRAM for smoother runs.
{% endhint %}

{% embed url="<https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/GLM_Flash_A100(80GB).ipynb>" %}

On fine-tung MoE's, it's probably not a good idea to fine-tune the router layer so we disabled it by default. If you want to maintain its reasoning capabilities (optional), you can use a mix of direct answers and chain-of-thought examples. Use at least <mark style="background-color:green;">75% reasoning</mark> and <mark style="background-color:green;">25% non-reasoning</mark> in your dataset to make the model retain its reasoning capabilities.

### 🦙Llama-server serving & deployment

To deploy GLM-4.7-Flash for production, we use `llama-server` In a new terminal say via tmux, deploy the model via:

{% code overflow="wrap" %}

```bash
./llama.cpp/llama-server \
    --model unsloth/GLM-4.7-Flash-GGUF/GLM-4.7-Flash-UD-Q4_K_XL.gguf \
    --alias "unsloth/GLM-4.7-Flash" \
    --fit on \
    --seed 3407 \
    --temp 1.0 \
    --top-p 0.95 \
    --min-p 0.01 \
    --ctx-size 16384 \
    --port 8001 \
    --jinja
```

{% endcode %}

Then in a new terminal, after doing `pip install openai`, do:

{% code overflow="wrap" %}

`python
from openai import OpenAI
import json
openai_client = OpenAI(
    base_url = "http://127.0.0.1:8001/v1",
    api_key = "sk-no-key-required",
)
completion = openai_client.chat.completions.create(
    model = "unsloth/GLM-4.7-Flash",
    messages = [{"role": "user", "content": "What is 2+2?"},],
)
print(completion.choices[0].message.content)
```

{% endcode %}

Which will print

{% code overflow="wrap" %}

```
User asks a simple question: "What is 2+2?" The answer is 4. Provide answer.

2 + 2 = 4.
```

{% endcode %}

### :computer: GLM-4.7-Flash in vLLM

You can now use our new [FP8 Dynamic quant](https://huggingface.co/unsloth/GLM-4.7-Flash-FP8-Dynamic) of the model for premium and fast inference. First install vLLM from nightly:

{% code overflow="wrap" %}

```bash
uv pip install --upgrade --force-reinstall vllm --torch-backend=auto --extra-index-url https://wheels.vllm.ai/nightly/cu130
uv pip install --upgrade --force-reinstall git+https://github.com/huggingface/transformers.git
uv pip instrce-reinstall numba
```

{% endcode %}

Then serve [Unsloth's dynamic FP8 version](https://huggingface.co/unsloth/GLM-4.7-Flash-FP8-Dynamic) of the model. We enabled FP8 to reduce KV cache memory usage by 50%, and on 4 GPUs. If you have 1 GPU, use `CUDA_VISIBLE_DEVICES='0'` and set `--tensor-parallel-size 1` or remove this argument. To disable FP8, remove `--quantization fp8 --kv-cache-dtype fp8`

```bash
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False
CUDA_VISIBLE_DEVICES='0,1,2,3' vllm serve unsloth/GLM-4.7-Flash-FP8-Dynamic \
    --served-model-name unsloth/GLM-4.7-Flash \
    --tensor-parallel-size 4 \
    --tool-call-parser glm47 \
    --reasoning-parser glm45 \
    --enable-auto-tool-choice \
    --dtype bfloat16 \
    --seed 3407 \
    --max-model-len 200000 \
    --gpu-memory-utilization 0.95 \
    --max_num_batched_tokens 16384 \
    --port 8001 \
    --kv-cache-dtype fp8
```

You can then call the served model via the OpenAI API:

```python
from openai import AsyncOpenAI, OpenAI
openai_api_key = "EMPTY"
openai_api_base = "http://localhost:8001/v1"
client = OpenAI( # or AsyncOpenAI
    api_key=openai_api_key,
    base_url=openai_api_base,
)
```

#### :star: vLLM GLM-4.7-Flash Speculative Decoding

We found using the MTP (multi token prediction) module from GLM 4.7 Flash makes generation throughput drop from 13,000 tokens on 1 B200 to 1,300 tokens! (10x slower) On Hopper, it should be fine hopefully.

```bash
    --speculative-config.method mtp \
    --speculative-config.num_speculative_tokens 1
```

Only 1,300 tokens / s throughput on 1xB200 (130 tokens / s decoding per user)

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FCJPJYh1uIS1yL8vskiOF%2Fimage.png?alt=media&#x26;token=f07aaad9-93bd-4507-836f-967a3d39b0e5" alt=""><figcaption></figcaption></figure>

And 13,000 tokens / s throughput  on 1xB200 (still 130 token /s decoding per user)

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FrXaHEknUb1QW1v0arO0q%2Fimage.png?alt=media&#x26;token=dd81b731-90bb-4d1b-a647-a64618f5952a" alt=""><figcaption></figcaption></figure>

### :hammer:Tool Calling with GLM-4.7-Flash

See [tool-calling-guide-for-local-llms](https://unsloth.ai/docs/basics/tool-calling-guide-for-local-llms "mention") for more details on how to do tool calling. In a new terminal (if using tmux, use CTRL+B+D), we create some tools like adding 2 numbers, executing Python code, executing Linux functions and much more:

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
    temperature = 0.7,
    top_p = 1.0,
    top_k = -1,
    repetition_penalty = 0.0,
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
            extra_body = {"top_k": top_k, "min_p": min_p, "dry_multiplier" :repetition_penalty,}
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

After launching GLM-4.7-Flash via `llama-server` like in [#deploy-with-llama-server-and-openais-completion-library](#deploy-with-llama-server-and-openais-completion-library "mention") or see [tool-calling-guide-for-local-llms](https://unsloth.ai/docs/basics/tool-calling-guide-for-local-llms "mention") for more details, we then can do some tool calls:

**Tool Call for mathematical operations for GLM 4.7**

{% code overflow="wrap" %}

```python
messages = [{
    "role": "user",
    "content": [{"type": "text", "text": "What is today's date plus 3 days?"}],
}]
unsloth_inference(messages, temperature = 1.0, top_p = 0.95, top_k = -1, min_p = 0.01)
```

{% endcode %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FoFkZ20QOSGdzT4iz2SOB%2Fimage.png?alt=media&#x26;token=e4ca30b0-dcec-4a26-b019-dd33f0600949" alt=""><figcaption></figcaption></figure>

**Tool Call to execute generated Python code for GLM-4.7-Flash**

{% code overflow="wrap" %}

```python
messages = [{
    "role": "user",
    "content": [{"type": "text", "text": "Create a Fibonacci function in Python and find fib(20)."}],
}]
unsloth_inference(messages, temperature = 1.0, top_p = 0.95, top_k = -1, min_p = 0.01)
```

{% endcode %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FhS8sWtZwjwerElezCc2C%2Fimage.png?alt=media&#x26;token=39032ef8-386e-4837-8dd2-c552c80a3ee3" alt="" width="563"><figcaption></figcaption></figure>

### Benchmarks

GLM-4.7-Flash is the best performing 30B model across all benchmarks except AIME 25.
