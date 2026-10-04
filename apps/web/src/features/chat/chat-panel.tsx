'use client';

import { MESSAGE_CONTENT_MAX } from '@curio/shared';
import {
  Brain,
  Check,
  ChevronDown,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  SendHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
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
import { useNotedMemories } from '@/features/memories/use-noted-memories';
import { timeAgo } from '@/lib/format';
import { Answer, QuestionBubble } from './chat-message';
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
import { useCitationOpener } from './use-citation-opener';

/** `latest` follows the most recent conversation; `new` is a chat not created yet. */
type Selection = { kind: 'latest' } | { kind: 'new' } | { kind: 'conversation'; id: string };

type DialogState = { type: 'rename' } | { type: 'delete' } | null;

export function ChatPanel({ notebookId }: { notebookId: string }) {
  const conversations = useConversations(notebookId);
  const createConversation = useCreateConversation(notebookId);
  const renameConversation = useRenameConversation(notebookId);
  const deleteConversation = useDeleteConversation(notebookId);
  const answer = useAnswerStream(notebookId);
  const noted = useNotedMemories();

  const [selection, setSelection] = useState<Selection>({ kind: 'latest' });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const citations = useCitationOpener(notebookId, setNotice);
  const sources = citations.sources;
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
    noted.afterAnswer();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const busy = answer.isStreaming || createConversation.isPending;

  return (
    <section
      aria-labelledby="chat-heading"
      className="bg-card flex h-full flex-col rounded-xl border"
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
                  onCite={(citation) => {
                    setNotice(null);
                    citations.open(citation);
                  }}
                  status={item.status}
                  streaming={item.streaming}
                  error={item.error}
                  onRetry={
                    item.retryable && activeId && !busy
                      ? () => void answer.retry(activeId).then(() => noted.afterAnswer())
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
        {noted.noted.length > 0 && (
          <div
            role="status"
            className="bg-muted mb-2 flex items-start gap-2 rounded-md px-3 py-2 text-sm"
          >
            <Brain className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1">
              <span className="font-medium">Noted: </span>
              {noted.noted.map((memory) => memory.content).join(' · ')}{' '}
              <Link href="/memories" className="text-muted-foreground underline">
                Manage memory
              </Link>
            </p>
            <button
              type="button"
              aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground"
              onClick={noted.dismiss}
            >
              <X className="size-4" />
            </button>
          </div>
        )}
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
            placeholder="Ask about your sources…"
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

      {citations.viewer}
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
