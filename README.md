# Luna

Luna is a mobile-first conversational scheduling assistant with separate boss
and employee experiences.

Employees use a private username link to chat and view their meetings. Rafi,
the team boss, signs in to chat, uses voice input, and manages the entire team
calendar.

The system uses React and TypeScript, FastAPI, PostgreSQL, SQLAlchemy, Alembic,
OpenRouter chat and speech, and browser speech recognition. Luna books meetings
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
- Persistent chat history and streamed OpenRouter responses
- Calendar tool-calling: Luna reads meetings, checks a time, and books it
- Conflict detection offering real free slots inside working hours
- Read-back and explicit confirmation before anything is written
- The attendee is messaged automatically when a meeting is booked
- Spoken wall-clock times resolved in the caller's timezone, stored as UTC
- Environment-configurable chat model, speech model, and female voice
- Press-and-hold browser speech recognition and MP3 response playback
- Meeting creation, conflict detection, cancellation, and rescheduling
- Mobile-first Chat/Calendar workspaces with local HTTPS support

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
│   │   └── services/        # OpenRouter chat and voice
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
