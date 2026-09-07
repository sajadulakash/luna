import { useState } from 'react';
import { LogOut } from 'lucide-react';
import type { Meeting } from '../api/types';
import { useAuthStore } from '../stores/authStore';
import { ChatPane } from '../features/chat/ChatPane';
import { ViewTabs, type ViewTab } from '../components/ViewTabs';
import { NotificationBell } from '../components/NotificationBell';
import { WeekView } from '../features/calendar/WeekView';
import { MeetingDetail } from '../features/calendar/MeetingDetail';

/**
 * /chat — the employee's own screen.
 *
 * An ordinary signed-in page: the session comes from the auth store, the same
 * as the console, and signing out returns to the login page. There is no link
 * to keep and no separate way in.
 *
 * Chat and a calendar share the compact tab header. The calendar is read-only:
 * employees see the meetings arranged for them without the owner's controls.
 */
export function EmployeeChat() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [tab, setTab] = useState<ViewTab>('chat');
  const [selected, setSelected] = useState<Meeting | null>(null);

  const firstName = user?.name.split(' ')[0] ?? 'there';

  return (
    <main className="h-app bg-bg px-safe">
      <div className="mx-auto flex h-full max-w-chat flex-col">
        <div className="flex items-center border-b border-line bg-surface pt-safe">
          <ViewTabs active={tab} onChange={setTab} className="flex-1" />
          <NotificationBell />
          <button
            type="button"
            onClick={() => void logout()}
            aria-label="Sign out"
            className="tap flex shrink-0 items-center justify-center px-16 text-faint transition-colors duration-150 ease-out hover:text-ink"
          >
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {tab === 'chat' ? (
            <ChatPane
              token={accessToken}
              greeting={`Hi ${firstName} — I'm Luna. When would you like to meet?`}
              slotsTappable
              composerPlaceholder="Message Luna"
            />
          ) : (
            <WeekView onSelectMeeting={setSelected} />
          )}
        </div>
      </div>

      {selected ? (
        <MeetingDetail
          meeting={selected}
          editable={false}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </main>
  );
}
