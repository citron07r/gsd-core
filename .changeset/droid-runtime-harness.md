---
type: Added
---
**Factory AI Droid is now an installable runtime** — `gsd-core --droid` lands GSD skills at `~/.factory/skills/`, subagent droids at `~/.factory/droids/<name>.md` (converted via `convertClaudeAgentToDroidAgent` with a DroidValidator-style schema self-check), local slash commands under `.factory/commands/`, and settings.json hook registrations in the Claude event dialect per Factory's hooks reference. Droid ships as a pure declarative capability descriptor (`capabilities/droid/capability.json`) under the ADR-1239 architecture with no `runtime === 'droid'` install branches beyond flag parsing. The gsd-local `FACTORY_HOME` env var redirects installer writes (used by tests to stay out of `~/.factory`).
