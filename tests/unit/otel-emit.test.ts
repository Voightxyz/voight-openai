/**
 * Tests for the OpenTelemetry side-channel of `@voightxyz/openai`.
 *
 * Two surfaces under test:
 *
 *   1. `attributesForEvent` — a pure mapping from Voight
 *      `EventPayload` to the flat OTel attribute bag. No OTel
 *      runtime needed; we just assert keys + values.
 *   2. `createEmitter` — the wiring that connects an `EventPayload`
 *      to a span on a real (or mocked) `Tracer`. We inject a fake
 *      `otelModule` so this file does not require
 *      `@opentelemetry/api` at runtime.
 *
 * Both flows are designed to be failure-isolated: the wrapper's
 * direct POST to api.voight.xyz is the canonical delivery; the OTel
 * emission is a best-effort side-channel and must never throw.
 */

import { describe, it, expect } from 'vitest'

import {
  attributesForEvent,
  createEmitter,
  type OtelLikeModule,
  type OtelLikeSpan,
  type OtelLikeTracer,
} from '../../src/otel-emit'
import type { EventPayload } from '../../src/types'

// ─── Fake OTel module ───────────────────────────────────────────────
//
// Just enough surface to satisfy `OtelLikeModule`. Records every
// span the emitter creates so each test can assert on what landed.

interface RecordedSpan {
  name: string
  startTime: number | undefined
  attributes: Record<string, string | number | boolean>
  statusCode: number | null
  statusMessage: string | null
  ended: boolean
  endedAt: number | null
  exceptions: unknown[]
}

function makeFakeOtel(): {
  mod: OtelLikeModule
  spans: RecordedSpan[]
  // Lets a test wire a thrower into `startSpan` to confirm
  // `createEmitter` swallows the failure instead of crashing.
  throwOnStartSpan: (err: Error) => void
} {
  const spans: RecordedSpan[] = []
  let injectedThrow: Error | null = null

  const SpanStatusCode = { OK: 1, ERROR: 2, UNSET: 0 } as const

  const tracer: OtelLikeTracer = {
    startSpan(name, options) {
      if (injectedThrow !== null) {
        const err = injectedThrow
        injectedThrow = null
        throw err
      }
      const record: RecordedSpan = {
        name,
        startTime: options?.startTime,
        attributes: { ...(options?.attributes ?? {}) } as Record<
          string,
          string | number | boolean
        >,
        statusCode: null,
        statusMessage: null,
        ended: false,
        endedAt: null,
        exceptions: [],
      }
      const span: OtelLikeSpan = {
        setAttributes(attrs) {
          Object.assign(record.attributes, attrs)
        },
        setStatus(status) {
          record.statusCode = status.code
          record.statusMessage = status.message ?? null
        },
        recordException(err) {
          record.exceptions.push(err)
        },
        end(endTime) {
          record.ended = true
          record.endedAt = endTime ?? null
        },
      }
      spans.push(record)
      return span
    },
  }

  return {
    mod: {
      trace: { getTracer: () => tracer },
      SpanStatusCode,
    },
    spans,
    throwOnStartSpan: (err) => {
      injectedThrow = err
    },
  }
}

// ─── Event fixtures ─────────────────────────────────────────────────

function baseEvent(overrides: Partial<EventPayload> = {}): EventPayload {
  return {
    agentId: 'agt_smoke',
    type: 'reasoning',
    model: 'gpt-4o-mini',
    durationMs: 1234,
    outcome: 'success',
    metadata: {
      sessionId: '11111111-2222-3333-4444-555555555555',
      tokens: { input: 100, output: 50 },
      finishReason: 'stop',
    },
    ...overrides,
  }
}

// ─── attributesForEvent — pure ──────────────────────────────────────

