import { EvidenceUploadTicket, type EvidenceRef } from 'protocol';

/**
 * Getting captured evidence out of the browser and into object storage.
 *
 * The extension already holds redacted bytes — a PNG of the target region, an HTML snapshot with
 * every piece of content masked (`session/evidence.ts`). What it needs is somewhere to put them.
 *
 * ## Two hops, on purpose
 *
 * The gateway issues a pre-signed PUT for exactly one key; the bytes then go straight to object
 * storage. A screenshot never transits the control plane's request pipeline, and the extension
 * never holds a storage credential — the ticket authorises one object and expires.
 *
 * ## Best effort, always
 *
 * Every failure here returns null. Evidence is what explains a failed step; it is not the step,
 * and an upload that could not happen must not turn a recorded action into an unrecorded one.
 * The caller attaches whatever refs it got and moves on.
 */

export interface EvidenceUploaderOptions {
  /** Origin of the control plane. Must match the manifest's `host_permissions`. */
  readonly gatewayOrigin: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly onError?: (error: unknown) => void;
}

export interface EvidenceUpload {
  readonly kind: EvidenceRef['kind'];
  readonly stepOrdinal: number;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly contentHash: string;
  readonly capturedAt: string;
}

export interface EvidenceUploader {
  /** Upload one artifact and return the reference to record. Null when it could not be stored. */
  upload(
    sessionId: string,
    upload: EvidenceUpload,
    bearerToken: string,
  ): Promise<EvidenceRef | null>;
}

export function createEvidenceUploader(options: EvidenceUploaderOptions): EvidenceUploader {
  const { gatewayOrigin, fetch: fetchImpl = globalThis.fetch.bind(globalThis), onError } = options;

  return {
    async upload(sessionId, upload, bearerToken): Promise<EvidenceRef | null> {
      try {
        const ticketResponse = await fetchImpl(
          new URL(`/v1/sessions/${sessionId}/evidence`, gatewayOrigin).href,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${bearerToken}`,
            },
            // The hash, not the bytes. The gateway derives the key from it, which is what makes a
            // retried capture land on the same object rather than a second copy.
            body: JSON.stringify({
              kind: upload.kind,
              stepOrdinal: upload.stepOrdinal,
              contentHash: upload.contentHash,
              contentType: upload.contentType,
            }),
          },
        );

        if (!ticketResponse.ok) {
          onError?.(new Error(`evidence ticket refused: HTTP ${String(ticketResponse.status)}`));
          return null;
        }

        const ticket = EvidenceUploadTicket.safeParse(await ticketResponse.json());
        if (!ticket.success) {
          onError?.(ticket.error);
          return null;
        }

        const put = await fetchImpl(ticket.data.uploadUrl, {
          method: 'PUT',
          // The content type is signed into the ticket, so it has to match or the store rejects it.
          headers: { 'content-type': upload.contentType },
          body: upload.bytes as unknown as BodyInit,
        });

        if (!put.ok) {
          onError?.(new Error(`evidence upload failed: HTTP ${String(put.status)}`));
          return null;
        }

        return {
          kind: upload.kind,
          storageKey: ticket.data.storageKey,
          contentHash: upload.contentHash,
          capturedAt: upload.capturedAt,
        };
      } catch (error: unknown) {
        onError?.(error);
        return null;
      }
    },
  };
}

/** Decode a base64 PNG from CDP into the bytes that go on the wire. */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
