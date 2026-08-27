import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

/**
 * /login — centred card, username and password, one button.
 * Errors inline beneath the field. Nothing else.
 */
export function Login() {
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);
  const restore = useAuthStore((s) => s.restore);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Someone landing here with a live refresh cookie shouldn't have to log in.
  useEffect(() => {
    if (status === 'unknown') void restore();
  }, [restore, status]);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    const ok = await login(username, password);
    setSubmitting(false);

    if (ok) navigate('/', { replace: true });
  };

  return (
    <main className="flex h-app items-center justify-center bg-bg px-24 px-safe">
      <div className="w-full max-w-[380px] rounded-card border border-line bg-surface p-24">
        <h1 className="text-20 font-semibold text-ink">Luna</h1>
        <p className="mt-4 text-13 text-muted">Sign in to your console</p>

        <form onSubmit={onSubmit} className="mt-24 flex flex-col gap-16" noValidate>
          <Field
            id="username"
            label="Username"
            type="text"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            inputMode="text"
          />

          <Field
            id="password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            error={error}
          />

          <button
            type="submit"
            disabled={submitting}
            className="tap mt-8 w-full rounded-control bg-accent px-16 text-15 font-medium text-surface transition-opacity duration-150 ease-out disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}

interface FieldProps {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  inputMode?: 'text';
  /** Rendered inline beneath this field. */
  error?: string | null;
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  inputMode,
  error,
}: FieldProps) {
  return (
    <div className="flex flex-col gap-4">
      <label htmlFor={id} className="text-13 text-muted">
        {label}
      </label>

      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={[
          'w-full rounded-control border bg-bg px-12 py-8 text-17 text-ink',
          'transition-colors duration-150 ease-out focus:border-accent',
          error ? 'border-busy' : 'border-line',
        ].join(' ')}
      />

      {error ? (
        <p id={`${id}-error`} role="alert" className="text-13 text-busy">
          {error}
        </p>
      ) : null}
    </div>
  );
}
