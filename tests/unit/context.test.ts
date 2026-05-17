/**
 * Tests for the async-context layer that powers parent-span tracking,
 * route tagging, and log capture inside wrapped calls.
 *
 * Two surfaces are exercised:
 *   1. The pure helpers in `src/context.ts` + `src/log.ts` —
 *      withTrace / log / drainTraceLogs / pushSpanAndRun behave
 *      correctly in isolation and stay safe outside any trace.
 *   2. The integration with `instrumentChatCompletions` — events
 *      emitted inside a withTrace boundary carry the expected
 *      metadata.spanId / parentSpanId / endpoint / logs; events
 *      emitted outside still carry a stable spanId so the dashboard
 *      always has a key, but skip the trace-scoped fields.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  drainTraceLogs,
  getCurrentTrace,
  pushSpanAndRun,
  withTrace,
} from '../../src/context.js'
import { log } from '../../src/log.js'
import { instrumentChatCompletions } from '../../src/instruments/chat-completions.js'
import type { EventPayload } from '../../src/types.js'

// ─── Test-only ctx + response factories ─────────────────────────

function makeContext(
  overrides: Partial<{ routeTag: string; sessionId: string }> = {},
) {
  const events: EventPayload[] = []
  const ingest = { send: (e: EventPayload) => void events.push(e) }
  let t = 1000
  return {
    events,
    ctx: {
      agentId: 'agent-x',
      privacy: 'full' as const,
      sessionId: overrides.sessionId ?? 'sess-test',
      routeTag: overrides.routeTag,
      ingest,
      now: () => {
        const v = t
        t += 250
        return v
      },
    },
  }
}

function nonStreamingResponse() {
  return {
    id: 'chatcmpl-test',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }
}

// ─── 1. Pure context helpers ─────────────────────────────────────

describe('withTrace / log / drain — outside a trace', () => {
  it('getCurrentTrace returns undefined when no trace is active', () => {
    expect(getCurrentTrace()).toBeUndefined()
  })

  it('log() is a no-op (and does not throw) outside withTrace', () => {
    expect(() => log('orphan line')).not.toThrow()
    // Nothing observable to assert — verified indirectly via the
    // integration test below (no metadata.logs on the event).
  })

  it('drainTraceLogs() returns an empty array outside withTrace', () => {
    expect(drainTraceLogs()).toEqual([])
  })

  it('pushSpanAndRun outside withTrace just runs the fn', async () => {
    const spy = vi.fn(async () => 'ok')
    const result = await pushSpanAndRun('span-1', spy)
    expect(result).toBe('ok')
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('withTrace — frame lifecycle', () => {
  it('opens a frame with an empty logs buffer + supplied routeTag', async () => {
    await withTrace(
      async () => {
        const trace = getCurrentTrace()
        expect(trace).toBeDefined()
        expect(trace!.logs).toEqual([])
        expect(trace!.routeTag).toBe('POST /api/chat')
        expect(trace!.tags).toBeUndefined()
        expect(trace!.currentSpanId).toBeUndefined()
      },
      { routeTag: 'POST /api/chat' },
    )
  })

  it('attaches supplied tags to the frame for downstream events', async () => {
    await withTrace(
      async () => {
        const trace = getCurrentTrace()
        expect(trace!.tags).toEqual({
          userId: 'user_123',
          plan: 'pro',
          org: 'acme-corp',
        })
      },
      { tags: { userId: 'user_123', plan: 'pro', org: 'acme-corp' } },
    )
  })

  it('drops an empty tags object to undefined (no metadata.tags: {} on events)', async () => {
    await withTrace(
      async () => {
        expect(getCurrentTrace()!.tags).toBeUndefined()
      },
      { tags: {} },
    )
  })

  it('isolates tags across nested withTrace calls', async () => {
    await withTrace(
      async () => {
        await withTrace(
          async () => {
            // Inner frame has its own tags — no inheritance from outer.
            expect(getCurrentTrace()!.tags).toEqual({ userId: 'inner' })
          },
          { tags: { userId: 'inner' } },
        )
        // Outer's tags survive after inner exits.
        expect(getCurrentTrace()!.tags).toEqual({ userId: 'outer' })
      },
      { tags: { userId: 'outer' } },
    )
  })

  it('trims a routeTag with whitespace down to its content', async () => {
    await withTrace(
      async () => {
        expect(getCurrentTrace()!.routeTag).toBe('cron:nightly')
      },
      { routeTag: '   cron:nightly  ' },
    )
  })

  it('drops a blank routeTag to undefined (no "" leaking through)', async () => {
    await withTrace(
      async () => {
        expect(getCurrentTrace()!.routeTag).toBeUndefined()
      },
      { routeTag: '   ' },
    )
  })

  it('isolates frames across nested withTrace calls', async () => {
    await withTrace(async () => {
      log('outer line')
      await withTrace(async () => {
        const inner = getCurrentTrace()!
        // Inner frame is fresh — outer's "outer line" is not visible.
        expect(inner.logs).toEqual([])
        log('inner line')
        expect(inner.logs.map((l) => l.message)).toEqual(['inner line'])
      })
      // Back in the outer frame, the inner's line is not present.
      expect(getCurrentTrace()!.logs.map((l) => l.message)).toEqual([
        'outer line',
      ])
    })
  })
})

describe('log() inside a trace', () => {
  it('appends to the active frame logs with default level "info"', async () => {
    await withTrace(async () => {
      log('something happened')
      const trace = getCurrentTrace()!
      expect(trace.logs).toHaveLength(1)
      expect(trace.logs[0]).toMatchObject({
        level: 'info',
        message: 'something happened',
      })
      // Timestamp is an ISO string — exact value can't be asserted,
      // but the shape can.
      expect(typeof trace.logs[0]!.ts).toBe('string')
    })
  })

  it('respects an explicit level option', async () => {
    await withTrace(async () => {
      log('boom', { level: 'error' })
      log('be careful', { level: 'warn' })
      const levels = getCurrentTrace()!.logs.map((l) => l.level)
      expect(levels).toEqual(['error', 'warn'])
    })
  })

  it('preserves insertion order across multiple calls', async () => {
    await withTrace(async () => {
      log('a')
      log('b')
      log('c')
      expect(getCurrentTrace()!.logs.map((l) => l.message)).toEqual([
        'a',
        'b',
        'c',
      ])
    })
  })
})

describe('drainTraceLogs — drains the buffer', () => {
  it('returns the current logs and clears the frame buffer', async () => {
    await withTrace(async () => {
      log('one')
      log('two')
      const drained = drainTraceLogs()
      expect(drained.map((l) => l.message)).toEqual(['one', 'two'])
      // Buffer is now empty for the next caller.
      expect(getCurrentTrace()!.logs).toEqual([])
    })
  })

  it('returns an empty array when there is nothing to drain', async () => {
    await withTrace(async () => {
      expect(drainTraceLogs()).toEqual([])
    })
  })
})

describe('pushSpanAndRun — currentSpanId stack', () => {
  it('sets currentSpanId for the duration of fn and restores it after', async () => {
    await withTrace(async () => {
      expect(getCurrentTrace()!.currentSpanId).toBeUndefined()
      await pushSpanAndRun('span-a', async () => {
        expect(getCurrentTrace()!.currentSpanId).toBe('span-a')
      })
      expect(getCurrentTrace()!.currentSpanId).toBeUndefined()
    })
  })

  it('nests cleanly: inner restores outer, outer restores undefined', async () => {
    await withTrace(async () => {
      await pushSpanAndRun('outer', async () => {
        expect(getCurrentTrace()!.currentSpanId).toBe('outer')
        await pushSpanAndRun('inner', async () => {
          expect(getCurrentTrace()!.currentSpanId).toBe('inner')
        })
        expect(getCurrentTrace()!.currentSpanId).toBe('outer')
      })
      expect(getCurrentTrace()!.currentSpanId).toBeUndefined()
    })
  })

  it('restores currentSpanId even when fn throws', async () => {
    await withTrace(async () => {
      await expect(
        pushSpanAndRun('span-throws', async () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect(getCurrentTrace()!.currentSpanId).toBeUndefined()
    })
  })
})

// ─── 2. Integration with the chat-completions instrument ─────────

describe('chat-completions × context', () => {
  it('stamps metadata.spanId on every event, even outside withTrace', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(events).toHaveLength(1)
    const meta = events[0]!.metadata as Record<string, unknown>
    expect(typeof meta.spanId).toBe('string')
    expect((meta.spanId as string).length).toBeGreaterThan(0)
    // No trace ⇒ no parent, no endpoint, no logs.
    expect(meta.parentSpanId).toBeUndefined()
    expect(meta.endpoint).toBeUndefined()
    expect(meta.logs).toBeUndefined()
  })

  it('emits metadata.endpoint from ctx.routeTag when there is no trace', async () => {
    const { ctx, events } = makeContext({ routeTag: 'cron:rollup' })
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await wrapped({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect((events[0]!.metadata as Record<string, unknown>).endpoint).toBe(
      'cron:rollup',
    )
  })

  it('propagates withTrace tags onto metadata.tags of every emitted event', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await withTrace(
      async () => {
        await wrapped({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
        })
        await wrapped({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi again' }],
        })
      },
      {
        tags: { userId: 'user_alpha', plan: 'pro' },
      },
    )
    // Both events in the same trace carry the same tags.
    for (const evt of events) {
      const meta = evt.metadata as Record<string, unknown>
      expect(meta.tags).toEqual({ userId: 'user_alpha', plan: 'pro' })
    }
  })

  it('omits metadata.tags when withTrace is opened without tags', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await withTrace(async () => {
      await wrapped({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      })
    })
    const meta = events[0]!.metadata as Record<string, unknown>
    expect(meta.tags).toBeUndefined()
  })

  it('lets a withTrace routeTag override the wrapper-level routeTag', async () => {
    const { ctx, events } = makeContext({ routeTag: 'default-tag' })
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await withTrace(
      async () => {
        await wrapped({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
        })
      },
      { routeTag: 'POST /api/chat' },
    )
    expect((events[0]!.metadata as Record<string, unknown>).endpoint).toBe(
      'POST /api/chat',
    )
  })

  it('drains accumulated log() lines into metadata.logs on the next event', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await withTrace(async () => {
      log('preparing call')
      log('cache miss', { level: 'warn' })
      await wrapped({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      })
    })
    const meta = events[0]!.metadata as Record<string, unknown>
    const logs = meta.logs as Array<{ level: string; message: string }>
    expect(logs).toBeDefined()
    expect(logs.map((l) => ({ level: l.level, message: l.message }))).toEqual([
      { level: 'info', message: 'preparing call' },
      { level: 'warn', message: 'cache miss' },
    ])
  })

  it('clears the log buffer after a call so the next event gets only fresh lines', async () => {
    const { ctx, events } = makeContext()
    const wrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    await withTrace(async () => {
      log('first batch line')
      await wrapped({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      })
      log('second batch line')
      await wrapped({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      })
    })
    const meta1 = events[0]!.metadata as Record<string, unknown>
    const meta2 = events[1]!.metadata as Record<string, unknown>
    expect((meta1.logs as Array<{ message: string }>).map((l) => l.message)).toEqual([
      'first batch line',
    ])
    expect((meta2.logs as Array<{ message: string }>).map((l) => l.message)).toEqual([
      'second batch line',
    ])
  })

  it('sets parentSpanId on nested wrapped calls to the outer call\'s spanId', async () => {
    const { ctx, events } = makeContext()
    // The outer "call" simulates user code that runs inside a wrapped
    // call by invoking another wrapped call within its `original`.
    // The inner call should see the outer's spanId as its parent.
    let outerSpanId: string | undefined
    const innerWrapped = instrumentChatCompletions(
      (async () => nonStreamingResponse()) as never,
      ctx,
    )
    const outerWrapped = instrumentChatCompletions(
      (async () => {
        // We don't have access to the outer's spanId from inside its
        // own `original`, so we capture it via getCurrentTrace().
        outerSpanId = getCurrentTrace()?.currentSpanId
        await innerWrapped({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'nested' }],
        })
        return nonStreamingResponse()
      }) as never,
      ctx,
    )

    await withTrace(async () => {
      await outerWrapped({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'outer' }],
      })
    })

    expect(events).toHaveLength(2)
    // Inner event fires first (the outer one awaits inner before emitting).
    const innerMeta = events[0]!.metadata as Record<string, unknown>
    const outerMeta = events[1]!.metadata as Record<string, unknown>
    expect(innerMeta.parentSpanId).toBe(outerSpanId)
    expect(outerMeta.parentSpanId).toBeUndefined()
  })
})
