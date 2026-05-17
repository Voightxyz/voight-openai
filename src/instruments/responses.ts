/**
 * Instrument for `client.responses.create` (OpenAI Responses API).
 *
 * Sister to `chat-completions.ts`, adapted for the typed Responses
 * shape:
 *
 *   - Non-streaming: read `response.output_text` (convenience field)
 *     or aggregate text from `output[].message.content[].text`. Tool
 *     calls live as top-level `output[]` items with `type:
 *     'function_call'` and a flat `{ call_id, name, arguments }`
 *     shape, so we flatten + normalise to the same wire format as
 *     the chat-completions instrument produces.
 *
 *   - Streaming: a typed event union with 60+ types. We only react
 *     to the subset that drives capture:
 *       · response.created                         → seed model + state
 *       · response.output_text.delta               → append to text
 *       · response.output_item.added (function_call) → start a tool entry at output_index
 *       · response.function_call_arguments.delta   → append args fragment
 *       · response.completed                       → final usage + status
 *       · response.failed / response.incomplete    → error paths
 *
 *     Every other event (audio, web_search, file_search, code_
 *     interpreter, image_gen, MCP, …) passes through to the caller
 *     unchanged and does not affect the emitted Voight event.
 *
 * Token surface:
 *   - input / output / total: always
 *   - cache_read: only when `input_tokens_details.cached_tokens > 0`
 *   - reasoning: only when `output_tokens_details.reasoning_tokens > 0`
 *     (o1 / o3 / future reasoning models — separates the "thinking"
 *     fraction of output token cost from the visible answer)
 *
 * Privacy fan-out: identical contract to chat-completions
 * (`minimal` / `standard` / `full`). Tool call names always survive
 * as `toolExecuted` so the audit-log DETAIL column renders.
 *
 * Events emitted carry `metadata.api: 'responses'` (the
 * chat-completions instrument omits this field) so the dashboard
 * can distinguish call sites that go through the legacy API vs the
 * new Responses surface.
 */

import { randomUUID } from 'node:crypto'

import type { EventPayload, PrivacyLevel } from '../types.js'
import { scrubAnyValue, scrubPii } from '../privacy.js'
import {
  drainTraceLogs,
  getCurrentTrace,
  pushSpanAndRun,
} from '../context.js'

// ─── Loose Responses types ────────────────────────────────────────

interface ResponseCreateParams {
  model: string
  input?: string | Array<unknown>
  instructions?: string
  stream?: boolean
  tools?: unknown[]
  [k: string]: unknown
}

interface ResponseUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number; [k: string]: unknown }
  output_tokens_details?: { reasoning_tokens?: number; [k: string]: unknown }
  [k: string]: unknown
}

interface ResponseOutputMessage {
  type: 'message'
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  [k: string]: unknown
}

interface ResponseFunctionCallItem {
  type: 'function_call'
  call_id?: string
  name?: string
  arguments?: string
  [k: string]: unknown
}

type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseFunctionCallItem
  | { type: string; [k: string]: unknown }

interface NonStreamingResponse {
  id?: string
  model?: string
  status?: string
  output_text?: string
  output?: ResponseOutputItem[]
  usage?: ResponseUsage
  [k: string]: unknown
}

// Streaming events we react to. The rest of the 60+ event union
// passes through without state updates.
interface StreamCreated {
  type: 'response.created'
  response?: { model?: string; [k: string]: unknown }
}
interface StreamCompleted {
  type: 'response.completed'
  response: NonStreamingResponse
}
interface StreamTextDelta {
  type: 'response.output_text.delta'
  delta: string
}
interface StreamItemAdded {
  type: 'response.output_item.added'
  output_index: number
  item: ResponseOutputItem
}
interface StreamFuncArgsDelta {
  type: 'response.function_call_arguments.delta'
  output_index: number
  delta: string
}

type StreamEvent =
  | StreamCreated
  | StreamCompleted
  | StreamTextDelta
  | StreamItemAdded
  | StreamFuncArgsDelta
  | { type: string; [k: string]: unknown }

