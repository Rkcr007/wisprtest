import type { Rect, Viewport } from './config.js';

/**
 * Viewport-normalised geometry.
 *
 * The last-resort signal at 0.05. Position is the first thing a redesign changes, so it can
 * never be more than a nudge — but it is a genuinely useful nudge between two otherwise
 * identical controls, one at the top of a form and one at the bottom.
 *
 * Fractions of the viewport rather than pixels, so a fingerprint taken on the indexer's
 * 1280×720 headless window still means something on a tester's 2560×1440 monitor.
 */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Convert a measured rect into the fractions the contract's `NormalizedBBox` requires. */
export function normalizeRect(
  rect: Rect,
  viewport: Viewport,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const width = viewport.width > 0 ? viewport.width : 1;
  const height = viewport.height > 0 ? viewport.height : 1;

  return {
    x: clamp01(rect.x / width),
    y: clamp01(rect.y / height),
    width: clamp01(rect.width / width),
    height: clamp01(rect.height / height),
  };
}

interface NormalizedBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Similarity of two normalised boxes, in [0, 1].
 *
 * Centre distance and size agreement, averaged. Not intersection-over-union: two renders of the
 * same control after a scroll do not overlap at all, and IoU would score that 0 where this
 * scores it by how far it moved. Distance is scaled by the diagonal so a full-viewport
 * displacement reaches 0 rather than going negative.
 *
 * Two zero-area boxes score 1. That is the case where neither side has geometry — happy-dom,
 * or a detached node — and the honest reading is "no disagreement", which the scorer then
 * weights at 0.05 anyway.
 */
export function bboxSimilarity(a: NormalizedBox, b: NormalizedBox): number {
  const degenerate = a.width === 0 && a.height === 0 && b.width === 0 && b.height === 0;
  if (degenerate) return a.x === b.x && a.y === b.y ? 1 : positionScore(a, b);

  return (positionScore(a, b) + sizeScore(a, b)) / 2;
}

function positionScore(a: NormalizedBox, b: NormalizedBox): number {
  const centreA = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const centreB = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = centreA.x - centreB.x;
  const dy = centreA.y - centreB.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // The diagonal of the unit square: the furthest two points in a viewport can be.
  return clamp01(1 - distance / Math.SQRT2);
}

function sizeScore(a: NormalizedBox, b: NormalizedBox): number {
  return (ratio(a.width, b.width) + ratio(a.height, b.height)) / 2;
}

/** Ratio of the smaller value to the larger, treating two zeroes as agreement. */
function ratio(a: number, b: number): number {
  const larger = Math.max(a, b);
  if (larger === 0) return 1;
  return clamp01(Math.min(a, b) / larger);
}
