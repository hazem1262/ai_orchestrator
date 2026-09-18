# Fixtures
All content is made up and redacted. Layout mirrors `~/.claude` and `~/.codex` (see docs/04-data-sources.md).
Tests copy these into a temp dir and point CLAUDE_HOME / CODEX_HOME at the copy — never mutate in place.
`s-errors.jsonl` intentionally ends with a truncated line; `s-unknown.jsonl` intentionally contains unknown types and a non-JSON line.
The only intentional secret-like strings are the fake `PGPASSWORD=hunter2` in `s-drift.jsonl` (used by redaction tests).
