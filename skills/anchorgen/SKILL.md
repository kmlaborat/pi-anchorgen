---
name: anchorgen
description: "Generate and apply edits using natural language instructions. anchorgen_edit combines AI-powered code generation with hash-verified file writing in one step."
---

# anchorgen

Use anchorgen_edit when you want to describe a change in natural language
rather than writing the exact replacement yourself.

## Usage

1. Read the file to find the target section
2. Call anchorgen_edit with:
   - file: the file path
   - anchor: the exact current text (must be unique in the file)
   - source: the same text (what will be transformed)
   - instruction: what you want changed, in plain language

## When to use this vs anchoredit_apply

- anchoredit_apply: you already know the exact replacement text
- anchorgen_edit: you want to describe the change and let generation produce the replacement
