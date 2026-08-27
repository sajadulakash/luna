import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { useAppHeight } from './lib/useAppHeight';
import { EmployeeChat } from './routes/EmployeeChat';
import { OwnerConsole } from './routes/OwnerConsole';
import { Login } from './routes/Login';
import { ScreenMessage } from './components/ScreenMessage';

/** Three routes only. */
export function App() {
  useAppHeight();

  return (
    <Routes>
      <Route path="/chat/:token" element={<EmployeeChat />} />
      <Route
        path="/chat-ended"
        element={
          <ScreenMessage
            title="You've left the chat."
            body="You can safely close this tab."
          />
        }
      />
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireOwner>
            <OwnerConsole />
          </RequireOwner>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * The owner's guard.
 *
 * A reload starts with no access token — it lives in memory by design — so
 * the first thing to try is a silent refresh against the httpOnly cookie.
 * Only when that fails does the owner see /login.
 */
function RequireOwner({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const restore = useAuthStore((s) => s.restore);

  useEffect(() => {
    if (status === 'unknown') void restore();
  }, [restore, status]);

  if (status === 'unknown' || status === 'restoring') {
    return <ScreenMessage title="One moment…" />;
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
