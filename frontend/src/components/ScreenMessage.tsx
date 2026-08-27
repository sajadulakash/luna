/** A plain centred message. Used for loading, and for the dead-link page. */

interface ScreenMessageProps {
  title: string;
  body?: string;
}

export function ScreenMessage({ title, body }: ScreenMessageProps) {
  return (
    <main className="flex h-app flex-col items-center justify-center bg-bg px-24 px-safe">
      <h1 className="text-20 font-medium text-ink">{title}</h1>
      {body ? (
        <p className="mt-8 max-w-chat text-center text-15 text-muted">{body}</p>
      ) : null}
    </main>
  );
}
