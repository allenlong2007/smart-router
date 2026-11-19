# Benchmark

## Summary: more work per dollar

Each suite below was run with and without the router, with Opus as the session model. Cost is the API's own billed total. Every run was graded automatically by test suites and hidden checks.

| Suite | Cost of one pass (router / baseline) | Tasks correct | Correct tasks per $10 |
|---|---|---|---|
| Small project, 8 tasks | $0.62 / $1.30 (52% less) | 100% / 100% | 129 / 62 |
| Mid project, 7 tasks + a 7-turn session | $1.12 / $1.67 (33% less) | 100% / 100% | 72 / 48 |
| **click** (13k lines, 2,262 tests), 7 tasks + a 7-turn session | $1.83 / $2.40 (24% less) | 94% / 94% | 41 / 31 |
| **All** | **$3.57 / $5.37 (34% less)** | **98% / 98%** | **66 / 44: 51% more work per dollar** |

### Cost-weighted usage vs raw tokens

- **Raw tokens** count every token the same, whichever model processed it.
- **Cost-weighted usage** counts each token at its model's price.

Per million tokens, this build billed:

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| Opus | $4 | $20 | $0.20 | $8 |
| Sonnet | $2 | $10 | $0.10 | $4 |
| Haiku | $0.10 | $0.50 | $0.01 | $0.20 |

So a token on Sonnet weighs half an Opus token, and a token on Haiku weighs one fortieth. A turn moved from Opus to Haiku can use the same raw tokens or more and still cost about 97% less. Your bill, and usage limits weighted by model, follow cost-weighted usage. That is the number the router lowers.

Raw tokens rose about 5% on the small suite, and fell 11% on the mid project and 19% on click. In the long sessions, cheaper turns left a smaller context for later Opus turns to re-read.

## Lower effort and Haiku searches (v0.6)

v0.6 runs Opus and Haiku steps at low effort (Sonnet at medium) and sends read-only searches to Haiku. Two variants were tested: **a** lowers effort on every turn, **b** keeps the session's effort for hard work. Same click tasks and graders, 2 runs each. "Opus alone" runs at Claude Code's default effort, medium.

| Arm | 10 single tasks | Cost | Time | 8-turn sessions | Cost per session | Time per session |
|---|---|---|---|---|---|---|
| Opus 5.5 alone (medium) | 20/20 | $5.58 | 8.8 min | 16/16 | $2.55 | 3.9 min |
| Opus 5.5 alone (low) | 20/20 | $4.80 | 6.6 min | 16/16 | $1.97 | 2.6 min |
| v0.3 | 20/20 | $5.01 | 8.2 min | 16/16 | $2.25 | 3.4 min |
| **v0.6a (shipped)** | **20/20** | **$4.20** | 7.1 min | **16/16** | **$2.00** | 2.7 min |
| v0.6b | 19/20 | $4.52 | 11.5 min | 16/16 | $2.04 | 2.7 min |

- v0.6a is 25% cheaper than Opus alone on single tasks and 22% cheaper on sessions, and faster on both. Against v0.3 it is 16% and 11% cheaper.
- Most of the saving is effort: Opus at low alone gets close on sessions. On single tasks v0.6a beats Opus-low by another 12%, from Haiku searches and Sonnet edits.
- In the long sessions every turn still ran on Opus: with a large context, the cost estimate kept searches there.
- v0.6b's miss: a Haiku search started a disk-wide background search, ran for about 4 minutes, and ended on a follow-up message. That is the risk of Haiku searches: occasional wandering. It happened in 1 of 8 Haiku search runs.
- Limits: 2 runs per arm, one codebase, Claude Code `-p` runs.

## Long sessions and effort levels (v0.5)

### Long sessions

One conversation of 8 turns on click, resumed turn by turn. Turn 1 reads `core.py` and `types.py` in full (about 4,500 lines, 60k tokens), so every later turn carries a large context. Then: list env var reads, fix a planted clamp bug, list `echo` calls, locate all 65 exports, add 34 docstrings, survey modules, "thanks". Each turn is graded.

| Arm | Runs | Correct turns | Avg session cost |
|---|---|---|---|
| Opus 5.5 alone | 2 | 16/16 | $2.55 |
| v0.3 | 2 | 16/16 | $2.25 |
| v0.4 | 2 | 16/16 | $2.79 |
| v0.4 + delegation note | 2 | 16/16 | $2.57 |
| v0.4 forced delegation | 2 | 16/16 | $2.37 |
| **v0.5** | 4 | 32/32 | **$2.40** |

- Even with a large context and delegation made mandatory, Opus never started a subagent.
- In 3 of 6 v0.4 runs, turn 1 was triaged "standard" and ran on Sonnet. It saved about $0.30 there, then Opus paid about $0.65 on turn 2 to cache-write the 60k tokens Sonnet had read. v0.5 keeps prompts that load whole files on the session model; turn 2 cost about $0.17 in all 4 runs.
- In this kind of session nearly every turn is real work, so the router mostly stays on Opus and saves little. The differences between v0.3, v0.5 and Opus alone are within run-to-run noise (about 10%).

### Effort levels

Each model alone (no router) at low, medium and high effort, on 8 tasks (searches, bulk docstrings, rename, bug fix, new feature, explanation), 2 runs each. Fresh context per task.

