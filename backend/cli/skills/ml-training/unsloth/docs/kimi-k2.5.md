# Kimi K2.5: How to Run Locally Guide

Kimi-K2.5 is the new model by Moonshot which achieves SOTA performance in vision, coding, agentic and chat tasks. The 1T parameter hybrid reasoning model requires 600GB of disk space, while the quantized **Unsloth Dynamic 1.8-bit** version reduces this to 240GB (-60% size)**:** [**Kimi-K2.5-GGUF**](https://huggingface.co/unsloth/Kimi-K2.5-GGUF)

All uploads use Unsloth [Dynamic 2.0](https://unsloth.ai/docs/basics/unsloth-dynamic-2.0-ggufs) for SOTA Aider and 5-shot MMLU performance. See how our Dynamic 1–2 bit GGUFs perform on [coding benchmarks](https://unsloth.ai/docs/basics/unsloth-dynamic-2.0-ggufs/unsloth-dynamic-ggufs-on-aider-polyglot).

### :gear: Recommended Requirements

{% hint style="info" %}
You need >**240GB of disk space** to run the 1-bit quant!

The only requirement is **`disk space + RAM + VRAM ≥ 240GB`**. That means you do not need to have that much RAM or VRAM (GPU) to run the model, but it will be much slower.
{% endhint %}

The 1.8-bit (Q1\_0) quant will run on a single 24GB GPU if you offload all MoE layers to system RAM (or a fast SSD). With \~256GB RAM, expect \~10 tokens/s. The full Kimi K2.5 model is 630GB and typically requires at least 4× H200 GPUs.

If the model fits, you will get >40 tokens/s when using a B200.

To run the model in near **full precision**, you can use the 4-bit or 5-bit quants. You can use any higher just to be safe.

For strong performance, aim for >240GB of unified memory (or combined RAM+VRAM) to reach 10+ tokens/s. If you’re below that, it'll work but speed will drop (llama.cpp can still run via mmap/disk offload) and may fall from \~10 tokens/s to <2 token/s.

We recommend UD-Q2\_K\_XL (375GB) as a good size/quality balance. Best rule of thumb: RAM+VRAM ≈ the quant size; otherwise it’ll still work, just slower due to offloading.

## 🥝 Run Kimi K2.5 Guide

Kimi-K2.5 requires different sampling parameters for different use-cases.

Currently there is **no vision support** for the model but hopefully llill support it soon.

{% hint style="success" %}
**To run the model in full precision, you only need to use the 4-bit or 5-bit Dynamic GGUFs (e.g. UD\_Q4\_K\_XL) because the model was originally released in INT4 format.**

You can choose a higher-bit quantization just to be safe in case of small quantization differences, but in most cases this is unnecessary.
{% endhint %}

#### Kimi K2.5 differences to Kimi K2 Thinking

* Both models use a modified DeepSeek V3 MoE architecture.
* **`rope_scaling.beta_fast` K2.5 uses 32.0 vs K2 Thinking's 1.0.**
* MoonViT is the native‑resolution 200M parameter vision encoder. It's similar to the one used in  Kimi-VL-A3B-Instruct.

### 🌙 Usage Guide:

According to Moonshot AI, these are the recommended settings for Kimi K2.5 inference:

| Default Settings (Instant Mode)                                    | Thinking Mode                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| <mark style="background-color:green;">**temperature = 0.6**</mark> | <mark style="background-color:green;">**temperature = 1.0**</mark> |
| <mark style="background-color:green;">**top\_p = 0.95**</mark>     | <mark style="background-color:green;">**top\_p = 0.95**</mark>     |
| min\_p = 0.01                                                      | min\_p = 0.01                                                      |

* Set the **temperature 1.0** to reduce repetition and incoherence.
* Suggested context length = 98,304 (up to 256K)
* Note: Using different tools may require different settings

{% hint style="info" %}
We recommend setting <mark style="background-color:green;">**min\_p to 0.01**</mark> to suppress the occurrence of unlikely tokens with low probabilities. And **disable or set repeat penalty = 1.0** if needed.
{% endhint %}

#### Chat Template for Kimi K2.5

Running `tokenizer.apply_chat_template([{"role": "user", "content": "What is 1+1?"},])` gets:

{% code overflow="wrap" %}

```
<|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|><|im_user|>user<|im_middle|>What is 1+1?<|im_end|><|im_assistant|>assistant<|im_middle|><think>
```

{% endcode %}

### ✨ Run Kimi K2.5 in llama.cpp

For this guide we'll be running the smallest 1-bit quant which is 240GB in size. Feel free to change quantization type to 2-bit, 3-bit etc. To run the model in near **full precision**, you can use the 4-bit or 5-bit quants. You can use any higher just to be safe.

1. Obtain the latest `llama.cpp` on [GitHub here](https://github.com/ggml-org/llama.cpp). You can follow the build instructions below as well. Change `-DGGML_CUDA=ON` to `-DGGML_CUDA=OFF` if you don't have a GPU or just want CPU inference.

```bash
apt-get update
apt-get install pciutils build-essential cmake curl libcurl4-openssl-dev -y
git clone https://github.com/ggml-org/llama.cpp
cmake llama.cpp -B llama.cpp/build \
    -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON
cmake --build ama.cpp/build --config Release -j --clean-first --target llama-cli llama-mtmd-cli llama-server llama-gguf-split
cp llama.cpp/build/bin/llama-* llama.cpp
```

2. If you want to use `llama.cpp` directly to load models, you can do the below: (:UD-TQ1\_0) is the quantization type. You can also download via Hugging Face (point 3). This is similar to `ollama run` . Use `export LLAMA_CACHE="folder"` to force `llama.cpp` to save to a specific location.

{% hint style="success" %}
`LLAMA_SET_ROWS=1` makes llama.cpp a little bit faster! Use it! `--fit on` auto fits models on all your GPUs and CPUs optimally.
{% endhint %}

```bash
export LLAMA_CACHE="unsloth/Kimi-K2.5-GGUF"
LLAMA_SET_ROWS=1 ./llama.cpp/llama-cli \
    -hf unsloth/Kimi-K2.5-GGUF:UD-TQ1_0\
    --temp 1.0 \
    --min-p 0.01 \
    --top-p 0.95 \
    --ctx-size 16384 \
    --seed 3407 \
    --fit on \
    --jinja
```

3. `--fit on` will auto fit the model to your system. If not using `--fit on` and you have around 360GB of combined GPU memory, remove `-ot ".ffn_.*_exps.=CPU"` to get maximum speed.

{% hint style="info" %}
Use `--fit on` for auto fitting on GPUs and CPUs. If this doesn't work, then see below:

Please try out `-ot ".ffn_.*_exps.=CPU"` to offload all MoE layers to the CPU! This effectively allows you to fit all non MoE layers on 1 GPU, improving generation speeds. You can customize the regex expression to fit more layers if you have more GPU capacity.

If you have a bit more GPU memory, try `-ot ".ffn_(up|down)_exps.=CPU"` This offloads up and down projection MoE layers.

Try `-ot ".ffn_(up)_exps.=CPU"` if you have even more GPU memory. This offloads only up projection MoE layers.

And finally offload all layers via `-ot ".ffn_.*_exps.=CPU"` This uses the least VRAM.

You can also customize the regex, for example `-ot "\.(6|7|8|9|[0-9][0-9]|[0-9][0-9][0-9])\.ffn_(gate|up|down)_exps.=CPU"` means to offload gate, up and down MoE layers but only from the 6th layer onwards.
{% endhint %}

3. Download the model via (after installing `pip install huggingface_hub hf_transfer` ). We recommend using our 2bit dynamic quant UD-Q2\_K\_XL to balance size and accuracy. All versions at: [huggingface.co/unsloth/Kimi-K2.5-GGUF](https://huggingface.co/unsloth/Kimi-K2.5-GGUF)

{% code overflow="wrap" %}

```bash
pip install -U huggingface_hub
hf download unsloth/Kimi-K2.5-GGUF \
    --local-dir unsloth/Kimi-K2.5-GGUF \
    --include "*UD-TQ1_0*" # Use "*UD-Q2_K_XL*" for Dynamic 2bit
```

{% endcode %}

{% hint style="info" %}
If you find that downloads get stuck at 90 to 95% or so, please see our [troubleshooting guide](https://docs.unsloth.ai/basics/troubleshooting-and-faqs#downloading-gets-stuck-at-90-to-95).
{% endhint %}

4. Run any prompt.
5. Edit  `--ctx-size 16384` for context length. You can also leave this out for auto context length discovery via `--fit on`

{% code overflow="wrap" %}

```bash
LLAMA_SET_ROWS=1 ./llama.cpp/llama-cli \
    --model unsloth/Kimi-K2.5-GGUF/UD-TQ1_0/Kimi-K2.5-UD-TQ1_0-00001-of-00005.gguf \
    --temp 1.0 \
    --min_p 0.01 \
    --top-p 0.95 \
    --ctx-size 16384 \
    --seed 3407 \
    --fit on \
    --jinja
```

{% endcode %}

6. As an example try: "Create a Flappy Bird game in HTML", and you will get:

{% columns %}
{% column width="33.33333333333333%" %}

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FwgHfM2RE4JaK2shbPLWj%2Fimage.png?alt=media&#x26;token=ae7e5bae-b4b5-45d8-a126-adc3695e36ad" alt="" width="188"><figcaption></figcaption></figure>
{% endcolumn %}

{% column width="66.66666666666667%" %}
{% code expandable="true" %}

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flappy Bird</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            background: #222;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            font-family: 'Segoe UI', sans-serif;
            overflow: hidden;
            touch-action: none;
        }
        
        #game-container {
            position: relative;
            width: 400px;
            height: 600px;
            background: linear-gradient(to bottom, #70c5ce 0%, #70c5ce 80%, #c23810 80%, #c23810 100%);
            box-shadow: 0 0 20px rgba(0,0,0,0.5);
            overflow: hidden;
        }
        
        canvas {
            display: block;
        }
        
        .overlay {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            text-align: center;
            color: white;
            text-shadow: 2px 2px 0 #000;
            font-weight: bold;
            pointer-events: none;
        }
        
        .game-title {
            font-size: 48px;
            margin-bottom: 20px;
        }
        
        .score-display {
            font-size: 36px;
            margin-bottom: 10px;
        }
        
        .best-score {
            font-size: 24px;
            color: #ffe;
        }
        
        .instruction {
            font-size: 20px;
            animation: pulse 1s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .hidden { display: none; }
    </style>
</head>
<body>
    <div id="game-container">
        <canvas id="canvas" width="400" height="600"></canvas>
        
        <!-- Start Screen -->
        <div id="start-screen" class="overlay">
            <div class="game-title">FLAPPY BIRD</div>
            <div class="instruction">Click or Space to Fly</div>
        </div>
        
        <!-- Game Over Screen -->
        <div id="game-over-screen" class="overlay hidden">
            <div class="game-title">GAME OVER</div>
            <div class="score-display">Score: <span id="final-score">0</span></div>
            <div class="best-score">Best: <span id="best-score">0</span></div>
            <div class="instruction">Click to Restart</div>
        </div>
        
        <!-- Score Counter -->
        <div id="current-score" class="overlay hidden" style="top: 10%; font-size: 72px; color: white; text-shadow: 4px 4px 0 #000;">
            0
        </div>
    </div>

    <script>
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        
        // Game constants
        const GRAVITY = 0.4;
        const JUMP_STRENGTH = -7;
        const PIPE_SPEED = 3;
        const PIPE_SPAWN_RATE = 120; // frames
        const PIPE_GAP = 120;
        
        // Game state
        let bird = { x: 50, y: 200, velocity: 0, radius: 15, wingState: 0 };
        let pipes = [];
        let score = 0;
        let bestScore = localStorage.getItem('flappyBest') || 0;
        let frameCount = 0;
        let isGameOver = false;
        let isPlaying = false;
        
        // DOM elements
        const startScreen = document.getElementById('start-screen');
        const gameOverScreen = document.getElementById('game-over-screen');
        const currentScoreDisplay = document.getElementById('current-score');
        const finalScoreEl = document.getElementById('final-score');
        const bestScoreEl = document.getElementById('best-score');
        
        // Input handling
        function handleInput(e) {
            if (!isPlaying) {
                if (isGameOver) {
                    resetGame();
                }
                startGame();
            } else if (!isGameOver) {
                bird.velocity = JUMP_STRENGTH;
                bird.wingState = 1;
            }
        }
        
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' || e.code === 'ArrowUp') handleInput(e);
        });
        canvas.addEventListener('pointerdown', handleInput);
        
        function startGame() {
            isPlaying = true;
            isGameOver = false;
            startScreen.classList.add('hidden');
            currentScoreDisplay.classList.remove('hidden');
            resetGameState();
            gameLoop();
        }
        
        function resetGameState() {
            bird = { x: 50, y: 200, velocity: 0, radius: 15, wingState: 0 };
            pipes = [];
            score = 0;
            frameCount = 0;
            currentScoreDisplay.textContent = score;
        }
        
        function resetGame() {
            isGameOver = false;
            isPlaying = true;
            gameOverScreen.classList.add('hidden');
            currentScoreDisplay.classList.remove('hidden');
            resetGameState();
            gameLoop();
        }
        
        function spawnPipe() {
            const minHeight = 100;
            const maxHeight = 400;
            const topHeight = Math.floor(Math.random() * (maxHeight - minHeight + 1) + minHeight);
            const bottomHeight = canvas.height - topHeight - PIPE_GAP;
            
            pipes.push({
                x: canvas.width,
                topHeight: topHeight,
                bottomY: topHeight + PIPE_GAP,
                bottomHeight: bottomHeight,
                passed: false
            });
        }
        
        function update() {
            if (isGameOver) return;
            
            // Bird physics
            bird.velocity += GRAVITY;
            bird.y += bird.velocity;
            
            // Floor/ceiling collision
            if (bird.y + bird.radius > canvas.height || bird.y - bird.radius < 0) {
                gameOver();
                return;
            }
            
            // Pipe spawning
            frameCount++;
            if (frameCount % PIPE_SPAWN_RATE === 0) {
                spawnPipe();
            }
            
            // Pipe movement and collision
            for (let i = pipes.length - 1; i >= 0; i--) {
                const pipe = pipes[i];
                pipe.x -= PIPE_SPEED;
                
                // Remove off-screen pipes
                if (pipe.x + 60 < 0) {
                    pipes.splice(i, 1);
                    continue;
                }
                
                // Collision detection (simplified rect-circle)
                const pipeWidth = 60;
                const pipeX = pipe.x;
                const pipeLeft = pipeX;
                const pipeRight = pipeX + pipeWidth;
                
                // Bird is circle, pipes are rects
                const birdLeft = bird.x - bird.radius + 4; // +4 for beak offset
                const birdRight = bird.x + bird.radius + 2;
                const birdTop = bird.y - bird.radius;
                const birdBottom = bird.y + bird.radius;
                
                // Horizontal collision check
                if (birdRight > pipeLeft && birdLeft < pipeRight) {
                    // Top pipe collision
                    if (birdTop < pipe.topHeight) {
                        gameOver();
                        return;
                    }
                    // Bottom pipe collision
                    if (birdBottom > pipe.bottomY) {
                        gameOver();
                        return;
                    }
                }
                
                // Score counting
                if (pipe.x + pipeWidth < bird.x && !pipe.passued) {
                    pipe.passed = true;
                    score++;
                    currentScoreDisplay.textContent = score;
                }
            }
            
            // Animate wings
            if (bird.wingState > 0) {
                bird.wingState = (bird.wingState + 0.2) % 2;
            }
        }
        
        function draw() {
            // Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Draw pipes
            pipes.forEach(pipe => {
                // Top pipe
                ctx.fillStyle = '#46c';
                ctx.fillRect(pipe.x, 0, 60, pipe.topHeight);
                ctx.fillStyle = '#34a';
                ctx.fillRect(pipe.x, pipe.topHeight - 20, 60, 20); // Cap
                
                // Bottom pipe
                ctx.fillStyle = '#46c';
                ctx.fillRect(pipe.x, pipe.bottomY, 60, canvas.height - pipe.bottomY);
                ctx.fillStyle = '#34a';
                ctx.fillRect(pipe.x, pipe.bottomY - 20, 60, 20); // Cap
            });
            
            // Draw bird (circle with beak)
            ctx.fillStyle = '#e3bc4e';
            ctx.beginPath();
            ctx.arc(bird.x, bird.y, bird.radius, 0, Math.PI * 2);
            ctx.fill();
            
            // Beak
            ctx.fillStyle = '#e04c4c';
            ctx.beginPath();
            ctx.moveTo(bird.x + bird.radius - 4, bird.y - 4);
            ctx.lineTo(bird.x + bird.radius + 10, bird.y);
            ctx.lineTo(bird.x + bird.radius - 4, bird.y + 4);
            ctx.fill();
            
            // Eyes
            ctx.fillStyle = 'black';
            ctx.beginPath();
            ctx.arc(bird.x + 5, bird.y - 6, 3, 0, Math.PI * 2);
            ctx.fill();
            
            // Wings
            ctx.fillStyle = '#c4a';
            ctx.beginPath();
            ctx.ellipse(bird.x - 5, bird.y + 5, 10, 6, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        
        function gameOver() {
            isGameOver = true;
            isPlaying = false;
            
            // Update best score
            if (score > bestScore) {
                bestScore = score;
                localStorage.setItem('flappyBest', bestScore);
            }
            
            // Show game over screen
            currentScoreDisplay.classList.add('hidden');
            gameOverScreen.classList.remove('hidden');
            finalScoreEl.textContent = score;
            bestScoreEl.textContent = bestScore;
        }
        
        function gameLoop() {
            if (!isPlaying) return;
            
            update();
            draw();
            requestAnimationFrame(gameLoop);
        }
        
        // Initial draw
        draw();
    </script>
</body>
</html>
```

{% endcode %}
{% endcolumn %}
{% endcolumns %}

### ✨ Deploy with llama-server and OpenAI's completion library

{% hint style="success" %}
Using `--kv-unified` can make inference serving faster in llama.cpp! See <https://www.reddit.com/r/LocalLLaMA/comments/1qnwa33/glm_47_flash_huge_performance_improvement_with_kvu/>
{% endhint %}

After installing llama.cpp as per [#run-kimi-k2-thinking-in-llama.cpp](#run-kimi-k2-thinking-in-llama.cpp "mention"), you can use the below to launch an OpenAI compatible server:

{% code overflow="wrap" %}

```bash
LLAMA_SET_ROWS=1 ./llama.cpp/llama-server \
    --model unsloth/Kimi-K2.5-GGUF/UD-TQ1_0/Kimi-K2.5-UD-TQ1_0-00001-of-00005.gguf \
    --special \
    --alias "unsloth/Kimi-K2.5" \
    --min_p 0.01 \
    --ctx-size 16384 \
    --port 8001 \
    --fit on \
    --jinja \
    --kv-unified
```

{% endcode %}

Then use OpenAI's Python library after `pip install openai` :

```python
from openai import OpenAI
import json
openai_client = OnAI(
    base_url = "http://127.0.0.1:8001/v1",
    api_key = "sk-no-key-required",
)
completion = openai_client.chat.completions.create(
    model = "unsloth/Kimi-K2.5",
    messages = [{"role": "user", "content": "What is 1+1?"},],
)
print(completion.choices[0].message.content)
```

And we get:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FkltZYBKtXcy5TzKKvGzN%2Fimage.png?alt=media&#x26;token=d0a7c6e2-bac8-4d95-a5fa-446975dff581" alt="" width="563"><figcaption></figcaption></figure>

And in the other llama-server screen:

<figure><img src="https://3215535692-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FjwlPZF5cdLHaHYgOhna3%2Fimage.png?alt=media&#x26;token=602f1cbf-80bf-49ce-bbdb-21862d3d65fe" alt="" width="563"><figcaption></figcaption></figure>

### 📊 Benchmarks

You can view further below for benchmarks in table format:

<figure><img src="https://32155352-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FxhOjnexMCB3dmuQFQ2Zq%2Fuploads%2FxRTS9YSfD8G0d9KiXK3W%2Fkimi%20k25%20benchmarks.jpg?alt=media&#x26;token=b537ff73-136e-4bc6-ba76-0882ee30c72c" alt="" width="375"><figcaption></figcaption></figure>

#### Reasoning & Knowledge

| Benchmark           | Kimi K2.5 | GPT-5.2 | Claude 4.5 Opus | Gemini 3 Pro | DeepSeek V3.2 | Qwen3-VL-235B-A22B-Thinking |
| ------------------- | --------: | ------: | --------------: | -----------: | ------------: | --------------------------: |
| HLE-Full            |      30.1 |    34.5 |            30.8 |         37.5 |         25.1† |                           - |
| HLE-Full (w/ tools) |      50.2 |    45.5 |            43.2 |         45.8 |         40.8† |                           - |
| AIME 2025           |      96.1 |     100 |            92.8 |         95.0 |          93.1 |                           - |
| HMMT 2025 (Feb)     |      95.4 |    99.4 |          92.9\* |       97.3\* |          92.5 |                       - |
| IMO-AnswerBench     |      81.8 |    86.3 |          78.5\* |       83.1\* |          78.3 |                           - |
| GPQA-Diamond        |      87.6 |    92.4 |            87.0 |         91.9 |          82.4 |                           - |
| MMLU-Pro            |      87.1 |  86.7\* |          89.3\* |         90.1 |          85.0 |                           - |

#### Image & Video

| Benchmark            | Kimi K2.5 | GPT-5.2 | Claude 4.5 Opus | Gemini 3 Pro | DeepSeek V3.2 | Qwen3-VL-235B-A22B-Thinking |
| -------------------- | --------: | ------: | --------------: | -----------: | ------------: | --------------------------: |
| MMMU-Pro             |      78.5 |  79.5\* |            74.0 |         81.0 |             - |                        69.3 |
| CharXiv (RQ)         |      77.5 |    82.1 |          67.2\* |         81.4 |             - |                        66.1 |
| MathVision           |      84.2 |    83.0 |          77.1\* |       86.1\* |             - |                        74.6 |
| MathVista (mini)     |      90.1 |  82.8\* |          80.2\* |       89.8\* |             - |                        85.8 |
| ZeroBench            |         9 |     9\* |             3\* |          8\* |             - |                         4\* |
| ZeroBench (w/ tools) |        11 |     7\* |             9\* |         12\* |             - |                         3\* |
| OCRBench             |      92.3 |  80.7\* |          86.5\* |       90.3\* |             - |                        87.5 |
| OmniDocBench 1.5     |      88.8 |    85.7 |          87.7\* |         88.5 |             - |                      82.0\* |
| InfoVQA (val)        |      92.6 |    84\* |          76.9\* |       57.2\* |             - |                        89.5 |
| SimpleVQA            |      71.2 |  55.8\* |          69.7\* |       69.7\* |             - |                      56.8\* |
| WorldVQA             |      46.3 |    28.0 |            36.8 |         47.4 |             - |                        23.5 |
| VideoMMMU            |      86.6 |    85.9 |          84.4\* |         87.6 |             - |                        80.0 |
| MMVU                 |      80.4 |  80.8\* |            77.3 |         77.5 |             - |                        71.1 |
| MotionBench          |      70.4 |    64.8 |            60.3 |         70.3 |             - |                           - |
| VideoMME             |      87.4 |  86.0\* |               - |       88.4\* |             - |                        79.0 |
| LongVideoBench       |      79.8 |  76.5\* |          67.2\* |       77.7\* |             - |                      65.6\* |
| LVBench              |      75.9 |       - |               - |       73.5\* |             - |                        63.6 |

#### Coding

| Benchmark              | Kimi K2.5 | GPT-5.2 | Claude 4.5 Opus | Gemini 3 Pro | DeepSeek V3.2 | Qwen3-VL-235B-A22B-Thinking |
| ---------------------- | --------: | ------: | --------------: | -----------: | ------------: | --------------------------: |
| SWE-Bench Verified     |      76.8 |    80.0 |            80.9 |         76.2 |          73.1 |                           - |
| SWE-Bench Pro          |      50.7 |    55.6 |          55.4\* |            - |             - |                           - |
| SWE-Bench Multilingual |      73.0 |    72.0 |            77.5 |         65.0 |          70.2 |                           - |
| Terminal Bench 2.0     |      50.8 |    54.0 |            59.3 |         54.2 |          46.4 |                           - |
| PaperBench             |      63.5 |  63.7\* |          72.9\* |            - |          47.1 |                           - |
| CyberGym               |      41.3 |       - |            50.6 |       39.9\* |        17.3\* |                           - |
| SciCode                |      48.7 |    52.1 |            49.5 |         56.1 |          38.9 |                           - |
| OJBench (cpp)          |      57.4 |       - |          54.6\* |       68.5\* |        54.7\* |                           - |
| LiveCodeBench (v6)     |      85.0 |       - |          82.2\* |       87.4\* |          83.3 |                           - |

#### Long Context

| Benchmark    | Kimi K2.5 | GPT-5.2 | Claude 4.5 Opus | Gemini 3 Pro | DeepSeek V3.2 | Qwen3-VL-235B-A22B-Thinking |
| ------------ | --------: | ------: | --------------: | -----------: | ------------: | --------------------------: |
| Longbench v2 |      61.0 |  54.5\* |          64.4\* |       68.2\* |        59.8\* |                           - |
| AA-LCR       |      70.0 |  72.3\* |          71.3\* |       65.3\* |        64.3\* |                           - |

#### Agentic Search

| Benchmark                        | Kimi K2.5 | GPT-5.2 | Claude 4.5 Opus | Gemini 3 Pro | DeepSeek V3.2 | Qwen3-VL-235B-A22B-Thinking |
| -------------------------------- | --------: | ------: | --------------: | -----------: | ------------: | --------------------------: |
| BrowseComp                       |      60.6 |    65.8 |            37.0 |         37.8 |          51.4 |                           - |
| BrowseComp (w/ctx manage)        |      74.9 |    65.8 |            57.8 |         59.2 |          67.6 |                           - |
| BrowseComp (Agent Swarm)         |      78.4 |       - |               - |            - |             - |                           - |
| WideSearch (item-f1)             |      72.7 |       - |          76.2\* |         57.0 |        32.5\* |                           - |
| WideSearch (item-f1 Agent Swarm) |      79.0 |       - |               - |            - |             - |                           - |
| DeepSearchQA                     |      77.1 |  71.3\* |          76.1\* |       63.2\* |        60.9\* |                           - |
| FinSearchCompT2\&T3              |      67.8 |       - |          66.2\* |         49.9 |        59.1\* |                           - |
| Seal-0                           |      57.4 |    45.0 |          47.7\* |       45.5\* |        49.5\* |                           - |

#### Notes

* `*` = score re-evaluated by the authors (not publicly available previously).
* `†` = DeepSeek V3.2 score corresponds to its text-only subset (as noted in the footnotes).
* `-` = not evaluated / not available.