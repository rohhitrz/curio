import { ApiStatus } from './api-status';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-4xl font-semibold tracking-tight">Curio</h1>
      <p className="text-muted-foreground">
        Add your sources or a topic, get grounded, cited answers, learning paths, and lessons.
      </p>
      <ApiStatus />
    </main>
  );
}
