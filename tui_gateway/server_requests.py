"""Backend→renderer questions as JSON-RPC requests.

The backend sends ``{"id": "srq-N", "method": ..., "params": ...}`` and blocks until a response frame
with that id arrives. Ids carry the ``srq-`` prefix so they never collide with the renderer's own
request ids on the same socket. One registry holds every open question, including questions a
compute-host child owns: those are mirrored here with a ``forward`` so a reply from the renderer
travels to the child instead of settling locally, and ``open_requests`` has one source.
"""

from __future__ import annotations

import dataclasses
import itertools
import threading
from typing import Any, Callable, Literal

_ID_PREFIX = "srq-"
CANCEL_METHOD = "request.cancel"
PROGRESS_METHOD = "clarify.progress"

Write = Callable[[dict], bool]
Outcome = Literal["answered", "error", "timeout", "cancelled"]


@dataclasses.dataclass(frozen=True)
class Answer:
    kind: Outcome
    result: dict = dataclasses.field(default_factory=dict)
    partial: dict[str, str] = dataclasses.field(default_factory=dict)

    @property
    def answered(self) -> bool:
        return self.kind == "answered"


@dataclasses.dataclass
class _Open:
    sid: str
    method: str
    params: dict
    event: threading.Event
    # Set for questions a compute-host child owns: renderer replies go there, not to ``event``.
    forward: Write | None = None
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


def _params(frame: dict) -> dict:
    raw = frame.get("params")
    return raw if isinstance(raw, dict) else {}


def _cancel_frame(sid: str, rid: str, reason: str) -> dict:
    return {"jsonrpc": "2.0", "method": CANCEL_METHOD, "params": {"session_id": sid, "id": rid, "reason": reason}}


def server_request(method: str, sid: str, params: dict, *, timeout: float | None = 300,
                   write: Write | None = None) -> Answer:
    """Ask the renderer and block until its response, a timeout, or a cancel. ``timeout=None`` waits
    until answered or cancelled; ``0`` returns after sending (probe shape used by the tour bridge)."""
    write = write or _default_write
    rid = f"{_ID_PREFIX}{next(_ids)}"
    entry = _Open(sid=sid, method=method, params=dict(params), event=threading.Event())
    with _lock:
        _open[rid] = entry
    write({"jsonrpc": "2.0", "id": rid, "method": method, "params": {"session_id": sid, **entry.params}})
    answered = entry.event.wait(timeout)
    with _lock:
        _open.pop(rid, None)
    partial = dict(entry.partial)
    if entry.cancelled:
        return Answer("cancelled", partial=partial)
    if not answered:
        write(_cancel_frame(sid, rid, "timeout"))
        return Answer("timeout", partial=partial)
    if entry.error is not None:
        return Answer("error", result=entry.error, partial=partial)
    return Answer("answered", result=entry.result or {}, partial=partial)


def mirror_open(frame: dict, *, forward: Write) -> None:
    """Register a question a compute-host child sent through the parent, so it appears in
    ``open_requests`` and the renderer's reply is forwarded to the child."""
    params = _params(frame)
    entry = _Open(sid=str(params.get("session_id") or ""), method=str(frame["method"]),
                  params={k: v for k, v in params.items() if k != "session_id"},
                  event=threading.Event(), forward=forward)
    with _lock:
        _open[str(frame["id"])] = entry


def _is_reply(frame: dict) -> bool:
    return ("method" not in frame and isinstance(frame.get("id"), str) and frame["id"].startswith(_ID_PREFIX)
            and ("result" in frame or "error" in frame))


def take(frame: Any) -> bool:
    """The one classifier for inbound frames that belong to this layer: a response to an ``srq-`` id, a
    ``clarify.progress`` lock, or a relayed ``request.cancel`` for a mirrored question. Returns False
    for anything else (the RPC method table owns it) and for replies to ids no longer open."""
    if not isinstance(frame, dict):
        return False
    method = frame.get("method")
    if method == PROGRESS_METHOD:
        params = _params(frame)
        with _lock:
            entry = _open.get(str(params.get("id") or ""))
            if entry is None:
                return True
            entry.partial[str(params.get("question_id") or "")] = str(params.get("answer") or "")
            forward = entry.forward
        if forward is not None:
            forward(frame)
        return True
    if method == CANCEL_METHOD:
        # A child's cancel relayed through the parent: drop the mirror; the frame still goes to the renderer.
        rid = str(_params(frame).get("id") or "")
        with _lock:
            if (entry := _open.get(rid)) is not None and entry.forward is not None:
                _open.pop(rid, None)
        return False
    if not _is_reply(frame):
        return False
    with _lock:
        entry = _open.get(frame["id"])
        if entry is None:
            return True
        if entry.forward is not None:
            _open.pop(frame["id"], None)
        elif isinstance(frame.get("error"), dict):
            entry.error = frame["error"]
            entry.event.set()
        else:
            entry.result = frame.get("result") if isinstance(frame.get("result"), dict) else {}
            entry.event.set()
        forward = entry.forward
    if forward is not None:
        forward(frame)
    return True


def open_requests(sid: str) -> list[dict]:
    """Unanswered requests for *sid*, in send order, in the shape ``session.events.since`` returns."""
    with _lock:
        return [{"id": rid, "method": e.method, "params": {"session_id": e.sid, **e.params}, "partial": dict(e.partial)}
                for rid, e in _open.items() if e.sid == sid]


def open_kind(sid: str) -> str:
    """Method name of the oldest unanswered request for *sid*, ``""`` when none (session status)."""
    with _lock:
        return next((e.method for e in _open.values() if e.sid == sid), "")


def cancel_open(sid: str | None, *, reason: str, write: Write | None = None) -> int:
    """Release local waiters with ``cancelled`` and drop mirrored entries: only *sid*'s, or every one
    when *sid* is None (shutdown). Sends ``request.cancel`` per released request so live cards close."""
    write = write or _default_write
    with _lock:
        targets = [(rid, e) for rid, e in _open.items() if sid is None or e.sid == sid]
        for rid, e in targets:
            e.cancelled = True
            e.event.set()
            if e.forward is not None:
                _open.pop(rid, None)
    for rid, e in targets:
        write(_cancel_frame(e.sid, rid, reason))
    return len(targets)


def _reset_for_tests() -> None:
    with _lock:
        for e in _open.values():
            e.cancelled = True
            e.event.set()
        _open.clear()


__all__ = ["Answer", "CANCEL_METHOD", "PROGRESS_METHOD", "cancel_open", "mirror_open", "open_kind",
           "open_requests", "server_request", "take"]
