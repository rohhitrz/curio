import { describe, expect, it } from 'vitest';
import { createFakeStorage } from '../fakes/storage.js';

describe('fake storage provider', () => {
  it('head is null until the file is put, then reports size and type', async () => {
    const storage = createFakeStorage();

    expect(await storage.provider.head('k.pdf')).toBeNull();
    storage.put('k.pdf', 2048);
    expect(await storage.provider.head('k.pdf')).toEqual({
      size: 2048,
      contentType: 'application/pdf',
    });
  });

  it('download is null for a missing key and returns the bytes of a stored file', async () => {
    const storage = createFakeStorage();
    const bytes = new Uint8Array([1, 2, 3]);

    expect(await storage.provider.download('k.pdf')).toBeNull();
    storage.putFile('k.pdf', bytes);

    expect(await storage.provider.download('k.pdf')).toEqual(bytes);
    expect(await storage.provider.head('k.pdf')).toMatchObject({ size: 3 });
  });

  it('delete removes the object and records the call', async () => {
    const storage = createFakeStorage();
    storage.put('k.pdf');

    await storage.provider.delete('k.pdf');

    expect(storage.has('k.pdf')).toBe(false);
    expect(storage.deleted).toEqual(['k.pdf']);
  });

  it('can be told to fail the next call', async () => {
    const storage = createFakeStorage();
    storage.failNextCall(new Error('R2 down'));

    await expect(storage.provider.head('k.pdf')).rejects.toThrow('R2 down');
    await expect(storage.provider.head('k.pdf')).resolves.toBeNull();
  });
});
