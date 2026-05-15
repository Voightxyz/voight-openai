/**
 * Instrument for `client.chat.completions.create`.
 *
 * The instrument wraps a single function with the same signature
 * as the OpenAI SDK's `create`: same params in, same value out.
 * On the way through it:
 *
 *   1. Snapshots the start time and the request (model, messages).
 *   2. Awaits the original call.
 *   3. For non-streaming: captures the response + usage and emits
 *      one event.
 *   4. For streaming: wraps the async iterator so chunks pass to
 *      the caller untouched while the wrapper aggregates them; one
 *      event is emitted at end-of-stream.
 *
 * The instrument never alters return values or throws extra errors.
 * If the OpenAI SDK throws, we record an event with
 * `outcome: 'failed'` and re-raise the original error so the
 * caller's try/catch sees the unchanged exception.
 *
 * Privacy fan-out:
 *
 *   - `full`     → messages and response text included verbatim.
 *   - `standard` → both scrubbed of PII (delegates to scrubAnyValue
 *                   / scrubPii — see privacy.ts).
 *   - `minimal`  → both dropped entirely. Only model, tokens,
 *                   timing, and outcome reach the event.
 */

import type { EventPayload, PrivacyLevel } from '../types.js'
import { scrubAnyValue, scrubPii } from '../privacy.js'

// ─── Loose OpenAI types ───────────────────────────────────────────
//
// The OpenAI SDK's full types are large and version-sensitive. We
// model only the surface this instrument actually touches, keep
// it `unknown`-flavoured where possible, and never narrow at the
// type boundary in a way that would break across SDK minor bumps.

interface ChatCreateParams {
  model: string
  messages: Array<Record<string, unknown>>
  stream?: boolean
  stream_options?: Record<string, unknown>
  [k: string]: unknown
}

interface ChatChoice {
  message?: { content?: string | null }
  finish_reason?: string | null
  delta?: { content?: string | null }
  [k: string]: unknown
}

interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    [k: string]: unknown
  }
  [k: string]: unknown
}

/**
 * Token shape we emit on `metadata.tokens`. `cache_read` is optional
 * and only present when the response actually reports cached input
 * tokens (`prompt_tokens_details.cached_tokens > 0`). This keeps the
 * payload tight for the >99% of calls that don't hit the cache.
 */
interface NormalisedTokens {
  input: number
  output: number
  total: number
  cache_read?: number
}

interface ChatCompletion {
  model?: string
  choices?: ChatChoice[]
  usage?: ChatUsage
  [k: string]: unknown
}

type ChatChunk = ChatCompletion

type CreateFn = (
  params: ChatCreateParams,
) => Promise<ChatCompletion | AsyncIterable<ChatChunk>>

/**
 * Sink interface — anything that can absorb an event. The real
 * implementation is `createIngestClient` from ingest.ts; the
 * abstraction here lets tests inject a synchronous collector.
 */
export interface EventSink {
  send: (event: EventPayload) => void
}

export interface InstrumentContext {
  agentId: string
  privacy: PrivacyLevel
  ingest: EventSink
  /**
   * Time source in milliseconds since the epoch. Injected so tests
   * can produce deterministic `durationMs` values.
   */
  now: () => number
}

/**
 * Wrap a `create` function and return one with the same signature.
 * The returned function is what the proxy hands the user.
 */
export function instrumentChatCompletions(
  original: CreateFn,
  ctx: InstrumentContext,
): CreateFn {
  return async function wrappedCreate(params: ChatCreateParams) {
    const startedAt = ctx.now()
    const isStream = params.stream === true
    const effectiveParams = isStream ? withStreamUsage(params) : params

    let result: ChatCompletion | AsyncIterable<ChatChunk>
    try {
      result = await original(effectiveParams)
    } catch (err) {
      // Record a failure event, then re-throw the original error
      // so the user's error path is unchanged.
      ctx.ingest.send(
        buildFailureEvent({
          ctx,
          params,
          startedAt,
          error: err,
        }),
      )
      throw err
    }

    if (!isStream) {
      ctx.ingest.send(
        buildSuccessEvent({
          ctx,
          params,
          startedAt,
          response: result as ChatCompletion,
        }),
      )
      return result
    }

    // Streaming: tap the iterator. We must NOT consume chunks
    // ourselves — the user is iterating. We forward each chunk
    // and accumulate locally; the event lands when the user's
    // for-await loop finishes (or after the iterator throws).
    return wrapStream(result as AsyncIterable<ChatChunk>, ctx, params, startedAt)
  }
}