| Model | Effort | Correct | Cost (16 runs) | Time |
|---|---|---|---|---|
| Haiku 5.5 | low | 16/16 | $0.16 | 10.0 min |
| Haiku 5.5 | medium | 16/16 | $0.20 | 10.3 min |
| Haiku 5.5 | high | 16/16 | $0.27 | 14.2 min |
| Sonnet 5.5 | low | 14/16 | $2.11 | 16.7 min |
| Sonnet 5.5 | medium | 16/16 | $2.32 | 5.2 min |
| Sonnet 5.5 | high | 15/16 | $2.48 | 10.9 min |
| Opus 5.5 | low | 16/16 | $3.95 | 5.4 min |
| Opus 5.5 | medium | 16/16 | $4.58 | 7.2 min |
| Opus 5.5 | high | 16/16 | $4.94 | 8.2 min |

- Higher effort never raised accuracy here. It cost 10 to 25% more.
- Haiku 5.5 solved all 48 runs, including the bug fix and the new feature, at about 1/25 of Opus's cost, but took about twice as long.
- Sonnet missed 3 of 48: the new feature twice at low effort, and one bulk docstring run at high.
- Not acted on yet: 2 runs on one codebase is too little to move hard work to Haiku or lower effort without risking quality. A grader bug that counted docstring examples as `echo` calls was fixed and every run regraded.

## Splitting work across models (v0.4)

**Question:** does handing parts of a task to cheaper subagents (Haiku, Sonnet) save money without hurting results, when the session model is Opus 5.5?

**Setup:** click 8.1.7, `claude -p` on Opus 5.5, account plugins off, learning off, 2 runs per arm per task. Three arms:

- **v0.3:** the turn router alone.
- **v0.4:** v0.3 plus subagent routing and a gentle note telling Opus it may delegate.
- **v0.4 forced:** the same, but the note says delegation is required for searches and bulk edits.

Ten tasks: the seven from before plus three bigger ones (add docstrings to 72 functions across 4 files without changing code; give file:line for all 65 names click exports; list all 33 `echo(` calls).

| Task | v0.3 | v0.4 | v0.4 forced |
|---|---|---|---|
| 72 docstrings | 2/2 $0.41 | 2/2 $0.50 | 2/2 $0.70 (Sonnet 47%) |
| rename + docstrings + tests | 2/2 $0.27 | 2/2 $0.27 | 2/2 $0.32 |
| 33 echo calls | 1/2 $0.23 | 2/2 $0.24 | 2/2 $0.26 |
| env var reads | 2/2 $0.22 | 2/2 $0.23 | 0/2 $0.29 (see below) |
| explain | 2/2 $0.17 | 2/2 $0.17 | 2/2 $0.18 |
| 65 exports | 2/2 $0.26 | 2/2 $0.28 | 2/2 $0.31 |
| module survey | 2/2 $0.24 | 2/2 $0.23 | 2/2 $0.28 |
| all 10 tasks | 19/20 $5.01 | 20/20 $5.27 | |

**Findings:**

- With a gentle note, Opus 5.5 never delegated. It did each task with 3 to 8 Bash calls, often one script for a whole bulk edit. There was nothing cheap left to hand off.
- Forced delegation cost more on every task (10 to 70%) and was slower. Opus still read the files, wrote the brief, and checked the result, so the subagent's cost landed on top.
- The Haiku subagents themselves were accurate (33/33, 65/65, all 17 env var lines) and cost about $0.005 each.
- The forced env var runs scored 0/2 because Opus answered first and then sent a short follow-up when a background subagent finished. The grader reads only the last message. The list itself was right, but it is a real usability cost of background subagents.

**What shipped in v0.4:** subagent routing stays on (when Opus starts a subagent on its own, it runs on the cheapest model its job allows). The delegation note is off by default (`/route delegate on` to try it). Older Opus models are always replaced by Opus 5.5.

**Limits:** small samples (2 runs). Single headless tasks with short context. In a long interactive session Opus re-reads a large context on every step, so handing a wide search to a fresh Haiku subagent may pay off there. That was not measured.

## Large real-world project: click (v0.3)

**Project:** [pallets/click](https://github.com/pallets/click), about 13k lines of source and 16k of tests. The project's own 2,262-test suite was the main grader. 2 runs per arm per task.

| Task | Router chose | Correct (router · baseline) | Avg cost router | Avg cost baseline |
|---|---|---|---|---|
| K1 Which function decides the extra info shown in `--help`? | Haiku / Opus (triaged) | 2/2 · 2/2 | $0.074 | $0.136 |
| K3 Write unit tests for `make_str` (must catch a planted change) | Opus | 2/2 · 2/2 | $0.203 | $0.185 |
| K4 Rename a helper across files and update callers | Sonnet | 2/2 · 2/2 | $0.070 | $0.154 |
| K5 Rewrite a docstring | Sonnet | 2/2 · 2/2 | $0.056 | $0.121 |
| K6 Fix a planted `IntRange` clamping bug | Opus | 2/2 · 2/2 | $0.168 | $0.175 |
| K7 Add a `ByteSize` parameter type, export it, add tests | Opus | 1/2 · 1/2 | $0.401 | $0.411 |
| K8 Explain how parameter processing order is decided | Opus (triaged) | 2/2 · 2/2 | $0.203 | $0.195 |
| 7-turn session: overview, bug fix, lookup, tests, test run, new feature, thanks | mixed | 2/2 · 2/2 | $0.657 | $1.029 (36% less) |

- **K7 misses:** both ran on Opus in their arm. The router run added an import that broke click's lightweight-imports test, and the baseline run left a syntax error in a test file.
- **K2 dropped:** "run test_basic.py and report the count" is left out of the comparison. The benchmark harness allowed `python3`, but every model typed `python`, so all runs in both arms were blocked. On that task, the router moved Haiku up to Sonnet after 2 blocked commands, as designed.

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
