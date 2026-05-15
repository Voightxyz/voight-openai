/**
 * End-to-end smoke test for `wrapOpenAI`.
 *
 * Run with real credentials in the environment:
 *
 *   OPENAI_API_KEY=...   real OpenAI key, used for `new OpenAI()`
 *   VOIGHT_KEY=...       Voight API key, used by the wrapper
 *
 * Then:
 *   npx tsx examples/basic.ts
 *
 * Expected: the script prints a streamed answer to stdout AND a
 * single event appears in the Voight dashboard under the agent
 * label printed at startup.
 */

import OpenAI from 'openai'
import { wrapOpenAI } from '../src/index.js'

async function main() {
  const agent = 'voight-openai-smoke-test'
  console.log(`[smoke] agent = ${agent}`)

  const client = wrapOpenAI(new OpenAI(), {
    agent,
    privacy: 'full',
  })

  // ── Non-streaming ────────────────────────────────────────────
  console.log('[smoke] non-streaming…')
  const r1 = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Reply with exactly: pong' },
    ],
  })
  console.log('[smoke] response:', r1.choices[0]!.message.content)

  // ── Streaming ────────────────────────────────────────────────
  console.log('[smoke] streaming…')
  const stream = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    stream: true,
    messages: [
      { role: 'user', content: 'Count from 1 to 5 separated by spaces.' },
    ],
  })

  process.stdout.write('[smoke] stream output: ')
  for await (const chunk of stream) {
    const piece = chunk.choices[0]?.delta?.content ?? ''
    process.stdout.write(piece)
  }
  process.stdout.write('\n')

  // Give the fire-and-forget ingest a beat to flush.
  await new Promise((r) => setTimeout(r, 500))
  console.log('[smoke] done. check the Voight dashboard.')
}

main().catch((err) => {
  console.error('[smoke] failed:', err)
  process.exit(1)
})