// ─── Event builders ──────────────────────────────────────────────

function buildSuccessEvent(args: {
  ctx: InstrumentContext
  params: ChatCreateParams
  startedAt: number
  response: ChatCompletion
}): EventPayload {
  const { ctx, params, startedAt, response } = args
  const durationMs = ctx.now() - startedAt
  const responseText = firstChoiceContent(response)
  const tokens = normaliseTokens(response.usage)

  return assembleEvent({
    ctx,
    params,
    durationMs,
    outcome: 'success',
    responseText,
    tokens,
    streaming: false,
    finishReason: response.choices?.[0]?.finish_reason ?? null,
    modelFromResponse: response.model,
  })
}

function buildFailureEvent(args: {
  ctx: InstrumentContext
  params: ChatCreateParams
  startedAt: number
  error: unknown
}): EventPayload {
  const { ctx, params, startedAt, error } = args
  const durationMs = ctx.now() - startedAt
  const message =
    error instanceof Error ? error.message : String(error)

  return assembleEvent({
    ctx,
    params,
    durationMs,
    outcome: 'failed',
    streaming: params.stream === true,
    errorMessage: message,
  })
}

function buildStreamEvent(args: {
  ctx: InstrumentContext
  params: ChatCreateParams
  startedAt: number
  aggregated: string
  tokens: { input: number; output: number; total: number } | null
  modelFromResponse: string | undefined
  finishReason: string | null
}): EventPayload {
  const { ctx, params, startedAt, aggregated, tokens, modelFromResponse, finishReason } = args
  return assembleEvent({
    ctx,
    params,
    durationMs: ctx.now() - startedAt,
    outcome: 'success',
    responseText: aggregated.length > 0 ? aggregated : undefined,
    tokens,
    streaming: true,
    finishReason,
    modelFromResponse,
  })
}

/**
 * Central event assembler. Holds the privacy fan-out + payload
 * shape in one place so the three callers above can't drift.
 */
