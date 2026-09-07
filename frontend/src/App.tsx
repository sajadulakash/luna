import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { useAppHeight } from './lib/useAppHeight';
import { EmployeeChat } from './routes/EmployeeChat';
import { OwnerConsole } from './routes/OwnerConsole';
import { Login } from './routes/Login';
import { Register } from './routes/Register';
import { ScreenMessage } from './components/ScreenMessage';

/** Login, register, the owner console, and an employee's chat. */
export function App() {
  useAppHeight();

  return (
    <Routes>
      <Route
        path="/chat"
        element={
          <RequireAuth role="EMPLOYEE">
            <EmployeeChat />
          </RequireAuth>
        }
      />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/"
        element={
          <RequireAuth role="BOSS">
            <OwnerConsole />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * The guard on both signed-in areas.
 *
 * A reload starts with no access token — it lives in memory by design — so
 * the first thing to try is a silent refresh against the httpOnly cookie.
 * Only when that fails does anyone see /login.
 *
 * Landing on the wrong area is a redirect rather than a refusal: an employee
 * who opens / belongs in the chat, and the boss who opens /chat belongs in
 * the console.
 */
function RequireAuth({
  role,
  children,
}: {
  role: 'BOSS' | 'EMPLOYEE';
  children: React.ReactNode;
}) {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const restore = useAuthStore((s) => s.restore);

  useEffect(() => {
    if (status === 'unknown') void restore();
  }, [restore, status]);

  if (status === 'unknown' || status === 'restoring') {
    return <ScreenMessage title="One moment…" />;
  }

  if (status === 'anonymous' || !user) {
    return <Navigate to="/login" replace />;
  }

  if (user.role !== role) {
    return <Navigate to={homeFor(user.role)} replace />;
  }

  return <>{children}</>;
}

/** Where someone belongs once signed in. */
export function homeFor(role: 'BOSS' | 'EMPLOYEE'): string {
  return role === 'BOSS' ? '/' : '/chat';
}
