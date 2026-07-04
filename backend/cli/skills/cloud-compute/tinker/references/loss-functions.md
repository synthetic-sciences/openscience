# Loss Functions

## Built-in Loss Functions

Pass as string to `forward_backward(data, loss_fn)`.

## Supervised Learning

### cross_entropy

Standard next-token prediction loss.

$$\mathcal{L}(\theta) = -\mathbb{E}_x[\log p_\theta(x)]$$

```python
fwd_bwd = training_client.forward_backward(data, loss_fn="cross_entropy")
```

**Inputs:**
- `target_tokens: array[(N,), int]` - Target token IDs
- `weights: array[(N,), float]` - Loss weights (0 = ignore, 1 = train)

**Outputs:**
- `logprobs: array[(N,), float]` - Log probabilities
- `loss:sum` (scalar) - Total weighted loss

## Policy Gradient Methods

### importance_sampling

Policy gradient with importance weighting for off-policy correction:

$$\mathcal{L}_{IS}(\theta) = \mathbb{E}_{x\sim q}\left[\frac{p_\theta(x)}{q(x)}A(x)\right]$$

```python
fwd_bwd = training_client.forward_backward(data, loss_fn="importance_sampling")
```

**Inputs:**
- `target_tokens: array[(N,), int]` - Target tokens
- `logprobs: array[(N,), float]` - Sampling logprobs (from q)
- `advantages: array[(N,), float]` - Advantage values

### ppo

Proximal Policy Optimization with clipping:

$$\mathcal{L}_{PPO}(\theta) = -\mathbb{E}_{x \sim q}\left[\min\left(\frac{p_\theta(x)}{q(x)} A(x), \text{clip}\left(\frac{p_\theta(x)}{q(x)}, 1-\epsilon, 1+\epsilon\right) A(x)\right)\right]$$

```python
fwd_bwd = training_client.forward_backward(
    data,
    loss_fn="ppo",
    loss_fn_config={"clip_low_threshold": 0.9, "clip_high_threshold": 1.1}
)
```

**Inputs:** Same as `importance_sampling`

### cispo

Clipped Importance Sampling Policy Optimization:

$$\mathcal{L}_{CISPO}(\theta) = \mathbb{E}_{x \sim q}\left[\text{sg}\left(\text{clip}\left(\frac{p_\theta(x)}{q(x)}, 1-\epsilon, 1+\epsilon\right)\right) \log p_\theta(x) A(x)\right]$$

```python
fwd_bwd = training_client.forward_backward(
    data,
    loss_fn="cispo",
    loss_fn_config={"clip_low_threshold": 0.8, "clip_high_threshold": 1.2}
)
```

### dro

Direct Reward Optimization with quadratic penalty:

$$\mathcal{L}_{DRO}(\theta) = \mathbb{E}_{x \sim q}\left[\log p_\theta(x) A(x) - \frac{1}{2}\beta \left(\log \frac{p_\theta(x)}{q(x)}\right)^2\right]$$

```python
fwd_bwd = training_client.forward_backward(
    data,
    loss_fn="dro",
    loss_fn_config={"beta": 0.05}
)
```

## Custom Loss Functions

For losses not covered above, use `forward_backward_custom`:

```python
def custom_loss(data: list[Datum], logprobs: list[torch.Tensor]) -> tuple[torch.Tensor, dict[str, float]]:
    loss = (logprobs ** 2).sum()
    return loss, {"custom_loss": loss.item()}

loss, metrics = training_client.forward_backward_custom(data, custom_loss)
```

### Multi-Sequence Loss

```python
def variance_loss(data: list[Datum], logprobs: list[torch.Tensor]) -> tuple[torch.Tensor, dict[str, float]]:
    flat_logprobs = torch.cat(logprobs)
    variance = torch.var(flat_logprobs)
    return variance, {"variance_loss": variance.item()}
```

### How forward_backward_custom Works

1. Forward pass computes logprobs
2. Custom function computes loss from logprobs
3. `loss.backward()` computes grad_outputs
4. Second forward_backward with linear surrogate loss

**Note:** Uses 1.5x FLOPs and up to 3x wall time compared to built-in losses.

## Implementation Details

All losses:
- Applied at token level with shape `(N,)` where N = sequence length
- Use sum reduction (not mean)
- Accept numpy.ndarray or torch.Tensor inputs

### cross_entropy Implementation
```python
elementwise_loss = -target_logprobs * weights
loss = elementwise_loss.sum()
```

### importance_sampling Implementation
```python
prob_ratio = torch.exp(target_logprobs - sampling_logprobs)
loss = -(prob_ratio * advantages).sum()
```

### ppo Implementation
```python
prob_ratio = torch.exp(target_logprobs - sampling_logprobs)
clipped_ratio = torch.clamp(prob_ratio, 1 - eps, 1 + eps)
unclipped = prob_ratio * advantages
clipped = clipped_ratio * advantages
loss = -torch.min(unclipped, clipped).sum()
```

### cispo Implementation
```python
prob_ratio = torch.exp(target_logprobs - sampling_logprobs)
clipped_ratio = torch.clamp(prob_ratio, 1 - eps, 1 + eps)
loss = -(clipped_ratio.detach() * target_logprobs * advantages).sum()
```

### dro Implementation
```python
quadratic_term = (target_logprobs - sampling_logprobs) ** 2
loss = -(target_logprobs * advantages - 0.5 * beta * quadratic_term).sum()
```

## Notes

- KL regularization: Include in reward rather than loss (see `incorporate_kl_penalty` in Cookbook)
- Aggregation: Token-level losses are summed; for different schemes, modify advantages
- Reference: [Schulman et al., 2017](https://arxiv.org/abs/1707.06347) for PPO
