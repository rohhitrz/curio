import { createHash } from 'node:crypto';
import { SOURCE_TITLE_MAX } from '@curio/shared';
import { describe, expect, it } from 'vitest';
import {
  hasActiveSources,
  pdfContentType,
  sha256Hex,
  titleAfterFileChange,
  titleFromFileName,
} from './upload';

describe('sha256Hex', () => {
  it('matches the server-side SHA-256 of the same bytes', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 hello');
    const expected = createHash('sha256').update(bytes).digest('hex');

    expect(await sha256Hex(bytes.buffer)).toBe(expected);
  });

  it('is 64 lowercase hex chars (the API contract)', async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('titleFromFileName', () => {
  it.each([
    ['Lecture 3.pdf', 'Lecture 3'],
    ['NOTES.PDF', 'NOTES'],
    ['  spaced.pdf  ', 'spaced'],
    ['no-extension', 'no-extension'],
    ['.pdf', '.pdf'],
  ])('%s → %s', (name, title) => {
    expect(titleFromFileName(name)).toBe(title);
  });

  it('caps long names at the title limit', () => {
    expect(titleFromFileName(`${'a'.repeat(300)}.pdf`)).toHaveLength(SOURCE_TITLE_MAX);
  });
});

describe('pdfContentType', () => {
  it('uses the browser type when present', () => {
    expect(pdfContentType({ name: 'a.pdf', type: 'application/pdf' })).toBe('application/pdf');
    expect(pdfContentType({ name: 'a.png', type: 'image/png' })).toBe('image/png');
  });

  it('falls back to the extension when the browser gives no type', () => {
    expect(pdfContentType({ name: 'a.PDF', type: '' })).toBe('application/pdf');
    expect(pdfContentType({ name: 'a.bin', type: '' })).toBe('application/octet-stream');
  });
});

describe('hasActiveSources', () => {
  it('true while any source is pending or processing', () => {
    expect(hasActiveSources([{ status: 'READY' }, { status: 'PENDING' }])).toBe(true);
    expect(hasActiveSources([{ status: 'PROCESSING' }])).toBe(true);
  });

  it('false when all are ready or failed, or there are none', () => {
    expect(hasActiveSources([{ status: 'READY' }, { status: 'FAILED' }])).toBe(false);
    expect(hasActiveSources([])).toBe(false);
  });
});

describe('titleAfterFileChange', () => {
  it('fills an empty title from the file name', () => {
    expect(titleAfterFileChange('', '', 'Lecture 1.pdf')).toBe('Lecture 1');
  });

  it('switching files replaces the auto-filled title', () => {
    expect(titleAfterFileChange('Lecture 1', 'Lecture 1', 'Lecture 2.pdf')).toBe('Lecture 2');
  });

  it('keeps a title the user typed', () => {
    expect(titleAfterFileChange('My notes', 'Lecture 1', 'Lecture 2.pdf')).toBeNull();
    expect(titleAfterFileChange('My notes', '', 'Lecture 2.pdf')).toBeNull();
  });

  it('clearing the file clears an auto-filled title', () => {
    expect(titleAfterFileChange('Lecture 1', 'Lecture 1', null)).toBe('');
  });
});
