/**
 * Input sanitization for prompt injection protection.
 *
 * Social media content (comments, captions, usernames) is untrusted user input
 * that flows into LLM context via MCP tool results. This module strips technical
 * smuggling vectors — invisible characters, whitespace abuse, and context flooding.
 *
 * We do NOT attempt semantic injection detection (that's the LLM's job via system prompts).
 */

const MAX_FIELD_LENGTH = 10_000;

/**
 * Sanitize a string from external user-generated content.
 *
 * 1. Strip zero-width and control characters used to hide instructions
 * 2. Collapse excessive whitespace that pushes content out of context
 * 3. Truncate to prevent context flooding from a single field
 */
export function sanitize(text: string): string {
  // 1. Strip zero-width and control characters (U+200B–U+200F, U+2028–U+202F, U+2060–U+206F, U+FEFF)
  let clean = text.replace(
    /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g,
    "",
  );

  // 2. Collapse excessive whitespace
  clean = clean.replace(/\n{4,}/g, "\n\n\n");
  clean = clean.replace(/ {100,}/g, " ");

  // 3. Truncate to safe max length
  clean = clean.slice(0, MAX_FIELD_LENGTH);

  return clean;
}
