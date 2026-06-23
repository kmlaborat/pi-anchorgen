# Tool Selection Observations: anchoredit_apply vs anchorgen_edit

Status: Informal experiment log
Date: 2026-06
Scope: pi-anchoredit + pi-anchorgen, observed under Qwen3.6-27B

This document lives in **pi-anchorgen**, not in AnchorGen's core
specification. AnchorGen's SPEC describes the world after
`Generator::generate(source, task)` is called. This log describes what
happens *before* that call — specifically, how an orchestrating agent
decides whether to call a `Generator` at all. That decision is outside
AnchorGen's scope by design (see AnchorGen SPEC Section 5, Non-Goals) and
belongs with the orchestrator that makes it.

---

## 1. Background

`pi-anchoredit` exposes `anchoredit_apply` (the agent supplies the exact
replacement text; AnchorEdit applies it with hash verification).
`pi-anchorgen` exposes `anchorgen_edit` (the agent supplies a natural
language instruction; a `Generator` — initially `FastApplyGenerator` —
produces the replacement, which is then applied the same way).

Both packages were installed simultaneously, with both skills loaded. No
hints about which tool to use were given in any prompt. The goal was to
observe which tool an agent (Qwen3.6-27B) chooses for tasks of varying
complexity, and whether that choice is stable.

This log does not represent a controlled experiment (sample size is small
and some variables were not isolated — see Section 5, Confounds). It
records observations precisely because they are easy to forget and hard to
reproduce after the fact.

---

## 2. Test Cases

| Case | Description | Approx. size |
| :--- | :--- | :--- |
| A | Add a guard clause (`if width < 0.0 ...`) to an existing function | 3–5 lines |
| B | Extract a sub-calculation into a new function (`calculate_order_total`), add an error case to an existing function | ~20–30 lines |
| C | Add a new function from scratch (manual JSON serialization with escaping) | ~35–50 lines |

---

## 3. Runs

### Run 1 — FastApply-1.5B backend

