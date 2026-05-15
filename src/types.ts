// Public types for @voightxyz/openai. Kept in a single file so the public
// surface is auditable at a glance — anything not exported from `index.ts`
// is implementation detail.

/**
 * Capture aggressiveness for prompts and responses.
 *
 * - `minimal`: model, tokens, latency, errors only. Zero content.
 * - `standard` (default): + prompts/responses redacted of common PII
 *   (emails, phone numbers, SSNs).
 * - `full`: everything raw, no redaction.
 */
export type PrivacyLevel = 'minimal' | 'standard' | 'full'

export interface WrapOptions {
  /** Voight API key. Falls back to `process.env.VOIGHT_KEY`. */
  voightApiKey?: string

  /** Voight API base URL. Defaults to `https://api.voight.xyz`. */
  apiBase?: string

  /**
   * Stable agent identifier surfaced in the dashboard. Falls back to
   * `process.env.VOIGHT_AGENT`, then `process.env.HOSTNAME`, then
   * `'unknown-agent'`.
   */
  agent?: string

  /** Default `'standard'`. See {@link PrivacyLevel}. */
  privacy?: PrivacyLevel

  /** Kill switch. When `false` the wrapper is a no-op pass-through. */
  enabled?: boolean
}
