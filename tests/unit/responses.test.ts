/**
 * Tests for the responses.create instrument (OpenAI Responses API).
 *
 * Strategy mirrors chat-completions.test.ts:
 *   - The OpenAI SDK is treated as opaque: we hand the instrument
 *     a fake `original` that returns a canned Response (or async
 *     iterator of stream events), and assert what lands in a
 *     captured ingest sink.
 *
 * Responses API differs from chat.completions in three places this
 * suite is explicit about:
 *   - The response carries `output: ResponseOutputItem[]` (typed
 *     items: message, function_call, reasoning, …) rather than
 *     `choices[].message`. Text comes from `output_text` (a
 *     convenience field the SDK populates) or aggregated message
 *     content. Function calls are top-level items with
 *     `{ call_id, name, arguments, type: 'function_call' }`.
 *   - `usage.input_tokens_details.cached_tokens` carries the cache
 *     read count. `usage.output_tokens_details.reasoning_tokens`
 *     carries the reasoning model "thinking" overhead — captured
 *     so o1/o3 cost analysis stays accurate.
 *   - Streaming is a typed event union with 60+ types. The
 *     instrument captures the critical ones: text_delta,
 *     function_call args delta, completed (final state), failed.
 */

import { describe, it, expect, vi } from 'vitest'

import { instrumentResponses } from '../../src/instruments/responses.js'
import type { EventPayload } from '../../src/types.js'

function makeContext(
  overrides: Partial<{
    privacy: 'minimal' | 'standard' | 'full'
    agentId: string
    sessionId: string
    now: () => number
  }> = {},
) {
  const events: EventPayload[] = []
  const ingest = { send: (e: EventPayload) => void events.push(e) }
  const times = [1000, 1250]
  const ctx = {
    agentId: overrides.agentId ?? 'test-agent',
    privacy: overrides.privacy ?? ('full' as const),
    sessionId: overrides.sessionId ?? 'sess-test',
    ingest,
    now: overrides.now ?? (() => times.shift() ?? 0),
  }
  return { ctx, events }
}

function nonStreamingResponse(
  extra: Partial<Record<string, unknown>> = {},
) {
  return {
    id: 'resp_test_1',
    object: 'response',
    created_at: 1700000000,
    model: 'gpt-4o-mini',
    status: 'completed',
    output_text: 'pong',
    output: [
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'pong' }],
      },
    ],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
    ...extra,
  }
}

