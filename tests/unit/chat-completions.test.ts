/**
 * Tests for the chat-completions instrument.
 *
 * Strategy:
 *   - The OpenAI SDK is treated as an opaque function: we hand the
 *     instrument a fake `original` that returns a canned response
 *     (or async iterator), and assert what events land in a captured
 *     ingest sink.
 *   - Privacy fan-out is exercised at the integration boundary
 *     only. The redaction patterns themselves are proven by
 *     privacy.test.ts; here we just confirm the right level
 *     reaches the event.
 *   - Streaming covers the wrapper's most subtle contract: chunks
 *     must pass through to the user unchanged AND aggregate
 *     internally for the post-stream event.
 */

import { describe, it, expect, vi } from 'vitest'

import { instrumentChatCompletions } from '../../src/instruments/chat-completions.js'
import type { EventPayload } from '../../src/types.js'

function makeContext(overrides: Partial<{
  privacy: 'minimal' | 'standard' | 'full'
  agentId: string
  now: () => number
}> = {}) {
  const events: EventPayload[] = []
  const ingest = { send: (e: EventPayload) => void events.push(e) }
  const times = [1000, 1250]
  const ctx = {
    agentId: overrides.agentId ?? 'test-agent',
    privacy: overrides.privacy ?? 'full' as const,
    ingest,
    now: overrides.now ?? (() => times.shift() ?? 0),
  }
  return { ctx, events }
}

function nonStreamingResponse(extra: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chatcmpl-test-1',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello back' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    },
    ...extra,
  }
}

describe('instrumentChatCompletions — non-streaming', () => {
  it('passes the original response through to the caller', async () => {
    const { ctx } = makeContext()
    const original = vi.fn(async () => nonStreamingResponse())
    const wrapped = instrumentChatCompletions(original as never, ctx)

    const result = await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result).toEqual(nonStreamingResponse())
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('emits one event per call', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    })

    // Ingest is fire-and-forget, but our test sink is synchronous,
    // so the event has already landed.
    await new Promise((r) => setTimeout(r, 0))
    expect(events).toHaveLength(1)
  })

  it('event carries model, agentId, durationMs, outcome=success', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect(e.agentId).toBe('test-agent')
    expect(e.model).toBe('gpt-4o-mini')
    expect(e.durationMs).toBe(250)
    expect(e.outcome).toBe('success')
    expect(e.type).toBe('reasoning')
    expect(e.metadata?.source).toBe('openai-sdk')
  })

  it('event carries token counts under metadata.tokens', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).toEqual({
      input: 12,
      output: 5,
      total: 17,
    })
  })

  it('captures cache_read when prompt_tokens_details.cached_tokens is present', async () => {
    /**
     * OpenAI auto-caches prompts >1024 tokens. The cached portion is
     * reported back in `usage.prompt_tokens_details.cached_tokens`
     * (verified against the official @types/openai bundled
     * declarations 2026-05-15). Path-A pricing requires that this
     * portion be tracked separately so consumers (and the backend
     * cost engine) can apply the OpenAI cache discount.
     */
    const { ctx, events } = makeContext()
    const responseWithCache = nonStreamingResponse({
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 200,
        total_tokens: 1700,
        prompt_tokens_details: {
          cached_tokens: 1024,
        },
      },
    })
    const wrapped = instrumentChatCompletions(
      (async () => responseWithCache) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'long prompt here' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).toEqual({
      input: 1500,
      output: 200,
      total: 1700,
      cache_read: 1024,
    })
  })

  it('omits cache_read when prompt_tokens_details is absent', async () => {
    // Backwards-compatibility: pre-cache-aware OpenAI responses (or
    // models that don't cache) must still produce a clean event with
    // no spurious `cache_read: 0` noise.
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).not.toHaveProperty('cache_read')
  })

  it('omits cache_read when cached_tokens is zero', async () => {
    // Even when the details object is present, a `cached_tokens: 0`
    // value is informationally identical to "no cache used" and we
    // skip it to keep the metadata payload tight.
    const { ctx, events } = makeContext()
    const responseNoCacheHit = nonStreamingResponse({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        prompt_tokens_details: {
          cached_tokens: 0,
        },
      },
    })
    const wrapped = instrumentChatCompletions(
      (async () => responseNoCacheHit) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).not.toHaveProperty('cache_read')
  })

  it('under privacy=full, includes messages + responseText', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'mail me at user@example.com' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect(e.input?.messages).toBeDefined()
    expect((e.input!.messages as { content: string }[])[0]!.content).toBe(
      'mail me at user@example.com',
    )
    expect(e.metadata?.responseText).toBe('hello back')
  })

  it('under privacy=standard, redacts PII in messages + responseText', async () => {
    const { ctx, events } = makeContext({ privacy: 'standard' })
    const wrapped = instrumentChatCompletions(
      (async () =>
        nonStreamingResponse({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'reply to test@acme.io',
              },
              finish_reason: 'stop',
            },
          ],
        })) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'reach user@example.com' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect((e.input!.messages as { content: string }[])[0]!.content).toBe(
      'reach [REDACTED-EMAIL]',
    )
    expect(e.metadata?.responseText).toBe('reply to [REDACTED-EMAIL]')
  })

  it('under privacy=minimal, drops messages + responseText, keeps tokens + model', async () => {
    const { ctx, events } = makeContext({ privacy: 'minimal' })
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'reach user@example.com' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect(e.input).toBeUndefined()
    expect(e.metadata?.responseText).toBeUndefined()
    expect(e.model).toBe('gpt-4o-mini')
    expect(e.metadata?.tokens).toBeDefined()
  })

  it('records outcome=failed + errorMessage when original throws, then re-throws', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => {
        throw new Error('rate_limit_exceeded')
      }) as never,
      ctx,
    )

    await expect(
      wrapped({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('rate_limit_exceeded')

    await new Promise((r) => setTimeout(r, 0))
    expect(events).toHaveLength(1)
    expect(events[0]!.outcome).toBe('failed')
    expect(events[0]!.errorMessage).toBe('rate_limit_exceeded')
  })
})

