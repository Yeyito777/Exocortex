"""App API resilience end to end, with the Python reference client (what batch jobs use).

PHASE=restart: an ephemeral one-shot run whose app tool call is pending, a temporary
conversation streaming (its stream must show every integer exactly once), an ephemeral
multi-turn conversation, and a message queued on an ephemeral conversation mid-turn all ride
a graceful restart of the test daemon; a send made while the daemon is down waits and completes.
PHASE=drop: the client's connection drops mid-reply; after the reconnect the turn catch-up
completes the stream with every integer exactly once.
PHASE=credits: with every Claude account marked limited (EXOCORTEX_DEV_CLAUDE_ROUTING),
app turns fall back to API credits like ordinary ones and say so; route credits=never
fails fast (whenLimited=error) or waits (default).

Env: SOCKET, SCRATCH (restart-now / restarted marker files), CLIENT_DIR.
"""

import os
import re
import socket as _socket
import sys
import threading
import time
import uuid

sys.path.insert(0, os.environ["CLIENT_DIR"])
import exocortex  # noqa: E402
from exocortex import Tool  # noqa: E402

SOCKET = os.environ["SOCKET"]
SCRATCH = os.environ["SCRATCH"]
RESTART_NOW = os.path.join(SCRATCH, "restart-now")
RESTARTED = os.path.join(SCRATCH, "restarted")
MODEL = dict(provider="anthropic", model="claude-haiku-5-5", effort="low")
failures = 0


def check(ok, label, detail=None):
    global failures
    print(("  ok   " if ok else "  FAIL ") + label + ("" if ok or detail is None else f": {str(detail)[:600]}"), flush=True)
    if not ok:
        failures += 1


def wait_for(path, seconds=300):
    deadline = time.time() + seconds
    while time.time() < deadline and not os.path.exists(path):
        time.sleep(0.05)
    return os.path.exists(path)


def integers_once(text, n):
    """The stream showed 1..n, each exactly once, in order, and nothing else."""
    return [int(x) for x in re.findall(r"\d+", text)] == list(range(1, n + 1))


def stream_text(events):
    return "".join(e.text or "" for e in events if e.type == "text")


def turn_text(result):
    return "".join(b.get("text", "") for b in (result.raw.get("blocks") or []) if b.get("type") == "text")


