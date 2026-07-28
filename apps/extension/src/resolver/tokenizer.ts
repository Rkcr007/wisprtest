/**
 * A WordPiece tokenizer, the front half of the bge-small embedding pipeline.
 *
 * bge-small-en-v1.5 is a BERT-family model, so its ONNX graph takes token ids produced by the
 * uncased BERT tokenizer: a basic tokenizer (clean, lowercase, strip accents, split on whitespace
 * and punctuation) followed by greedy longest-match WordPiece against a 30k vocabulary. This is
 * that algorithm, implemented rather than pulled from `@huggingface/transformers` — the extension
 * ships the model and runs it through `onnxruntime-web` directly (docs/BUILD-PLAN.md Phase 8), and
 * a full transformers runtime bundled into every content script to do 150 lines of string work
 * would be a poor trade against the hot path's size budget.
 *
 * What is covered is the uncased-English path the QA corpus needs. What is not: cased models,
 * language-specific segmentation beyond the CJK spacing every BERT tokenizer does, and the
 * SentencePiece/BPE families other models use. Those are documented absences, not silent ones.
 */

export interface EncodedBatch {
  /** Token ids, one row per input, padded to the batch's longest row. */
  readonly inputIds: number[][];
  /** 1 for a real token, 0 for padding — how the model ignores the pad tail. */
  readonly attentionMask: number[][];
  /** All zeros: these inputs are single sentences, so every token is segment 0. */
  readonly tokenTypeIds: number[][];
}

export interface TokenizerOptions {
  /** Longest sequence, including `[CLS]` and `[SEP]`. BERT's limit is 512; bge keeps it. */
  readonly maxLength?: number;
}

const CLS = '[CLS]';
const SEP = '[SEP]';
const PAD = '[PAD]';
const UNK = '[UNK]';
const MAX_CHARS_PER_WORD = 100;
const DEFAULT_MAX_LENGTH = 512;

/**
 * Parse a `vocab.txt` — one token per line, id is the line index.
 *
 * This is the format BERT and bge both ship. The map it returns is what the tokenizer looks every
 * WordPiece up in.
 */
export function loadVocab(vocabText: string): Map<string, number> {
  const vocab = new Map<string, number>();
  const lines = vocabText.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    // The final newline yields a trailing empty entry; a real vocab has no empty token, so
    // skipping it keeps the id space contiguous with the file's line numbers.
    const token = lines[index];
    if (token === undefined || token === '') continue;
    vocab.set(token, index);
  }
  return vocab;
}

export class WordPieceTokenizer {
  readonly #vocab: Map<string, number>;
  readonly #maxLength: number;
  readonly #unkId: number;
  readonly #clsId: number;
  readonly #sepId: number;
  readonly #padId: number;

  constructor(vocab: Map<string, number>, options: TokenizerOptions = {}) {
    this.#vocab = vocab;
    this.#maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    this.#unkId = requireToken(vocab, UNK);
    this.#clsId = requireToken(vocab, CLS);
    this.#sepId = requireToken(vocab, SEP);
    this.#padId = requireToken(vocab, PAD);
  }

