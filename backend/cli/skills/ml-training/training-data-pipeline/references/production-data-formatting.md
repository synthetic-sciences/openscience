# Production Data Formatting Reference

## Overview

Production data is the most valuable training signal for model specialization. This reference covers patterns for extracting, cleaning, and formatting production data from common sources.

## Data Source Patterns

### REST API Logs

Most production systems log API requests and responses. Common formats:

```python
# Typical API log structure
log_entry = {
    "timestamp": "2026-01-15T10:30:00Z",
    "request_id": "req_abc123",
    "user_id": "user_456",
    "endpoint": "/v1/chat/completions",
    "input": {
        "model": "gpt-4o",
        "messages": [...],
        "temperature": 0.7
    },
    "output": {
        "choices": [{"message": {"content": "..."}}],
        "usage": {"prompt_tokens": 150, "completion_tokens": 200}
    },
    "latency_ms": 1200,
    "status": 200
}
```

**Extraction pattern**: Pull `input.messages` and `output.choices[0].message.content`, format into standard JSONL.

### Database Records

If your product stores LLM interactions in a database:

```sql
SELECT
    system_prompt,
    user_input,
    COALESCE(corrected_response, model_response) as target_response,
    user_feedback
FROM llm_interactions
WHERE user_feedback != 'rejected'
    AND created_at > NOW() - INTERVAL '90 days'
ORDER BY created_at DESC;
```

**Key**: Always prefer `corrected_response` over raw `model_response` when available.

### Structured Feedback

If users rate or edit model outputs:

| Signal | Quality | Use |
|--------|---------|-----|
| User edited output | Highest | Use edited version as training target |
| Thumbs up / accepted | High | Use original output as training target |
| Thumbs down / rejected | Medium | Exclude from SFT, use for DPO (rejected example) |
| No feedback | Low | Use with caution, filter by heuristics |

## Cleaning Pipeline

```python
def clean_production_data(examples):
    """Standard cleaning pipeline for production data."""
    cleaned = []
    for ex in examples:
        messages = ex["messages"]

        # Skip empty or trivial examples
        assistant_msg = next((m for m in messages if m["role"] == "assistant"), None)
        if not assistant_msg or len(assistant_msg["content"].strip()) < 10:
            continue

        # Normalize whitespace
        for msg in messages:
            msg["content"] = " ".join(msg["content"].split())

        # Remove PII patterns (customize for your domain)
        for msg in messages:
            msg["content"] = redact_pii(msg["content"])

        # Skip if user input is too short (likely a test)
        user_msg = next((m for m in messages if m["role"] == "user"), None)
        if user_msg and len(user_msg["content"].strip()) < 5:
            continue

        cleaned.append({"messages": messages})

    return cleaned
```

## Multi-Turn Conversations

For products with multi-turn interactions, preserve the full conversation:

```python
def conversation_to_training(conversation):
    """Convert a multi-turn conversation to training format.
    Each assistant turn becomes a training example with full history."""
    examples = []
    messages = []

    for turn in conversation["turns"]:
        messages.append({"role": turn["role"], "content": turn["content"]})

        # Create an example at each assistant turn
        if turn["role"] == "assistant":
            examples.append({"messages": list(messages)})

    return examples
```

## Volume Guidelines

| Dataset Size | Expected Quality | Recommended Approach |
|-------------|-----------------|---------------------|
| < 100 | Insufficient for SFT | Use synthetic bootstrapping first |
| 100-1,000 | Minimum viable | LoRA fine-tune, careful eval |
| 1,000-10,000 | Good | Standard LoRA or QLoRA |
| 10,000-100,000 | Strong | Full fine-tune viable |
| > 100,000 | Excellent | Multi-epoch training, curriculum learning |
