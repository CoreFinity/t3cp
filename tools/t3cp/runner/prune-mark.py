#!/usr/bin/env python3
"""t3cp record runner: the event log's prune mark in a kept run's database, read-only; or set before a try.

usage: prune-mark.py --db <statev2.sqlite> --end-ms <epoch ms>
       prune-mark.py --db <statev2.sqlite> --set-age-days <n> --now-ms <epoch ms>

Prints one JSON object: {value, reason, detail: {mark_updated_at, end_at}}. value is the mark's age at end-ms past
the one retained day, in days, floored at 0 and rounded to 0.1: max(0, (end - mark.updated_at) / 86,400 s - 1).
A database without the mark (no event-log-prune-mark row, or no metadata table) gives value null with the reason
no_event_prune; one that cannot be opened gives null with db_unreadable; a mark whose updated_at is not a timestamp
gives null with mark_unreadable. The database is opened read-only (SQLite URI mode=ro): the run's file is never
written, and a write-ahead log the server left is read, not checkpointed. Exit 0 whenever the JSON is printed.

--set-age-days (the runner, on the migrated fixture before each try of a cell that names mark_age_days): the mark's
updated_at becomes now-ms minus n days, so the try starts with a mark of the row's age whenever the record runs. A
fixture without a mark gets one as the server writes it: the projections' schema version (the thread-projections
row's), the event log's head as last_sequence, and that updated_at; an existing mark keeps its last_sequence. Prints
{set, inserted, reason, mark_updated_at}. A database without projection metadata or an event log is left as it is
({set: false, reason: no_event_prune}). After the write the write-ahead log is checkpointed into the database file,
so a copy of that file alone (a restore) holds the mark. Exit 1, with set false and reason db_unwritable (or
db_unreadable), if it cannot be written.
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


def has_tables(db, names):
    """Whether every table in names exists, read-only; None if the database cannot be read."""
    uri = pathlib.Path(db).resolve().as_uri() + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
        try:
            found = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    return all(name in found for name in names)


def set_age(db, days, now_ms):
    """Dates the mark days before now_ms, in place, writing it if the fixture has none."""
    out = {"set": False, "inserted": False, "reason": None, "mark_updated_at": None}
    if not pathlib.Path(db).is_file():
        return {**out, "reason": "db_unreadable"}, 1
    metadata = has_tables(db, ["orchestration_v2_projection_metadata"])
    if metadata is None:
        return {**out, "reason": "db_unreadable"}, 1
    if not metadata:
        return {**out, "reason": "no_event_prune"}, 0
    # An existing mark is re-dated; a missing one is written only where there is an event log to cover.
    events = has_tables(db, ["orchestration_events"])
    at = iso_ms(now_ms - days * DAY_MS)
    try:
        conn = sqlite3.connect(db)
        try:
            with conn:
                updated = conn.execute(
                    "UPDATE orchestration_v2_projection_metadata SET updated_at = ? WHERE projection_name = ?", (at, MARK)
                ).rowcount
                inserted = False
                if updated == 0:
                    if not events:
                        return {**out, "reason": "no_event_prune"}, 0
                    version = conn.execute(
                        "SELECT COALESCE((SELECT schema_version FROM orchestration_v2_projection_metadata"
                        " WHERE projection_name = 'thread-projections'),"
                        " (SELECT MAX(schema_version) FROM orchestration_v2_projection_metadata))"
                    ).fetchone()[0]
                    if version is None:
                        return {**out, "reason": "no_event_prune"}, 0
                    head = conn.execute("SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events").fetchone()[0]
                    conn.execute(
                        "INSERT INTO orchestration_v2_projection_metadata"
                        " (projection_name, schema_version, last_sequence, updated_at) VALUES (?, ?, ?, ?)",
                        (MARK, version, head, at),
                    )
                    inserted = True
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return {**out, "reason": "db_unwritable"}, 1
    return {**out, "set": True, "inserted": inserted, "mark_updated_at": at}, 0


def main(argv):
    parser = argparse.ArgumentParser(description="the event log's prune mark: read-only, or set before a try")
    parser.add_argument("--db", required=True)
    parser.add_argument("--end-ms", type=int)
    parser.add_argument("--set-age-days", type=int)
    parser.add_argument("--now-ms", type=int)
    args = parser.parse_args(argv)
    if args.set_age_days is not None:
        if args.now_ms is None or args.end_ms is not None or args.set_age_days < 1:
            parser.error("--set-age-days n (n >= 1) needs --now-ms, and no --end-ms")
        result, code = set_age(args.db, args.set_age_days, args.now_ms)
        sys.stdout.write(json.dumps(result) + "\n")
        return code
    if args.end_ms is None:
        parser.error("--end-ms is required")
    sys.stdout.write(json.dumps(measure(args.db, args.end_ms)) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