describe('instrumentResponses — non-streaming', () => {
  it('passes the original response through to the caller', async () => {
    const { ctx } = makeContext()
    const original = vi.fn(async () => nonStreamingResponse())
    const wrapped = instrumentResponses(original as never, ctx)

    const result = await wrapped({
      model: 'gpt-4o-mini',
      input: 'hi',
    } as never)

    expect(result).toEqual(nonStreamingResponse())
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('emits one event with source=openai-sdk and api=responses', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentResponses(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({ model: 'gpt-4o-mini', input: 'hi' } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.metadata?.source).toBe('openai-sdk')
    expect(e.metadata?.api).toBe('responses')
    expect(e.agentId).toBe('test-agent')
    expect(e.model).toBe('gpt-4o-mini')
    expect(e.durationMs).toBe(250)
    expect(e.outcome).toBe('success')
    expect(e.type).toBe('reasoning')
  })

  it('stamps sessionId on every event', async () => {
    const { ctx, events } = makeContext({ sessionId: 'sess-abc' })
    const wrapped = instrumentResponses(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )

    await wrapped({ model: 'gpt-4o-mini', input: 'hi' } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.sessionId).toBe('sess-abc')
  })

  it('extracts response text from output_text', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentResponses(
      (async () =>
        nonStreamingResponse({ output_text: 'Hello world' })) as never,
      ctx,
    )

    await wrapped({ model: 'gpt-4o-mini', input: 'say hi' } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.responseText).toBe('Hello world')
  })

  it('aggregates text from output[].message.content when output_text is absent', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentResponses(
      (async () =>
        nonStreamingResponse({
          output_text: undefined,
          output: [
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                { type: 'output_text', text: 'Part one. ' },
                { type: 'output_text', text: 'Part two.' },
              ],
            },
          ],
        })) as never,
      ctx,
    )

    await wrapped({ model: 'gpt-4o-mini', input: 'hi' } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(events[0]!.metadata?.responseText).toBe('Part one. Part two.')
  })

  it('captures function_call items into metadata.toolCalls and toolExecuted', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentResponses(
      (async () =>
        nonStreamingResponse({
          output: [
            {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_abc',
              name: 'get_weather',
              arguments: '{"location":"Tokyo"}',
            },
          ],
        })) as never,
      ctx,
    )

    await wrapped({ model: 'gpt-4o-mini', input: 'weather?' } as never)
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect(e.toolExecuted).toBe('get_weather')
    expect(e.metadata?.toolCalls).toEqual([
      {
        id: 'call_abc',
        name: 'get_weather',
        arguments: '{"location":"Tokyo"}',
      },
    ])
  })

  it('captures cache_read when input_tokens_details.cached_tokens > 0', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentResponses(
      (async () =>
        nonStreamingResponse({
          usage: {
            input_tokens: 1500,
            input_tokens_details: { cached_tokens: 1024 },
            output_tokens: 200,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 1700,
          },
        })) as never,
      ctx,
    )

    await wrapped({ model: 'gpt-4o-mini', input: 'long' } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).toEqual({
      input: 1500,
      output: 200,
      total: 1700,
      cache_read: 1024,
    })
  })

  it('captures reasoning_tokens when output_tokens_details reports them', async () => {
    /**
     * Reasoning models (o1, o3) emit "thinking" tokens that count
     * toward output_tokens but are tracked separately. Surfacing
     * the breakdown lets the dashboard show what fraction of
     * output cost was reasoning vs visible answer.
     */
    const { ctx, events } = makeContext()
    const wrapped = instrumentResponses(
      (async () =>
        nonStreamingResponse({
          usage: {
            input_tokens: 50,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 500,
            output_tokens_details: { reasoning_tokens: 380 },
            total_tokens: 550,
          },
        })) as never,
      ctx,
    )

    await wrapped({ model: 'o3-mini', input: 'solve' } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(events[0]!.metadata?.tokens).toEqual({
      input: 50,
      output: 500,
      total: 550,
      reasoning: 380,
    })
  })

  it('captures status on metadata.finishReason', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentResponses(
      (async () =>
        nonStreamingResponse({ status: 'incomplete' })) as never,
      ctx,
    )
    await wrapped({ model: 'gpt-4o-mini', input: 'hi' } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(events[0]!.metadata?.finishReason).toBe('incomplete')
  })

  it('drops messages + responseText + toolCalls under privacy=minimal but keeps toolExecuted', async () => {
    const { ctx, events } = makeContext({ privacy: 'minimal' })
    const wrapped = instrumentResponses(
      (async () =>
        nonStreamingResponse({
          output: [
            {
              id: 'fc_1',
              type: 'function_call',
              call_id: 'call_x',
              name: 'send_email',
              arguments: '{"to":"user@example.com"}',
            },
          ],
        })) as never,
      ctx,
    )

    await wrapped({ model: 'gpt-4o-mini', input: 'send mail' } as never)
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect(e.input).toBeUndefined()
    expect(e.metadata?.responseText).toBeUndefined()
    expect(e.metadata?.toolCalls).toBeUndefined()
    expect(e.toolExecuted).toBe('send_email')
    expect(e.metadata?.tokens).toBeDefined()
  })

  it('scrubs PII inside input + response + tool args under privacy=standard', async () => {
    const { ctx, events } = makeContext({ privacy: 'standard' })
    const wrapped = instrumentResponses(
      (async () =>
        nonStreamingResponse({
          output_text: 'reply to jane@acme.io',
          output: [
            {
              id: 'fc_1',
              type: 'function_call',
              call_id: 'call_x',
              name: 'send_email',
              arguments: '{"to":"support@example.com"}',
            },
          ],
        })) as never,
      ctx,
    )

    await wrapped({
      model: 'gpt-4o-mini',
      input: 'mail me at user@example.com',
    } as never)
    await new Promise((r) => setTimeout(r, 0))

    const e = events[0]!
    expect(e.input?.input).toBe('mail me at [REDACTED-EMAIL]')
    expect(e.metadata?.responseText).toBe('reply to [REDACTED-EMAIL]')
    const calls = e.metadata?.toolCalls as Array<{ arguments: string }>
    expect(calls[0]!.arguments).toContain('[REDACTED-EMAIL]')
  })

  it('records outcome=failed + errorMessage when original throws, then re-throws', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentResponses(
      (async () => {
        throw new Error('rate_limit_exceeded')
      }) as never,
      ctx,
    )

    await expect(
      wrapped({ model: 'gpt-4o-mini', input: 'hi' } as never),
    ).rejects.toThrow('rate_limit_exceeded')

    await new Promise((r) => setTimeout(r, 0))
    expect(events).toHaveLength(1)
    expect(events[0]!.outcome).toBe('failed')
    expect(events[0]!.errorMessage).toBe('rate_limit_exceeded')
  })
})

