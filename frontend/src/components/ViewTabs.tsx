import { CalendarDays, MessageSquare } from 'lucide-react';

export type ViewTab = 'chat' | 'calendar';

interface ViewTabsProps {
  active: ViewTab;
  onChange: (tab: ViewTab) => void;
  className?: string;
}

/** Shared Chat/Calendar navigation for owner and employee views. */
export function ViewTabs({ active, onChange, className = '' }: ViewTabsProps) {
  return (
    <nav className={`flex ${className}`} aria-label="View">
      <TabButton
        active={active === 'chat'}
        onClick={() => onChange('chat')}
        icon={<MessageSquare size={16} aria-hidden="true" />}
        label="Chat"
      />
      <TabButton
        active={active === 'calendar'}
        onClick={() => onChange('calendar')}
        icon={<CalendarDays size={16} aria-hidden="true" />}
        label="Calendar"
      />
    </nav>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={[
        'tap flex flex-1 items-center justify-center gap-8 text-13',
        'border-b-2 transition-colors duration-150 ease-out',
        active ? 'border-accent text-ink' : 'border-transparent text-muted',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}
