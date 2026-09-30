import { describe, expect, it } from 'vitest';
import { buildPdf } from '../helpers/pdf.js';
import { IngestionError } from '../../src/errors/ingestion-error.js';
import { createUnpdfParser } from '../../src/lib/pdf/unpdf.js';

const parser = createUnpdfParser();

async function failure(file: Uint8Array): Promise<IngestionError> {
  const error = await parser.parse(file).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IngestionError);
  return error as IngestionError;
}

describe('unpdf parser', () => {
  it('reads text page by page, with 1-based page numbers', async () => {
    const { pages } = await parser.parse(
      buildPdf(['Gradient descent minimizes a loss.', 'Overfitting (and how to avoid it).']),
    );

    expect(pages).toEqual([
      { pageNumber: 1, text: 'Gradient descent minimizes a loss.' },
      { pageNumber: 2, text: 'Overfitting (and how to avoid it).' },
    ]);
  });

  it('keeps a page without text as an empty page, so page numbers stay right', async () => {
    const { pages } = await parser.parse(buildPdf(['First page.', '', 'Third page.']));

    expect(pages.map((page) => page.text)).toEqual(['First page.', '', 'Third page.']);
    expect(pages[2]?.pageNumber).toBe(3);
  });

  it('leaves the caller’s bytes usable after parsing', async () => {
    const file = buildPdf(['Some text.']);
    const length = file.length;

    await parser.parse(file);

    expect(file.length).toBe(length);
    expect(file[0]).toBe('%'.charCodeAt(0));
  });

  it('scanned PDF (no text on any page) → permanent NO_TEXT', async () => {
    const error = await failure(buildPdf(['', '']));

    expect(error).toMatchObject({ code: 'NO_TEXT', retryable: false });
    expect(error.message).toContain('no selectable text');
  });

  it('not a PDF → permanent INVALID_FILE', async () => {
    const error = await failure(new TextEncoder().encode('<html><body>hello</body></html>'));

    expect(error).toMatchObject({ code: 'INVALID_FILE', retryable: false });
    expect(error.message).toBe("This file isn't a PDF.");
  });

  it('empty file → permanent INVALID_FILE', async () => {
    expect(await failure(new Uint8Array())).toMatchObject({
      code: 'INVALID_FILE',
      retryable: false,
    });
  });

  it('damaged PDF → permanent INVALID_FILE with the cause kept', async () => {
    const error = await failure(new TextEncoder().encode('%PDF-1.4\nthis is not a real document'));

    expect(error).toMatchObject({ code: 'INVALID_FILE', retryable: false });
    expect(error.message).toContain('may be damaged');
    expect(error.cause).toBeInstanceOf(Error);
  });
});
