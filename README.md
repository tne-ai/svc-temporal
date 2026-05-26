# svc-temporal

TypeScript [Temporal](https://temporal.io/) worker for the orion product surface. Runs FSM process workflows, long-running jobs, Ralph feedback loops, and scheduled watchdog skills. Activities invoke skills via the Claude Agent SDK and sync workspaces to S3.

Co-resident with [tne-plugins](https://github.com/tne-ai/tne-plugins)' Python engine on the same Temporal cluster, partitioned by task queue (`tne-fsm-queue` / `tne-jobs-queue` here, `tne-engine` there).

## Workflows

| Workflow | Task queue | Purpose |
|---|---|---|
| `FsmProcessWorkflow` | `tne-fsm-queue` | Multi-step p-* process — preamble → generator/evaluator loop → postamble. Approval signals, durable resume. |
| `LongRunningJobWorkflow` | `tne-jobs-queue` | Generic Claude Agent SDK task (Jobs panel). Dispatches to `FsmProcessWorkflow` as a child when `skillName` is set. |
| `RalphLoopWorkflow` | `tne-fsm-queue` | Feedback loop: re-invoke until output contains completion promise. `continueAsNew` every 5 iterations to bound history. |
| `WatchdogWorkflow` | `tne-fsm-queue` | Scheduled runner for w-* watchdog skills. Thin wrapper around `FsmProcessWorkflow` with `autoApprove: true`. |

## Running the worker

```bash
yarn install
yarn dev          # ts-node, hot from src/
yarn build && yarn start    # tsc → dist/, run compiled output
```

Env (all have defaults):

| Var | Default | Notes |
|---|---|---|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Frontend gRPC endpoint |
| `TEMPORAL_NAMESPACE` | `tne` | |
| `AGENT_BACKEND` | (unset) | Override per-call backend (claude-agent-sdk / horizon-http) |

## CLI

Ad-hoc workflow submission and Temporal Schedule management — analog to tne-plugins' `python -m engine <skill>`. Useful for ops and debug; not the primary trigger surface (orion-backend kicks off most workflows via the Temporal SDK directly).

Reads `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` from env. Prints the workflow id and exits — does NOT follow execution. Use `temporal workflow show -w <id>` to follow.

### `yarn submit` — start a workflow

```bash
# Run a watchdog right now (one shot)
yarn submit watchdog --skill w-cai-ethos4-watch-rules --user svc

# Run an FSM with auto-approval
yarn submit fsm --skill p-ceo1-strategy --runId my-run-1 --user svc \
  --workspace /tmp/ws --autoApprove

# Ralph feedback loop
yarn submit ralph --scope my-task --prompt "..." --completion DONE --max 10

# Generic long-running job
yarn submit job --jobId j1 --user svc --workspaceId w1 --prompt "..."
```

Common flags: `--user`, `--workspace`, `--workingDir`, `--s3Bucket`, `--s3Prefix`, `--agentBackend`. Run `yarn submit` with no args for the full reference.

### `yarn schedule` — manage Temporal Schedules

```bash
# Daily watchdog
yarn schedule create watchdog --skill w-cai-ethos4-watch-rules --user svc --interval 1d

# Custom schedule id (default is watchdog-<skill>)
yarn schedule create watchdog --skill w-... --user svc --interval 12h --id my-id

yarn schedule list
yarn schedule delete watchdog-w-cai-ethos4-watch-rules
```

Interval is a Go-style duration: `30s`, `15m`, `1h30m`, `1d`.

### Cross-cluster

```bash
TEMPORAL_ADDRESS=temporal-frontend.tne.svc:7233 \
TEMPORAL_NAMESPACE=tne \
  yarn submit watchdog --skill w-... --user svc
```

## Tests

```bash
yarn test --run
```

47 vitest unit tests. CI (`.github/workflows/ci.yml`) runs typecheck + tests on push and PRs.

## Image build

Production image is built by troopship's `.github/workflows/build_svc_temporal.yaml` on every merge to `main` (pushes to ECR). The Dockerfile here is the source of truth; troopship's checkout vendors `tne-plugins/` as a submodule so the image bundles the skill catalog.
