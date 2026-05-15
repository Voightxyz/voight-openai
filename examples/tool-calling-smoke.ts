/**
 * Smoke test for tool / function calling capture (0.1.0-beta.3).
 *
 * We define two tools and ask the model a question that nudges it
 * toward calling one of them. The wrapper should:
 *
 *   - emit `toolExecuted: '<first-tool-name>'` on the event
 *   - emit `metadata.toolCalls: [{ id, name, arguments }]`
 *
 * Both non-streaming and streaming runs are exercised. The
 * streaming aggregator must concatenate the argument fragments
 * back into a single string per tool call.
 *
 * Run with:
 *   OPENAI_API_KEY=... VOIGHT_KEY=... npx tsx examples/tool-calling-smoke.ts
 */

import OpenAI from 'openai'
import { wrapOpenAI } from '../src/index.js'

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Return the current weather for a city.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name, e.g. "Tokyo" or "Madrid"',
          },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_docs',
      description: 'Search internal documentation for a query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
]

async function main() {
  const agent = 'voight-openai-smoke-test'
  console.log(`[smoke] agent = ${agent}`)

  const client = wrapOpenAI(new OpenAI(), {
    agent,
    privacy: 'full',
  })

  // ── Non-streaming ────────────────────────────────────────────
  console.log('[smoke] non-streaming tool call…')
  const r1 = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content:
          "What's the weather in Tokyo right now? Use the available tool.",
      },
    ],
    tools: TOOLS,
  })
  const toolCalls1 = r1.choices[0]?.message?.tool_calls
  if (toolCalls1 && toolCalls1.length > 0) {
    console.log(
      `[smoke] non-streaming result: ${toolCalls1.length} tool call(s) — first: ${toolCalls1[0]!.function.name}(${toolCalls1[0]!.function.arguments})`,
    )
  } else {
    console.log('[smoke] non-streaming: model returned no tool calls (text only)')
  }

  // ── Streaming ────────────────────────────────────────────────
  console.log('[smoke] streaming tool call…')
  const stream = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    stream: true,
    messages: [
      {
        role: 'user',
        content:
          'Search the docs for "rate limiting". Use the search_docs tool.',
      },
    ],
    tools: TOOLS,
  })

  // Pure pass-through aggregation so we can echo what the user
  // would have seen — the wrapper handles its own aggregation
  // internally in parallel.
  let collected = ''
  const toolNames = new Set<string>()
  for await (const chunk of stream) {
    const choice = chunk.choices[0]
    if (choice?.delta?.content) collected += choice.delta.content
    for (const tc of choice?.delta?.tool_calls ?? []) {
      if (tc.function?.name) toolNames.add(tc.function.name)
    }
  }
  console.log(
    `[smoke] streaming result: tool names seen in deltas: ${[...toolNames].join(', ') || '(none — text mode)'}`,
  )
  if (collected) console.log(`[smoke] streaming text fallback: ${collected}`)

  // Give the fire-and-forget ingest a beat to flush.
  await new Promise((r) => setTimeout(r, 1000))
  console.log(
    '[smoke] done. Verify in dashboard: 2 new events under voight-openai-smoke-test,',
  )
  console.log(
    '       both with `toolExecuted` populated and `metadata.toolCalls[]` carrying name + arguments.',
  )
}

main().catch((err) => {
  console.error('[smoke] failed:', err)
  process.exit(1)
})