function assembleEvent(args: {
  ctx: InstrumentContext
  params: ChatCreateParams
  durationMs: number
  outcome: 'success' | 'failed'
  responseText?: string | undefined
  tokens?: { input: number; output: number; total: number } | null
  streaming: boolean
  finishReason?: string | null
  errorMessage?: string
  modelFromResponse?: string | undefined
}): EventPayload {
  const { ctx, params, durationMs, outcome, streaming, errorMessage } = args
  const responseText = args.responseText
  const tokens = args.tokens ?? null
  const model = args.modelFromResponse ?? params.model

  const metadata: Record<string, unknown> = {
    source: 'openai-sdk',
    privacyLevel: ctx.privacy,
    streaming,
  }
  if (tokens) metadata.tokens = tokens
  if (args.finishReason !== undefined && args.finishReason !== null) {
    metadata.finishReason = args.finishReason
  }

  // Privacy: response text + messages
  if (ctx.privacy === 'minimal') {
    // Drop content entirely. metadata.tokens / streaming / source
    // already set above. Return early with no input + no responseText.
    return {
      agentId: ctx.agentId,
      type: 'reasoning',
      model,
      durationMs,
      outcome,
      metadata,
      ...(errorMessage ? { errorMessage } : {}),
    }
  }

  // standard or full path. Messages are included; under standard
  // we scrub them; under full they pass through verbatim.
  const messages =
    ctx.privacy === 'standard'
      ? (scrubAnyValue(params.messages) as ChatCreateParams['messages'])
      : params.messages

  const scrubbedResponse =
    responseText !== undefined
      ? ctx.privacy === 'standard'
        ? scrubPii(responseText)
        : responseText
      : undefined

  if (scrubbedResponse !== undefined) {
    metadata.responseText = scrubbedResponse
  }

  return {
    agentId: ctx.agentId,
    type: 'reasoning',
    model,
    durationMs,
    outcome,
    input: { messages },
    metadata,
    ...(errorMessage ? { errorMessage } : {}),
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Ensure streaming requests opt into `usage` in the final chunk.
 *
 * OpenAI's streaming API does not emit `usage` by default — the
 * caller must pass `stream_options: { include_usage: true }`. We
 * add this flag for the user so token capture works out of the
 * box. The user's explicit choice always wins: if they passed
 * `include_usage: false`, we leave it alone (they'll see "no
 * tokens" on the event, but it's their decision).
 *
 * Returns a fresh params object; the caller-supplied one is never
 * mutated. Non-streaming params pass through untouched at the
 * call site.
 */
function withStreamUsage(params: ChatCreateParams): ChatCreateParams {
  const existing =
    (params.stream_options as Record<string, unknown> | undefined) ?? {}
  if ('include_usage' in existing) return params
  return {
    ...params,
    stream_options: { ...existing, include_usage: true },
  }
}

function firstChoiceContent(r: ChatCompletion): string | undefined {
  const c = r.choices?.[0]?.message?.content
  return typeof c === 'string' ? c : undefined
}

function normaliseTokens(u: ChatUsage | undefined): NormalisedTokens | null {
  if (!u) return null
  const input = numberOrZero(u.prompt_tokens)
  const output = numberOrZero(u.completion_tokens)
  const total = numberOrZero(u.total_tokens) || input + output
  // Path-A breakdown: OpenAI reports the cached portion of the
  // prompt under `prompt_tokens_details.cached_tokens` (auto-applied
  // by the platform to prompts ≥1024 tokens). We only emit
  // `cache_read` when it's strictly positive — a zero is informationally
  // identical to "no cache hit" and bloats the payload.
  const cachedRaw = u.prompt_tokens_details?.cached_tokens
  const cached =
    typeof cachedRaw === 'number' && Number.isFinite(cachedRaw) ? cachedRaw : 0
  if (cached > 0) {
    return { input, output, total, cache_read: cached }
  }
  return { input, output, total }
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// ─── Streaming wrapper ───────────────────────────────────────────

function wrapStream(
  source: AsyncIterable<ChatChunk>,
  ctx: InstrumentContext,
  params: ChatCreateParams,
  startedAt: number,
): AsyncIterable<ChatChunk> {
  let aggregated = ''
  let tokens: { input: number; output: number; total: number } | null = null
  let modelFromResponse: string | undefined
  let finishReason: string | null = null
  let emitted = false

  function emit() {
    if (emitted) return
    emitted = true
    ctx.ingest.send(
      buildStreamEvent({
        ctx,
        params,
        startedAt,
        aggregated,
        tokens,
        modelFromResponse,
        finishReason,
      }),
    )
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of source) {
          if (chunk.model && !modelFromResponse) {
            modelFromResponse = chunk.model
          }
          const choice = chunk.choices?.[0]
          const piece = choice?.delta?.content
          if (typeof piece === 'string') aggregated += piece
          if (choice?.finish_reason && finishReason === null) {
            finishReason = choice.finish_reason ?? null
          }
          if (chunk.usage) tokens = normaliseTokens(chunk.usage)
          yield chunk
        }
      } catch (err) {
        // Record a failure event for the stream. We still want
        // the original error to surface to the user's for-await.
        ctx.ingest.send(
          buildFailureEvent({
            ctx,
            params,
            startedAt,
            error: err,
          }),
        )
        emitted = true
        throw err
      } finally {
        emit()
      }
    },
  }
}
