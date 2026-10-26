# Smart Router

A Claude Code mod that starts each turn on the cheapest model that can handle it, and moves up one model as soon as the task proves harder than it looked:

**Haiku → Sonnet → your session model (e.g. Opus)**

Simple lookups stop using up your Opus budget, and real engineering work still gets your best model.

## How a turn is placed

| Starts on | When |
| --- | --- |
| **Haiku** | Short lookups and read-only commands: "what does X do", "list the functions in…", `git status`, "run the tests and tell me what fails", "thanks". |
| **Sonnet** | Small, well-defined edits: add a docstring, rename a variable, write a simple test, update a comment, format, bump a version. |
| **Your session model** | Anything long or containing code, and anything involving design, debugging, refactoring, bugs, failures, security, migrations, multi-file or "every/entire" changes. |

A prompt the keyword rules can't place gets a one-word triage from Haiku (about 300 tokens). If the triage is unsure, the turn goes to the harder model.

Replying "yes", "go ahead" or "continue" keeps the previous turn's model, so approving a plan never moves the work itself to a cheaper model.

## Quality guards (moving up a model)

A turn moves up one model, for the rest of that turn, when:

- **on Haiku** it tries to edit or write a file, or to start a subagent. The call is handed to Sonnet, which makes it itself.
- it hits repeated tool errors (2 on Haiku, 3 on Sonnet).
- it runs long (more than 6 model requests on Haiku, more than 25 on Sonnet).
- **on Sonnet** its edits spread over more than 6 files.
- a reply is cut off (`max_tokens`) or refused.

A Haiku turn moves to the session model instead of Sonnet when Sonnet's cold cache would make Sonnet the more expensive of the two.

Also:

- **Complaints:** if you say the last cheap answer was wrong ("that's wrong", "didn't work", "not what I asked", "try again"), the next two turns stay on your session model, and the mistake is recorded (see below).
- **Effort:** the effort setting is never lowered. A cheaper model is asked to think exactly as hard as your session model would.
- **Subagents** keep whatever model their own definition or the caller picks.

## It learns from its mistakes

Every turn is filed under a kind of request, for example `lookup:what`, `edit:rename` or `run-report`. The router keeps a record of how each model did on each kind. Recent turns count most, and older ones fade out over about 20 turns.

- **Mistakes:** a turn that had to move up a model counts as one failure. A turn you said was wrong counts as two. Once a model fails more than about a third of the time on a kind of request (from about 3 recent turns), it stops being tried for that kind. The next model up is tried instead: Sonnet before your session model.
- **Second chances:** a model that was ruled out gets one retry after 8 turns, so a bad patch doesn't lock it out for good. Steady clean runs earn back trust as old failures fade.
- **Costs:** each turn's real cost is measured, including what your session model later pays to cache-write the cheap turn's tokens when it takes over again. This is kept per kind of request, separately for short and long conversations. If a cheaper model didn't actually save at least 10% for a kind of request, it stops being used for that kind (with the same retry).
- The measured steps and output for each kind also feed the cost estimate below.

`/route learned` shows the record. `/route forget` clears it. `/route learning off` turns learning off and routes by the rules alone.

## It won't switch when switching costs more

Prompt caching makes switching models in a long conversation expensive. A model that hasn't seen the conversation has to cache-write all of it. For Sonnet that costs 20× an Opus cache read, so in a long conversation a Sonnet turn can cost more than staying on Opus. A Haiku cache write costs about the same as an Opus cache read.

Before every turn, the router estimates the cost on each eligible model from:

- how much of the conversation each model already has cached
- the expected steps and output (measured defaults, then the learned record)
- the session model's later cache-write of the cheap turn's tokens

A cheaper model is used only if it is estimated to save at least 10%. Deep into a long conversation that bar rises to 50%, because measured savings there were smaller than estimated. In practice, long conversations keep edits on your session model and send lookups to Haiku only when Haiku already holds most of the conversation.

Routing state, such as which model holds which part of the conversation, is saved per session, so a resumed session carries on where it left off.

## Controls

- `/route` shows the mode and how many turns started on each model, and how often turns moved up.
- `/route balanced` is the default: all three models.
- `/route safe` uses Haiku and your session model only. Sonnet is still where a Haiku turn moves first.
- `/route off` turns routing off. Setting the `SMART_ROUTER=off` environment variable does the same for one process.
- `/route classifier on|off` turns the Haiku triage of unclear prompts on or off.
- `/route learned` shows the learned record, `/route forget` clears it, and `/route learning on|off` turns learning on or off.
- `/route reset` clears the stats. `/route` also shows the estimated spend against an all-session-model baseline.
- Start a prompt with `!full`, `!sonnet` or `!light` to pick the starting model for that turn.

## Results

Across three benchmark suites, from a small project up to click (13k lines and its 2,262-test suite), the router did **51% more correct work per dollar** at the same success rate: 98% with it, 98% without. A full pass cost $3.57 with the router against $5.37 on Opus alone.

The saving is in cost-weighted usage, which counts each token at its model's price. Your bill follows that number. A Haiku token costs one fortieth of an Opus token and a Sonnet token half, so the router saves money even where raw token counts stay level. On the larger projects, raw tokens also fell, by 11–19%.

Earlier rounds, with Opus as the session model, over 67 graded runs (45 with the router, 22 without), all correct:

- **Scoped edits** in a multi-file project (add a flag, write tests, update docs, rename across files) ran on Sonnet, cost 55–62% less, and finished about twice as fast.
- **Hard tasks** (bug fixes, new features) stayed on Opus at the same cost.
- **7-turn working sessions** cost 20% less on average: $0.32 against $0.40.
- **Small lookups** cost about 99% less on Haiku.

See [BENCHMARK.md](BENCHMARK.md) for the method, every number, and the limits.

## Install

At the prompt of a terminal session:

```
/plugin install smart-router --marketplace allenlong2007/smart-router
```

Answer `y` to add the marketplace, then choose the **user** scope so the mod runs in every project and session.

From a shell:

```
claude plugin install smart-router --marketplace allenlong2007/smart-router
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `allenlong2007/smart-router`, then Add plugin.

A private repository installs only for people who can read it on GitHub and whose machine already holds a git credential for github.com: an SSH key, or `gh auth login` followed by `gh auth setup-git`.

## Development

```
claude plugin validate .
claude plugin test .
```