  /** Token ids for one string, with `[CLS]`/`[SEP]` and no padding. */
  encode(text: string): number[] {
    const pieces: number[] = [this.#clsId];

    for (const word of basicTokenize(text)) {
      for (const piece of this.#wordPiece(word)) {
        pieces.push(piece);
        // Leave room for the closing `[SEP]`: truncate the content, never the terminator, so a
        // very long utterance still produces a well-formed sequence.
        if (pieces.length >= this.#maxLength - 1) break;
      }
      if (pieces.length >= this.#maxLength - 1) break;
    }

    pieces.push(this.#sepId);
    return pieces;
  }

  /** Encode and right-pad a batch to a rectangular tensor the model can take in one pass. */
  encodeBatch(texts: readonly string[]): EncodedBatch {
    const rows = texts.map((text) => this.encode(text));
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);

    const inputIds: number[][] = [];
    const attentionMask: number[][] = [];
    const tokenTypeIds: number[][] = [];

    for (const row of rows) {
      const pad = width - row.length;
      inputIds.push([...row, ...Array<number>(pad).fill(this.#padId)]);
      attentionMask.push([...Array<number>(row.length).fill(1), ...Array<number>(pad).fill(0)]);
      tokenTypeIds.push(Array<number>(width).fill(0));
    }

    return { inputIds, attentionMask, tokenTypeIds };
  }

  /** Greedy longest-match-first WordPiece for one whitespace token. */
  #wordPiece(word: string): number[] {
    // Code points, not UTF-16 units, so a multi-byte character is one piece boundary.
    const chars = Array.from(word);
    if (chars.length > MAX_CHARS_PER_WORD) return [this.#unkId];

    const pieces: number[] = [];
    let start = 0;

    while (start < chars.length) {
      let end = chars.length;
      let matchedId: number | undefined;

      // Shrink the window from the right until a substring is in the vocabulary. Continuation
      // pieces carry the `##` prefix BERT uses to mark "this joins the previous piece".
      while (start < end) {
        const substring = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        const id = this.#vocab.get(substring);
        if (id !== undefined) {
          matchedId = id;
          break;
        }
        end -= 1;
      }

      // A word with even one unmatchable span is `[UNK]` as a whole, exactly as BERT does it —
      // partial coverage would produce ids that no longer reconstruct the word.
      if (matchedId === undefined) return [this.#unkId];
      pieces.push(matchedId);
      start = end;
    }

    return pieces;
  }
}

function requireToken(vocab: Map<string, number>, token: string): number {
  const id = vocab.get(token);
  if (id === undefined) {
    throw new Error(`vocabulary is missing the required special token ${token}`);
  }
  return id;
}

/**
 * BERT's BasicTokenizer: clean control characters, space CJK, lowercase, strip accents, then
 * split on whitespace and break punctuation into its own tokens.
 */
export function basicTokenize(text: string): string[] {
  const cleaned = spaceCjk(cleanText(text));
  const tokens: string[] = [];

  for (const rawWord of cleaned.split(/\s+/)) {
    if (rawWord === '') continue;
    const folded = stripAccents(rawWord.toLowerCase());
    tokens.push(...splitOnPunctuation(folded));
  }

  return tokens;
}

/** Drop control characters and normalise every run of whitespace to a single space. */
function cleanText(text: string): string {
  let output = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0 || code === 0xfffd) continue;
    if (isControl(char)) continue;
    output += isWhitespace(char) ? ' ' : char;
  }
  return output;
}

/** NFD-decompose and drop the combining marks — "café" → "cafe", matching uncased BERT. */
function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{Mn}+/gu, '');
}

/** Split a token so each punctuation character becomes its own token. */
function splitOnPunctuation(text: string): string[] {
  const output: string[] = [];
  let current = '';

  for (const char of text) {
    if (isPunctuation(char)) {
      if (current !== '') {
        output.push(current);
        current = '';
      }
      output.push(char);
    } else {
      current += char;
    }
  }

  if (current !== '') output.push(current);
  return output;
}

/** Put spaces around CJK ideographs so each becomes its own token, as every BERT tokenizer does. */
function spaceCjk(text: string): string {
  let output = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    output += isCjk(code) ? ` ${char} ` : char;
  }
  return output;
}

function isControl(char: string): boolean {
  if (char === '\t' || char === '\n' || char === '\r') return false;
  return /\p{Cc}|\p{Cf}/u.test(char);
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || /\p{Zs}/u.test(char);
}

function isPunctuation(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  // BERT treats the ASCII punctuation ranges as punctuation even though some are not `\p{P}`
  // (e.g. `^`), plus every Unicode punctuation category.
  if (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(char);
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}
