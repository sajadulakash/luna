import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { configureApi } from '../api/client';
import type { Meeting } from '../api/types';
import { queryKeys } from '../api/meetings';
import { ChatPane } from '../features/chat/ChatPane';
import { ScreenMessage } from '../components/ScreenMessage';
import { ViewTabs, type ViewTab } from '../components/ViewTabs';
import { WeekView } from '../features/calendar/WeekView';
import { MeetingDetail } from '../features/calendar/MeetingDetail';

/**
 * /chat/:token — the employee's chat.
 *
 * The token is in the URL and goes out as a bearer token. There is no login,
 * no refresh and no retry: if the API rejects it, the link is dead and the
 * only honest thing to show is that it is dead.
 *
 * Chat and a token-scoped calendar share the same compact tab header as the
 * owner console. The calendar is read-only: employees can see meetings the
 * owner books for them without receiving owner management controls.
 */
export function EmployeeChat() {
  const { token = null } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ViewTab>('chat');
  const [selected, setSelected] = useState<Meeting | null>(null);

  // Switches the fetch wrapper into employee mode for this route: a 401 here
  // must not attempt a refresh, because employees have no session to refresh.
  useEffect(() => {
    configureApi({ getAuth: () => ({ mode: 'employee', token }) });
  }, [token]);

  if (!token) {
    return (
      <ScreenMessage
        title="This link isn't valid any more."
        body="Ask Rafi for a new one."
      />
    );
  }

  const leaveChat = () => {
    queryClient.removeQueries({ queryKey: queryKeys.chatHistory(token) });
    queryClient.removeQueries({ queryKey: queryKeys.employeeMeetings(token) });
    configureApi({ getAuth: () => ({ mode: 'employee', token: null }) });
    navigate('/chat-ended', { replace: true });
  };

  return (
    <main className="h-app bg-bg px-safe">
      <div className="mx-auto flex h-full max-w-chat flex-col">
        <div className="flex items-center border-b border-line bg-surface pt-safe">
          <ViewTabs active={tab} onChange={setTab} className="flex-1" />
          <button
            type="button"
            onClick={leaveChat}
            aria-label="Leave employee chat"
            className="tap flex shrink-0 items-center justify-center px-16 text-faint transition-colors duration-150 ease-out hover:text-ink"
          >
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {tab === 'chat' ? (
            <ChatPane
              token={token}
              greeting="Hi — I'm Luna, Rafi's assistant. When would you like to meet?"
              slotsTappable
              composerPlaceholder="Message Luna"
              renderDeadLink={() => (
                <ScreenMessage
                  title="This link isn't valid any more."
                  body="Ask Rafi for a new one."
                />
              )}
            />
          ) : (
            <WeekView token={token} onSelectMeeting={setSelected} />
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
