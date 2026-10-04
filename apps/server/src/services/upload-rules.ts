import { randomUUID } from 'node:crypto';
import { quotas, uploads } from '../config/index.js';
import { AppError } from '../errors/app-error.js';

/** Rejects anything that isn't a PDF within the size limit (checked before issuing an upload URL). */
export function assertUploadAllowed(input: { fileSize: number; contentType: string }): void {
  if (input.contentType.toLowerCase() !== uploads.pdfContentType) {
    throw new AppError('UNSUPPORTED_FILE_TYPE', 'Only PDF files can be uploaded.');
  }
  assertPdfSize(input.fileSize);
}

/** The size the browser declared, and again the stored file's real size when the source is added. */
export function assertPdfSize(bytes: number): void {
  if (bytes > quotas.pdfMaxBytes) {
    const maxMb = Math.round(quotas.pdfMaxBytes / (1024 * 1024));
    throw new AppError('FILE_TOO_LARGE', `PDFs can be at most ${maxMb} MB.`);
  }
}

function userPrefix(userId: string): string {
  return `users/${userId}/`;
}

/** `users/{userId}/uploads/{uuid}.pdf` (docs/04-api-design.md §4). */
export function newUploadKey(userId: string): string {
  return `${userPrefix(userId)}uploads/${randomUUID()}.pdf`;
}

/** A key belongs to the user only if it's under their prefix and has no path tricks. */
export function isOwnUploadKey(userId: string, key: string): boolean {
  const pattern = /^users\/[0-9a-f-]{36}\/uploads\/[0-9a-f-]{36}\.pdf$/;
  return key.startsWith(userPrefix(userId)) && pattern.test(key);
}
