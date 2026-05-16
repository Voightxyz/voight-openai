/**
 * Tests for `wrapOpenAI` — the package's public entrypoint.
 *
 * The wrapper is intentionally thin: it composes identity +
 * ingest + the chat-completions instrument behind a `Proxy`. The
 * test surface here is correspondingly small:
 *
 *   - The returned object exposes the same shape as the input
 *     (chat.completions.create + any other properties).
 *   - Calls to `chat.completions.create` go through the instrument
 *     and produce an event.
 *   - Calls to unrelated methods pass through untouched.
 *   - Missing API key / `enabled: false` short-circuit cleanly.
 *
 * Network capture is exercised via a `fetch` injection so we don't
 * need a real Voight backend in unit tests.
 */

import { describe, it, expect, vi } from 'vitest'

import { wrapOpenAI } from '../../src/wrap.js'

function fakeOpenAIClient(handlers: {
  create?: (params: unknown) => Promise<unknown>
  otherMethod?: () => string
} = {}) {
  return {
    chat: {
      completions: {
        create:
          handlers.create ??
          (async () => ({
            id: 'cc-1',
            created: 1,
            model: 'gpt-4o-mini',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })),
      },
    },
    embeddings: {
      create: handlers.otherMethod ?? (() => 'unrelated-passthrough'),
    },
  }
}

describe('wrapOpenAI', () => {
  it('forwards chat.completions.create through to the original', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const original = vi.fn(async () => ({
      id: 'cc-2',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [
        {
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }))

    const client = wrapOpenAI(fakeOpenAIClient({ create: original }), {
      voightApiKey: 'vk_test',
      agent: 'test-agent',
      privacy: 'full',
      apiBase: 'https://api.example.test',
      // Internal hook so the test can inject fetch without a global.
      _fetch: fetchMock,
    } as never)

    const result = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(original).toHaveBeenCalledOnce()
    expect((result as { id: string }).id).toBe('cc-2')
  })

  it('emits a network event after a chat.completions.create call', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))

    const client = wrapOpenAI(fakeOpenAIClient(), {
      voightApiKey: 'vk_test',
      agent: 'test-agent',
      privacy: 'minimal',
      apiBase: 'https://api.example.test',
      _fetch: fetchMock,
    } as never)

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })

    // ingest is fire-and-forget; await a tick.
    await new Promise((r) => setTimeout(r, 0))

    expect(fetchMock).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer vk_test',
    )
    const body = JSON.parse(init.body as string)
    expect(body.agentId).toBe('test-agent')
    expect(body.type).toBe('reasoning')
    expect(body.model).toBe('gpt-4o-mini')
  })

  it('passes unrelated client properties through untouched', () => {
    const otherMethod = vi.fn(() => 'unrelated-passthrough')
    const client = wrapOpenAI(
      fakeOpenAIClient({ otherMethod }),
      {
        voightApiKey: 'vk_test',
        agent: 'test-agent',
      } as never,
    )

    expect(client.embeddings.create()).toBe('unrelated-passthrough')
    expect(otherMethod).toHaveBeenCalledOnce()
  })

  it('returns the original client untouched when enabled=false', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const original = vi.fn(async () => ({ id: 'noop' }))

    const client = wrapOpenAI(
      fakeOpenAIClient({ create: original }),
      {
        voightApiKey: 'vk_test',
        agent: 'test-agent',
        enabled: false,
        _fetch: fetchMock,
      } as never,
    )

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(original).toHaveBeenCalledOnce()
    await new Promise((r) => setTimeout(r, 0))
    // No event posted when the kill switch is engaged.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('auto-generates a sessionId UUID per wrapper instance and emits it on every event', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const client = wrapOpenAI(fakeOpenAIClient(), {
      voightApiKey: 'vk_test',
      agent: 'test-agent',
      apiBase: 'https://api.example.test',
      _fetch: fetchMock,
    } as never)

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 0))
    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi again' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    // Both events share the same auto-generated sessionId (stable
    // across calls of one wrapper instance).
    const body1 = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    const body2 = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)
    expect(body1.metadata.sessionId).toBeTruthy()
    expect(body1.metadata.sessionId).toBe(body2.metadata.sessionId)
    // UUID v4 shape: 8-4-4-4-12 lowercase hex with version digit 4
    expect(body1.metadata.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('uses an explicit sessionId override when provided', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const client = wrapOpenAI(fakeOpenAIClient(), {
      voightApiKey: 'vk_test',
      agent: 'test-agent',
      sessionId: 'user-123-conv-456',
      apiBase: 'https://api.example.test',
      _fetch: fetchMock,
    } as never)

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body.metadata.sessionId).toBe('user-123-conv-456')
  })

  it('produces different auto-generated sessionIds across distinct wrapper instances', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const a = wrapOpenAI(fakeOpenAIClient(), {
      voightApiKey: 'vk_test',
      agent: 'agent-a',
      apiBase: 'https://api.example.test',
      _fetch: fetchMock,
    } as never)
    const b = wrapOpenAI(fakeOpenAIClient(), {
      voightApiKey: 'vk_test',
      agent: 'agent-b',
      apiBase: 'https://api.example.test',
      _fetch: fetchMock,
    } as never)

    await a.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await b.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 0))

    const bodyA = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    const bodyB = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)
    expect(bodyA.metadata.sessionId).not.toBe(bodyB.metadata.sessionId)
  })

  it('is a no-op transport when no API key resolves (with a warn)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const client = wrapOpenAI(fakeOpenAIClient(), {
      agent: 'test-agent',
      _fetch: fetchMock,
      _env: {},
    } as never)

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