describe('attributesForEvent', () => {
  it('maps the @voightxyz/openai package to gen_ai.system=openai', () => {
    const attrs = attributesForEvent(baseEvent(), '@voightxyz/openai')
    expect(attrs['gen_ai.system']).toBe('openai')
    expect(attrs['ai.model.provider']).toBe('openai')
  })

  it('maps the @voightxyz/anthropic package to gen_ai.system=anthropic', () => {
    const attrs = attributesForEvent(baseEvent(), '@voightxyz/anthropic')
    expect(attrs['gen_ai.system']).toBe('anthropic')
    expect(attrs['ai.model.provider']).toBe('anthropic')
  })

  it('preserves the model id verbatim for downstream cost lookups', () => {
    const attrs = attributesForEvent(
      baseEvent({ model: 'gpt-4o-mini-2024-07-18' }),
      '@voightxyz/openai',
    )
    expect(attrs['gen_ai.request.model']).toBe('gpt-4o-mini-2024-07-18')
    expect(attrs['ai.model.id']).toBe('gpt-4o-mini-2024-07-18')
  })

  it('emits input/output token counts under both gen_ai and ai namespaces', () => {
    const attrs = attributesForEvent(
      baseEvent({
        metadata: { tokens: { input: 100, output: 50 } },
      }),
      '@voightxyz/openai',
    )
    expect(attrs['gen_ai.usage.input_tokens']).toBe(100)
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50)
    expect(attrs['ai.usage.promptTokens']).toBe(100)
    expect(attrs['ai.usage.completionTokens']).toBe(50)
  })

  it('emits cache_read tokens when present (and only when present)', () => {
    const withCache = attributesForEvent(
      baseEvent({
        metadata: {
          tokens: { input: 100, output: 50, cache_read: 80 },
        },
      }),
      '@voightxyz/openai',
    )
    expect(withCache['gen_ai.usage.cache_read_input_tokens']).toBe(80)
    expect(withCache['ai.usage.cachedInputTokens']).toBe(80)

    const withoutCache = attributesForEvent(baseEvent(), '@voightxyz/openai')
    expect(
      'gen_ai.usage.cache_read_input_tokens' in withoutCache,
    ).toBe(false)
    expect('ai.usage.cachedInputTokens' in withoutCache).toBe(false)
  })

  it('serialises finish reason as a JSON array on gen_ai (semconv) and a scalar on ai (Vercel)', () => {
    const attrs = attributesForEvent(
      baseEvent({ metadata: { finishReason: 'tool_calls' } }),
      '@voightxyz/openai',
    )
    expect(attrs['gen_ai.response.finish_reasons']).toBe('["tool_calls"]')
    expect(attrs['ai.response.finishReason']).toBe('tool_calls')
  })

  it("stamps voight.source='wrapper' so the Voight exporter can dedupe", () => {
    const attrs = attributesForEvent(baseEvent(), '@voightxyz/openai')
    // This is the dedup marker that `@voightxyz/vercel-ai`'s exporter
    // checks for. Critical: do not rename without updating the
    // exporter in lock-step.
    expect(attrs['voight.source']).toBe('wrapper')
    expect(attrs['voight.package']).toBe('@voightxyz/openai')
  })

  it('forwards agent + sessionId + endpoint + api + streaming markers', () => {
    const attrs = attributesForEvent(
      baseEvent({
        agentId: 'production-chat-api',
        metadata: {
          sessionId: 'sess-abc',
          endpoint: 'POST /api/chat',
          api: 'responses',
          streaming: true,
        },
      }),
      '@voightxyz/openai',
    )
    expect(attrs['voight.agent']).toBe('production-chat-api')
    expect(attrs['voight.sessionId']).toBe('sess-abc')
    expect(attrs['voight.endpoint']).toBe('POST /api/chat')
    expect(attrs['voight.api']).toBe('responses')
    expect(attrs['voight.streaming']).toBe(true)
  })

  it('omits voight.* markers when their source values are missing', () => {
    const attrs = attributesForEvent(
      { type: 'reasoning', outcome: 'success' } as EventPayload,
      '@voightxyz/openai',
    )
    expect('voight.agent' in attrs).toBe(false)
    expect('voight.sessionId' in attrs).toBe(false)
    expect('voight.endpoint' in attrs).toBe(false)
    expect('voight.api' in attrs).toBe(false)
    // Source + package are always stamped.
    expect(attrs['voight.source']).toBe('wrapper')
    expect(attrs['voight.package']).toBe('@voightxyz/openai')
  })

  it('silently drops non-numeric token values instead of forwarding NaN', () => {
    const attrs = attributesForEvent(
      baseEvent({
        metadata: {
          tokens: {
            // Intentional garbage from a future-shape provider — we
            // want the runtime to discard the field rather than
            // emit `NaN` (which OTel exporters tend to reject).
            input: 'lots' as unknown as number,
            output: 50,
          },
        },
      }),
      '@voightxyz/openai',
    )
    expect('gen_ai.usage.input_tokens' in attrs).toBe(false)
    expect('ai.usage.promptTokens' in attrs).toBe(false)
    // Output is still valid and goes through.
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50)
  })
})

