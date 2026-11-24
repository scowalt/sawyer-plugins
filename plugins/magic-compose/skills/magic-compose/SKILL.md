---
name: magic-compose
description: "Route a prompt to the best project, machine, and environment with the Magic Compose plugin, or inspect how it would route."
---

# Magic Compose

Magic Compose asks Jev, a fast classifier model, where a new thread should run. It
chooses among the projects and environments the user allowed and the connected
machines, following routing instructions the user wrote in the plugin's settings.
It does not choose a model or a reasoning effort: bb's model autopilot (the Usage
Pace plugin) picks those for every new thread that names none.

## Commands

```sh
bb magic-compose route "<prompt>" --json [--profile]
bb magic-compose spawn "<prompt>" --json
bb magic-compose machines --json
bb magic-compose preferences get --json
```

- `route` reports where the prompt would go and starts nothing. Each of
  `project`, `machine`, and `environment` carries the pick's `label`, its
  `probability`, Jev's `confidence`, and the runner-up `alternatives`. A `source`
  of `only-option` means there was nothing to choose between; `fallback` means the
  preferred environment was unavailable for that project or machine and the next
  best was used.
- `spawn` routes the prompt and starts a visible thread there. It passes no
  provider, model, or reasoning level, so bb's model autopilot chooses them. It
  prints the new thread id and the same decision. Only use it when the user asked
  for a thread to be started; starting threads is otherwise outside an agent's
  remit.
- `machines` prints what Jev is told about each connected machine: operating
  system, CPU load, memory, free disk, and running agent threads.
- `preferences get|set` reads and writes the routing instructions and the other
  preferences. They are not BB plugin settings, so `bb plugin config` does not
  reach them; only the API keys and the choice of gateway are.

## Constraints

- Every call needs a Vercel AI Gateway, OpenRouter, or OpenCode key, set by the
  user in Settings → Magic Compose. Without one the command exits 1 with a
  message saying so. Do not ask the user to paste the key into chat.
- To bill Jev to the user's OpenCode Go subscription instead of OpenCode's
  pay-as-you-go balance, run `bb plugin config magic-compose set jevProvider opencode-go`.
  It uses the same OpenCode key and `jev-1.14`. `auto` never picks it.
- `route` and `spawn` each normally make one Jev request. Add `--profile` to
  `route` for a timeline of where the time went. Vercel's free tier
  allows about 10 Jev calls per 5 minutes, so do not loop over many prompts.
- Treat a pick with confidence under about 0.5 as a guess. Prefer `route` and
  show the user the alternatives before spawning on a guess.
- The prompt, project names and folders, recent thread titles, and machine names
  are sent to TypeSafe through Vercel, OpenRouter, OpenCode, or OpenCode Go. Do not route prompts containing secrets.
