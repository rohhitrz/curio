'use client';

import type { CitationSnapshot, Source } from '@curio/shared';
import { useState } from 'react';
import { useOpenSourceFile, useSources } from '@/features/sources/queries';
import { SourceViewerDialog } from '@/features/sources/source-viewer-dialog';
import type { HighlightRange } from '@/features/sources/viewer';
import { citationTarget, pdfAtPage } from './citations';

/**
 * Opens a citation at its spot: a PDF at its page, a web page or video at its URL, a passage in
 * the viewer. Problems go to `onNotice`. Render `viewer` once, next to the content.
 */
export function useCitationOpener(notebookId: string, onNotice: (message: string) => void) {
  const sources = useSources(notebookId);
  const openFile = useOpenSourceFile();
  const [viewer, setViewer] = useState<{ source: Source; highlight: HighlightRange | null } | null>(
    null,
  );

  async function open(citation: CitationSnapshot) {
    const source = sources.data?.find((s) => s.id === citation.sourceId);
    const target = citationTarget(citation, source);
    switch (target.kind) {
      case 'pdf': {
        // Open the tab during the click, or the browser blocks it as a pop-up once we await.
        const tab = window.open('', '_blank');
        try {
          const { url } = await openFile.mutateAsync(target.sourceId);
          const atPage = pdfAtPage(url, target.page);
          if (tab) {
            tab.opener = null;
            tab.location.href = atPage;
          } else {
            window.location.href = atPage;
          }
        } catch (err) {
          tab?.close();
          onNotice(err instanceof Error ? err.message : 'Couldn’t open the PDF.');
        }
        return;
      }
      case 'url':
        window.open(target.url, '_blank', 'noopener,noreferrer');
        return;
      case 'passage':
        if (source) setViewer({ source, highlight: target.range });
        return;
      case 'unavailable':
        onNotice(
          `“${citation.sourceTitle}” was deleted or is being processed again. The quoted passage is shown with the citation.`,
        );
    }
  }

  return {
    sources,
    open: (citation: CitationSnapshot) => void open(citation),
    viewer: (
      <SourceViewerDialog
        source={viewer?.source ?? null}
        highlight={viewer?.highlight ?? null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setViewer(null);
        }}
      />
    ),
  };
}
