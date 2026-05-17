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

import { randomUUID } from 'node:crypto'

import type { EventPayload, PrivacyLevel } from '../types.js'
import { scrubAnyValue, scrubPii } from '../privacy.js'
import {
  drainTraceLogs,
  getCurrentTrace,
  pushSpanAndRun,
} from '../context.js'

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

/**
 * Per-tool-call shape after we aggregate streaming deltas. Mirrors
 * the non-streaming `message.tool_calls[*]` shape but flattened
 * (no nested `function` namespace) so consumers don't need to know
 * which transport produced the event.
 */
interface CapturedToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * Streaming chunk shape for a single tool-call delta. OpenAI emits
 * one of these per chunk per parallel tool call. The first chunk
 * for a given `index` carries `id` + `function.name`; subsequent
 * chunks append fragments to `function.arguments`.
 */
interface ToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

interface ChatChoice {
  message?: {
    content?: string | null
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
  }
  finish_reason?: string | null
  delta?: {
    content?: string | null
    tool_calls?: ToolCallDelta[]
  }
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
  /**
   * Trace grouping identifier stamped on every emitted event under
   * `metadata.sessionId`. The wrapper resolves it once per instance
   * (explicit option or auto-generated UUID v4).
   */
  sessionId: string
  /**
   * Optional route / job / endpoint tag stamped on `metadata.endpoint`.
   * Lets the dashboard group calls by user-facing endpoint without
   * the wrapper having to introspect HTTP context. Undefined when
   * the caller didn't supply `routeTag` in {@link WrapOptions}.
   */
  routeTag?: string
  ingest: EventSink
  /**
   * Time source in milliseconds since the epoch. Injected so tests
   * can produce deterministic `durationMs` values.
   */
  now: () => number
}

/**
 * Resolved span context for a single intercepted call. Generated
 * once per `wrappedCreate` invocation and threaded through every
 * event builder so spanId / parentSpanId / endpoint stay consistent
 * across success / failure / streaming.
 */
interface SpanInfo {
  spanId: string
  parentSpanId?: string
  endpoint?: string
}

/**
 * Build a SpanInfo by reading the current trace frame (if any) and
 * resolving the endpoint with trace-level overriding wrapper-level.
 */
function captureSpanInfo(ctx: InstrumentContext): SpanInfo {
  const trace = getCurrentTrace()
  return {
    spanId: randomUUID(),
    parentSpanId: trace?.currentSpanId,
    endpoint: trace?.routeTag ?? ctx.routeTag,
  }
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
    const span = captureSpanInfo(ctx)

    // Non-streaming path: run the await + emit inside pushSpanAndRun
    // so nested wrapped calls during this call (e.g., a tool invoked
    // from a multi-turn agent) see this call as their parent.
    if (!isStream) {
      return pushSpanAndRun(span.spanId, async () => {
        let result: ChatCompletion
        try {
          result = (await original(effectiveParams)) as ChatCompletion
        } catch (err) {
          ctx.ingest.send(
            buildFailureEvent({ ctx, params, startedAt, error: err, span }),
          )
          throw err
        }
        ctx.ingest.send(
          buildSuccessEvent({ ctx, params, startedAt, response: result, span }),
        )
        return result
      })
    }

    // Streaming path: we can't run the user's `for await` loop inside
    // pushSpanAndRun (the iteration happens in their code, outside
    // ours), so we manually mark currentSpanId for the duration of
    // the stream and restore it when the iterator finishes or throws.
    // Nested wrapped calls during the user's iteration see the right
    // parent; restoration is finally-safe.
    const trace = getCurrentTrace()
    const previousSpanId = trace?.currentSpanId
    if (trace) trace.currentSpanId = span.spanId

    let result: AsyncIterable<ChatChunk>
    try {
      result = (await original(effectiveParams)) as AsyncIterable<ChatChunk>
    } catch (err) {
      if (trace) trace.currentSpanId = previousSpanId
      ctx.ingest.send(
        buildFailureEvent({ ctx, params, startedAt, error: err, span }),
      )
      throw err
    }

    return wrapStream(result, ctx, params, startedAt, span, () => {
      if (trace) trace.currentSpanId = previousSpanId
    })
  }
}

// ─── Event builders ──────────────────────────────────────────────

