# Benchmark

## Larger tasks and multi-turn sessions (v0.3)

**Date:** 2026-10-26. **Claude Code:** 2.1.310. **Session model:** Opus (`claude -p --model opus`).

### Method

The test project is a small multi-file inventory app: models, storage, report, CLI, utils, tests and a README, with 1 planted bug.

- **Single tasks:** 7 larger tasks, each run in a fresh copy of the project as a fresh session.
- **Multi-turn sessions:** the same 7-turn conversation each time, chained with `--resume`: an overview, then fix the bug, then a lookup, then add a `--json` flag, then run the tests, then write a test for the flag, then "thanks".
- **Baseline:** the same runs with no mod loaded.

Grading was automatic:

- the test suite must pass
- hidden checks must pass: discounted totals, `list --json` output parsed as JSON, removing an item, no stale names left after a rename
- for the test-writing task, the new tests must catch a deliberately broken missing-file case
- for the explanation task, the answer must name the right functions

Cost is the API's own billed total.

### Single tasks

| Task | Router chose | Correct (router / baseline) | Avg cost router | Avg cost baseline | Saved |
|---|---|---|---|---|---|
| G1 Add a `--json` flag to the list command | Sonnet | 5/5 · 2/2 | $0.081 | $0.195 | 59% |
| G2 Write unit tests for storage.py (load, save, missing file) | Sonnet | 4/4 · 2/2 | $0.074 | $0.163 | 55% |
| G3 Document the CLI commands and options in the README | Sonnet | 4/4 · 2/2 | $0.088 | $0.216 | 59% |
| G4 Rename `parse_money` to `parse_price` and update callers | Sonnet | 4/4 · 2/2 | $0.074 | $0.194 | 62% |
| G5 Fix the discount bug in `Item.total()` | Opus | 3/3 · 2/2 | $0.155 | $0.167 | ≈0% (same model) |
| G6 Implement a `remove` command with tests | Opus | 2/2 · 2/2 | $0.217 | $0.206 | ≈0% (same model) |
| G7 Explain how the CLI loads and saves data | Opus or Sonnet (triaged) | 3/3 · 2/2 | $0.108 | $0.126 | 15% |

### Multi-turn sessions

| | Sessions | Correct | Avg cost | Range | Avg time |
|---|---|---|---|---|---|
| Baseline (Opus only) | 8 | 8/8 | $0.402 | $0.35–0.44 | 93 s |
| Router v0.3 | 11 | 11/11 | $0.320 (20% less) | $0.27–0.42 | 82 s |

### What the sessions taught (and the fixes made)

- **Return cost.** When Opus takes back over after a cheap turn, it must cache-write that turn's tokens at $8 per million. Measured mid-session, that rewrite ate most of a Haiku lookup's saving. v0.3 measures it on the next turn's first request and records it against that kind of request, separately for short and long conversations. It then stops routing where the saving disappears. In the last runs it measured Sonnet overviews and mid-session Sonnet edits at 109–110% of the Opus cost, and kept those turns on Opus. Lookups and run-and-report turns measured 17% and 6% of the Opus cost, and stay on Haiku.
- **Cold caches.** A model that hasn't seen a long conversation has to cache-write all of it, and for Sonnet that costs 20× an Opus cache read. The estimator now counts what each model holds, so long conversations keep edits on Opus.
- **Subagent override removed.** v0.2 sent the Explore subagent to Sonnet. Measured, that cost more than the subagent's own default, so subagents now keep their own model.
- **Honest accounting.** `/route` reports spend against what Opus would have paid with its cache as it stood. In the final runs it reported 26% saved, and its spend total matched the API's billing to the cent.

### Limits

Raw token counts are about the same with and without the router: 681k against 711k per session. What drops is cost-weighted usage, because Haiku and Sonnet tokens cost a fraction of Opus tokens. Results on a real, larger codebase will differ. The learned record adapts to that codebase as it goes.

---

## Small tasks (v0.2)

**Router version:** 0.2.0.

## Method

8 tasks were run against a small Python project: 5 helper functions, 5 tests, and 1 planted bug. Each task ran twice with the router on and twice with it off (`SMART_ROUTER=off`), each run in a fresh copy of the project as a fresh headless session: `claude -p --model opus`.

Correctness was graded automatically:

- **Lookup answers (L tasks):** the answer must name the right functions or numbers.
- **Edits (M and F tasks):** checked by parsing the code, running the test suite, and running hidden checks (for example `median([4,1,3,2]) == 2.5`).

Cost is the API's own `total_cost_usd` for the run.

## Results

| Task | Prompt | Model (on) | Correct on · off | Cost on | Cost off | Saved |
|---|---|---|---|---|---|---|
| L1 | What does calc.py do? Answer in two sentences. | Haiku | 2/2 · 2/2 | $0.005 | $0.404 | 99% |
| L2 | List the names of the functions defined in calc.py. | Haiku | 2/2 · 2/2 | $0.006 | $0.401 | 99% |
| L3 | Run the tests with python3 -m pytest -q and tell me how many pass and how many fail. | Opus* | 2/2 · 2/2 | $0.405 | $0.403 | 0% |
| M1 | Add a docstring to the add function in calc.py. | Sonnet | 2/2 · 2/2 | $0.115 | $0.214 | 46% |
| M2 | Rename the variable tmp to total in the mean function in calc.py. | Sonnet | 2/2 · 2/2 | $0.117 | $0.213 | 45% |
| M3 | Write a unit test for the multiply function in test_calc.py. | Sonnet | 2/2 · 2/2 | $0.132 | $0.310 | 57% |
| F1 | Fix the bug that makes test_divide fail. | Opus | 2/2 · 2/2 | $0.270 | $0.267 | ≈0% |
| F2 | Implement median(xs) in calc.py, handling both even and odd lengths, and add tests for it. | Opus | 2/2 · 2/2 | $0.392 | $0.390 | ≈0% |
| **All** | | | **16/16 · 16/16** | **$1.44** | **$2.60** | **45%** |

\* L3 matched a "complex" keyword ("fail") in this run. A run-and-report rule was then added. Rerun twice with that rule, L3 started on Haiku, was correct both times, and cost $0.003 per run instead of about $0.09.

## Findings

- **Quality:** every run in both arms was correct. Hard tasks (F1, F2) stayed on Opus and cost the same in both arms, so the router adds no measurable overhead there.
- **Spend:** 45% lower overall. In the second round, when every model's prompt cache was already warm, it was 37% lower: $0.60 against $0.95. Part of the first round's gap is Opus writing its prompt cache.
- **Speed:** the median run took 8.2 s with the router on, against 10.2 s with it off.
- **Raw token counts:** about 5% higher with the router on. Sonnet sometimes took one more step than Opus, and cached tokens are counted at full size here. What the router lowers is cost-weighted usage: a Haiku token costs a fraction of an Opus token.

## Limits of this benchmark

- The tasks are small and the project is tiny. The benchmark shows that routing works and saves money on typical simple requests. It does not show that results are identical on every task.
- Each run is a single prompt. In long sessions, switching models re-reads the conversation without the cache. The 40k-token switch limit guards against that cost, but this benchmark doesn't exercise it.
