'use client';

import { MESSAGE_CONTENT_MAX, type CitationSnapshot, type Source } from '@curio/shared';
import {
  Check,
  ChevronDown,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  SendHorizontal,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useOpenSourceFile, useSources } from '@/features/sources/queries';
import { SourceViewerDialog } from '@/features/sources/source-viewer-dialog';
import type { HighlightRange } from '@/features/sources/viewer';
import { timeAgo } from '@/lib/format';
import { Answer, QuestionBubble } from './chat-message';
import { citationTarget, pdfAtPage } from './citations';
import { DeleteConversationDialog, RenameConversationDialog } from './conversation-dialogs';
import { buildChatItems } from './display';
import {
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useMessageFeedback,
  useMessages,
  useRenameConversation,
} from './queries';
import { useAnswerStream } from './use-answer-stream';

/** `latest` follows the most recent conversation; `new` is a chat not created yet. */
type Selection = { kind: 'latest' } | { kind: 'new' } | { kind: 'conversation'; id: string };

type DialogState = { type: 'rename' } | { type: 'delete' } | null;

export function ChatPanel({ notebookId }: { notebookId: string }) {
  const conversations = useConversations(notebookId);
  const createConversation = useCreateConversation(notebookId);
  const renameConversation = useRenameConversation(notebookId);
  const deleteConversation = useDeleteConversation(notebookId);
  const sources = useSources(notebookId);
  const openFile = useOpenSourceFile();
  const answer = useAnswerStream(notebookId);

  const [selection, setSelection] = useState<Selection>({ kind: 'latest' });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [viewer, setViewer] = useState<{ source: Source; highlight: HighlightRange | null } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const list = conversations.data ?? [];
  const active =
    selection.kind === 'new'
      ? null
      : selection.kind === 'latest'
        ? (list[0] ?? null)
        : (list.find((c) => c.id === selection.id) ?? null);
  const activeId = active?.id ?? null;

  const messages = useMessages(activeId);
  const feedback = useMessageFeedback(activeId ?? '');
  const items = buildChatItems(messages.data ?? [], answer.pending, activeId);

  // Keep the newest message in view as answers stream in.
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastItem = items.at(-1);
  const scrollKey = `${activeId}:${items.length}:${lastItem?.kind === 'answer' ? lastItem.text.length : 0}`;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [scrollKey]);

  async function send() {
    const content = draft.trim();
    if (content === '' || answer.isStreaming) return;
    setNotice(null);
    answer.clearError();
    let conversationId = activeId;
    if (!conversationId) {
      try {
        const created = await createConversation.mutateAsync();
        conversationId = created.id;
        setSelection({ kind: 'conversation', id: created.id });
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Couldn’t start a conversation.');
        return;
      }
    }
    setDraft('');
    await answer.send(conversationId, content);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function openCitation(citation: CitationSnapshot) {
    setNotice(null);
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
          setNotice(err instanceof Error ? err.message : 'Couldn’t open the PDF.');
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
        setNotice(
          `“${citation.sourceTitle}” was deleted or is being processed again. The quoted passage is shown under the answer.`,
        );
    }
  }

  const busy = answer.isStreaming || createConversation.isPending;

  return (
    <section
      aria-labelledby="chat-heading"
      className="bg-card flex h-[70dvh] min-h-[24rem] flex-col rounded-xl border lg:h-[calc(100dvh-3rem)]"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 id="chat-heading" className="sr-only">
          Chat
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" />}
          >
            <MessageSquare />
            <span className="truncate">{active?.title ?? 'New conversation'}</span>
            <ChevronDown className="text-muted-foreground ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
            <DropdownMenuLabel>Conversations</DropdownMenuLabel>
            {list.length === 0 && (
              <p className="text-muted-foreground px-2 py-1.5 text-sm">No conversations yet.</p>
            )}
            {list.map((conversation) => (
              <DropdownMenuItem
                key={conversation.id}
                onClick={() => setSelection({ kind: 'conversation', id: conversation.id })}
              >
                <Check className={conversation.id === activeId ? '' : 'invisible'} />
                <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {timeAgo(conversation.lastMessageAt)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setSelection({ kind: 'new' });
            setNotice(null);
            answer.clearError();
          }}
        >
          <Plus />
          New chat
        </Button>
        {active && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" aria-label="Conversation actions" />}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setDialog({ type: 'rename' })}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onClick={() => setDialog({ type: 'delete' })}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {conversations.isPending || (activeId && messages.isPending) ? (
          <div className="space-y-3" aria-label="Loading">
            <Skeleton className="ml-auto h-9 w-2/3 rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        ) : messages.isError ? (
          <div className="rounded-lg border p-6 text-center">
            <p className="text-sm font-medium">Couldn’t load this conversation.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void messages.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <MessageSquare className="text-muted-foreground size-8" aria-hidden />
            <p className="mt-3 font-medium">Ask about your sources</p>
            <p className="text-muted-foreground mt-1 max-w-xs text-sm">
              {sources.data?.some((s) => s.status === 'READY')
                ? 'Answers come only from this notebook’s sources, with citations you can open.'
                : 'Add a source and wait until it’s ready. Answers come only from your sources.'}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {messages.hasNextPage && (
              <div className="text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={messages.isFetchingNextPage}
                  onClick={() => void messages.fetchNextPage()}
                >
                  {messages.isFetchingNextPage ? 'Loading…' : 'Show earlier messages'}
                </Button>
              </div>
            )}
            {items.map((item) =>
              item.kind === 'question' ? (
                <QuestionBubble key={item.key} content={item.content} />
              ) : (
                <Answer
                  key={item.key}
                  text={item.text}
                  citations={item.citations}
                  onCite={(citation) => void openCitation(citation)}
                  status={item.status}
                  streaming={item.streaming}
                  error={item.error}
                  onRetry={
                    item.retryable && activeId && !busy
                      ? () => void answer.retry(activeId)
                      : undefined
                  }
                  feedback={item.feedback}
                  onFeedback={
                    item.messageId && !item.error
                      ? (value) => feedback.mutate({ messageId: item.messageId ?? '', value })
                      : undefined
                  }
                />
              ),
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <form
        className="border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {(answer.error ?? notice) && (
          <p role="alert" className="text-destructive mb-2 text-sm">
            {answer.error?.message ?? notice}
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask a question about your sources…"
            aria-label="Your question"
            maxLength={MESSAGE_CONTENT_MAX}
            rows={1}
            className="max-h-40 min-h-10 resize-none"
          />
          <Button
            type="submit"
            size="icon"
            disabled={busy || draft.trim() === ''}
            aria-label="Send"
          >
            <SendHorizontal />
          </Button>
        </div>
      </form>

      <SourceViewerDialog
        source={viewer?.source ?? null}
        highlight={viewer?.highlight ?? null}
        onOpenChange={(open) => {
          if (!open) setViewer(null);
        }}
      />
      <RenameConversationDialog
        open={dialog?.type === 'rename'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        initialTitle={active?.title ?? ''}
        onSubmit={(title) =>
          active ? renameConversation.mutateAsync({ id: active.id, title }) : Promise.resolve()
        }
      />
      <DeleteConversationDialog
        open={dialog?.type === 'delete'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={active?.title ?? ''}
        onConfirm={async () => {
          if (!active) return;
          await deleteConversation.mutateAsync(active.id);
          setSelection({ kind: 'latest' });
        }}
      />
    </section>
  );
}
