/**
 * Verify the Responses API instrument (0.1.0-beta.5) end-to-end.
 *
 * Three calls under the same wrapped client (so the sessionId
 * stays stable):
 *   1. responses.create non-streaming text → expect responseText
 *   2. responses.create with function call → expect toolExecuted
 *      and metadata.toolCalls
 *   3. responses.create streaming text → expect streaming:true and
 *      aggregated responseText
 *
 *   OPENAI_API_KEY=... VOIGHT_KEY=... npx tsx examples/responses-smoke.ts
 */

import OpenAI from 'openai'
import { wrapOpenAI } from '../src/index.js'

const WEATHER_TOOL = {
  type: 'function' as const,
  name: 'get_weather',
  description: 'Get current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
    },
    required: ['location'],
  },
}

async function main() {
  const client = wrapOpenAI(new OpenAI(), {
    agent: 'voight-openai-smoke-test',
    privacy: 'full',
  })

  console.log('[smoke] 1/3 non-streaming text…')
  const r1 = await client.responses.create({
    model: 'gpt-4o-mini',
    input: 'Reply with exactly: pong',
  })
  console.log(`[smoke] response: ${r1.output_text}`)

  console.log('[smoke] 2/3 non-streaming function call…')
  const r2 = await client.responses.create({
    model: 'gpt-4o-mini',
    input: "What's the weather in Tokyo?",
    tools: [WEATHER_TOOL],
  })
  const fc = (r2.output ?? []).find(
    (item: { type: string }) => item.type === 'function_call',
  ) as { name?: string; arguments?: string } | undefined
  if (fc) {
    console.log(`[smoke] tool: ${fc.name}(${fc.arguments})`)
  } else {
    console.log('[smoke] no function call returned')
  }

  console.log('[smoke] 3/3 streaming text…')
  const stream = await client.responses.create({
    model: 'gpt-4o-mini',
    input: 'Count from 1 to 5 separated by spaces.',
    stream: true,
  })
  let text = ''
  for await (const event of stream as AsyncIterable<{
    type: string
    delta?: string
  }>) {
    if (event.type === 'response.output_text.delta' && event.delta) {
      text += event.delta
    }
  }
  console.log(`[smoke] streamed text: ${text}`)

  // Fire-and-forget ingest needs a beat to flush.
  await new Promise((r) => setTimeout(r, 1000))
  console.log('[smoke] done. Check the dashboard — 3 new events under')
  console.log('         voight-openai-smoke-test with metadata.api = "responses".')
}

main().catch((err) => {
  console.error('[smoke] failed:', err)
  process.exit(1)
})
