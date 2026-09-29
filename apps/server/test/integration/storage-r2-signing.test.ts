import { describe, expect, it } from 'vitest';
import { createR2StorageProvider } from '../../src/lib/storage/r2.js';

// Presigning is local (no network), so dummy credentials are enough.
const provider = createR2StorageProvider({
  accountId: 'acct',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucket: 'bucket',
});

describe('r2 provider signing', () => {
  it('upload URL signs content-type and content-length', async () => {
    const url = new URL(
      await provider.createUploadUrl({
        key: 'users/u/uploads/x.pdf',
        contentType: 'application/pdf',
        contentLength: 1024,
        expiresInSeconds: 600,
      }),
    );

    const signed = url.searchParams.get('X-Amz-SignedHeaders')?.split(';');
    expect(signed).toEqual(expect.arrayContaining(['content-type', 'content-length']));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
  });

  it('download URL uses the requested TTL', async () => {
    const url = new URL(
      await provider.createDownloadUrl({ key: 'users/u/uploads/x.pdf', expiresInSeconds: 300 }),
    );

    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });
});