def restart_phase():
    client = exocortex.connect("e2e-resilience", socket=SOCKET, reconnect_timeout=300)
    session = client.session
    check(bool(session), f"app_welcome gave a session ({session})")
    welcomes = []
    client.on_event(lambda e: welcomes.append(e) if e.get("type") == "app_welcome" else None)

    memory = client.conversation("ephemeral", system="You are a terse test bot. Follow instructions exactly.", **MODEL)
    first = memory.send("Remember the number 7461. Reply with just: OK", timeout=300)
    check(first.stop_reason == "end_turn", f"ephemeral conversation: first turn ({first.text!r})", first.raw)
    streaming = client.conversation("temporary", idle_ttl_ms=600_000, system="Follow instructions exactly.", **MODEL)

    calls = []
    queued_ready = threading.Event()
    streamed_enough = threading.Event()

    def step(_args, call):
        calls.append(call)
        if len(calls) > 1:
            return "marmalade"
        # The harness restarts the daemon while this call is pending: like any tool call it is
        # interrupted (app_tool_cancel), and the replayed turn sees that and calls it again.
        # It waits for the streaming turn to be part way through its reply.
        queued_ready.wait(300)
        streamed_enough.wait(120)
        open(RESTART_NOW, "w").close()
        wait_for(RESTARTED)
        time.sleep(1.0)
        return "too late"

    results = {}

    def run_job():
        try:
            results["run"] = client.run(
                "Call the step tool, then reply with exactly the word it returned and nothing else. "
                "If a call is interrupted, call it again.",
                system="Follow instructions exactly.", tools=[Tool("step", "Returns a secret word.",
                                                                    {"type": "object", "properties": {}}, step)],
                timeout=600, **MODEL)
        except Exception as error:  # noqa: BLE001
            results["run"] = error

    # An ephemeral conversation mid-turn with a message queued for after the turn (memory only,
    # handed over at the restart): after the replayed turn the queued one runs.
    holds = []
    holding = threading.Event()

    def hold(_args, call):
        holds.append(call)
        if len(holds) > 1:
            return "fig"
        holding.set()
        wait_for(RESTARTED)
        time.sleep(1.0)
        return "too late"

    queued = client.conversation("ephemeral", system="Follow instructions exactly.",
                                 tools=[Tool("hold", "Returns a word.", {"type": "object", "properties": {}}, hold)], **MODEL)
    queued_results = []
    client.on_event(lambda e: queued_results.append(e) if e.get("type") == "turn_result" and e.get("convId") == queued.id else None)

    def queued_job():
        try:
            pending = queued.stream("Call the hold tool, then reply with exactly the word it returned and nothing else. "
                                    "If a call is interrupted, call it again.")
            if not holding.wait(300):
                raise RuntimeError("the hold tool was never called")
            client.request({"type": "queue_message", "convId": queued.id, "text": "Reply with just the word: plum",
                            "timing": "message-end", "queueId": f"e2e-{uuid.uuid4().hex}"}, lambda e: e.get("type") == "ack")
            queued_ready.set()
            results["held"] = pending.result(600)
        except Exception as error:  # noqa: BLE001
            queued_ready.set()
            results["held"] = error

    stream_events = []
    shown_when_down = []

    def stream_job():
        try:
            live = streaming.stream("Write the integers from 1 to 300 separated by single spaces and nothing else.")
            for event in live:
                stream_events.append(event)
                if len(stream_text(stream_events)) > 60:
                    streamed_enough.set()
            results["stream"] = live.result(600)
        except Exception as error:  # noqa: BLE001
            results["stream"] = error
        streamed_enough.set()

    def watch_down():
        # How much of the reply the stream had shown when the daemon went away.
        deadline = time.time() + 300
        while time.time() < deadline and client._connected.is_set():
            time.sleep(0.005)
        shown_when_down.append(len(stream_text(stream_events)))

    def down_job():
        # Sent while the daemon is down: it waits for the reconnection, then runs on the handed-over history.
        wait_for(RESTART_NOW)
        deadline = time.time() + 60
        while time.time() < deadline and client._connected.is_set():
            time.sleep(0.01)
        results["down_while_sent"] = not client._connected.is_set()
        try:
            results["memory"] = memory.send("What number did I ask you to remember? Reply with just the number.", timeout=600)
        except Exception as error:  # noqa: BLE001
            results["memory"] = error

    threads = [threading.Thread(target=job) for job in (run_job, stream_job, down_job, queued_job, watch_down)]
    started = time.time()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(900)

    run = results.get("run")
    check(isinstance(run, exocortex.TurnResult) and run.stop_reason == "end_turn" and "marmalade" in run.text.lower(),
          f"one-shot ephemeral run with a tool call pending across the restart completed ({getattr(run, 'text', run)!r})",
          getattr(run, "raw", run))
    check(len(calls) == 2 and calls[0].cancelled.is_set() and calls[0].reason == "aborted",
          f"its pending app tool call was cancelled by the restart and called again ({len(calls)} calls, "
          f"first {calls[0].reason if calls else None})")
    stream = results.get("stream")
    check(isinstance(stream, exocortex.TurnResult) and stream.stop_reason == "end_turn" and "300" in stream.text,
          f"temporary conversation's turn completed ({sum(1 for e in stream_events if e.type == 'text')} text deltas)",
          getattr(stream, "raw", stream))
    shown = stream_text(stream_events)
    down = shown_when_down[0] if shown_when_down else None
    check(down is not None and 0 < down < len(shown),
          f"the restart came mid-reply: its stream had shown {down} of {len(shown)} characters")
    check(not any(e.type == "reset" for e in stream_events) and integers_once(shown, 300),
          f"its stream across the restart showed 1..300 exactly once ({shown[:40]!r}…{shown[-40:]!r})")
    if isinstance(stream, exocortex.TurnResult):
        check(shown == turn_text(stream), "and exactly the turn's text (turn_result.blocks)", turn_text(stream)[:300])
    memory_result = results.get("memory")
    check(results.get("down_while_sent") is True, "a send was made while the daemon was down")
    check(isinstance(memory_result, exocortex.TurnResult) and "7461" in memory_result.text,
          f"ephemeral conversation kept its history across the restart ({getattr(memory_result, 'text', memory_result)!r})",
          getattr(memory_result, "raw", memory_result))
    held = results.get("held")
    check(isinstance(held, exocortex.TurnResult) and "fig" in held.text.lower(),
          f"an ephemeral conversation's turn with a message queued behind it completed ({getattr(held, 'text', held)!r})",
          getattr(held, "raw", held))
    deadline = time.time() + 300
    while time.time() < deadline and not any("plum" in (e.get("text") or "").lower() for e in queued_results):
        time.sleep(0.1)
    check(any("plum" in (e.get("text") or "").lower() for e in queued_results),
          f"the message queued on it before the restart ran after it ({[e.get('text') for e in queued_results]})")
    resumed = [w for w in welcomes if w.get("resumed")]
    check(bool(resumed) and client.session == session,
          f"the client reconnected under the same session (resumed welcome, owns {len(resumed[-1].get('conversations', [])) if resumed else 0})")
    print(f"  (restart phase took {time.time() - started:.1f}s)", flush=True)

    streaming.delete()
    client.close()  # end_app_session: the ephemeral conversation ends now
    with exocortex.connect("e2e-resilience", socket=SOCKET) as other:
        check(other.list() == [], "closing the client ended its ephemeral conversation at once", other.list())


