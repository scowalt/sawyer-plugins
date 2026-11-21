---
name: magic-compose
description: "Route a prompt to the best project, machine, model, and reasoning level with the Magic Compose plugin, or inspect how it would route."
---

# Magic Compose

Magic Compose asks Jev, a fast classifier model, where a new thread should run. It
chooses among the projects and environments the user allowed, the connected
machines, and the models in the user's rotation, following routing instructions
the user wrote in the plugin's settings.

## Commands

```sh
bb magic-compose route "<prompt>" --json [--draw <0..1>]
bb magic-compose spawn "<prompt>" --json [--draw <0..1>]
bb magic-compose machines --json
bb magic-compose rotation get --json
bb magic-compose preferences get --json
bb magic-compose history --days 14 --json
```

- `route` reports where the prompt would go and starts nothing. Each of
  `project`, `machine`, `model`, `reasoning`, and `environment` carries the
  pick's `label`, its `probability`, Jev's `confidence`, and the runner-up
  `alternatives`. A `source` of `only-option` means there was nothing to choose
  between; `fallback` means the preferred environment was unavailable for that
  project or machine and the next best was used.
- `share` in the `route` output reports the random share, or is `null` when none
  is set. After Jev picks, the user may send a share of new threads to one
  more model at random, so they can compare it with the rotation. `outcome` is
  `drawn` (the share replaced Jev's pick, which `replaced` records, and the
  `model` and `reasoning` picks then have `source: "share"`), `kept` (the draw
  missed), or `skipped` (Jev already picked that model, the model cannot run on
  the chosen machine, or its quota group is over a limit). `odds` is the chance
  after usage, `usage` says why (`headroom`, `scaled` by a hot weekly pace,
  `unknown` when no reading was available, `over`), and `note` says it in words.
  A `source: "share"` pick was not Jev's choice, so do not read it as one.
- `--draw <0..1>` fixes the share's random draw. It lands when the draw is below
  `odds`, so `--draw 0` forces it whenever `odds` is above 0 and `--draw 0.99`
  avoids it. Leave it out for the real chance. A share draw starts a thread
  on the share's model, so use `--draw` with `spawn` only when the user wants that.
- `spawn` routes the prompt and starts a visible thread there. It prints the new
  thread id and the same decision. Only use it when the user asked for a thread
  to be started; starting threads is otherwise outside an agent's remit.
- `machines` prints what Jev is told about each connected machine: operating
  system, CPU load, memory, free disk, and running agent threads.
- `preferences get|set` reads and writes the routing instructions and the other
  preferences. They are not BB plugin settings, so `bb plugin config` does not
  reach them; only the API keys and the choice of gateway are.
- `rotation get|set`, `history`, and `backtest` read and tune the model
  preferences; the `tune-magic-compose` skill explains how to use them together.
  `rotation get --json` returns `{ entries, share }`. `rotation set` takes an
  array to replace the entries alone, or an object that replaces what it names:
  `{"entries": [...], "share": {"providerId", "model", "reasoningLevel", "share": 0.2}}`
  sets the share (`usage` is optional and defaults to the Antigravity "Gemini
  Models" group, stopping at 85% of its 5-hour or 90% of its weekly window), and
  `{"share": null}` turns it off. The share's model is never one of the entries.

## Constraints

- Every call needs a Vercel AI Gateway, OpenRouter, or OpenCode key and at least
  one model in the rotation, both set by the user in Settings → Magic Compose. Without them the
  command exits 1 with a message saying which is missing. Do not ask the user to
  paste the key into chat.
- `route` and `spawn` each normally make one Jev request. Add `--profile` to
  `route` for a timeline of where the time went. Vercel's free tier
  allows about 10 Jev calls per 5 minutes, so do not loop over many prompts.
- Treat a pick with confidence under about 0.5 as a guess. Prefer `route` and
  show the user the alternatives before spawning on a guess.
- The prompt, project names and folders, recent thread titles, and machine names
  are sent to TypeSafe through Vercel, OpenRouter, or OpenCode. Do not route prompts containing secrets.
