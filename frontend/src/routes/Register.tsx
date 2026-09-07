import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { fetchDepartments, register } from '../api/auth';
import { ApiRequestError } from '../api/client';
import { useAuthStore } from '../stores/authStore';
import { homeFor } from '../App';

/**
 * /register — an employee signs themselves up.
 *
 * Registering signs you in and drops you straight into your chat. There is no
 * link to keep and no screen in between: the account is a normal session, and
 * the way back in afterwards is the same login page everyone else uses.
 */

const FALLBACK_DEPARTMENTS = [
  'HR',
  'Finance',
  'Accounts',
  'Operations',
  'Data Analytics',
  'Engineering',
  'Sales',
  'Marketing',
  'Customer Support',
];

interface Fields {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  department: string;
  password: string;
}

const EMPTY: Fields = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  department: '',
  password: '',
};

/** Matches the server's own minimum, so the form can say so before submitting. */
const MIN_PASSWORD = 8;

export function Register() {
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const adopt = useAuthStore((s) => s.adopt);

  const [fields, setFields] = useState<Fields>(EMPTY);
  const [departments, setDepartments] = useState<string[]>(FALLBACK_DEPARTMENTS);
  const [errors, setErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The list comes from the server, which is also what validates against it.
  // The fallback is only so the dropdown is never empty if that call fails.
  useEffect(() => {
    let cancelled = false;
    fetchDepartments()
      .then((list) => {
        if (!cancelled && list.length) setDepartments(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (key: keyof Fields) => (value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    setFormError(null);
  };

  /** Checked here for a quick answer; the server checks it all again anyway. */
  const validate = (): boolean => {
    const found: Partial<Record<keyof Fields, string>> = {};
    if (!fields.first_name.trim()) found.first_name = 'Required.';
    if (!fields.last_name.trim()) found.last_name = 'Required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim()))
      found.email = 'Enter a valid email address.';
    if (fields.phone.replace(/\D/g, '').length < 6)
      found.phone = 'Enter a valid phone number.';
    if (!fields.department) found.department = 'Choose a department.';
    if (fields.password.length < MIN_PASSWORD)
      found.password = `At least ${MIN_PASSWORD} characters.`;

    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !validate()) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const session = await register({
        first_name: fields.first_name.trim(),
        last_name: fields.last_name.trim(),
        email: fields.email.trim().toLowerCase(),
        phone: fields.phone.trim(),
        department: fields.department,
        password: fields.password,
      });
      // Registering is a sign-in. Straight to their chat, no screen between.
      adopt(session.access_token, session.user);
      navigate(homeFor(session.user.role), { replace: true });
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.code === 'email_taken') {
        setErrors({ email: cause.message });
      } else {
        setFormError(
          cause instanceof Error ? cause.message : "That didn't go through.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Already signed in — nothing to register.
  if (status === 'authenticated' && user) {
    return <Navigate to={homeFor(user.role)} replace />;
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-24 py-32 px-safe">
      <div className="w-full max-w-[420px] rounded-card border border-line bg-surface p-24">
        <h1 className="text-20 font-semibold text-ink">Join the team</h1>
        <p className="mt-4 text-13 text-muted">
          Register and start talking to Luna.
        </p>

        <form onSubmit={onSubmit} className="mt-24 flex flex-col gap-16" noValidate>
          <div className="flex gap-12">
            <Field
              id="first_name"
              label="First name"
              value={fields.first_name}
              onChange={set('first_name')}
              autoComplete="given-name"
              error={errors.first_name}
            />
            <Field
              id="last_name"
              label="Last name"
              value={fields.last_name}
              onChange={set('last_name')}
              autoComplete="family-name"
              error={errors.last_name}
            />
          </div>

          <Field
            id="email"
            label="Email"
            type="email"
            inputMode="email"
            value={fields.email}
            onChange={set('email')}
            autoComplete="email"
            error={errors.email}
          />

          <Field
            id="phone"
            label="Phone number"
            type="tel"
            inputMode="tel"
            value={fields.phone}
            onChange={set('phone')}
            autoComplete="tel"
            error={errors.phone}
          />

          <div className="flex flex-col gap-4">
            <label htmlFor="department" className="text-13 text-muted">
              Department
            </label>
            <select
              id="department"
              value={fields.department}
              aria-invalid={errors.department ? true : undefined}
              aria-describedby={errors.department ? 'department-error' : undefined}
              onChange={(event) => set('department')(event.target.value)}
              className={[
                'tap w-full appearance-none rounded-control border bg-bg px-12 py-8 text-17 text-ink',
                'transition-colors duration-150 ease-out focus:border-accent',
                errors.department ? 'border-busy' : 'border-line',
                fields.department ? '' : 'text-faint',
              ].join(' ')}
            >
              <option value="">Select a department</option>
              {departments.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {errors.department ? (
              <p id="department-error" role="alert" className="text-13 text-busy">
                {errors.department}
              </p>
            ) : null}
          </div>

          <Field
            id="password"
            label="Password"
            type="password"
            value={fields.password}
            onChange={set('password')}
            autoComplete="new-password"
            error={errors.password}
          />

          {formError ? (
            <p role="alert" className="text-13 text-busy">
              {formError}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="tap mt-8 w-full rounded-control bg-accent px-16 text-15 font-medium text-surface transition-opacity duration-150 ease-out disabled:opacity-60"
          >
            {submitting ? 'Registering…' : 'Register'}
          </button>
        </form>

        <p className="mt-16 text-13 text-muted">
          Managing the team?{' '}
          <Link to="/login" className="text-accent">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  type?: string;
  inputMode?: 'text' | 'email' | 'tel';
  error?: string | undefined;
}

function Field({
  id,
  label,
  value,
  onChange,
  autoComplete,
  type = 'text',
  inputMode,
  error,
}: FieldProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
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