describe('instrumentChatCompletions — streaming usage injection', () => {
  /**
   * OpenAI doesn't send `usage` in streaming chunks unless the
   * caller opts in via `stream_options.include_usage: true`. We
   * inject this default when the user enables streaming, so token
   * capture works without any setup on their side. The user's
   * explicit choice always wins.
   */
  it('auto-injects stream_options.include_usage when streaming and not set', async () => {
    const { ctx } = makeContext()
    const seen: ChatCreateParamsCaptured[] = []
    const wrapped = instrumentChatCompletions(
      (async (p: ChatCreateParamsCaptured) => {
        seen.push(p)
        return (async function* () {
          yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        })()
      }) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    expect(seen[0]!.stream_options).toEqual({ include_usage: true })
  })

  it('preserves other stream_options keys when injecting include_usage', async () => {
    const { ctx } = makeContext()
    const seen: ChatCreateParamsCaptured[] = []
    const wrapped = instrumentChatCompletions(
      (async (p: ChatCreateParamsCaptured) => {
        seen.push(p)
        return (async function* () {
          yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        })()
      }) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      stream_options: { some_future_flag: true },
    } as never)) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    expect(seen[0]!.stream_options).toEqual({
      some_future_flag: true,
      include_usage: true,
    })
  })

  it('does NOT override an explicit include_usage: false', async () => {
    const { ctx } = makeContext()
    const seen: ChatCreateParamsCaptured[] = []
    const wrapped = instrumentChatCompletions(
      (async (p: ChatCreateParamsCaptured) => {
        seen.push(p)
        return (async function* () {
          yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        })()
      }) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      stream_options: { include_usage: false },
    } as never)) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    expect(seen[0]!.stream_options).toEqual({ include_usage: false })
  })

  it('does NOT mutate the caller-supplied params object', async () => {
    const { ctx } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () =>
        (async function* () {
          yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        })()) as never,
      ctx,
    )

    const userParams: Record<string, unknown> = {
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }
    const stream = (await wrapped(userParams as never)) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    expect(userParams.stream_options).toBeUndefined()
  })

  it('does NOT inject anything when stream is false', async () => {
    const { ctx } = makeContext()
    const seen: ChatCreateParamsCaptured[] = []
    const wrapped = instrumentChatCompletions(
      (async (p: ChatCreateParamsCaptured) => {
        seen.push(p)
        return nonStreamingResponse()
      }) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(seen[0]!.stream_options).toBeUndefined()
  })
})

interface ChatCreateParamsCaptured {
  model: string
  messages: unknown[]
  stream?: boolean
  stream_options?: Record<string, unknown>
}

describe('instrumentChatCompletions — streaming', () => {
  async function* mockStream() {
    yield {
      id: 'chatcmpl-stream-1',
      created: 1700000000,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hel' } }],
    }
    yield {
      id: 'chatcmpl-stream-1',
      created: 1700000000,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'lo' } }],
    }
    yield {
      id: 'chatcmpl-stream-1',
      created: 1700000000,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      },
    }
  }

  it('passes every chunk to the caller in order, unchanged', async () => {
    const { ctx } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => mockStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })) as AsyncIterable<{ choices: { delta: { content?: string } }[] }>

    const seen: string[] = []
    for await (const chunk of stream) {
      const c = chunk.choices[0]?.delta.content
      if (c !== undefined) seen.push(c)
    }
    expect(seen).toEqual(['hel', 'lo'])
  })

  it('captures cache_read from the streaming usage chunk when present', async () => {
    /**
     * Mirror of the non-streaming cache test for the streaming path:
     * the final chunk's `usage.prompt_tokens_details.cached_tokens`
     * must land on `metadata.tokens.cache_read` so Path-A pricing
     * works the same for both transports.
     */
    async function* mockStreamWithCache() {
      yield {
        id: 'chatcmpl-cache-1',
        created: 1700000000,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: 'ok' } }],
      }
      yield {
        id: 'chatcmpl-cache-1',
        created: 1700000000,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 200,
          total_tokens: 1700,
          prompt_tokens_details: { cached_tokens: 1024 },
        },
      }
    }

    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentChatCompletions(
      (async () => mockStreamWithCache()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'long prompt' }],
    })) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    await new Promise((r) => setTimeout(r, 0))
    expect(events[0]!.metadata?.tokens).toEqual({
      input: 1500,
      output: 200,
      total: 1700,
      cache_read: 1024,
    })
  })

  it('emits a single event with aggregated response after the stream ends', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentChatCompletions(
      (async () => mockStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })) as AsyncIterable<unknown>

    // Drain
    for await (const _ of stream) void _

    await new Promise((r) => setTimeout(r, 0))
    expect(events).toHaveLength(1)
    expect(events[0]!.model).toBe('gpt-4o-mini')
    expect(events[0]!.metadata?.responseText).toBe('hello')
    expect(events[0]!.metadata?.streaming).toBe(true)
    expect(events[0]!.metadata?.tokens).toEqual({
      input: 10,
      output: 2,
      total: 12,
    })
  })
})
