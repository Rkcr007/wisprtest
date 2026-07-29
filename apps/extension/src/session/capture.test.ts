import { describe, expect, it, vi } from 'vitest';

/** The two hops, discriminated the way they actually differ: the ticket is a POST, the upload a PUT. */
type Hop = 'ticket' | 'upload';

/** A fetch fake that answers per hop. `url` is normalised so a test can assert on it. */
function fakeFetch(
  answer: (hop: Hop, call: { url: string; init: RequestInit | undefined }) => Response,
): { fetch: typeof globalThis.fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(answer((init?.method ?? 'GET') === 'POST' ? 'ticket' : 'upload', call));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

import { createEvidenceUploader, decodeBase64 } from '../background/evidence-uploader.js';
import { contentHash } from './evidence.js';

/**
 * The capture pipeline — the hop from redacted bytes in the browser to an object in storage.
 *
 * The unit tests beside this one prove the *redaction*; this proves the *plumbing*, which is the
 * half that was missing when the phase first went green: primitives that nothing called.
 *
 * Two properties matter here:
 *
 * - **The bytes never transit the gateway.** The extension asks for somewhere to put them and PUTs
 *   them straight to storage, so the control plane spends no bandwidth on a customer's pixels and
 *   the extension never holds a storage credential.
 * - **A failure yields no reference, not a broken one.** Evidence explains a step; it is not the
 *   step, and a step recorded without a screenshot is still a recorded step.
 */

const SESSION = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
const TOKEN = 'scoped-token';
const KEY = 'tenants/1111/sessions/9c5b/3-screenshot-abc.png';

function ticketResponse(storageKey = KEY): Response {
  return new Response(
    JSON.stringify({
      storageKey,
      uploadUrl: 'https://evidence.test/put?sig=abc',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function upload(fetchImpl: typeof globalThis.fetch, onError?: (e: unknown) => void) {
  const bytes = new TextEncoder().encode('fake-png');
  const uploader = createEvidenceUploader({
    gatewayOrigin: 'https://gateway.test',
    fetch: fetchImpl,
    ...(onError === undefined ? {} : { onError }),
  });
  return uploader.upload(
    SESSION,
    {
      kind: 'screenshot',
      stepOrdinal: 3,
      bytes,
      contentType: 'image/png',
      contentHash: await contentHash(bytes),
      capturedAt: new Date().toISOString(),
    },
    TOKEN,
  );
}

describe('uploading one artifact', () => {
  it('asks for a ticket with the hash, then PUTs the bytes straight to storage', async () => {
    const { fetch, calls } = fakeFetch((hop) =>
      hop === 'ticket' ? ticketResponse() : new Response(null, { status: 200 }),
    );

    const ref = await upload(fetch);

    expect(calls).toHaveLength(2);

    // 1. The ticket request carries the hash and the content type — never the bytes.
    expect(calls[0]?.url).toBe(`https://gateway.test/v1/sessions/${SESSION}/evidence`);
    // The body is always the string this uploader serialises; typed here so the assertions below
    // read it as JSON rather than stringifying whatever `BodyInit` happens to be.
    const rawBody = calls[0]?.init?.body;
    const ticketBody = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}') as Record<
      string,
      unknown
    >;
    expect(ticketBody).toMatchObject({
      kind: 'screenshot',
      stepOrdinal: 3,
      contentType: 'image/png',
    });
    expect(ticketBody.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(ticketBody)).not.toContain('bytes');
    expect(Object.keys(ticketBody)).not.toContain('body');

    // 2. The bytes go to the signed URL, not to the gateway.
    expect(calls[1]?.url).toBe('https://evidence.test/put?sig=abc');
    expect(calls[1]?.init?.method).toBe('PUT');

    // 3. The reference is what gets recorded on the step.
    expect(ref?.kind).toBe('screenshot');
    expect(ref?.storageKey).toBe(KEY);
    expect(ref?.contentHash).toBe(ticketBody.contentHash);
  });

  it('sends the token to the gateway and never to object storage', async () => {
    const { fetch, calls } = fakeFetch((hop) =>
      hop === 'ticket' ? ticketResponse() : new Response(null, { status: 200 }),
    );

    await upload(fetch);

    // The pre-signed URL carries its own authorisation. Attaching the tenant's bearer token to a
    // third-party storage host would be handing a credential to somewhere it does not belong.
    const auth = calls.map((c) => new Headers(c.init?.headers).get('authorization'));
    expect(auth[0]).toBe(`Bearer ${TOKEN}`);
    expect(auth[1]).toBeNull();
  });

  it('records nothing when the gateway refuses a ticket', async () => {
    const errors: unknown[] = [];
    const { fetch } = fakeFetch(
      () => new Response(JSON.stringify({ code: 'session_closed' }), { status: 409 }),
    );

    // A closed session is the common case: the tab went away between the action and the capture.
    expect(await upload(fetch, (e) => errors.push(e))).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('records nothing when the upload itself fails', async () => {
    const { fetch } = fakeFetch((hop) =>
      hop === 'ticket' ? ticketResponse() : new Response(null, { status: 403 }),
    );

    expect(await upload(fetch, () => undefined)).toBeNull();
  });

  it('records nothing when the network is gone', async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new Error('offline')),
    ) as unknown as typeof globalThis.fetch;

    // Never throws into the executor: a capture that could not happen must not turn a recorded
    // action into an unrecorded one.
    expect(await upload(fetch, () => undefined)).toBeNull();
  });

  it('refuses a ticket that is not the contract shape', async () => {
    const { fetch } = fakeFetch((hop) =>
      hop === 'ticket'
        ? new Response(JSON.stringify({ storageKey: KEY }), { status: 200 })
        : new Response(null, { status: 200 }),
    );

    // A ticket with no expiry is a standing write authorisation, and not one this will use.
    expect(await upload(fetch, () => undefined)).toBeNull();
  });
});

describe('decoding what CDP returns', () => {
  it('turns a base64 screenshot into the bytes that go on the wire', async () => {
    const original = new TextEncoder().encode('fake-png-bytes');
    const base64 = btoa(String.fromCharCode(...original));

    const decoded = decodeBase64(base64);

    expect(decoded).toEqual(original);
    // The hash is computed over the decoded bytes, so it verifies against what storage serves.
    expect(await contentHash(decoded)).toBe(await contentHash(original));
  });
});