function buildSuccessEvent(args: {
  ctx: InstrumentContext
  params: ChatCreateParams
  startedAt: number
  response: ChatCompletion
  span: SpanInfo
}): EventPayload {
  const { ctx, params, startedAt, response, span } = args
  const durationMs = ctx.now() - startedAt
  const responseText = firstChoiceContent(response)
  const tokens = normaliseTokens(response.usage)
  const toolCalls = extractToolCallsFromMessage(response)

  return assembleEvent({
    ctx,
    params,
    span,
    durationMs,
    outcome: 'success',
    responseText,
    tokens,
    toolCalls,
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
  span: SpanInfo
}): EventPayload {
  const { ctx, params, startedAt, error, span } = args
  const durationMs = ctx.now() - startedAt
  const message =
    error instanceof Error ? error.message : String(error)

  return assembleEvent({
    ctx,
    params,
    span,
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
  tokens: NormalisedTokens | null
  toolCalls: CapturedToolCall[] | null
  modelFromResponse: string | undefined
  finishReason: string | null
  span: SpanInfo
}): EventPayload {
  const {
    ctx,
    params,
    startedAt,
    aggregated,
    tokens,
    toolCalls,
    modelFromResponse,
    finishReason,
    span,
  } = args
  return assembleEvent({
    ctx,
    params,
    span,
    durationMs: ctx.now() - startedAt,
    outcome: 'success',
    responseText: aggregated.length > 0 ? aggregated : undefined,
    tokens,
    toolCalls,
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
  span: SpanInfo
  durationMs: number
  outcome: 'success' | 'failed'
  responseText?: string | undefined
  tokens?: NormalisedTokens | null
  toolCalls?: CapturedToolCall[] | null
  streaming: boolean
  finishReason?: string | null
  errorMessage?: string
  modelFromResponse?: string | undefined
}): EventPayload {
  const { ctx, params, span, durationMs, outcome, streaming, errorMessage } = args
  const responseText = args.responseText
  const tokens = args.tokens ?? null
  const toolCalls = args.toolCalls ?? null
  const model = args.modelFromResponse ?? params.model

  const metadata: Record<string, unknown> = {
    source: 'openai-sdk',
    privacyLevel: ctx.privacy,
    streaming,
    sessionId: ctx.sessionId,
    // Span tree fields — populated even when no withTrace boundary is
    // in scope so the dashboard always has a stable span identity to
    // key off. parentSpanId is omitted (not emitted) when undefined.
    spanId: span.spanId,
  }
  if (span.parentSpanId) metadata.parentSpanId = span.parentSpanId
  if (span.endpoint) metadata.endpoint = span.endpoint
  // Tags propagate from the active trace frame (set via
  // `withTrace({ tags })`) so the dashboard can filter / aggregate
  // by user / plan / org / any custom dimension the caller supplies.
  // Omitted (not stamped) when no trace is active or no tags passed.
  const trace = getCurrentTrace()
  if (trace?.tags) metadata.tags = trace.tags
  // Drain log lines accumulated on the trace frame since the last
  // wrapped call (or since `withTrace` opened). Empty array means
  // either no `withTrace` is active or the user didn't call `log()`.
  const drainedLogs = drainTraceLogs()
  if (drainedLogs.length > 0) metadata.logs = drainedLogs
  if (tokens) metadata.tokens = tokens
  if (args.finishReason !== undefined && args.finishReason !== null) {
    metadata.finishReason = args.finishReason
  }

  // First tool-call name flows into `toolExecuted` for audit-log
  // compat regardless of privacy level. The name itself is a tag
  // (function-name, not user content), so even Minimal mode emits
  // it so the dashboard can show "agent did X" vs "agent did
  // nothing".
  const firstToolName = toolCalls && toolCalls.length > 0 ? toolCalls[0]!.name : undefined

  // Privacy: response text + messages
  if (ctx.privacy === 'minimal') {
    // Drop content entirely. metadata.tokens / streaming / source
    // already set above. Return early with no input + no responseText
    // and no tool arguments (which can carry user data).
    return {
      agentId: ctx.agentId,
      type: 'reasoning',
      model,
      durationMs,
      outcome,
      ...(firstToolName ? { toolExecuted: firstToolName } : {}),
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

  if (toolCalls && toolCalls.length > 0) {
    // Tool arguments can contain user content (emails, queries,
    // ids…). Scrub them at standard, pass through at full.
    metadata.toolCalls =
      ctx.privacy === 'standard'
        ? toolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            arguments: scrubPii(t.arguments),
          }))
        : toolCalls
  }

  return {
    agentId: ctx.agentId,
    type: 'reasoning',
    model,
    durationMs,
    outcome,
    ...(firstToolName ? { toolExecuted: firstToolName } : {}),
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

/**
 * Pull tool calls off a non-streaming response and flatten the shape
 * (drop the nested `function` namespace) so consumers don't care
 * which transport produced the event. Returns `null` when no tool
 * was called — keeps the call-site branch readable.
 */
function extractToolCallsFromMessage(
  r: ChatCompletion,
): CapturedToolCall[] | null {
  const raw = r.choices?.[0]?.message?.tool_calls
  if (!raw || raw.length === 0) return null
  const out: CapturedToolCall[] = []
  for (const tc of raw) {
    if (!tc || tc.type !== 'function' || !tc.function) continue
    out.push({
      id: typeof tc.id === 'string' ? tc.id : '',
      name: typeof tc.function.name === 'string' ? tc.function.name : '',
      arguments:
        typeof tc.function.arguments === 'string' ? tc.function.arguments : '',
    })
  }
  return out.length > 0 ? out : null
}

/**
 * Mutating accumulator for streaming tool-call deltas. OpenAI emits
 * one entry per parallel tool call, keyed by `index`. The first
 * delta for an index carries `id` + `function.name`; subsequent
 * deltas only append fragments to `function.arguments`. We mutate
 * the `acc` map in place because the stream wrapper holds the
 * single source of truth across chunks.
 */
function applyToolCallDeltas(
  acc: Map<number, CapturedToolCall>,
  deltas: ToolCallDelta[] | undefined,
): void {
  if (!deltas || deltas.length === 0) return
  for (const d of deltas) {
    if (typeof d.index !== 'number') continue
    let entry = acc.get(d.index)
    if (!entry) {
      entry = { id: '', name: '', arguments: '' }
      acc.set(d.index, entry)
    }
    if (typeof d.id === 'string' && d.id.length > 0 && entry.id.length === 0) {
      entry.id = d.id
    }
    if (
      typeof d.function?.name === 'string' &&
      d.function.name.length > 0 &&
      entry.name.length === 0
    ) {
      entry.name = d.function.name
    }
    if (typeof d.function?.arguments === 'string') {
      entry.arguments += d.function.arguments
    }
  }
}

/**
 * Snapshot the accumulator into the wire-shape ordered array. We
 * sort by `index` so consumers see the same order the model
 * produced (matters when the dashboard renders a list and humans
 * are debugging an interleaved trace).
 */
function snapshotToolCalls(
  acc: Map<number, CapturedToolCall>,
): CapturedToolCall[] | null {
  if (acc.size === 0) return null
  const entries = [...acc.entries()].sort(([a], [b]) => a - b)
  // Drop any leftover stubs that never received a name (shouldn't
  // happen in practice — OpenAI always emits name in the first
  // chunk for each index — but defensive in case of a partial
  // stream that was aborted mid-call).
  const out = entries.map(([, v]) => v).filter((t) => t.name.length > 0)
  return out.length > 0 ? out : null
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
  span: SpanInfo,
  onComplete: () => void,
): AsyncIterable<ChatChunk> {
  let aggregated = ''
  let tokens: NormalisedTokens | null = null
  let modelFromResponse: string | undefined
  let finishReason: string | null = null
  const toolCallsAcc = new Map<number, CapturedToolCall>()
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
        toolCalls: snapshotToolCalls(toolCallsAcc),
        modelFromResponse,
        finishReason,
        span,
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
          // Tool-call deltas arrive interleaved with content deltas;
          // an `index` keys multiple parallel tool calls.
          applyToolCallDeltas(toolCallsAcc, choice?.delta?.tool_calls)
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
            span,
          }),
        )
        emitted = true
        throw err
      } finally {
        emit()
        // Restore the trace's previous currentSpanId regardless of
        // whether the iteration completed cleanly or threw.
        onComplete()
      }
    },
  }
}
