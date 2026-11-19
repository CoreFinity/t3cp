#!/usr/bin/env python3
"""t3cp record runner: the event log's prune mark in a kept run's database, read-only.

usage: prune-mark.py --db <statev2.sqlite> --end-ms <epoch ms>

Prints one JSON object: {value, reason, detail: {mark_updated_at, end_at}}. value is the mark's age at end-ms past
the one retained day, in days, floored at 0 and rounded to 0.1: max(0, (end - mark.updated_at) / 86,400 s - 1).
A database without the mark (no event-log-prune-mark row, or no metadata table) gives value null with the reason
no_event_prune; one that cannot be opened gives null with db_unreadable; a mark whose updated_at is not a timestamp
gives null with mark_unreadable. The database is opened read-only (SQLite URI mode=ro): the run's file is never
written, and a write-ahead log the server left is read, not checkpointed. Exit 0 whenever the JSON is printed.
"""
import argparse
import datetime
import json
import math
import pathlib
import sqlite3
import sys

MARK = "event-log-prune-mark"
DAY_MS = 86_400_000


def iso_ms(ms):
    """Epoch ms as JavaScript's Date.toISOString() writes it: UTC, milliseconds, Z."""
    at = datetime.datetime.fromtimestamp(ms // 1000, tz=datetime.timezone.utc)
    return at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def parse_iso(text):
    """An ISO 8601 timestamp (a trailing Z included) as epoch ms, or None."""
    if not isinstance(text, str):
        return None
    try:
        at = datetime.datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=datetime.timezone.utc)
    return at.timestamp() * 1000


def read_mark(db):
    """(updated_at or None, reason or None)."""
    uri = pathlib.Path(db).resolve().as_uri() + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error:
        return None, "db_unreadable"
    try:
        row = conn.execute(
            "SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name = ?", (MARK,)
        ).fetchone()
    except sqlite3.OperationalError as error:
        if "no such table" in str(error):
            return None, "no_event_prune"
        return None, "db_unreadable"
    except sqlite3.Error:
        return None, "db_unreadable"
    finally:
        conn.close()
    if row is None:
        return None, "no_event_prune"
    return row[0], None


def measure(db, end_ms):
    detail = {"mark_updated_at": None, "end_at": iso_ms(end_ms)}
    if not pathlib.Path(db).is_file():
        return {"value": None, "reason": "db_unreadable", "detail": detail}
    updated_at, reason = read_mark(db)
    if reason is not None:
        return {"value": None, "reason": reason, "detail": detail}
    detail["mark_updated_at"] = updated_at
    mark_ms = parse_iso(updated_at)
    if mark_ms is None:
        return {"value": None, "reason": "mark_unreadable", "detail": detail}
    days = max(0.0, (end_ms - mark_ms) / DAY_MS - 1)
    return {"value": math.floor(days * 10 + 0.5) / 10, "reason": None, "detail": detail}


def main(argv):
    parser = argparse.ArgumentParser(description="the event log's prune mark, read-only")
    parser.add_argument("--db", required=True)
    parser.add_argument("--end-ms", required=True, type=int)
    args = parser.parse_args(argv)
    sys.stdout.write(json.dumps(measure(args.db, args.end_ms)) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
