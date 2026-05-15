// Stub. Real implementation arrives via TDD in feat/wrap-openai-mvp.
// Kept here so the scaffold type-checks and ships a coherent module graph
// on day one.

import type { WrapOptions } from './types.js'

export function wrapOpenAI<T>(client: T, _options?: WrapOptions): T {
  return client
}
