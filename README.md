# @voightxyz/openai

> **Beta.** API may change before the 0.1.0 stable release.

Voight observability for the OpenAI SDK. Wrap your OpenAI client and capture every model call — prompts, tokens, costs, latency, errors — surfaced live in the [Voight dashboard](https://voight.xyz).

## Install

```bash
npm install openai @voightxyz/openai@beta
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

| Signal | Status |
|---|---|
| Model id (with version suffix) | ✅ |
| Prompts + response text (privacy-respecting) | ✅ |
| Input / output / total tokens | ✅ |
| Cached input tokens (`prompt_tokens_details.cached_tokens` → `metadata.tokens.cache_read`) | ✅ since beta.2 |
| Streaming with token counts (auto-injects `stream_options.include_usage`) | ✅ |
| Finish reason | ✅ |
| Latency (ms) | ✅ |
| Errors (re-thrown to the caller, recorded with `outcome: 'failed'`) | ✅ |
| Tool / function calling | 🟡 beta.3 |
| `responses.create` (Responses API) | ⏳ beta.4 |
| Embeddings / images / audio | ⏳ 0.2.0 |
| Azure OpenAI client | ⏳ 0.2.0 |

## Privacy

Pass `privacy: 'minimal' | 'standard' | 'full'` (default `'standard'`). Standard scrubs 12 PII patterns (API keys, JWTs, emails, phone, credit cards) from prompts and responses before they leave the process. Minimal drops content entirely — only tokens, model, timing, and outcome survive.

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## License

Apache 2.0