describe('instrumentResponses — streaming', () => {
  /**
   * Mock the typed event sequence produced by the Responses API
   * when stream:true. Only the critical events for capture are
   * yielded — the rest of the 60+ event types in the production
   * stream are ignored by the aggregator and don't affect the
   * emitted Voight event.
   */
  async function* mockTextStream() {
    yield {
      type: 'response.created',
      response: {
        id: 'resp_s1',
        model: 'gpt-4o-mini',
        status: 'in_progress',
      },
    }
    yield {
      type: 'response.output_text.delta',
      delta: 'hel',
    }
    yield {
      type: 'response.output_text.delta',
      delta: 'lo',
    }
    yield {
      type: 'response.completed',
      response: {
        id: 'resp_s1',
        model: 'gpt-4o-mini',
        status: 'completed',
        output_text: 'hello',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      },
    }
  }

  it('passes every event to the caller in order, unchanged', async () => {
    const { ctx } = makeContext()
    const wrapped = instrumentResponses(
      (async () => mockTextStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      input: 'hi',
      stream: true,
    } as never)) as AsyncIterable<{ type: string }>
    const types: string[] = []
    for await (const ev of stream) types.push(ev.type)

    expect(types).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.completed',
    ])
  })

  it('emits a single event with aggregated text + final usage', async () => {
    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentResponses(
      (async () => mockTextStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      input: 'hi',
      stream: true,
    } as never)) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    await new Promise((r) => setTimeout(r, 0))
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.metadata?.responseText).toBe('hello')
    expect(e.metadata?.streaming).toBe(true)
    expect(e.metadata?.tokens).toEqual({
      input: 10,
      output: 2,
      total: 12,
    })
    expect(e.metadata?.finishReason).toBe('completed')
  })

  it('aggregates streaming function_call args into metadata.toolCalls', async () => {
    async function* mockToolStream() {
      yield {
        type: 'response.created',
        response: { id: 'resp_t1', model: 'gpt-4o-mini', status: 'in_progress' },
      }
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_stream',
          type: 'function_call',
          call_id: 'call_stream',
          name: 'get_weather',
          arguments: '',
        },
      }
      yield {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"loc',
      }
      yield {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: 'ation":"Tokyo"}',
      }
      yield {
        type: 'response.completed',
        response: {
          id: 'resp_t1',
          model: 'gpt-4o-mini',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 50,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 70,
          },
        },
      }
    }

    const { ctx, events } = makeContext({ privacy: 'full' })
    const wrapped = instrumentResponses(
      (async () => mockToolStream()) as never,
      ctx,
    )

    const stream = (await wrapped({
      model: 'gpt-4o-mini',
      input: 'weather?',
      stream: true,
    } as never)) as AsyncIterable<unknown>
    for await (const _ of stream) void _

    await new Promise((r) => setTimeout(r, 0))
    expect(events[0]!.toolExecuted).toBe('get_weather')
    expect(events[0]!.metadata?.toolCalls).toEqual([
      {
        id: 'call_stream',
        name: 'get_weather',
        arguments: '{"location":"Tokyo"}',
      },
    ])
  })
})
