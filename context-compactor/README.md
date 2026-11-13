# ContextCompactor

Deterministic, state-based context compaction for DeepSeek Harness. Instead of
asking a model to summarize old turns, ContextCompactor parses the session log
into a fixed, eleven-field task state and replaces the oldest balanced span of the
conversation with that state. The checkpoint is logged as ordinary model
history, so it survives restart, resume, and model switches.

## Install

ContextCompactor is a DSH bundle with no runtime dependencies. Node 18.17 or
newer is only needed to run the tests; the plugin itself runs on the
Harness's bundled Node.

### From GitHub (recommended)

Install the bundle directly from this repository:

```bash
dsh plugin --profile desktop add "github:Nischal079/dsh-plugins#path:/context-compactor"
```

Replace `desktop` with the name of your target profile if different.

> **Note:** The `#path:/context-compactor` parameter tells DSH to install the
> plugin from the `context-compactor` subdirectory inside the `dsh-plugins`
> repository, rather than treating `context-compactor` as part of the
> repository name. The quotes around the specifier are required so your shell
> does not misparse the `#`.

### Manual registration

Alternatively, point the app's bundle installer at this directory, or copy the
`insert` row from [cordis.patch.yml](cordis.patch.yml) into
`~/.dsh/profiles/<profile>/cordis.patch.yml` and restart the Harness. The
`config` block in that row is where the keys below are set.

### Verify

Run the test suite from inside the plugin directory:

```bash
npm test
```

### Updating

DSH does not support in-place updates via `add`. To pull the latest version
from GitHub, remove the plugin first, then reinstall:

```bash
dsh plugin --profile desktop remove @local/context-compactor
dsh plugin --profile desktop add "github:Nischal079/dsh-plugins#path:/context-compactor"
```

## Why

Summaries drift and hallucinate. A checkpoint that is mechanically extracted
from the log is reproducible: running the extractor twice over the same surface
produces byte-identical output. That makes the state safe to reload into a
different model, diff between checkpoints, and validate before it is allowed to
replace anything.

## What it does

| Requirement | Implementation |
|---|---|
| Monitor token usage | `tokenMeter.contextPressure(session)` on every `agent/pre-step` |
| Trigger at 90% | `thresholdRatio: 0.9` (configurable) |
| Automatic compaction | Replaces the oldest balanced surface span in place |
| Structured state | Eleven-field JSON schema, validated before use |
| Keep recent messages | `recentTailRatio` of surface nodes stay verbatim |
| Drop low-value exchanges | Greetings, acknowledgements, duplicates, and empty turns are filtered |
| Relevant memories only | Carried memories are scored against the current goal and kept above a relevance floor |
| Emergency handover | `handoverRatio` (default 98.5%) or `handoverReserveTokens`: replace the whole surface with one checkpoint and continue the same step — no pause, no `continue`, no model switch |
| Safe landing | A full reset runs only at `agent/pre-step` step 1, where no tool call is in flight; a mid-turn trigger defers the reset to the next turn boundary |
| Deterministic checkpoint | No model call, no timestamps in state, stable key ordering, content-addressed hash |
| Persistent memory | Versioned JSON under `$DSH_PROFILE_DIR/context-compactor/sessions/` |
| Model switch / restart | The checkpoint is in the session log; `agent/created` also re-injects it if the log lost it |
| Dry run | `dryRun: true` reports projected savings and touches nothing |
| Rollback | The replacement is one atomic `Session.append`; a rejected range changes nothing |
| Metrics | `tokensBefore`, `tokensAfter`, `compressionRatio`, `checkpointVersion`, `durationMs` |
| Concise output | `checkpointTokenBudget` (default 900 tokens, inside the 500–1500 target) |

## How the replacement works

The plugin appends a `user/message` with a surface replacement:

```js
session.append('user/message', { role: 'user', content: [...], source: { kind: 'user' } }, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: shadowedSeqs,
})
```

This is the same seam DSH's own compactor uses. Three invariants keep it safe:

