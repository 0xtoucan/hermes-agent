"""Backend→renderer JSON-RPC requests.

``srq-`` ids avoid client-id collisions. Timeouts and interrupts send ``request.cancel`` so clients close
cards; unanswered requests remain available to reconnecting clients.
"""

from __future__ import annotations

import dataclasses
import itertools
import threading
from typing import Any, Callable

_ID_PREFIX = "srq-"
CANCEL_METHOD = "request.cancel"
PROGRESS_METHOD = "clarify.progress"

Write = Callable[[dict], bool]


@dataclasses.dataclass(frozen=True)
class Answer:
    result: dict | None = None
    error: dict | None = None
    timed_out: bool = False
    cancelled: bool = False
    partial: dict[str, str] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass
class _Open:
    sid: str
    method: str
    params: dict
    event: threading.Event
    result: dict | None = None
    error: dict | None = None
    cancelled: bool = False
    partial: dict[str, str] = dataclasses.field(default_factory=dict)


_lock = threading.Lock()
_open: dict[str, _Open] = {}
_ids = itertools.count(1)


def _default_write(frame: dict) -> bool:
    from tui_gateway.server import write_json
    return write_json(frame)


def _cancel_frame(sid: str, rid: str, reason: str) -> dict:
    return {"jsonrpc": "2.0", "method": CANCEL_METHOD, "params": {"session_id": sid, "id": rid, "reason": reason}}


def server_request(method: str, sid: str, params: dict, *, timeout: float | None = 300,
                   write: Write | None = None) -> Answer:
    """``None`` waits until cancelled or answered; ``0`` sends without waiting."""
    write = write or _default_write
    rid = f"{_ID_PREFIX}{next(_ids)}"
    entry = _Open(sid=sid, method=method, params=dict(params), event=threading.Event())
    with _lock:
        _open[rid] = entry
    write({"jsonrpc": "2.0", "id": rid, "method": method, "params": {"session_id": sid, **entry.params}})
    answered = entry.event.wait(timeout)
    with _lock:
        _open.pop(rid, None)
    if not answered and not entry.cancelled:
        write(_cancel_frame(sid, rid, "timeout"))
        return Answer(timed_out=True, partial=dict(entry.partial))
    return Answer(result=entry.result, error=entry.error, cancelled=entry.cancelled, partial=dict(entry.partial))


def handle_client_frame(frame: dict) -> bool:
    """Unknown and expired response ids must fall through without a protocol error."""
    if not isinstance(frame, dict):
        return False
    rid = frame.get("id")
    method = frame.get("method")
    if method == PROGRESS_METHOD:
        raw = frame.get("params")
        params: dict = raw if isinstance(raw, dict) else {}
        with _lock:
            entry = _open.get(str(params.get("id") or ""))
            if entry is None:
                return False
            entry.partial[str(params.get("question_id") or "")] = str(params.get("answer") or "")
        return True
    if method is not None or not isinstance(rid, str) or not rid.startswith(_ID_PREFIX):
        return False
    with _lock:
        entry = _open.get(rid)
        if entry is None:
            return False
        if isinstance(frame.get("error"), dict):
            entry.error = frame["error"]
        else:
            entry.result = frame.get("result") if isinstance(frame.get("result"), dict) else {}
        entry.event.set()
    return True


def open_requests(sid: str) -> list[dict]:
    """Preserve send order for reconnect replay."""

    with _lock:
        return [{"id": rid, "method": e.method, "params": {"session_id": e.sid, **e.params}, "partial": dict(e.partial)}
                for rid, e in _open.items() if e.sid == sid]


def open_kind(sid: str) -> str:
    with _lock:
        return next((e.method for e in _open.values() if e.sid == sid), "")


def cancel_open(sid: str | None, *, reason: str, write: Write | None = None) -> int:
    """Send ``request.cancel`` so live cards close."""
    write = write or _default_write
    with _lock:
        targets = [(rid, e) for rid, e in _open.items() if sid is None or e.sid == sid]
        for _rid, e in targets:
            e.cancelled = True
            e.event.set()
    for rid, e in targets:
        write(_cancel_frame(e.sid, rid, reason))
    return len(targets)


def _reset_for_tests() -> None:
    with _lock:
        for e in _open.values():
            e.cancelled = True
            e.event.set()
        _open.clear()


__all__ = ["Answer", "CANCEL_METHOD", "PROGRESS_METHOD", "cancel_open", "handle_client_frame", "open_kind",
           "open_requests", "server_request"]
