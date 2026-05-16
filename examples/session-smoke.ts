/**
 * Verify that sessionId lands on metadata for every event from a
 * single wrapper instance. Two calls + a tool call from the same
 * wrapped client → all three events should share one sessionId.
 *
 *   OPENAI_API_KEY=... VOIGHT_KEY=... npx tsx examples/session-smoke.ts
 */

import OpenAI from 'openai'
import { wrapOpenAI } from '../src/index.js'

async function main() {
  const client = wrapOpenAI(new OpenAI(), {
    agent: 'voight-openai-smoke-test',
    privacy: 'full',
  })

  await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Reply with: session-1' }],
  })
  await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Reply with: session-2' }],
  })
  await new Promise((r) => setTimeout(r, 1000))
  console.log('[smoke] 2 openai events fired — same sessionId expected on both')
}

main().catch((err) => {
  console.error('[smoke] failed:', err)
  process.exit(1)
})
