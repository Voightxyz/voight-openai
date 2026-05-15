/**
 * Smoke test for Path-A `cache_read` capture (0.1.0-beta.2).
 *
 * OpenAI auto-caches prompts ≥1024 tokens for ~5 minutes. To exercise
 * the cache_read path end-to-end we send the SAME long prompt twice
 * back-to-back. The second call should report a non-zero
 * `prompt_tokens_details.cached_tokens` value that this wrapper
 * surfaces as `metadata.tokens.cache_read` on the Voight event.
 *
 * Run with:
 *   OPENAI_API_KEY=... VOIGHT_KEY=... npx tsx examples/cache-smoke.ts
 */

import OpenAI from 'openai'
import { wrapOpenAI } from '../src/index.js'

const LONG_PROMPT = `
You are a senior staff engineer reviewing infrastructure designs for a
distributed observability platform. Below is the full context and a
multi-part question. Read carefully before answering — the prompt is
intentionally verbose because OpenAI's automatic prompt caching only
kicks in once the prefix reaches at least 1024 tokens.

Context layer 1 — ingestion pipeline:
The team has built an event ingestion pipeline that receives JSON
payloads from third-party SDKs (Claude Code hooks, OpenAI SDK
wrappers, Anthropic SDK wrappers, Cursor IDE hooks, future Codex
plugin hooks). All payloads land at a single endpoint POST /v1/events
on a Fastify front-end deployed to Railway. The endpoint validates
the body against a Zod schema, looks up the API key in Postgres (the
key is stored as a SHA-256 hash, the plaintext never persists), and
upserts an Agent record scoped to the calling user. Agent identity
is resolved in priority order: a pre-bound key with an explicit
agentId wins; otherwise the body must carry an agentId, which can be
either a CUID (matched as primary key — rename-proof, folder-move
proof) or a free-form label (matched against SNS .sol domains or the
agent displayName). Soft-deleted agents return 410 Gone so the SDK
can clear its local marker and reset cleanly.

Context layer 2 — pricing engine:
Token usage data flows through metadata.tokens with input, output,
total, and optionally cache_read for providers that auto-cache. The
backend computes USD cost using a per-model pricing table that
supports longest-prefix matching so versioned model ids resolve to
their base entry. For example "gpt-4o-mini-2024-07-18" matches the
"gpt-4o-mini" entry; "claude-3-opus-20240229" matches "claude-3-opus".
The pricing engine has three modes: Path-A "exact" applies when
tokensBreakdown is present (the SDK ships inputBase, cacheCreation,
cacheRead, output as four separate counts, and we apply each at its
true rate per provider — full input rate for inputBase, 1.25x for
cacheCreation in Anthropic, 0.1x for cacheRead). Path-B "heuristic"
applies for Claude Code events where metadata.source equals
'claude-code' but tokensBreakdown is absent — we assume 95% of input
is cache_read and discount accordingly. Path-C "flat" applies for
library callers without breakdown data — no cache discount, full
input rate on all input tokens.

Context layer 3 — privacy model:
Privacy is configurable per call at three levels. Minimal mode strips
all content: only metadata fields land (tool names, timing, outcomes,
tokens, USD) and the responseText, prompts, file paths, cwd, git
state, and error messages are dropped before the wire. Standard mode
(the default) preserves content shape but scrubs every string leaf
against a 12-pattern regex catalogue: Anthropic API keys, OpenAI API
keys (both classic and project-scoped), Stripe live keys, GitHub PATs
(both fine-grained and classic), AWS access key IDs, Slack tokens,
Voight's own vk_ keys, JWTs, PEM private key blocks, emails (with TLD
validation), E.164 phone numbers, and Luhn-validated credit cards.
Full mode skips redaction entirely — useful for trusted internal
agents but not the default. The scrubbing is pure, idempotent, and
runs at >100KB/sec on a single core.

Context layer 4 — frontend surface:
The dashboard is a Next.js app deployed to Vercel that polls the
backend for events, aggregates them client-side into traces and
sessions, and surfaces cost / latency / model mix / error rate per
agent. The trace timeline groups events by sessionId. The audit log
provides a flat reverse-chronological view with filters by agent,
tool, type, and time window. Sensitive content (responseText,
thinkingPreview, prompts) is rendered behind a MaskedBlock component
that defaults to hidden and reveals on eye-toggle. The Models in Use
card shows top model by spend in 24h with an "+N others" overflow
when more than one model has activity. Brand glyphs are rendered per
framework: Claude Code, Cursor, Codex Desktop each get a distinct
mark sourced from /logos.

Context layer 5 — deployment topology:
Vercel builds the frontend from main. Railway builds the API from main
and runs Prisma migrate deploy on each redeploy. The Postgres database
is managed by Railway with daily snapshots. Anthropic API and OpenAI
API are accessed only client-side from user code — the backend never
makes outbound LLM calls (Voight is observability, not an LLM
gateway). The only external service the backend calls is Solana RPC
(Helius) for on-chain agent registry lookups, which feed the public
Explorer view.

Question:
Given that the smoke test is exercising the Path-A code path
specifically for OpenAI cached input tokens, what is the most likely
failure mode you would expect to surface during the first production
rollout, and how would you mitigate it without breaking existing
Anthropic Path-A consumers? Consider the following sub-cases: (a) the
OpenAI response shape differs from Anthropic in a subtle way that the
unit tests didn't catch, (b) the backend pricing engine rounds cost
to two decimal places and tiny cached deltas vanish, (c) the
dashboard's MaskedBlock has no rendering branch for cache_read so the
field appears unmasked even under standard privacy, (d) the Path-A
detection logic dispatches on the presence of tokensBreakdown but
OpenAI emits a different field name. Rank the four sub-cases by
likelihood and severity.

Be concise — three bullet points maximum, total response under
80 words. Skip preamble.
`.trim()

async function main() {
  const agent = 'voight-openai-smoke-test'
  console.log(`[smoke] agent = ${agent}`)
  console.log(`[smoke] prompt length: ${LONG_PROMPT.length} chars ≈ ${Math.round(LONG_PROMPT.length / 4)} tokens (rough estimate)`)

  const client = wrapOpenAI(new OpenAI(), {
    agent,
    privacy: 'full',
  })

  // First call — populates OpenAI's cache.
  console.log('[smoke] call 1 (cache populate)…')
  const r1 = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: LONG_PROMPT }],
  })
  console.log(`[smoke] call 1 done — prompt_tokens=${r1.usage?.prompt_tokens} cached=${r1.usage?.prompt_tokens_details?.cached_tokens ?? 0}`)

  // Wait briefly to ensure cache is committed before retry.
  await new Promise((r) => setTimeout(r, 1500))

  // Second call — same prompt, should hit cache.
  console.log('[smoke] call 2 (cache hit expected)…')
  const r2 = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: LONG_PROMPT }],
  })
  console.log(`[smoke] call 2 done — prompt_tokens=${r2.usage?.prompt_tokens} cached=${r2.usage?.prompt_tokens_details?.cached_tokens ?? 0}`)

  // Wait for fire-and-forget ingest to flush before exiting.
  await new Promise((r) => setTimeout(r, 1000))
  console.log('[smoke] done. Verify in dashboard: 2 new events under voight-openai-smoke-test, the second with metadata.tokens.cache_read > 0.')
}

main().catch((err) => {
  console.error('[smoke] failed:', err)
  process.exit(1)
})
