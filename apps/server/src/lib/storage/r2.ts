import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider } from './types.js';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Without these the SDK waits indefinitely on a hung connection. */
  connectTimeoutMs: number;
  requestTimeoutMs: number;
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}

export function createR2StorageProvider(config: R2Config): StorageProvider {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Default flexible checksums add headers that break R2 presigned uploads (decision A-10).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: config.connectTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
    },
  });
  const Bucket = config.bucket;

  return {
    createUploadUrl({ key, contentType, contentLength, expiresInSeconds }) {
      const command = new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      });
      // The presigner leaves Content-Type unsigned unless told to sign it.
      return getSignedUrl(client, command, {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(['content-type']),
      });
    },

    createDownloadUrl({ key, expiresInSeconds }) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },

    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: result.ContentLength ?? 0, contentType: result.ContentType };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async download(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return (await result.Body?.transformToByteArray()) ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
