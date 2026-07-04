# Instal Unsloth via pip and uv

## **Recommended installation method**

**Install with pip (recommended) for the latest pip release:**

```bash
pip install unsloth
```

To use **uv**:

```bash
pip install --upgrade pip && pip install uv
uv pip install unsloth
```

To install **vLLM and Unsloth** together, do:

```bash
uv pip install unsloth vllm
```

To install the **latest main branch** of Unsloth, do:

{% code overflow="wrap" %}

```bash
pip install unsloth
pip uninstall unsloth unsloth_zoo -y && pip install --no-deps git+https://github.com/unslothai/unsloth_zoo.git && pip install --no-deps git+https://github.com/unslothai/unsloth.git
```

{% endcode %}

For **venv and virtual environments installs** to isolate your installation to not break system packages, and to reduce irreparable damage to your system, use venv:

{% code overflow="wrap" %}

```bash
apt install python3.10-venv python3.11-venv python3.12-venv python3.13-venv -y
python -m venv unsloth_env
source unsloth_env/bin/activate
pip install --upgrade pip && pip install uv
uv pip install unsloth
```

{% endcode %}

If you're installing Unsloth in Jupyter, Colab, or other notebooks, be sure to prefix the command with `!`. This isn't necessary when using a terminal

{% hint style="info" %}
Python 3.13 is now supported!
{% endhint %}

## Uninstall or Reinstall

If you're still encountering dependency issues with Unsloth, many users have resolved them by forcing uninstalling and reinstalling Unsloth:

{% code overflow="wrap" %}

```bash
pip install --upgrade --force-reinstall --no-cache-dir --no-deps unsloth
pip install --upgrade --force-reinstall --no-cache-dir --no-deps unsloth_zoo
```

{% endcode %}

***

## Advanced Pip Installation

{% hint style="warning" %}
Do **NOT** use this if you have [Conda](https://unsloth.ai/docs/get-started/install/conda-install).
{% endhint %}

Pip is a bit more complex since there are dependency issues. The pip command is different for `torch 2.2,2.3,2.4,2.5` and CUDA versions.

For other torch versions, we support `torch211`, `torch212`, `torch220`, `torch230`, `torch240` and for CUDA versions, we support `cu118` and `cu121` and `cu124`. For Ampere devices (A100, H100, RTX3090) and above, use `cu118-ampere` or `cu121-ampere` or `cu124-ampere`.

For example, if you have `torch 2.4` and `CUDA 12.1`, use:

```bash
pip install --upgrade pip
pip install "unsloth[cu121-torch240] @ git+https://github.com/unslothai/unsloth.git"
```

Another example, if you have `torch 2.5` and `CUDA 12.4`, use:

```bash
pip install --upgrade pip
pip install "unsloth[cu124-torch250] @ git+https://github.com/unslothai/unsloth.git"
```

And other examples:

```bash
pip install "unsloth[cu121-ampere-torch240] @ git+https://github.com/unslothai/unsloth.git"
pip install "unsloth[cu118-ampere-torch240] @ git+https://github.com/unslothai/unsloth.git"
pip install "unsloth[cu121-torch240] @ git+https://github.com/unslothai/unsloth.git"
pip install "unsloth[cu118-torch240] @ git+https://github.com/unslothai/unsloth.git"

pip install "unsloth[cu121-torch230] @ git+https://github.com/unslothai/unsloth.git"
pip install "unsloth[cu121-ampere-torch230] @ git+https://github.com/unslothai/unsloth.git"

pip install "unsloth[cu121-torch250] @ git+https://github.com/unslothai/unsloth.git"
pip install "unsloth[cu124-ampere-torch250] @ git+https://github.com/unslothai/unsloth.git"
```

Or, run the below in a terminal to get the **optimal** pip installation command:

```bash
wget -qO- https://raw.githubusercontent.com/unslothai/unsloth/main/unsloth/_auto_install.py | python -
```

Or, run the below manually in a Python REPL:

{% code overflow="wrap" %}

```python
# Licensed under the Apache License, Version 2.0 (the "License")
try: import torch
except: raise ImportError('Install torch via `pip install torch`')
from packaging.version import Version as V
import re
v = V(re.match(r"[0-9\.]{3,}", torch.__version__).group(0))
cuda = str(torch.version.cuda)
is_ampere = torch.cuda.get_device_capability()[0] >= 8
USE_ABI = torch._C._GLIBCXX_USE_CXX11_ABI
if cuda not in ("11.8", "12.1", "12.4", "12.6", "12.8", "13.0"): raise RuntimeError(f"CUDA = {cuda} not supported!")
if   v <= V('2.1.0'): raise RuntimeError(f"Torch = {v} too old!")
elif v <= V('2.1.1'): x = 'cu{}{}-torch211'
elif v <= V('2.1.2'): x = 'cu{}{}-torch212'
elif v  < V('2.3.0'): x = 'cu{}{}-torch220'
elif v  < V('2.4.0'): x = 'cu{}{}-torch230'
elif v  < V('2.5.0'): x = 'cu{}{}-torch240'
elif v  < V('2.5.1'): x = 'cu{}{}-torch250'
elif v <= V('2.5.1'): x = 'cu{}{}-torch251'
elif v  < V('2.7.0'): x = 'cu{}{}-torch260'
elif v  < V('2.7.9'): x = 'cu{}{}-torch270'
elif v  < V('2.8.0'): x = 'cu{}{}-torch271'
elif v  < V('2.8.9'): x = 'cu{}{}-torch280'
elif v  < V('2.9.1'): x = 'cu{}{}-torch290'
elif v  < V('2.9.2'): x = 'cu{}{}-torch291'
else: raise RuntimeError(f"Torch = {v} too new!")
if v > V('2.6.9') and cuda not in ("11.8", "12.6", "12.8", "13.0"): raise RuntimeError(f"CUDA = {cuda} not supported!")
x = x.format(cuda.replace(".", ""), "-ampere" if False else "") # is_ampere is broken due to flash-attn
print(f'pip install --upgrade pip && pip install --no-deps git+https://github.com/unslothai/unsloth-zoo.git && pip install "unsloth[{x}] @ git+https://github.com/unslothai/unsloth.git" --no-build-isolation')
```
