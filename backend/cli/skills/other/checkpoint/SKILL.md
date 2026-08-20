---
name: checkpoint
description: Save a local recovery packet from durable session state. Use when the user invokes /checkpoint, asks to preserve progress, or wants a safe restore point before risky or lengthy work.
---

# Save a recovery checkpoint

Capture the session objective, current plan, completed and pending work, relevant evidence, workspace state, and exact next action. Apply the optional label when provided.

Create a new checkpoint without overwriting earlier recovery packets and report its project-relative path.
