// Public surface of @voightxyz/openai.
//
// The package's contract is intentionally tiny: one function that takes an
// OpenAI client and returns a wrapped client with the same shape. Everything
// else (ingest transport, privacy redaction, identity resolution) is an
// implementation detail and not part of the public API.

export { wrapOpenAI } from './wrap.js'
export type { WrapOptions, PrivacyLevel } from './types.js'
