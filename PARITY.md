# Python Engine ↔ svc-temporal Parity

This repo and the Python engine are two parallel implementations of the same
FSM orchestration model:

- **Python engine** — `tne-plugins/plugins/tne/engine/`. Local-first: runs on a
  developer's machine, auto-starts a local Temporal server, drives `claude -p`
  and CLI tooling directly, reads Dynaconf config files.
- **svc-temporal** (this repo) — cloud-first: runs as a Temporal worker against
  a managed cluster, drives the Claude Agent SDK / Pi harness in-process,
  syncs workspaces through S3, and is fed config/inputs from Horizon (orion).

Both speak the same SOP grammar (phases: preamble → generator ↔ evaluator →
postamble → finalization; gate cascade; Ralph loop; backprop/staleness) so a
skill authored once behaves the same in either. This file tracks **drift**:
what's ported, what's intentionally deferred, and what is local-first-only by
design.

> Created from a 2026-06-02 audit of the Python engine against svc-temporal.

## Ported

| Feature | Python source | svc-temporal |
|---------|---------------|--------------|
| Gate cascade (4 gates: type-specific, self-eval, persona, counsel) | `gates.py` | `src/activities/runGateCascade.ts` |
| Ralph loop | `temporal_workflow.py` / ralph driver | `src/workflows/ralphLoop.workflow.ts` |
| Watchdog + schedules | watchdog driver | `src/workflows/watchdog.workflow.ts` |
| Phase-1 backprop / staleness propagation on resume | `propagation.py` | `src/activities/checkFreshness.ts`, `src/workflows/propagation.ts` |
| Backprop target inference (explicit `backprop_to:` + 3 prose patterns) | `propagation.py` | `src/workflows/propagation.ts` |
| Manifest generation (Available Inputs) | manifest builder | `src/config/manifestGenerator.ts` |
| Template resolution / variable substitution | template vars | `src/config/templateResolver.ts` |
| Structured outputs (constrained JSON decode) | leaf `output_schema_path` | `src/activities/invokeSkill.ts` (+ `leafSkillSchema.ts`) |
| Variable sanitization | template vars | `src/config/templateResolver.ts` |
| Per-step model / timeout / tneEngine child-workflow / review (sequential **and** parallel) | `schema.Step`, `temporal_workflow.py` | `src/workflows/fsmProcess.workflow.ts` (`dispatchStep` + `runPhaseParallel`, **this PR**) |
| Backprop-to-inputs (output sections + evaluator signals → review/apply) | `backprop_inputs.py` | `src/shared/backpropFindings.ts`, `src/activities/backpropInputs.ts` (**this PR**) |
| llm-cli role config for gate model selection (`similarity` role) | `config/llm-cli.yaml` | `src/config/llmCliConfig.ts` → `runGateCascade.ts` (**this PR**) |

## Deferred (planned, not yet ported)

| Feature | Python source | Rationale |
|---------|---------------|-----------|
| DeltaProp / bidirectional execution (4-tier `PROPOSE_BACKWARD` ladder, LLM similarity judge) | `backward_dispatch.py` (~448 lines) | Still actively churning upstream — renamed to **DeltaProp** 3 days ago — and needs orion-side submission UX before it's worth mirroring. Revisit once the Python API stabilizes. |
| `--dry-run` plan mode / `--step` single-step / `--reset-failed` CLI modes | engine CLI | Operational tooling. The cloud equivalent is the Temporal UI plus workflow reset / signal-driven control, so a 1:1 CLI port adds little. |
| Dynaconf `engine-config.yaml` hierarchy | Dynaconf settings | svc-temporal configures via `src/shared/constants.ts` + environment variables; a layered Dynaconf hierarchy doesn't fit the per-deploy env-var model. |

## Intentionally not ported (local-first only)

These exist only to make the Python engine pleasant on a developer laptop and
have no meaning in the cloud worker:

- `file_opener.py` — opens artifacts in the local OS file viewer.
- `host_quirks.py` — per-OS shell / path workarounds.
- Local Temporal server auto-start — the cloud worker connects to a managed cluster.
- Concurrent engine-process checks — guards against two local engines fighting
  over one workspace; irrelevant when each run is an isolated Temporal workflow.

## How to keep this current

When adding a feature to the Python engine, **either** port it to svc-temporal
in the same sprint **or** add a row to the "Deferred" table above with a
rationale. The two implementations drift the moment a feature lands on one side
only and isn't recorded here — this file is the single place to notice that.
