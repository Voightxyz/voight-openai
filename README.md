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

## Status

This is a **beta** release. The API surface is stable; what's coming next:

- `responses.create` (Responses API) — beta.2
- Tool / function calling capture — beta.2
- Embeddings, images, audio — 0.2.0
- Azure OpenAI client — 0.2.0

See [CHANGELOG.md](./CHANGELOG.md).

## License

Apache 2.0