// ─── createEmitter — wiring ─────────────────────────────────────────

describe('createEmitter', () => {
  it("returns null when the OTel module isn't loadable (graceful degradation)", () => {
    // Force `loadOtelModule` to fail by NOT injecting an otelModule
    // and routing the error through `onLoadError`. The wrapper falls
    // back to direct ingestion only.
    let observedError: unknown = null
    const emitter = createEmitter({
      packageName: '@voightxyz/openai',
      packageVersion: '0.1.7',
      // Force an injected module that is structurally invalid:
      otelModule: {
        trace: {
          getTracer() {
            throw new Error('synthetic tracer-creation failure')
          },
        },
        SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
      },
      onLoadError: (err) => {
        observedError = err
      },
    })
    expect(emitter).toBeNull()
    expect((observedError as Error)?.message).toBe(
      'synthetic tracer-creation failure',
    )
  })

  it('emits one span per call with the expected attribute set', () => {
    const { mod, spans } = makeFakeOtel()
    const emitter = createEmitter({
      packageName: '@voightxyz/openai',
      packageVersion: '0.1.7',
      otelModule: mod,
    })
    expect(emitter).not.toBeNull()
    emitter!.emit(baseEvent())
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.name).toBe('voight.openai.chat')
    expect(span.attributes['gen_ai.system']).toBe('openai')
    expect(span.attributes['gen_ai.request.model']).toBe('gpt-4o-mini')
    expect(span.attributes['voight.source']).toBe('wrapper')
    expect(span.ended).toBe(true)
  })

  it("sets span.status=OK on a successful event", () => {
    const { mod, spans } = makeFakeOtel()
    const emitter = createEmitter({
      packageName: '@voightxyz/openai',
      packageVersion: '0.1.7',
      otelModule: mod,
    })
    emitter!.emit(baseEvent({ outcome: 'success' }))
    expect(spans[0]!.statusCode).toBe(1) // OK
  })

  it('sets span.status=ERROR and forwards the error message on a failed event', () => {
    const { mod, spans } = makeFakeOtel()
    const emitter = createEmitter({
      packageName: '@voightxyz/openai',
      packageVersion: '0.1.7',
      otelModule: mod,
    })
    emitter!.emit(
      baseEvent({ outcome: 'failed', errorMessage: 'rate limited' }),
    )
    expect(spans[0]!.statusCode).toBe(2) // ERROR
    expect(spans[0]!.statusMessage).toBe('rate limited')
  })

  it('startTime equals end - durationMs so dashboards reconstruct duration correctly', () => {
    const { mod, spans } = makeFakeOtel()
    const emitter = createEmitter({
      packageName: '@voightxyz/openai',
      packageVersion: '0.1.7',
      otelModule: mod,
    })
    emitter!.emit(baseEvent({ durationMs: 250 }))
    const span = spans[0]!
    expect(typeof span.startTime).toBe('number')
    expect(typeof span.endedAt).toBe('number')
    expect((span.endedAt as number) - (span.startTime as number)).toBe(250)
  })

  it("swallows errors thrown from the tracer's startSpan without surfacing them to the caller", () => {
    const { mod, throwOnStartSpan } = makeFakeOtel()
    let observedError: unknown = null
    const emitter = createEmitter({
      packageName: '@voightxyz/openai',
      packageVersion: '0.1.7',
      otelModule: mod,
      onLoadError: (err) => {
        observedError = err
      },
    })
    throwOnStartSpan(new Error('synthetic span-create failure'))
    // The whole point: this call must NOT throw — Voight is on the
    // user's hot path. The direct POST already succeeded.
    expect(() => emitter!.emit(baseEvent())).not.toThrow()
    expect((observedError as Error)?.message).toBe(
      'synthetic span-create failure',
    )
  })

  it('passes the package name + version through to getTracer', () => {
    const calls: Array<{ name: string; version?: string }> = []
    const { mod: baseMod, spans } = makeFakeOtel()
    const mod: OtelLikeModule = {
      ...baseMod,
      trace: {
        getTracer(name, version) {
          calls.push({ name, version })
          return baseMod.trace.getTracer(name, version)
        },
      },
    }
    const emitter = createEmitter({
      packageName: '@voightxyz/openai',
      packageVersion: '0.1.7',
      otelModule: mod,
    })
    emitter!.emit(baseEvent())
    expect(calls).toEqual([
      { name: '@voightxyz/openai', version: '0.1.7' },
    ])
    expect(spans).toHaveLength(1)
  })
})
