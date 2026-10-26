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

Also:

- **Complaints:** if you say the last cheap answer was wrong ("that didn't work", "not what I asked", "try again"), the next two turns stay on your session model.
- **Effort:** the effort setting is never lowered. A cheaper model is asked to think exactly as hard as your session model would.
- **Large conversations:** past 40k tokens of context, the turn won't switch to a model whose prompt cache has gone cold, because re-reading the conversation at full price would cost more than the switch saves.
- **Read-only subagents** (Explore, claude-code-guide) run on Sonnet, and statusline-setup runs on Haiku, unless the caller picked a model.

## Controls

- `/route` shows the mode and how many turns started on each model, and how often turns moved up.
- `/route balanced` is the default: all three models.
- `/route safe` uses Haiku and your session model only. Sonnet is still where a Haiku turn moves first.
- `/route off` turns routing off. Setting the `SMART_ROUTER=off` environment variable does the same for one process.
- `/route classifier on|off` turns the Haiku triage of unclear prompts on or off.
- `/route reset` clears the stats.
- Start a prompt with `!full`, `!sonnet` or `!light` to pick the starting model for that turn.

## Results

On a benchmark of 8 coding tasks, run twice with the router on and twice with it off (session model Opus), every run was correct in both arms. The router lowered spend by 45% (37% once caches were warm) and was faster at the median. See [BENCHMARK.md](BENCHMARK.md).

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
