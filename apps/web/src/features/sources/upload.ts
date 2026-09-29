import { SOURCE_TITLE_MAX, type Source } from '@curio/shared';

export const PDF_CONTENT_TYPE = 'application/pdf';

/** SHA-256 of the file bytes, as lowercase hex (the API's PDF `contentHash`). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** "Lecture 3.pdf" → "Lecture 3", capped at the title limit. */
export function titleFromFileName(fileName: string): string {
  const name = fileName.trim();
  const base = name.replace(/\.pdf$/i, '').trim() || name || 'Untitled PDF';
  return base.slice(0, SOURCE_TITLE_MAX);
}

/**
 * The title after choosing a file: it follows the file name while the title is empty or still
 * the one we filled in, and is kept once the user has typed their own. Returns null to keep it.
 */
export function titleAfterFileChange(
  current: string,
  autoFilled: string,
  fileName: string | null,
): string | null {
  if (current && current !== autoFilled) return null;
  return fileName ? titleFromFileName(fileName) : '';
}

/**
 * Some browsers report an empty type for PDFs; trust the extension then. Anything else is sent
 * as-is so the API can answer `UNSUPPORTED_FILE_TYPE`.
 */
export function pdfContentType(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  return /\.pdf$/i.test(file.name) ? PDF_CONTENT_TYPE : 'application/octet-stream';
}

/** Poll the source list while anything is still waiting or being processed. */
export function hasActiveSources(sources: Pick<Source, 'status'>[]): boolean {
  return sources.some((source) => source.status === 'PENDING' || source.status === 'PROCESSING');
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * PUTs the file straight to R2 through the signed URL, reporting progress (0–1). The URL signs
 * `Content-Type` and size, so this must send exactly that file with `application/pdf`.
 */
export function putFile(
  url: string,
  file: Blob,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', PDF_CONTENT_TYPE);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadError('The upload was rejected. Please try again.'));
    };
    xhr.onerror = () => reject(new UploadError('The upload failed. Check your connection.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
