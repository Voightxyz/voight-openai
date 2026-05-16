# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] — 2026-05-16

First stable release. Consolidates beta.1 through beta.5.

### Capabilities

- `wrapOpenAI(client, options)` — three-layer Proxy (`client → chat → completions → create`) plus a sibling layer for `client.responses.create`. Everything outside the instrumented paths passes through untouched.
- Chat Completions surface: non-streaming + streaming `chat.completions.create`. Streaming auto-injects `stream_options.include_usage: true` so token counts always land. Tool / function calling captured for both transports, with streaming `tool_calls` deltas aggregated by `index`.
- Responses API surface: non-streaming + streaming `responses.create`. State machine over the typed event union handles text deltas, function-call argument fragments, and final usage from `response.completed`. Events from this surface carry `metadata.api: 'responses'` so dashboards can distinguish the call site (chat-completions events omit the field).
- Token capture: `input` / `output` / `total` always present. `cache_read` from `prompt_tokens_details.cached_tokens` when positive. `reasoning` from `output_tokens_details.reasoning_tokens` when positive (o1, o3, future reasoning models).
- `sessionId` emission: each wrapper instance resolves a UUID v4 once (or accepts an explicit override) and stamps it on `metadata.sessionId` for every event. Dashboards group events sharing a sessionId into a single trace timeline.
- Three-level privacy redaction (`minimal` / `standard` / `full`) over prompts, response text, and tool arguments via a 12-pattern catalogue: PEM private keys, JWTs, Anthropic / OpenAI / Stripe live / GitHub / AWS / Slack / Voight API keys, emails, E.164 phones, and Luhn-validated credit cards. Function-call names always survive as tags.
- Fire-and-forget HTTP ingest to `https://api.voight.xyz/v1/events`. Never throws, never blocks the caller. `onError` hook for development.
- API key + agent identity resolution: `voightApiKey` option → `VOIGHT_KEY` env → `null`. `agent` option → `VOIGHT_AGENT` env → `HOSTNAME` env → `'unknown-agent'`.
- Non-fatal failure modes: `enabled: false` and missing API key both return the original client untouched.

### Tests

- 89 unit tests across privacy, identity, ingest, chat-completions, responses, and wrap surfaces. All green.
- End-to-end smoke verified against real OpenAI + real Voight backend: text, streaming text, tool calls (both surfaces), `cache_read` on cached prompts, `metadata.api` discrimination.

## [0.1.0-beta.5] — 2026-05-16

### Added

- Responses API support. The wrapper now intercepts `client.responses.create` in addition to `client.chat.completions.create`. Same event shape, same privacy model, same dashboard target — events from the new Responses surface land alongside chat-completions events under the same agent. Events carry `metadata.api: 'responses'` so the dashboard can distinguish call sites; chat-completions events omit the field (preserving the existing surface).
- Non-streaming capture: pulls text from `response.output_text` (or aggregates from `output[].message.content[]`), flattens function calls from `output[].function_call` items into `metadata.toolCalls` with the same `{ id, name, arguments }` shape produced by chat-completions.
- Streaming capture: state machine over the typed event union (`response.created`, `response.output_text.delta`, `response.output_item.added`, `response.function_call_arguments.delta`, `response.completed`, plus error/incomplete terminal states). Other event types in the 60+ union (audio, web_search, file_search, code_interpreter, image_gen, MCP, …) pass through untouched and do not affect capture.
- Reasoning-token capture: when `usage.output_tokens_details.reasoning_tokens > 0` (o1, o3, future reasoning models), the wrapper surfaces it as `metadata.tokens.reasoning` so cost analysis can separate visible-answer cost from "thinking" overhead.

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
