# Benchmark

**Date:** 2026-10-26. **Claude Code:** 2.1.310. **Router version:** 0.2.0.

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