type CreateFn = (
  params: ResponseCreateParams,
) => Promise<NonStreamingResponse | AsyncIterable<StreamEvent>>

interface CapturedToolCall {
  id: string
  name: string
  arguments: string
}

interface NormalisedTokens {
  input: number
  output: number
  total: number
  cache_read?: number
  reasoning?: number
}

export interface EventSink {
  send: (event: EventPayload) => void
}

export interface InstrumentContext {
  agentId: string
  privacy: PrivacyLevel
  sessionId: string
  /** Optional per-wrapper route / endpoint tag. Trace-level
   *  `withTrace({ routeTag })` overrides this at call time. */
  routeTag?: string
  ingest: EventSink
  now: () => number
}

/**
 * Resolved span context per intercepted call. Mirrors the structure
 * used by the chat-completions instrument so the dashboard's span
 * fields are identical across the two surfaces.
 */
interface SpanInfo {
  spanId: string
  parentSpanId?: string
  endpoint?: string
}

function captureSpanInfo(ctx: InstrumentContext): SpanInfo {
  const trace = getCurrentTrace()
  return {
    spanId: randomUUID(),
    parentSpanId: trace?.currentSpanId,
    endpoint: trace?.routeTag ?? ctx.routeTag,
  }
}

export function instrumentResponses(
  original: CreateFn,
  ctx: InstrumentContext,
): CreateFn {
  return async function wrappedCreate(params: ResponseCreateParams) {
    const startedAt = ctx.now()
    const isStream = params.stream === true
    const span = captureSpanInfo(ctx)

    if (!isStream) {
      return pushSpanAndRun(span.spanId, async () => {
        let result: NonStreamingResponse
        try {
          result = (await original(params)) as NonStreamingResponse
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

    // Streaming — manually maintain currentSpanId for the iterator's
    // lifetime so nested wrapped calls during streaming see this call
    // as their parent. Restoration is finally-safe.
    const trace = getCurrentTrace()
    const previousSpanId = trace?.currentSpanId
    if (trace) trace.currentSpanId = span.spanId

    let result: AsyncIterable<StreamEvent>
    try {
      result = (await original(params)) as AsyncIterable<StreamEvent>
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
  params: ResponseCreateParams
  startedAt: number
  response: NonStreamingResponse
  span: SpanInfo
}): EventPayload {
  const { ctx, params, startedAt, response, span } = args
  const responseText = extractText(response)
  const toolCalls = extractToolCalls(response.output ?? [])
  const tokens = normaliseTokens(response.usage)
  const durationMs = ctx.now() - startedAt

  return assembleEvent({
    ctx,
    params,
    span,
    durationMs,
    outcome: 'success',
    responseText: responseText.length > 0 ? responseText : undefined,
    tokens,
    toolCalls,
    streaming: false,
    finishReason: response.status ?? null,
    modelFromResponse: response.model,
  })
}

function buildFailureEvent(args: {
  ctx: InstrumentContext
  params: ResponseCreateParams
  startedAt: number
  error: unknown
  span: SpanInfo
}): EventPayload {
  const { ctx, params, startedAt, error, span } = args
  const durationMs = ctx.now() - startedAt
  const message = error instanceof Error ? error.message : String(error)
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
  params: ResponseCreateParams
  startedAt: number
  aggregatedText: string
  tokens: NormalisedTokens | null
  toolCalls: CapturedToolCall[] | null
  modelFromResponse: string | undefined
  finishReason: string | null
  span: SpanInfo
}): EventPayload {
  return assembleEvent({
    ctx: args.ctx,
    params: args.params,
    span: args.span,
    durationMs: args.ctx.now() - args.startedAt,
    outcome: 'success',
    responseText:
      args.aggregatedText.length > 0 ? args.aggregatedText : undefined,
    tokens: args.tokens,
    toolCalls: args.toolCalls,
    streaming: true,
    finishReason: args.finishReason,
    modelFromResponse: args.modelFromResponse,
  })
}

function assembleEvent(args: {
  ctx: InstrumentContext
  params: ResponseCreateParams
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
  const tokens = args.tokens ?? null
  const toolCalls = args.toolCalls ?? null
  const model = args.modelFromResponse ?? params.model

  const metadata: Record<string, unknown> = {
    source: 'openai-sdk',
    api: 'responses',
    privacyLevel: ctx.privacy,
    streaming,
    sessionId: ctx.sessionId,
    spanId: span.spanId,
  }
  if (span.parentSpanId) metadata.parentSpanId = span.parentSpanId
  if (span.endpoint) metadata.endpoint = span.endpoint
  // Tags from the active trace frame travel with every event so the
  // dashboard's per-user / per-tier filters work the same way for
  // Responses API calls as for chat-completions.
  const trace = getCurrentTrace()
  if (trace?.tags) metadata.tags = trace.tags
  const drainedLogs = drainTraceLogs()
  if (drainedLogs.length > 0) metadata.logs = drainedLogs
  if (tokens) metadata.tokens = tokens
  if (args.finishReason !== undefined && args.finishReason !== null) {
    metadata.finishReason = args.finishReason
  }

  const firstToolName =
    toolCalls && toolCalls.length > 0 ? toolCalls[0]!.name : undefined

  if (ctx.privacy === 'minimal') {
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

  // Build an `input` payload that mirrors what the user sent.
  // Responses API takes either a string or an array of structured
  // items (messages, tool_outputs, …). We pass it through under a
  // single `input` key so the dashboard can render the original
  // prompt shape without guessing.
  const rawInput = params.input
  let inputCopy: Record<string, unknown> | undefined
  if (rawInput !== undefined) {
    const scrubbed =
      ctx.privacy === 'standard' ? scrubAnyValue(rawInput) : rawInput
    inputCopy = { input: scrubbed }
    if (typeof params.instructions === 'string') {
      inputCopy.instructions =
        ctx.privacy === 'standard'
          ? scrubPii(params.instructions)
          : params.instructions
    }
  }

  const responseText = args.responseText
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
    ...(inputCopy ? { input: inputCopy } : {}),
    metadata,
    ...(errorMessage ? { errorMessage } : {}),
  }
}

// ─── Non-streaming helpers ──────────────────────────────────────

function extractText(r: NonStreamingResponse): string {
  // Convenience: the SDK populates `output_text` with the
  // concatenated text from every message item. Fall back to manual
  // aggregation if absent.
  if (typeof r.output_text === 'string' && r.output_text.length > 0) {
    return r.output_text
  }
  const items = r.output ?? []
  let out = ''
  for (const item of items) {
    if (item.type !== 'message') continue
    const msg = item as ResponseOutputMessage
    for (const part of msg.content ?? []) {
      if (
        part.type === 'output_text' &&
        typeof part.text === 'string'
      ) {
        out += part.text
      }
    }
  }
  return out
}

function extractToolCalls(
  output: ResponseOutputItem[],
): CapturedToolCall[] | null {
  const out: CapturedToolCall[] = []
  for (const item of output) {
    if (item.type !== 'function_call') continue
    const fc = item as ResponseFunctionCallItem
    out.push({
      id: typeof fc.call_id === 'string' ? fc.call_id : '',
      name: typeof fc.name === 'string' ? fc.name : '',
      arguments: typeof fc.arguments === 'string' ? fc.arguments : '',
    })
  }
  return out.length > 0 ? out : null
}

function normaliseTokens(
  u: ResponseUsage | undefined,
): NormalisedTokens | null {
  if (!u) return null
  const input = numberOrZero(u.input_tokens)
  const output = numberOrZero(u.output_tokens)
  const total = numberOrZero(u.total_tokens) || input + output
  const cacheRead = numberOrZero(u.input_tokens_details?.cached_tokens)
  const reasoning = numberOrZero(u.output_tokens_details?.reasoning_tokens)
  const base: NormalisedTokens = { input, output, total }
  if (cacheRead > 0) base.cache_read = cacheRead
  if (reasoning > 0) base.reasoning = reasoning
  return base
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// ─── Streaming wrapper ──────────────────────────────────────────

interface StreamState {
  aggregatedText: string
  toolEntries: Map<number, CapturedToolCall>
  usage: ResponseUsage | null
  modelFromResponse: string | undefined
  finishReason: string | null
}

function wrapStream(
  source: AsyncIterable<StreamEvent>,
  ctx: InstrumentContext,
  params: ResponseCreateParams,
  startedAt: number,
  span: SpanInfo,
  onComplete: () => void,
): AsyncIterable<StreamEvent> {
  const state: StreamState = {
    aggregatedText: '',
    toolEntries: new Map(),
    usage: null,
    modelFromResponse: undefined,
    finishReason: null,
  }
  let emitted = false

  function emit() {
    if (emitted) return
    emitted = true
    ctx.ingest.send(
      buildStreamEvent({
        ctx,
        params,
        startedAt,
        aggregatedText: state.aggregatedText,
        tokens: normaliseTokens(state.usage ?? undefined),
        toolCalls: snapshotTools(state.toolEntries),
        modelFromResponse: state.modelFromResponse,
        finishReason: state.finishReason,
        span,
      }),
    )
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const ev of source) {
          applyEvent(state, ev)
          yield ev
        }
      } catch (err) {
        ctx.ingest.send(
          buildFailureEvent({ ctx, params, startedAt, error: err, span }),
        )
        emitted = true
        throw err
      } finally {
        emit()
        onComplete()
      }
    },
  }
}

/**
 * Step the streaming state machine one event forward. The 60+
 * event types in the Responses API stream are matched against the
 * subset that affects capture; the rest are no-ops here and just
 * pass through to the user.
 */
function applyEvent(state: StreamState, ev: StreamEvent): void {
  switch (ev.type) {
    case 'response.created': {
      const e = ev as StreamCreated
      if (e.response?.model && !state.modelFromResponse) {
        state.modelFromResponse = e.response.model
      }
      return
    }
    case 'response.output_text.delta': {
      const e = ev as StreamTextDelta
      if (typeof e.delta === 'string') state.aggregatedText += e.delta
      return
    }
    case 'response.output_item.added': {
      const e = ev as StreamItemAdded
      if (e.item?.type === 'function_call') {
        const fc = e.item as ResponseFunctionCallItem
        state.toolEntries.set(e.output_index, {
          id: typeof fc.call_id === 'string' ? fc.call_id : '',
          name: typeof fc.name === 'string' ? fc.name : '',
          arguments:
            typeof fc.arguments === 'string' ? fc.arguments : '',
        })
      }
      return
    }
    case 'response.function_call_arguments.delta': {
      const e = ev as StreamFuncArgsDelta
      const entry = state.toolEntries.get(e.output_index)
      if (entry && typeof e.delta === 'string') {
        entry.arguments += e.delta
      }
      return
    }
    case 'response.completed': {
      const e = ev as StreamCompleted
      // The completed event carries the full response including
      // usage. We treat its usage as authoritative — overrides any
      // partial token info we'd accumulated.
      if (e.response?.usage) state.usage = e.response.usage
      if (e.response?.model && !state.modelFromResponse) {
        state.modelFromResponse = e.response.model
      }
      // `status` lands on the response field of the completed event.
      // It's the final terminal state (`completed`, `incomplete`,
      // …) that we surface as finishReason.
      const s = e.response?.status
      if (typeof s === 'string' && state.finishReason === null) {
        state.finishReason = s
      }
      return
    }
    case 'response.failed':
    case 'response.incomplete': {
      const e = ev as { type: string; response?: { status?: string } }
      const s = e.response?.status
      if (typeof s === 'string' && state.finishReason === null) {
        state.finishReason = s
      }
      return
    }
    // Everything else (audio_*, web_search_*, file_search_*,
    // code_interpreter_*, image_gen_*, mcp_*, reasoning_summary_*,
    // refusal_*, output_text.done, …) passes through without
    // state updates.
  }
}

function snapshotTools(
  acc: Map<number, CapturedToolCall>,
): CapturedToolCall[] | null {
  if (acc.size === 0) return null
  const entries = [...acc.entries()].sort(([a], [b]) => a - b)
  const out = entries.map(([, v]) => v).filter((t) => t.name.length > 0)
  return out.length > 0 ? out : null
}
