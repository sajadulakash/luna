import { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import type { Meeting } from '../api/types';
import { installOwnerAuth, useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { ChatPane, type ChatPaneHandle } from '../features/chat/ChatPane';
import { WeekView } from '../features/calendar/WeekView';
import { MeetingDetail } from '../features/calendar/MeetingDetail';
import { MicOrb } from '../features/voice/MicOrb';
import {
  VoiceController,
  type VoiceControllerHandle,
} from '../features/voice/VoiceController';
import { VoiceOverlay } from '../features/voice/VoiceOverlay';
import { ViewTabs, type ViewTab } from '../components/ViewTabs';

/**
 * / — the owner's console.
 *
 * The brief's desktop layout is chat at 420px beside the calendar. Below
 * 1024px the calendar collapses into a tab, and that is what a phone gets:
 * one pane at a time, with the mic orb sitting above the composer where the
 * thumb already is. The same components serve both — the breakpoint only
 * decides whether they sit side by side.
 */

export function OwnerConsole() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const logout = useAuthStore((s) => s.logout);

  const [tab, setTab] = useState<ViewTab>('chat');
  const [selected, setSelected] = useState<Meeting | null>(null);

  const chatRef = useRef<ChatPaneHandle | null>(null);
  const voiceRef = useRef<VoiceControllerHandle | null>(null);

  const supported = useVoiceStore((s) => s.supported);
  const permission = useVoiceStore((s) => s.permission);
  const voiceError = useVoiceStore((s) => s.error);
  const voiceState = useVoiceStore((s) => s.state);

  const [voiceOpen, setVoiceOpen] = useState(false);

  // The overlay follows the call rather than the turn: it is up for as long
  // as the line is open, because with no button to hold there is nothing else
  // telling the owner that Luna can still hear them.
  //
  // Going idle normally means they hung up, so the surface closes. When it
  // went idle *because* something failed, closing would flash the overlay open
  // and shut and leave them with no idea why — so it stays up holding the
  // explanation until it is dismissed.
  useEffect(() => {
    if (voiceState !== 'idle') setVoiceOpen(true);
    else if (!useVoiceStore.getState().error) setVoiceOpen(false);
  }, [voiceState]);

  // The employee route puts the fetch wrapper into employee mode. Coming back
  // here has to put it back.
  useEffect(() => {
    installOwnerAuth();
  }, []);

  // Spoken turns are already said and already saved by the time they arrive;
  // they only need to show up in the transcript alongside the typed ones.
  const handleTurn = useCallback(
    (role: 'user' | 'assistant', content: string) => {
      chatRef.current?.appendMessage(role, content);
    },
    [],
  );

  return (
    <div className="flex h-app flex-col bg-bg px-safe">
      <VoiceController ref={voiceRef} token={accessToken} onTurn={handleTurn} />

      {/* One slim bar instead of a title row above a tab row. The owner knows
          whose console this is, so the name and timezone bought nothing and
          cost a whole bar of height on a phone. Tabs below the desktop
          breakpoint; both panes are shown above it, where only sign-out
          remains. */}
      <div className="flex items-center border-b border-line bg-surface pt-safe">
        <ViewTabs active={tab} onChange={setTab} className="flex-1 lg:hidden" />

        <button
          type="button"
          onClick={() => void logout()}
          aria-label="Sign out"
          className="tap ml-auto flex shrink-0 items-center justify-center px-16 text-faint transition-colors duration-150 ease-out hover:text-ink"
        >
          <LogOut size={18} aria-hidden="true" />
        </button>
      </div>

      {voiceError ? (
        <p className="border-b border-line bg-surface px-16 py-8 text-13 text-muted">
          {voiceError}
        </p>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 lg:flex-row">
        {/* min-w-0 on both: a flex item defaults to min-width:auto, which lets
            the calendar's horizontally-scrolling grid push its own column
            wider than the phone and carry the week controls off-screen. */}
        <div
          className={[
            'min-h-0 min-w-0 flex-1 lg:flex lg:w-[420px] lg:flex-none lg:border-r lg:border-line',
            tab === 'chat' ? 'flex' : 'hidden lg:flex',
          ].join(' ')}
        >
          <div className="min-h-0 w-full min-w-0">
            <ChatPane
              ref={chatRef}
              token={accessToken}
              greeting="Morning, boss. What do you need?"
              composerPlaceholder="Message Luna"
              composerLeading={
                supported ? (
                  <MicOrb
                    onToggle={() => {
                      // Opens the line if it is closed, and always brings up
                      // the voice surface — the small orb is the way in.
                      if (useVoiceStore.getState().state === 'idle') {
                        voiceRef.current?.toggle();
                      }
                      setVoiceOpen(true);
                    }}
                    disabled={permission === 'denied'}
                  />
                ) : null
              }
            />
          </div>
        </div>

        <div
          className={[
            'min-h-0 min-w-0 flex-1',
            tab === 'calendar' ? 'flex' : 'hidden lg:flex',
          ].join(' ')}
        >
          <div className="min-h-0 w-full min-w-0">
            <WeekView onSelectMeeting={setSelected} />
          </div>
        </div>
      </div>

      {voiceOpen ? (
        <VoiceOverlay
          onClose={() => {
            voiceRef.current?.stop();
            setVoiceOpen(false);
          }}
          onHoldStart={() => voiceRef.current?.startTalking()}
          onHoldEnd={() => voiceRef.current?.stopTalking()}
        />
      ) : null}

      {selected ? (
        <MeetingDetail meeting={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}
