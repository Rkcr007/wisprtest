import { EscalateResponse, type EscalateRequest } from 'protocol';

/**
 * The T2 prompt, and the parser that turns the model's text back into a contract value.
 *
 * The task is deliberately small: the model is handed the tester's redacted phrase and the scoped
 * candidate set — dozens of elements, never the whole document — and asked which one the phrase
 * names. Everything it sees is already redacted (CLAUDE.md § "PII rule"); this file adds no data,
 * it only frames it. The output is demanded as strict JSON so the parser can validate it against
 * the `EscalateResponse` contract rather than scrape prose.
 *
 * ## Why the parser is strict about membership
 *
 * A small model will occasionally answer with an id that was not in the list, or invent a plausible
 * UUID. That is not a resolution — it is a hallucination wearing the shape of one, and executing it
 * is exactly the false execution CLAUDE.md gates releases on. So the parser rejects any `elementId`
 * that is not one of the candidates offered, which routes the call to a repair retry and then, if
 * that also fails, to an honest "not found" the extension turns into disambiguation.
 */

export const ESCALATION_SYSTEM_PROMPT = [
  'You resolve a spoken phrase to exactly one on-screen element.',
  'You are given the phrase and a numbered list of candidate elements that are currently visible.',
  'Choose the single candidate the phrase most likely refers to.',
  'Respond with ONE JSON object and nothing else — no prose, no code fences.',
  'The object has exactly these keys:',
  '  "elementId": the id string of your chosen candidate, copied verbatim from the list;',
  '  "confidence": a number from 0 to 1 for how sure you are;',
  '  "reasoning": one short sentence, naming only the candidate labels shown to you.',
  'You may only choose an elementId that appears in the list. Never invent one.',
].join('\n');

/** Appended as a follow-up turn when the first answer did not parse. One retry only. */
export const ESCALATION_REPAIR_INSTRUCTION = [
  'That was not a single valid JSON object with the required keys, or the elementId was not one',
  'of the candidates. Reply again with ONLY the JSON object:',
  '{"elementId": "<one of the listed ids>", "confidence": <0..1>, "reasoning": "<one sentence>"}',
].join('\n');

/** Render the candidate list the model chooses from. Labels are already redacted by the contract. */
export function buildUserPrompt(request: EscalateRequest): string {
  const lines = request.candidates.map(
    (candidate, index) =>
      `${String(index + 1)}. id=${candidate.elementId} key=${candidate.elementKey} label=${JSON.stringify(candidate.label)}`,
  );
  return [`Phrase: ${JSON.stringify(request.utterance)}`, '', 'Candidates:', ...lines].join('\n');
}

/**
 * Parse the model's text into an `EscalateResponse`, or null if it is unusable.
 *
 * Tolerates the small stuff a model does even when told not to — a code fence, a stray sentence
 * around the object — by taking the first balanced `{…}` span, but is unforgiving about the things
 * that matter: the object must satisfy the contract, and the chosen id must be one that was offered.
 */
export function parseEscalation(
  text: string,
  candidateIds: ReadonlySet<string>,
): EscalateResponse | null {
  const json = extractJsonObject(text);
  if (json === null) return null;

  let candidate: unknown;
  try {
    candidate = JSON.parse(json);
  } catch {
    return null;
  }

  const parsed = EscalateResponse.safeParse(candidate);
  if (!parsed.success) return null;

  // The one check the schema cannot make: the model must have picked from the list it was given.
  if (!candidateIds.has(parsed.data.elementId)) return null;

  return parsed.data;
}

/** The first balanced `{…}` span in `text`, or null. Ignores braces inside JSON string literals. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
