"""Backend→renderer questions are JSON-RPC requests (id + method); the renderer answers with a response
frame. Replaces the ``_block`` / ``*.respond`` / ``*.expire`` correlation layer (#110521)."""

import json
import threading

import pytest

from tui_gateway import server_requests as sr


@pytest.fixture(autouse=True)
def _clean_registry():
    sr._reset_for_tests()
    yield
    sr._reset_for_tests()


class _Sink:
    def __init__(self):
        self.frames: list[dict] = []

    def __call__(self, frame: dict) -> bool:
        self.frames.append(json.loads(json.dumps(frame)))
        return True


def _run_in_thread(fn):
    box = {}
    t = threading.Thread(target=lambda: box.__setitem__("result", fn()), daemon=True)
    t.start()
    return t, box


def _wait_for_frame(sink, predicate, timeout=2.0):
    deadline = threading.Event()
    for _ in range(int(timeout / 0.01)):
        for f in sink.frames:
            if predicate(f):
                return f
        deadline.wait(0.01)
    raise AssertionError(f"no frame matched; got {sink.frames}")


def test_request_frame_has_srq_id_and_result_returns_to_caller():
    sink = _Sink()
    t, box = _run_in_thread(lambda: sr.server_request("clarify.request", "s1", {"question": "?"}, timeout=5, write=sink))
    req = _wait_for_frame(sink, lambda f: f.get("method") == "clarify.request")
    assert req["jsonrpc"] == "2.0"
    assert isinstance(req["id"], str) and req["id"].startswith("srq-")
    assert req["params"] == {"session_id": "s1", "question": "?"}

    handled = sr.handle_client_frame({"jsonrpc": "2.0", "id": req["id"], "result": {"answer": "yes"}})
    assert handled is True
    t.join(2)
    assert box["result"] == sr.Answer(result={"answer": "yes"}, timed_out=False, cancelled=False)


def test_timeout_emits_request_cancel_and_returns_timed_out():
    sink = _Sink()
    answer = sr.server_request("secret.request", "s1", {"name": "X"}, timeout=0, write=sink)
    assert answer.timed_out is True and answer.result is None
    req = next(f for f in sink.frames if f.get("method") == "secret.request")
    cancel = next(f for f in sink.frames if f.get("method") == "request.cancel")
    assert "id" not in cancel
    assert cancel["params"] == {"session_id": "s1", "id": req["id"], "reason": "timeout"}
    assert sr.open_requests("s1") == []


def test_unknown_response_id_is_dropped_not_raised():
    assert sr.handle_client_frame({"jsonrpc": "2.0", "id": "srq-nope", "result": {}}) is False
    assert sr.handle_client_frame({"jsonrpc": "2.0", "id": 42, "result": {}}) is False


def test_error_response_settles_as_error():
    sink = _Sink()
    t, box = _run_in_thread(lambda: sr.server_request("tour.request", "s1", {}, timeout=5, write=sink))
    req = _wait_for_frame(sink, lambda f: f.get("method") == "tour.request")
    sr.handle_client_frame({"jsonrpc": "2.0", "id": req["id"], "error": {"code": 4009, "message": "no window"}})
    t.join(2)
    assert box["result"].result is None
    assert box["result"].error == {"code": 4009, "message": "no window"}


def test_open_requests_lists_unanswered_for_session_only():
    sink = _Sink()
    t1, _ = _run_in_thread(lambda: sr.server_request("clarify.request", "s1", {"question": "a"}, timeout=5, write=sink))
    t2, _ = _run_in_thread(lambda: sr.server_request("sudo.request", "s2", {}, timeout=5, write=sink))
    _wait_for_frame(sink, lambda f: f.get("method") == "sudo.request")
    _wait_for_frame(sink, lambda f: f.get("method") == "clarify.request")

    open_s1 = sr.open_requests("s1")
    assert [o["method"] for o in open_s1] == ["clarify.request"]
    assert open_s1[0]["params"] == {"session_id": "s1", "question": "a"}
    assert open_s1[0]["id"].startswith("srq-")
    assert [o["method"] for o in sr.open_requests("s2")] == ["sudo.request"]

    sr.cancel_open("s1", reason="interrupt", write=sink)
    sr.cancel_open("s2", reason="interrupt", write=sink)
    t1.join(2), t2.join(2)


def test_cancel_open_releases_waiters_with_cancelled_and_emits_cancel_only_for_that_session():
    sink = _Sink()
    t1, b1 = _run_in_thread(lambda: sr.server_request("clarify.request", "s1", {}, timeout=5, write=sink))
    t2, b2 = _run_in_thread(lambda: sr.server_request("clarify.request", "s2", {}, timeout=5, write=sink))
    _wait_for_frame(sink, lambda f: f.get("method") == "clarify.request" and f["params"]["session_id"] == "s2")
    _wait_for_frame(sink, lambda f: f.get("method") == "clarify.request" and f["params"]["session_id"] == "s1")

    sr.cancel_open("s1", reason="interrupt", write=sink)
    t1.join(2)
    assert b1["result"].cancelled is True and b1["result"].result is None
    cancels = [f for f in sink.frames if f.get("method") == "request.cancel"]
    assert [c["params"]["session_id"] for c in cancels] == ["s1"]
    assert t2.is_alive()
    sr.cancel_open(None, reason="shutdown", write=sink)
    t2.join(2)
    assert b2["result"].cancelled is True


def test_progress_notification_accumulates_partial_answers_and_survives_timeout():
    sink = _Sink()
    t, box = _run_in_thread(lambda: sr.server_request(
        "clarify.request", "s1", {"questions": [{"qid": "q0"}, {"qid": "q1"}]}, timeout=0.3, write=sink))
    req = _wait_for_frame(sink, lambda f: f.get("method") == "clarify.request")
    assert sr.handle_client_frame({"jsonrpc": "2.0", "method": "clarify.progress",
                                   "params": {"id": req["id"], "question_id": "q0", "answer": "A"}}) is True
    assert sr.open_requests("s1")[0]["partial"] == {"q0": "A"}
    t.join(2)
    assert box["result"].timed_out is True
    assert box["result"].partial == {"q0": "A"}


def test_reply_frames_route_to_the_transport_that_sent_the_request(monkeypatch):
    """No explicit ``write``: frames go through server.write_json (session transport, then context, then stdio)."""
    seen = []
    import tui_gateway.server as server
    monkeypatch.setattr(server, "write_json", lambda obj: seen.append(obj) or True)
    answer = sr.server_request("window.read.request", "s9", {}, timeout=0)
    assert answer.timed_out
    assert [f.get("method") for f in seen] == ["window.read.request", "request.cancel"]
