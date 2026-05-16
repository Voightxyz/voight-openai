# @voightxyz/openai

Voight observability for the OpenAI SDK. Wrap your OpenAI client and capture every model call — prompts, tokens, cache reads, tool calls, costs, latency, errors — surfaced live in the [Voight dashboard](https://voight.xyz).

Same backend and dashboard as [`@voightxyz/anthropic`](https://www.npmjs.com/package/@voightxyz/anthropic). Drop in whichever provider your app uses; events from both land side-by-side under the same agent.

## Install

```bash
npm install openai @voightxyz/openai
```

## Quick start

```ts
import OpenAI from 'openai'
import { wrapOpenAI } from '@voightxyz/openai'

const client = wrapOpenAI(new OpenAI(), {
  voightApiKey: process.env.VOIGHT_KEY,
  agent: 'my-prod-agent',
})

const response = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

That's it — every call is captured automatically. Visit your [Voight dashboard](https://voight.xyz) to see them in real time.

## What's captured

| Signal | Where it lands |
|---|---|
| Model id (with version suffix) | `model` |
| Prompt messages | `input.messages` (or `input.input` for Responses API) |
| Response text | `metadata.responseText` |
| Token counts (input / output / total) | `metadata.tokens` |
| Cache reads (`prompt_tokens_details.cached_tokens`) | `metadata.tokens.cache_read` |
| Reasoning tokens (o1, o3 — Responses API only) | `metadata.tokens.reasoning` |
| Tool / function calls | `metadata.toolCalls` + `toolExecuted` |
| Streaming flag | `metadata.streaming` |
| API surface used (`chat.completions` vs `responses`) | `metadata.api` |
| Trace grouping (auto UUID or explicit) | `metadata.sessionId` |
| Finish reason / response status | `metadata.finishReason` |
| Latency (ms) | `durationMs` |
| Errors (re-thrown to the caller) | `errorMessage` + `outcome: 'failed'` |

## Supported endpoints

- `client.chat.completions.create` — legacy chat completions (non-streaming + streaming)
- `client.responses.create` — Responses API (non-streaming + streaming, function calls, reasoning models)

The wrapper passes everything else through untouched. Embeddings, images, audio, and the Azure OpenAI client are on the [0.2.0 roadmap](./CHANGELOG.md).

## Options

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `voightApiKey` | string | `process.env.VOIGHT_KEY` | Your Voight key from the dashboard |
| `agent` | string | `process.env.VOIGHT_AGENT` → `HOSTNAME` → `'unknown-agent'` | Stable identifier surfaced in the dashboard |
| `apiBase` | string | `https://api.voight.xyz` | Override for self-hosted deployments |
| `privacy` | `'minimal' \| 'standard' \| 'full'` | `'standard'` | Capture aggressiveness |
| `sessionId` | string | auto UUID v4 | Trace grouping. Stable across calls of one wrapper instance |
| `enabled` | boolean | `true` | Kill switch — returns the original client untouched |

## Privacy

Three levels apply to prompts, response text, and tool-call arguments. The function name in `toolExecuted` always survives as a tag (not user content).

| Level | Prompts | Response text | Tool arguments | Tokens / timing / model |
| --- | --- | --- | --- | --- |
| `minimal` | dropped | dropped | dropped | kept |
| `standard` (default) | scrubbed | scrubbed | scrubbed | kept |
| `full` | verbatim | verbatim | verbatim | kept |

Standard scrubs 12 patterns: PEM private keys, JWTs, Anthropic / OpenAI / Stripe live / GitHub / AWS / Slack / Voight API keys, emails, E.164 phones, and Luhn-validated credit cards.

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## License

Apache 2.0
