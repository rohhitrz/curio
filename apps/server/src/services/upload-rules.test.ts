import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { quotas } from '../config/index.js';
import { AppError } from '../errors/app-error.js';
import { assertUploadAllowed, isOwnUploadKey, newUploadKey } from './upload-rules.js';

function codeOf(fn: () => void) {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'OTHER';
  }
  return 'OK';
}

describe('assertUploadAllowed', () => {
  it('accepts a PDF at exactly the size limit', () => {
    expect(
      codeOf(() =>
        assertUploadAllowed({ fileSize: quotas.pdfMaxBytes, contentType: 'application/pdf' }),
      ),
    ).toBe('OK');
  });

  it('file > 25 MB → FILE_TOO_LARGE', () => {
    expect(
      codeOf(() =>
        assertUploadAllowed({ fileSize: quotas.pdfMaxBytes + 1, contentType: 'application/pdf' }),
      ),
    ).toBe('FILE_TOO_LARGE');
  });

  it.each(['image/png', 'text/plain', 'application/x-pdf', ''])(
    'content type %j → UNSUPPORTED_FILE_TYPE',
    (contentType) => {
      expect(codeOf(() => assertUploadAllowed({ fileSize: 100, contentType }))).toBe(
        'UNSUPPORTED_FILE_TYPE',
      );
    },
  );

  it('content type check ignores case', () => {
    expect(
      codeOf(() => assertUploadAllowed({ fileSize: 100, contentType: 'Application/PDF' })),
    ).toBe('OK');
  });
});

describe('upload keys', () => {
  const userId = randomUUID();

  it('new keys live under the user prefix and are recognized as theirs', () => {
    const key = newUploadKey(userId);

    expect(key).toMatch(new RegExp(`^users/${userId}/uploads/[0-9a-f-]{36}\\.pdf$`));
    expect(isOwnUploadKey(userId, key)).toBe(true);
  });

  it('another user’s key is rejected', () => {
    expect(isOwnUploadKey(userId, newUploadKey(randomUUID()))).toBe(false);
  });

  it.each([
    `users/${userId}/uploads/../../other/uploads/x.pdf`,
    `users/${userId}/uploads/${randomUUID()}.exe`,
    `users/${userId}/other/${randomUUID()}.pdf`,
    `users/${userId}/uploads/${randomUUID()}.pdf/extra`,
  ])('malformed key %s is rejected', (key) => {
    expect(isOwnUploadKey(userId, key)).toBe(false);
  });
});
