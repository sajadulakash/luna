# Luna

Luna is a mobile-first conversational scheduling assistant with separate boss
and employee experiences.

Employees use a private username link to chat and view their meetings. Rafi,
the team boss, signs in to chat, uses voice input, and manages the entire team
calendar.

The system uses React and TypeScript, FastAPI, PostgreSQL, SQLAlchemy, Alembic,
OpenAI chat and the Realtime API for voice. Luna books meetings
herself through calendar tool-calling: she reads the team calendar, checks a
time, books it, and messages the person she booked it with.

## Demo

## Quick Start

```bash
[ -f .env ] || cp .env.example .env
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python setup_database.py
.venv/bin/uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```

## Features

- PostgreSQL persistence for teams, users, messages, and meetings
- Alembic database migrations with automatic model-difference detection
- One boss per team enforced by the database
- Username/password boss login with hashed passwords and a development session
- Username-based private employee chat links
- Team-scoped boss calendar and employee-scoped calendars
- Persistent chat history and streamed OpenAI responses
- Calendar tool-calling: Luna reads meetings, checks a time, and books it
- Conflict detection offering real free slots inside working hours
- Read-back and explicit confirmation before anything is written
- The attendee is messaged automatically when a meeting is booked
- Spoken wall-clock times resolved in the caller's timezone, stored as UTC
- Environment-configurable chat, realtime, transcription and voice
- Speech-to-speech voice mode over WebRTC — one model hears and answers
- She greets you when the line opens, varying with the time of day
- Hold the orb (or the spacebar) to talk; the mic is muted between turns
- Hold while she is speaking to interrupt her
- Voice tools and transcripts are executed and stored server-side
- The browser gets a short-lived session key, never the API key
- Voice works in Chrome, Edge, Safari and Firefox, on desktop and mobile
- Meeting creation, conflict detection, cancellation, and rescheduling
- Mobile-first Chat/Calendar workspaces with local HTTPS support

## Voice

Voice is the OpenAI Realtime API, not a transcribe-think-speak relay. The
browser holds a WebRTC connection straight to OpenAI, so one model hears the
microphone and answers over the same connection — which is why it can be
interrupted mid-sentence and why it ends your turn on whether a thought sounds
finished rather than on a silence timer.

Audio never touches this server. Three things still do, because all three need
authority the browser does not have:

| Endpoint | Why it is server-side |
| --- | --- |
| `POST /api/voice/realtime/session` | Mints a short-lived key. The prompt, voice and tools are fixed here, so a tampered browser can spend the session but not widen it. |
| `POST /api/voice/realtime/tool` | The model asks the browser to run a tool; the browser relays it here, where the actor is the authenticated user rather than whatever the model named. |
| `POST /api/voice/realtime/transcript` | Spoken turns are written into the same history the text chat reads, so Luna does not forget a call the moment it ends. |

The microphone is muted except while the orb (or the spacebar) is held, so
nothing is transmitted between turns. Releasing commits the turn manually —
there is a short grace period first, because audio and the commit travel over
different transports and the commit would otherwise overtake the last word of
your sentence.

Opening the line is answered out loud, with a greeting suited to the time of
day where you are. The line is chosen on the server, not asked for in the
prompt: every call is a fresh session with no memory of the last, so "vary your
greeting" is an instruction the model cannot follow — asked four times in a row
it returns the same sentence four times.

Voice and text share one system prompt and one set of tools, derived from the
same definitions, so the two cannot drift apart.

### Tuning for the room

The defaults assume one person speaking English into a phone or a headset. All
five are environment variables; none needs changing to work.

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENAI_VOICE_LANGUAGE` | `en` | Pins what the transcriber may hear. Left to guess, it reads accented or noisy English as Bengali or Hindi. Luna's replies are locked to this language in the prompt as well. |
| `OPENAI_NOISE_REDUCTION` | `near_field` | `near_field` for a headset or a phone held close; `far_field` for a laptop across the desk, where the room is loud relative to the voice. |
| `OPENAI_VAD` | `push_to_talk` | How a turn ends. `push_to_talk` disables automatic turn-taking — nothing is a turn until the button says so. `server_vad` gates on loudness, `semantic_vad` on whether a thought sounds finished. |
| `OPENAI_VAD_EAGERNESS` | `low` | `semantic_vad` only: `low`/`medium`/`high`/`auto`. Lower waits longer before deciding you have finished. |
| `OPENAI_VAD_THRESHOLD` | `0.75` | `server_vad` only. Higher ignores more. The API's own default is `0.5`. |

`push_to_talk` is the default because it is the only setting that survives
**other people talking nearby**. A threshold filters on level, which deals with
hum, traffic and clatter — but a voice detector is built to find voices, so no
threshold separates yours from theirs, only one high enough to miss both. With
push-to-talk the microphone is muted between holds, so the room reaches nothing
and costs nothing.

In a quiet room `OPENAI_VAD=server_vad` gives the hands-free conversation back,
and `semantic_vad` reads turn-endings best of the three when there is no noise
to confuse it.

## Database

The development database has four tables:

```text
teams
└── users
    ├── messages
    └── meetings
```

A meeting names two people. `user_id` is whose calendar it sits on, and
`created_by_id` is who arranged it. When Rafi books time with Rakib, the meeting
belongs to Rakib's calendar while still crediting Rafi as the requester.

`setup_database.py` is repeatable. It creates the database when missing,
upgrades it to the latest Alembic revision, and inserts or refreshes the dummy
data.

Development access:

| Name | Username | Password | Role | Access |
| --- | --- | --- | --- | --- |
| Rafi | `rafi` | `luna123` | Boss | `/login` |
| Rakib | `rakib` | `luna123` | Employee | `/chat/rakib` |
| Nabila | `nabila` | `luna123` | Employee | `/chat/nabila` |
| Tanvir | `tanvir` | `luna123` | Employee | `/chat/tanvir` |

```bash
.venv/bin/alembic -c alembic.ini revision --autogenerate -m "describe change"
.venv/bin/alembic -c alembic.ini upgrade head
.venv/bin/alembic -c alembic.ini current
```

## Project Structure

```text
luna/
├── alembic/                 # Database migration history
│   └── versions/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI routes and the tool-calling loop
│   │   ├── tools.py         # Calendar tools Luna is allowed to call
│   │   ├── models.py        # Database table definitions
│   │   ├── database.py      # PostgreSQL connection
│   │   ├── seed.py          # Development dummy data
│   │   └── services/        # OpenAI chat and realtime voice
│   └── requirements.txt     # Python dependencies
├── frontend/
│   ├── src/
│   │   ├── api/             # Calls to the backend
│   │   ├── features/        # Chat, calendar, and voice
│   │   ├── routes/          # Login, boss, and employee pages
│   │   └── stores/          # Frontend application state
│   └── package.json         # Frontend dependencies and commands
├── .env.example             # Environment-variable template
├── alembic.ini              # Alembic configuration
├── setup_database.py        # Creates, migrates, and seeds the database
└── README.md
```

Local-only folders such as `.venv`, `node_modules`, certificates, caches, and
the real `.env` file are intentionally excluded from this tree and from Git.