| Case | Tool chosen (final) | Outcome |
| :--- | :--- | :--- |
| A | `anchoredit_apply` | Success, one shot |
| B | `anchorgen_edit` → fallback to `anchoredit_apply` | `anchorgen_edit` failed with `STRUCTURE_MANGLE_ERROR`; agent fell back |
| C | `anchorgen_edit` | Reported success, but generated code contained a duplicated struct and a buggy escape function (caught only on manual inspection, not by the tool's own validation) |

### Run 2 — FastApply-7B backend, reworded prompt

| Case | Tool chosen (final) | Outcome |
| :--- | :--- | :--- |
| A | `anchoredit_apply` | Success |
| B | `anchoredit_apply` | Success |
| C | `anchoredit_apply` | Success — `anchorgen_edit` was not invoked at all |

### Run 3 — FastApply-7B backend, prompt identical to Run 1

| Case | Tool chosen (final) | Outcome |
| :--- | :--- | :--- |
| A | `anchoredit_apply` | Success, 1 turn |
| B | `anchoredit_apply` | Success, 1 turn — existing function cleanly split into two |
| C | `anchorgen_edit` | Success, 1 turn — manual JSON escaping (`"`, `\`, `\n`, `\r`, `\t`, control chars) generated correctly, no structural errors |

---

## 4. Observations

### Observation 1 — Tool choice tracked "transform vs. generate", not size

Across all three runs, `anchoredit_apply` was chosen whenever the task was
a **transformation of existing code** with a clear before/after
correspondence — even when that transformation was ~20–30 lines (Case B).
`anchorgen_edit` was only chosen for **generation of new code from
scratch** (Case C: a new function with no prior counterpart in the file).

Line count alone did not predict tool choice. Case B (22 lines, transform)
and Case C (35 lines, generate) differ more in *kind* of work than in
*amount* of work, and kind tracked the tool choice.

### Observation 2 — Backend quality affected outcome, not selection

Switching FastApply from 1.5B to 7B did not change whether `anchorgen_edit`
was selected for a given case. It changed whether the result, once
generated, was correct. The 1.5B backend produced a structurally invalid
result for Case B (caught by validation) and a structurally valid but
buggy result for Case C (not caught by validation). The 7B backend
produced correct results for the same task in Run 3.

This suggests tool *selection* and generation *quality* are separate
concerns, governed by different parts of the system: selection appears to
be a property of the orchestrating agent's judgment about the task;
quality is a property of the chosen backend.

### Observation 3 — Prompt wording changed tool selection for the same task

Run 2 and Run 3 used the same backend (FastApply-7B) and the same
underlying task for Case C, but different prompt wording. Run 2 did not
invoke `anchorgen_edit` at all; Run 3 did, and succeeded. This is the
single largest confound in this log (see Section 5) but is reported
because it was directly observed and is easy to overlook: **tool selection
is not solely a function of task complexity. It is sensitive to how the
task is phrased.**

### Observation 4 — Validation did not catch all failures

In Run 1, Case C reported success (`OK: written N bytes`) despite
containing a duplicated struct definition and a buggy escape function.
`FastApplyGenerator`'s structural validation (ported from `pi-fa-merge`)
caught the Case B failure (`STRUCTURE_MANGLE_ERROR`) but not the Case C
defect. The validation logic should be revisited; passing structural
checks is not equivalent to correctness.

---

## 5. Hypothesis: An Implicit Route Stage

The original three-stage model (Locate / Generate / Apply, see AnchorGen
SPEC Section 9) treats Generate as a single stage performed by *some*
Generator. These observations suggest — but do not establish — that a
fourth stage may sit implicitly between Locate and Generate:

```
Locate   — determine where to act          (the agent, by reading the file)
Route    — decide who performs Generate     (the agent's implicit judgment)
Generate — produce the replacement          (the agent itself, or a Generator)
Apply    — commit the change safely         (AnchorEdit / AnchorScope)
```

What was actually observed is more modest than "a Route stage exists":
in every run, the orchestrating agent (Qwen3.6-27B) made *some* decision
between "generate it myself inline, then call `anchoredit_apply`" and
"describe the intent and call `anchorgen_edit`," and that decision was
sensitive to task kind (Observation 1) and to prompt phrasing
(Observation 3). Whether this constitutes a distinct, generalizable stage
of agentic editing, or is simply an artifact of how these two specific
tools and their skill descriptions happened to compete for the same
intent, is not resolved by three cases and three runs.

This reframes the open question for future work: as agentic editing
systems mature, the question of *who* performs Generate (self vs.
delegate to a specialized backend) may turn out to matter as much as
Generate itself. Whether that decision should remain implicit (left to
the orchestrating LLM's judgment, as observed here) or become an
explicit, inspectable stage is a hypothesis to test, not a conclusion to
report.

---

## 6. Confounds and Limitations

- **Sample size:** one agent (Qwen3.6-27B), 3 cases, 3 runs. Not
  statistically meaningful; treat as qualitative observation.
- **Prompt wording was not held constant across all runs** (Run 2 vs.
  Run 3 differ in phrasing for the same underlying task). This is the
  largest unresolved confound and the direct cause of Observation 3.
- **Backend and prompt wording changed simultaneously** between Run 1 and
  Run 2, which initially made it impossible to attribute the change in
  Case C's outcome to either variable alone. Run 3 (7B + Run-1 wording)
  was added specifically to isolate the backend variable; it shows the
  backend-quality effect (Observation 2) holds independent of the wording
  effect (Observation 3), but does not fully separate the two — a true
  2×2 (backend × wording) was not run.
- **No non-FastApply Generator was tested** (e.g. a Claude- or
  GPT-backed Generator). It is unknown whether Route behavior changes
  when the available Generator is a frontier model rather than a
  specialized small model.
- **`anchoredit`'s SKILL.md states "Use anchoredit_apply for ALL file
  edits."** This instruction was left unmodified throughout all runs
  specifically to observe whether the agent would deviate from it under
  task pressure. It did (Cases B/C in some runs), which is itself notable,
  but the strength of this instruction is a deliberate experimental
  choice, not a neutral baseline.

---

## 7. Suggested Follow-up Work

1. Hold prompt wording constant and vary only backend, across a larger
   case set, to isolate Observation 2 from Observation 3 cleanly.
2. Test a Claude- or GPT-backed `Generator` to see whether Route behavior
   changes when the delegate is a frontier model rather than a small
   specialized one.
3. Investigate whether an explicit Route stage (e.g. a tool that decides
   and reports which path it will take, before generating) produces more
   consistent behavior than leaving Route implicit.
4. Strengthen `FastApplyGenerator`'s structural validation to catch the
   Case C defect class (duplicated definitions, subtly incorrect escape
   logic) that passed validation in Run 1.

---

*This log is informal and intended to preserve observations that would
otherwise be lost. It is not a peer-reviewed result and should be treated
as a starting point for more rigorous experimentation, not a conclusion.*
