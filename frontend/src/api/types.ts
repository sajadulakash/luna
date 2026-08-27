// §5 of the brief, verbatim. When FastAPI is real, regenerate from its
// OpenAPI schema and diff against this — differences are bugs on one side
// or the other. Do not edit to make the frontend compile.

export type Role = 'BOSS' | 'EMPLOYEE';
export type MeetingStatus = 'CONFIRMED' | 'CANCELLED';
export type BookedVia = 'VOICE' | 'CHAT' | 'OWNER';

export type ConflictReason =
  | 'booked'          // someone already has it
  | 'outside_hours'   // beyond working hours
  | 'too_soon'        // inside the minimum-notice window
  | 'blackout'        // lunch, holiday, focus block
  | 'day_full';       // daily meeting cap reached

export interface Person {
  id: string;
  team_id: string;
  name: string;
  role: Role;
}

export interface Meeting {
  id: string;
  title: string;
  notes: string | null;
  start_at: string;        // ISO 8601 UTC — "2026-08-25T10:30:00Z"
  end_at: string;
  status: MeetingStatus;
  booked_via: BookedVia;
  requested_by: { id: string; name: string } | null;
}

export interface Slot {
  start: string;           // ISO 8601 UTC
  end: string;
  label: string;           // server-rendered in viewer's tz: "Tuesday at 2:00 PM"
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  slots?: Slot[];          // present when Luna is offering times
  conflict?: ConflictReason;
}

export interface Policy {
  default_duration_min: number;
  buffer_min: number;
  min_notice_hours: number;
  max_days_ahead: number;
  max_meetings_per_day: number;
  slot_granularity_min: number;
}

export interface ApiError {
  error: string;           // machine-readable: "invalid_token", "rate_limited"
  message: string;         // human-readable, safe to show
}

// --- Request / response envelopes for the endpoints in §5 -------------------

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  expires_in: number;
  user: Person;
}

export interface RefreshResponse {
  access_token: string;
  expires_in: number;
}

export interface CreateMeetingRequest {
  start: string;                  // ISO 8601 UTC
  duration_minutes: number;
  title: string;
  notes?: string;
}

/** The body of a 409 from POST /api/meetings. A normal outcome, not an error. */
export interface ConflictResponse {
  error: 'conflict';
  reason: ConflictReason;
  alternatives: Slot[];
}

export interface RescheduleRequest {
  start: string;
}

export interface CancelRequest {
  reason?: string;
}
