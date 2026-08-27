"""Non-persistent scheduling defaults and date helpers."""

from datetime import datetime, timedelta, timezone


POLICIES = {
    "default_duration_min": 30,
    "buffer_min": 10,
    "min_notice_hours": 4,
    "max_days_ahead": 30,
    "max_meetings_per_day": 6,
    "slot_granularity_min": 15,
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def fake_slots(duration_minutes: int = 30) -> list[dict[str, str]]:
    base = utc_now().replace(minute=0, second=0, microsecond=0)
    slots: list[dict[str, str]] = []
    for hours, label in (
        (26, "Tomorrow at 2:00 PM"),
        (28, "Tomorrow at 4:00 PM"),
        (50, "The following day at 2:00 PM"),
    ):
        start = base + timedelta(hours=hours)
        slots.append(
            {
                "start": iso(start),
                "end": iso(start + timedelta(minutes=duration_minutes)),
                "label": label,
            }
        )
    return slots