1. **The system prompt is never shadowed.** Node 0 is skipped, and the range
   starts on a balanced node.
2. **Tool pairs stay intact.** A range always ends immediately before a
   `user/message`, so an assistant tool call can never be separated from its
   results.
3. **One atomic append.** If the surface fold rejects the range, the log and the
   turn are unchanged and the agent continues with its original history.

The full original history remains in the append-only session log; only the
model-visible surface is compacted.

### Emergency full reset

At the emergency trigger the plugin plans the opposite of a range: every node
after the protected system prompt is replaced by a single checkpoint message.
Because the checkpoint is appended during `agent/pre-step`, DSH derives the
current step's request from the new surface — the model simply wakes up in the
same session with a minimal, authoritative task state and keeps working. No
`continue`, no restart, and no model change are needed.

The reset runs only at step 1 of a turn. If the trigger fires mid-turn, the
plugin records a pending reset, finishes the current step normally, and resets
at the next turn boundary so the in-flight tool exchange is never abandoned.
With `fullResetOnHandover: false` the old pause-and-reject behavior returns.

`handoverReserveTokens` exists because DSH caps a request's output at
`contextWindow − estimate − 4096`. On a small window (the local 20,480-token
llama.cpp profile) the ratio alone can fire too late, while the reserve guard
resets as soon as the remaining room approaches that hard floor.

## Configuration

Set these on the plugin row in the profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`); the user layer wins over this
bundle's defaults:

```yaml
- id: context-compactor
  config:
    thresholdRatio: 0.85
    dryRun: true
```

Or edit the bundle row in `cordis.patch.yml` and reinstall the bundle.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Mount the listeners |
| `thresholdRatio` | `0.9` | Fraction of the context window that triggers range compaction |
| `handoverRatio` | `0.985` | Fraction that triggers the emergency full reset |
| `fullResetOnHandover` | `true` | Reset the surface to one checkpoint and continue; `false` restores pause-and-reject |
| `handoverReserveTokens` | `6144` | Emergency reset once fewer tokens remain before the window edge; `0` disables the guard |
| `carriedSummaryTokenBudget` | `200` | Target size of the summary of the previous checkpoint |
| `recentTailRatio` | `0.12` | Share of surface nodes kept verbatim |
| `minRecentMessages` | `2` | Floor on the verbatim tail |
| `minNodesToCompact` | `4` | Do not rewrite smaller ranges |
| `checkpointTokenBudget` | `900` | Hard target for the serialized state |
| `dryRun` | `false` | Measure and log without mutating anything |
| `retentionPolicy` | `5` | Checkpoint versions kept per session |
| `pauseOnCompaction` | `false` | Always pause after a compaction (strict handover) |
| `resumeOnRestart` | `true` | Re-inject the newest checkpoint on `agent/created` |
| `storageDir` | `''` | Override the profile checkpoint directory |
| `verbose` | `false` | Log every pressure reading |

Unknown keys are rejected at load time so a typo cannot silently disable a
threshold.

The bundle intentionally declares no `Config` schema: a workspace bundle cannot
resolve `@deepseek-ai/schemastery`, so there is no generated settings form. The
runtime validator is stricter than a form anyway — unknown keys and
out-of-range values fail the plugin loudly instead of being silently ignored.

## Coexistence with the built-in compactor

`dsh-base` ships `@deepseek-ai/dsh-compaction-basic`, which summarizes with an
extra model call at a much lower effective threshold. In this profile that row
was already disabled, so ContextCompactor is the only engine running. The bundle
patch still pins the built-in engine to a last-resort 97% band for profiles
where it is enabled, so the two never race if you turn it back on:

```yaml
- id: compaction-basic
  config:
    thresholdRatio: 0.97
    headroomTokens: 1024
    retainRatio: 0.08
    maxTokens: 8192