def drop_phase():
    """The client's connection drops mid-reply (the daemon stays up): the reconnect's turn
    catch-up completes the stream, every integer exactly once."""
    client = exocortex.connect("e2e-resilience", socket=SOCKET, reconnect_timeout=300)
    check(client.welcome.get("turnCatchup") is True, "the daemon sends this client turn catch-ups")
    conv = client.conversation("ephemeral", system="Follow instructions exactly.", **MODEL)
    welcomes = []
    client.on_event(lambda e: welcomes.append(e) if e.get("type") == "app_welcome" else None)
    raw = []
    client.on_event(lambda e: raw.append(e.get("type")) if e.get("convId") == conv.id else None)
    stream = conv.stream("Write the integers from 1 to 300 separated by single spaces and nothing else.")
    events, dropped_at = [], None
    for event in stream:
        events.append(event)
        if dropped_at is None and len(stream_text(events)) > 60:
            dropped_at = len(stream_text(events))
            client._sock.shutdown(_socket.SHUT_RDWR)  # the connection drops mid-reply
    result = stream.result(300)
    shown = stream_text(events)
    check(dropped_at is not None and dropped_at < len(shown),
          f"the connection dropped mid-reply (after {dropped_at} of {len(shown)} characters)")
    check(any(w.get("resumed") for w in welcomes) and "turn_catchup" in raw,
          f"the client took its session back and was caught up ({raw.count('turn_catchup')} catch-up(s))")
    check(not any(e.type == "reset" for e in events) and integers_once(shown, 300),
          f"the stream showed 1..300 exactly once ({shown[:30]!r}…{shown[-30:]!r})")
    check(shown == turn_text(result), "and exactly the turn's text (turn_result.blocks)", turn_text(result)[:300])
    client.close()


def crash_phase():
    """A crash (SIGKILL): nothing is handed over. The one-shot run starts over on a new
    conversation (rerun_lost); a multi-turn ephemeral conversation is reported lost."""
    client = exocortex.connect("e2e-resilience", socket=SOCKET, reconnect_timeout=300)
    memory = client.conversation("ephemeral", system="You are a terse test bot.", **MODEL)
    memory.send("Remember the number 3318. Reply with just: OK", timeout=300)
    calls = []

    def step(_args, call):
        calls.append(call)
        if len(calls) > 1:
            return "quince"
        open(RESTART_NOW, "w").close()  # the harness kills the daemon now
        wait_for(RESTARTED)
        return "too late"

    result = client.run("Call the step tool, then reply with exactly the word it returned and nothing else.",
                        system="Follow instructions exactly.", tools=[Tool("step", "Returns a secret word.", {"type": "object", "properties": {}}, step)],
                        timeout=600, **MODEL)
    check(result.stop_reason == "end_turn" and "quince" in result.text.lower() and len(calls) == 2,
          f"after a crash the one-shot run started over and completed ({result.text!r}, {len(calls)} tool calls)", result.raw)
    check(result.conv_id != "" and memory.ended == "lost", f"the multi-turn ephemeral conversation is reported lost ({memory.ended})")
    try:
        memory.send("What number?", timeout=30)
        check(False, "sending to a lost conversation fails")
    except exocortex.ExocortexError as error:
        check(error.code == "ended" and "lost" in str(error), f"sending to a lost conversation fails clearly ({error})")
    client.close()


def credits_phase():
    client = exocortex.connect("e2e-resilience", socket=SOCKET)
    events = []
    result = client.run("Reply with just the word ok.", on_event=events.append, timeout=300, **MODEL)
    notices = [e.get("route") for e in events if e.get("type") == "system_message" and e.get("route")]
    check(result.stop_reason == "end_turn" and result.billing == "api-credits",
          f"default route: the turn ran on API credits (billing={result.billing})", result.raw)
    check(any(n.get("kind") == "api_credits" for n in notices), f"the app saw the API-credits notice as an event ({notices})")

    started = time.time()
    refused = client.run("Reply with just the word ok.", route={"credits": "never", "whenLimited": "error"}, timeout=120, **MODEL)
    check(refused.stop_reason == "error" and refused.limited is not None and time.time() - started < 60,
          f"credits never + whenLimited error: failed fast ({time.time() - started:.1f}s, limited={refused.limited})", refused.raw)
    check(refused.billing is None, "and nothing ran on credits")

    waits = []
    conv = client.conversation("ephemeral", route={"credits": "never"}, **MODEL)

    def on_event(event):
        if event.get("type") == "connection_wait_status" and event.get("active"):
            waits.append(event)

    pending = conv.stream("Reply with just the word ok.", on_event=on_event)
    deadline = time.time() + 60
    while time.time() < deadline and not waits:
        time.sleep(0.05)
    check(bool(waits) and waits[0].get("reason") == "usage_limit", f"credits never (default wait): waits for a usage limit ({waits[:1]})")
    conv.abort()
    check(pending.result(60).stop_reason == "aborted", "and an abort ends the wait")
    info = conv.info
    check(info.get("route") == {"credits": "never"}, f"the conversation reports its route ({info.get('route')})")
    client.close()


if __name__ == "__main__":
    {"restart": restart_phase, "drop": drop_phase, "crash": crash_phase, "credits": credits_phase}[os.environ["PHASE"]]()
    sys.exit(1 if failures else 0)
