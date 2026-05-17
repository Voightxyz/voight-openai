/**
 * `wrapOpenAI` — the public entrypoint of @voightxyz/openai.
 *
 * The wrapper is a layered `Proxy`. Level 0 intercepts the
 * `chat` property; level 1 intercepts `completions`; level 2
 * intercepts the `create` function. Everything outside the
 * `client.chat.completions.create` path passes through untouched
 * via `Reflect.get`, so embeddings, images, audio, files, the
 * `responses` namespace and any future SDK additions keep
 * working with zero special-casing.
 *
 * Failure modes are intentionally non-fatal:
 *
 *   - `enabled: false`         → return the original client. Zero
 *                                 wrapping, zero overhead.
 *   - no API key resolves      → log a one-line warning and return
 *                                 the original client. Production
 *                                 keeps running; the developer
 *                                 sees the misconfiguration in the
 *                                 terminal.
 *
 * Internal `_fetch` and `_env` options exist so tests can drive
 * the network + environment surface without touching globals.
 * They're cast away from the public `WrapOptions` type at the
 * boundary so users never see them in their IDE.
 */

import { randomUUID } from 'node:crypto'

import type { WrapOptions } from './types.js'
import { resolveApiKey, resolveAgent } from './identity.js'
import { createIngestClient } from './ingest.js'
import {
  instrumentChatCompletions,
  type InstrumentContext,
} from './instruments/chat-completions.js'
import { instrumentResponses } from './instruments/responses.js'

interface InternalOptions extends WrapOptions {
  _fetch?: typeof fetch
  _env?: Record<string, string | undefined>
}

const DEFAULT_API_BASE = 'https://api.voight.xyz'

export function wrapOpenAI<T extends object>(
  client: T,
  options: WrapOptions = {},
): T {
  const opts = options as InternalOptions

  // Kill switch — return the original client untouched. No proxy,
  // no per-call overhead.
  if (opts.enabled === false) return client

  const env = opts._env ?? process.env
  const apiKey = resolveApiKey(
    { voightApiKey: opts.voightApiKey, agent: opts.agent },
    env,
  )

  // No usable API key: warn once and hand back the original
  // client. We never break the user's call path because Voight
  // isn't configured.
  if (apiKey === null) {
    console.warn(
      '[voight] no VOIGHT_KEY resolved — wrapper is a pass-through. ' +
        'Set process.env.VOIGHT_KEY or pass `voightApiKey` to wrapOpenAI() to enable capture.',
    )
    return client
  }

  const agentId = resolveAgent(
    { voightApiKey: opts.voightApiKey, agent: opts.agent },
    env,
  )

  const ingest = createIngestClient({
    apiBase: opts.apiBase ?? DEFAULT_API_BASE,
    apiKey,
    fetch: opts._fetch,
  })

  // sessionId is generated once per wrapper instance. Explicit
  // override wins so callers can scope by user / conversation /
  // request without us second-guessing them.
  const sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.trim().length > 0
      ? opts.sessionId.trim()
      : randomUUID()

  // routeTag is normalised once at the boundary: trimmed, empty
  // strings dropped to undefined so the instrument doesn't have to
  // distinguish between "no tag" and "empty tag".
  const routeTag =
    typeof opts.routeTag === 'string' && opts.routeTag.trim().length > 0
      ? opts.routeTag.trim()
      : undefined

  const ctx: InstrumentContext = {
    agentId,
    privacy: opts.privacy ?? 'standard',
    sessionId,
    routeTag,
    ingest,
    now: () => Date.now(),
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') {
        const chat = Reflect.get(target, prop, receiver)
        return wrapChat(chat as object, ctx)
      }
      if (prop === 'responses') {
        const responses = Reflect.get(target, prop, receiver)
        return wrapResponses(responses as object, ctx)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

function wrapResponses<R extends object>(
  responses: R,
  ctx: InstrumentContext,
): R {
  return new Proxy(responses, {
    get(target, prop, receiver) {
      if (prop === 'create') {
        const original = Reflect.get(target, prop, receiver) as (
          params: never,
        ) => Promise<unknown>
        return instrumentResponses(
          original.bind(target) as never,
          ctx,
        )
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

function wrapChat<C extends object>(chat: C, ctx: InstrumentContext): C {
  return new Proxy(chat, {
    get(target, prop, receiver) {
      if (prop === 'completions') {
        const completions = Reflect.get(target, prop, receiver)
        return wrapCompletions(completions as object, ctx)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

function wrapCompletions<C extends object>(
  completions: C,
  ctx: InstrumentContext,
): C {
  return new Proxy(completions, {
    get(target, prop, receiver) {
      if (prop === 'create') {
        const original = Reflect.get(target, prop, receiver) as (
          params: never,
        ) => Promise<unknown>
        // .bind so `this` inside the SDK's `create` stays the
        // real completions instance, not the proxy. Without this
        // the OpenAI SDK loses access to its internal http client.
        return instrumentChatCompletions(
          original.bind(target) as never,
          ctx,
        )
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}
