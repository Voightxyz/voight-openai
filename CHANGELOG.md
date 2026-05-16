# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0-beta.4] — 2026-05-16

### Added

- `sessionId` is now stamped on every emitted event under `metadata.sessionId`. The wrapper auto-generates a UUID v4 once per `wrapOpenAI()` call and reuses it for the life of the wrapped client. An explicit `options.sessionId` overrides the auto value so callers can scope a trace per-user / per-conversation / per-request. The Voight dashboard groups events with the same `sessionId` into a single trace timeline.

## [0.1.0-beta.3] — 2026-05-15

### Added

- Tool / function calling capture. When the model returns one or more tool calls, the wrapper now emits `metadata.toolCalls: [{ id, name, arguments }]` and mirrors the first tool's name into the top-level `toolExecuted` field (audit-log compat with hook events). Works for both non-streaming responses and streaming deltas — the streaming aggregator keys per-tool entries by `index` and concatenates argument fragments in arrival order.
- Privacy fan-out for tool calls: under `minimal`, only `toolExecuted` (the function name, a tag not user content) survives; the arguments — which can carry user data — drop entirely. Under `standard`, arguments are scrubbed against the same 12 PII patterns the rest of the payload uses. Under `full`, arguments pass through verbatim.

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
