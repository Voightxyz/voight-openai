# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0-beta.2] — 2026-05-15

### Added

- Path-A token breakdown: when OpenAI reports cached prompt tokens via `usage.prompt_tokens_details.cached_tokens`, the wrapper now emits them as `metadata.tokens.cache_read`. The field is only present when the cache was actually used (strictly positive) so non-cache events keep a tight payload. Backend pricing engines can apply the OpenAI cache discount against this number directly.

## [0.1.0-beta.1] — 2026-05-15

### Added

- Initial scaffold.
- `wrapOpenAI(client, options)` — proxy wrapper that captures every call to the OpenAI SDK and forwards the event to the Voight backend.
- `chat.completions.create` instrumentation, non-streaming + streaming.
- Streaming token capture: the wrapper auto-injects `stream_options.include_usage: true` so the final chunk reports `usage` without the user having to opt in. An explicit `include_usage: false` from the caller is preserved.
- 3-level privacy redaction (`minimal` / `standard` / `full`).
- Fire-and-forget HTTP ingest to `https://api.voight.xyz/v1/events`.
- API key + agent identity resolution (`VOIGHT_KEY`, `VOIGHT_AGENT` env vars).