```

Without this override the built-in engine compacts first and ContextCompactor
rarely runs. To restore the original behavior, delete the `compaction-basic`
block from `cordis.patch.yml` and reinstall the bundle.

## State schema

```json
{
  "task_goal": "",
  "current_status": "",
  "completed_work": [],
  "pending_work": [],
  "important_decisions": [],
  "known_constraints": [],
  "relevant_files": [],
  "important_memories": [],
  "next_actions": [],
  "resume_instructions": "",
  "carried_summary": ""
}
```

Extraction is mechanical:

- `task_goal` — first substantive user prompt, carried forward across compactions
- `current_status` — last model sentence plus the last tool outcome
- `completed_work` — successful tool calls (`tool name: target`), newest 12
- `pending_work` — failures, unfinished calls, open checkboxes, and explicit next-step lists
- `important_decisions` — sentences matching decision markers ("decided", "instead of", "I will use")
- `known_constraints` — user and developer sentences with constraint markers
- `relevant_files` — paths from tool arguments and message text
- `important_memories` — carried memories rescored against the current goal, plus explicit "remember" notes
- `next_actions` — the most recent "Next:" list, open checkboxes, and retries
- `resume_instructions` — a deterministic resume sentence assembled from the above
- `carried_summary` — a deterministic condensation of the previous checkpoint (goal, status, recent completions, decisions, next actions, and its own carried summary), bounded by `carriedSummaryTokenBudget`; empty on the first checkpoint

## Persistence

```text
~/.dsh/context-compactor/sessions/<session-id>.json
{
  "schemaVersion": 2,
  "sessionId": "...",
  "checkpoints": [{ "version": 1, "hash": "...", "tokens": 812, "state": { ... } }],
  "metrics": [{ "tokensBefore": 118000, "tokensAfter": 41000, "compressionRatio": 0.35 }]
}
```

`$DSH_PROFILE_DIR/context-compactor` is used instead when that variable exists
in the Host environment; this Desktop build does not export it, so the fallback
above applies. Session ids are UUIDs, so a shared root cannot collide across
profiles.

Writes use a same-directory temporary file plus `rename`, so a crash never
leaves a half-written checkpoint.

`context-compactor/status.json` is a best-effort diagnostic artifact: activation
time, resolved config, the last pressure reading per session, and the last
compaction metrics. It is throttled to one write per two seconds and never
fails a turn.

## Verification

```bash
node --test test/*.test.mjs
```

The suite covers schema shape, determinism, low-value filtering, tool-outcome
splitting, budget fitting, checkpoint round-tripping, and range selection
(including the system-node and tool-pair invariants). A second suite drives the
real `apply()` wiring with a fake Host context: threshold gating, the single
atomic replacement, dry run, the reset-and-continue handover, the reserve
guard, mid-turn deferral, legacy handover rejection, rollback on a rejected
append, persistence, metrics, and resume injection.

### Trying the emergency reset without waiting for a full window

```yaml
- id: context-compactor
  config:
    thresholdRatio: 0.02
    handoverRatio: 0.02
    fullResetOnHandover: true
    dryRun: true
```

The next model step reports the projected full reset in `status.json` and the
host log. Remove `dryRun` to land it; the raw history stays in the append-only
session log either way.

## Known limits

- The reset removes history from the model-visible surface only. The
  append-only session log keeps every event for audit and replay; the plugin
  never rewrites or truncates log files.
- The system prompt is owned by the framework and is not rewritten. Personality
  and tool schemas therefore stay at their normal size; the checkpoint itself
  carries no persona.
- A full reset runs at `agent/pre-step` step 1. A trigger that fires mid-turn is
  recorded and the reset lands at the next turn boundary, so an in-flight tool
  exchange is never abandoned.
- A single indivisible unit larger than the budget cannot be split. The plugin
  compacts only complete, balanced ranges.
- `resumeOnRestart` restores within the same session id. It deliberately does
  not copy one session's checkpoint into an unrelated new session.
- With `pauseOnCompaction: true` the turn ends after the checkpoint. That is the
  strict "emergency handover" contract; the default continues the turn so the
  model resumes without interruption.

## License

[MIT](LICENSE) © Nischal Poudel
