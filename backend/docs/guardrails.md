# Guardrails — profiles & A/B

The hexagonal refactor split the response-validation logic into two layers:

- **PedagogicalReviewerAgent** — deterministic style/scaffolding fixes that
  run BEFORE the safety pipeline. Lives in
  `backend/src/domain/agents/pedagogicalReviewerAgent.js`.
- **GuardrailPipeline** — parallel safety checks → surgical-first → at most
  one consolidated LLM retry → final surgical fallback. Lives in
  `backend/src/domain/services/GuardrailPipeline.js`.

## Profiles

Selected at boot via the `GUARDRAIL_PROFILE` env var. Default is `default`.

### `default` (recommended)

```
solution_leak, false_confirmation, complete_solution, state_reveal, element_naming
```

Five hard-safety checks. The pedagogical adapters (premature confirmation,
didactic explanation, dataset style) are **disconnected from this profile**
because the `PedagogicalReviewerAgent` already enforces them upstream with
deterministic fixes — running them again in the safety pipeline would be
redundant work and could double-correct edge cases.

### `legacy`

```
solution_leak, false_confirmation, premature_confirmation, complete_solution,
state_reveal, element_naming, didactic_explanation, dataset_style
```

The full pre-hexagonal set. The `PedagogicalReviewerAgent` still runs (its
output goes into the same pipeline), but with this profile the three legacy
adapters also run inside the safety pipeline — useful for A/B comparison
("does the agent regress any case the old guardrails caught?").

## How to switch

In `backend/.env` (or your shell):

```bash
GUARDRAIL_PROFILE=default   # production
GUARDRAIL_PROFILE=legacy    # benchmarking / regression testing
```

The container logs the active profile and the resolved guardrail list at
boot, e.g.:

```
[Container] GuardrailPipeline profile=default (5 guardrails: solution_leak, false_confirmation, ...)
```

## Adapters left in the codebase but disconnected from `default`

These are still importable from `backend/src/infrastructure/guardrails/`,
keep their unit tests, and can be reactivated by switching to `legacy`:

| Adapter | Replaced by |
|---|---|
| `PrematureConfirmationGuardrail` | `PedagogicalReviewerAgent._stripPrematureConfirmation` |
| `DidacticExplanationGuardrail`   | `PedagogicalReviewerAgent._fixDidacticExplanation` |
| `DatasetStyleGuardrail`          | `PedagogicalReviewerAgent._enforceDatasetStyle` |

## Budget

`GUARDRAIL_BUDGET_MS` defaults to **20s** (was 45s pre-refactor). With
`OLLAMA_TIMEOUT_MS=60s` we don't have margin for a 45s LLM retry — the
reviewer agent is purely deterministic and doesn't consume LLM budget,
so the safety pipeline only spends time when a hard violation forces a
retry. Override via env if you need more headroom.

## When to add a new check

- **Pedagogical / scaffolding rule** (style, tone, phrasing): extend
  `PedagogicalReviewerAgent`. Determinístic, no LLM, runs every turn.
- **Hard safety constraint** (must NEVER reach the student in any wording):
  add a new `IGuardrail` adapter under `backend/src/infrastructure/guardrails/`
  and include it in `createDefaultGuardrails()`.
