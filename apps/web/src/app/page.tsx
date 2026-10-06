import { Show, SignInButton, SignUpButton } from '@clerk/nextjs';
import { RecentNotebooks } from '@/features/notebooks/recent-notebooks';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <>
      <Show when="signed-in">
        <RecentNotebooks />
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

function Landing() {
  return (
    <main className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-12 px-4 py-14 sm:py-20 lg:min-h-[calc(100dvh-3.5rem)] lg:grid-cols-[1.1fr_1fr]">
      <div>
        <h1 className="text-4xl leading-[1.05] font-bold tracking-tight text-balance sm:text-5xl">
          Answers from your own sources, with the page to prove it.
        </h1>
        <p className="text-muted-foreground mt-5 max-w-xl text-lg text-pretty">
          Add PDFs, web pages, videos and notes, or name a topic to learn. Curio answers only from
          those sources, cites every claim, and turns them into lessons for your level.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <SignUpButton>
            <Button size="lg">Get started</Button>
          </SignUpButton>
          <SignInButton>
            <Button size="lg" variant="outline">
              Sign in
            </Button>
          </SignInButton>
        </div>
      </div>
      <SampleAnswer />
    </main>
  );
}

/** What an answer looks like: a claim, its citation, and where the citation opens. */
function SampleAnswer() {
  return (
    <figure aria-label="Example answer" className="bg-card rounded-2xl border p-5 shadow-sm sm:p-6">
      <p className="text-muted-foreground text-sm">You asked</p>
      <p className="mt-1 font-medium">How many layers does the Transformer encoder have?</p>
      <div className="mt-5 border-t pt-5">
        <p className="leading-relaxed">
          The encoder is a stack of six identical layers, each with a self-attention sub-layer and a
          feed-forward network
          <span className="bg-primary text-primary-foreground ml-1 inline-flex size-5 items-center justify-center rounded text-[0.7rem] font-semibold align-text-top">
            1
          </span>
          .
        </p>
      </div>
      <figcaption className="bg-background mt-5 flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm">
        <span className="bg-primary text-primary-foreground inline-flex size-5 shrink-0 items-center justify-center rounded text-[0.7rem] font-semibold">
          1
        </span>
        <span className="min-w-0 truncate">Attention Is All You Need</span>
        <span className="text-muted-foreground ml-auto shrink-0">page 3</span>
      </figcaption>
    </figure>
  );
}
