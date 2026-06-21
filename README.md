# pi-anchorgen

Generate-and-apply editing for pi coding agent.

## What it does

anchorgen_edit lets the agent describe a desired change in natural
language. A FastApply-style generator produces the replacement, which is
then applied with hash verification via AnchorEdit.

```
source + instruction
  ↓ FastApplyGenerator
result
  ↓ anchoredit apply
File updated
```

## Status

v0.1.0 — Experimental. This package validates whether Generate (AnchorGen
concept) and Apply (AnchorEdit) compose cleanly as a single tool. It
intentionally has no Locate stage: `source` and `anchor` must be supplied
by the caller (typically after a `read`).

## Prerequisites

- AnchorEdit v2: https://github.com/kmlaborat/AnchorEdit
- FastApply-compatible model endpoint (see pi-fa-merge for reference)

## Related

- AnchorGen (Rust SPEC): https://github.com/kmlaborat/AnchorGen
- pi-fa-merge (FastApplyGenerator origin): https://github.com/kmlaborat/pi-fa-merge
- pi-anchoredit (Apply-only tool): https://github.com/kmlaborat/pi-anchoredit

## License

MIT License
