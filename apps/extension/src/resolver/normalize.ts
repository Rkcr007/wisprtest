/**
 * Phrase normalisation, shared by T0 exact matching and the alias map.
 *
 * Both sides of a T0 comparison pass through here, which is the whole point: a tester who says
 * "The Pending Filter." must hit an alias stored as "the pending filter", and an accessible name
 * rendered as "Pending  " (with a stray trailing space the layout added) must match the phrase
 * "pending". Normalising both ends with one function is what makes the exact tier actually exact
 * rather than exact-modulo-whitespace-and-case.
 *
 * It is deliberately lossy and deterministic: lowercase, Unicode-folded, punctuation flattened to
 * spaces, whitespace collapsed. It is not stemming and not synonymy — anything past a trivial
 * surface difference is T1's job, where embeddings handle it.
 */
export function normalizePhrase(text: string): string {
  return (
    text
      // NFKC folds compatibility forms — a full-width digit, a ligature — onto their plain
      // equivalents, so two spellings that look identical compare identical.
      .normalize('NFKC')
      .toLowerCase()
      // Punctuation becomes a separator rather than being deleted, so "sign-in" and "sign in"
      // both normalise to "sign in" instead of one collapsing to "signin".
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Whether two phrases are the same once normalised. */
export function phrasesEqual(a: string, b: string): boolean {
  return normalizePhrase(a) === normalizePhrase(b);
}
