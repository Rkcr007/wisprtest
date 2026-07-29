import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { GatewayConfig } from '../config.js';
import type { EvidenceStore, EvidenceUpload } from './evidence-store.js';

/**
 * The real evidence store: any S3-compatible object storage.
 *
 * MinIO locally (see docker-compose.yml), managed object storage in production
 * (docs/ARCHITECTURE.md § 9). The same client talks to both, so moving between them is a change of
 * endpoint and credentials rather than of code — which is the whole reason for using the S3 API
 * against a local container instead of writing files to a directory and pretending.
 *
 * `forcePathStyle` is on because MinIO serves buckets as a path (`host/bucket/key`) rather than as
 * a subdomain; managed S3 accepts both, so one setting works for both deployments.
 */

export interface S3EvidenceStoreOptions {
  readonly config: GatewayConfig;
  /** Injectable so a test can drive a fake S3 without the SDK's credential chain. */
  readonly client?: S3Client;
  readonly now?: () => number;
}

export function createS3EvidenceStore(options: S3EvidenceStoreOptions): EvidenceStore & {
  /** Create the bucket if it is not there. Called at boot; safe to call repeatedly. */
  ensureBucket(): Promise<void>;
  readonly client: S3Client;
} {
  const { config } = options;
  const now = options.now ?? (() => Date.now());
  const client =
    options.client ??
    new S3Client({
      endpoint: config.EVIDENCE_ENDPOINT,
      region: config.EVIDENCE_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.EVIDENCE_ACCESS_KEY_ID,
        secretAccessKey: config.EVIDENCE_SECRET_ACCESS_KEY,
      },
    });

  return {
    client,

    async ensureBucket(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.EVIDENCE_BUCKET }));
        return;
      } catch {
        // Absent, or not visible to these credentials. Creating it is the next thing to try, and
        // its own failure is the one worth surfacing — it names the actual problem.
      }
      await client.send(new CreateBucketCommand({ Bucket: config.EVIDENCE_BUCKET }));
    },

    async put(upload: EvidenceUpload): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: config.EVIDENCE_BUCKET,
          Key: upload.key,
          Body: upload.body,
          ContentType: upload.contentType,
        }),
      );
    },

    async signedUrl(key: string): Promise<{ url: string; expiresAt: string }> {
      const ttlSeconds = config.EVIDENCE_URL_TTL_SECONDS;
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: config.EVIDENCE_BUCKET, Key: key }),
        { expiresIn: ttlSeconds },
      );
      // Reported alongside the URL rather than left for the caller to compute: a console that has
      // to guess when a link dies will guess wrong, and the failure looks like corrupt evidence.
      return { url, expiresAt: new Date(now() + ttlSeconds * 1000).toISOString() };
    },
  };
}
