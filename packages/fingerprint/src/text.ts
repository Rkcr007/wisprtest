import type { FingerprintConfig } from './config.js';
import { normalizeWhitespace, type Redactor } from './redact.js';
import { sha256Hex } from './sha256.js';

/**
 * Text shingles.
 *
 * The weakest signal at 0.07, and the ARCHITECTURE table says why: content-derived. An
 * element's text changes whenever the data behind it changes, so it earns a small vote and no
 * more. It is included because it is the tie-breaker of last resort in a table of otherwise
 * identical rows.
 *
 * Shingling — hashing overlapping runs of `shingleSize` words rather than the whole string —
 * means a small edit perturbs a few shingles instead of changing everything. The stored
 * fingerprint keeps a single digest over the shingle set, so comparison is a string equality
 * rather than a set operation, which is what the 15 ms budget can afford.
 *
 * Text is redacted before it is shingled. A shingle hash computed over unredacted text would be
 * a searchable digest of customer data, which is precisely what CLAUDE.md § "PII rule" forbids
 * memory from holding.
 */

/** Overlapping word runs of `size`, lowercased. Fewer words than `size` yields one shingle. */
export function shingles(text: string, size: number): string[] {
  const words = normalizeWhitespace(text).toLowerCase().split(' ').filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= size) return [words.join(' ')];

  const result: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) {
    result.push(words.slice(i, i + size).join(' '));
  }
  return result;
}

/**
 * A single digest over an element's shingled, redacted text.
 *
 * Empty text hashes the empty string rather than returning a sentinel, so the field always
 * satisfies the contract's `Sha256Hex` and two empty elements agree on this signal.
 */
export function computeTextShingleHash(
  element: Element,
  config: FingerprintConfig,
  redact: Redactor,
): string {
  // `textContent` is nullable on `Node` but never on `Element`, which is all this takes.
  const raw = element.textContent.slice(0, config.maxShingleTextLength);
  const redacted = redact(raw);
  return sha256Hex(shingles(redacted, config.shingleSize).join(''));
}
