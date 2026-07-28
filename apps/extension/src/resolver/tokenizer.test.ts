import { describe, expect, it } from 'vitest';

import { basicTokenize, loadVocab, WordPieceTokenizer } from './tokenizer.js';

/**
 * A small vocabulary covering the words these tests use, in `vocab.txt` order so the ids are the
 * line numbers. It carries the four special tokens, some whole words, and the pieces needed to
 * show WordPiece splitting ("playing" → "play" + "##ing") and an out-of-vocabulary fallback.
 */
const VOCAB_LINES = [
  '[PAD]', // 0
  '[UNK]', // 1
  '[CLS]', // 2
  '[SEP]', // 3
  'approve', // 4
  'order', // 5
  'the', // 6
  'pending', // 7
  'play', // 8
  '##ing', // 9
  'cafe', // 10
  '.', // 11
  'sign', // 12
  'in', // 13
];
const vocab = loadVocab(VOCAB_LINES.join('\n'));
const tokenizer = new WordPieceTokenizer(vocab);

const [PAD, UNK, CLS, SEP] = [0, 1, 2, 3];

describe('basicTokenize', () => {
  it('lowercases, strips accents and splits punctuation into its own token', () => {
    expect(basicTokenize('Café.')).toEqual(['cafe', '.']);
  });

  it('splits on whitespace', () => {
    expect(basicTokenize('sign  in')).toEqual(['sign', 'in']);
  });
});

describe('WordPieceTokenizer.encode', () => {
  it('wraps a sequence in [CLS] … [SEP]', () => {
    expect(tokenizer.encode('approve order')).toEqual([CLS, 4, 5, SEP]);
  });

  it('splits an unknown word into WordPiece continuation pieces', () => {
    // "playing" is not in the vocab whole, but "play" + "##ing" are.
    expect(tokenizer.encode('playing')).toEqual([CLS, 8, 9, SEP]);
  });

  it('emits [UNK] for a word with no coverage at all', () => {
    expect(tokenizer.encode('zzzz')).toEqual([CLS, UNK, SEP]);
  });

  it('truncates content but never drops the terminator', () => {
    const short = new WordPieceTokenizer(vocab, { maxLength: 3 });
    // maxLength 3 leaves room for [CLS], one content token, [SEP] — the rest is truncated.
    expect(short.encode('approve order the pending')).toEqual([CLS, 4, SEP]);
  });
});

describe('WordPieceTokenizer.encodeBatch', () => {
  it('right-pads to the longest row and masks the padding', () => {
    const batch = tokenizer.encodeBatch(['approve', 'approve order']);

    expect(batch.inputIds).toEqual([
      [CLS, 4, SEP, PAD],
      [CLS, 4, 5, SEP],
    ]);
    expect(batch.attentionMask).toEqual([
      [1, 1, 1, 0],
      [1, 1, 1, 1],
    ]);
    // Single sentences: every token is segment 0.
    expect(batch.tokenTypeIds).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
  });
});

describe('constructing without the special tokens', () => {
  it('refuses a vocabulary missing a required special token', () => {
    const partial = loadVocab(['[PAD]', '[CLS]', '[SEP]', 'approve'].join('\n'));
    expect(() => new WordPieceTokenizer(partial)).toThrow(/\[UNK\]/);
  });
});
