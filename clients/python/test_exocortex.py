"""Tests against clients/testing/fake-daemon.ts: python3 -m unittest -v test_exocortex (needs bun)."""

import asyncio
import os
import json
import shutil
import socket as _socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exocortex  # noqa: E402
from exocortex import ExocortexError, Tool  # noqa: E402

FAKE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "testing", "fake-daemon.ts")
DOCTOR = '{"ok":false,"problems":[{"id":"daemon","severity":"error","message":"The daemon is not running.","fix":"exocortexd start"}]}'
SCHEMA = {"type": "object", "properties": {"word": {"type": "string"}}, "required": ["word"]}


class Fake:
    def __init__(self, *args: str):
        self.dir = tempfile.mkdtemp(prefix="exo-client-py-")
        self.socket = os.path.join(self.dir, "d.sock")
        self.proc = subprocess.Popen(["bun", FAKE, "--socket", self.socket, *args],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        timer = threading.Timer(5, self.proc.kill)
        timer.start()
        line = self.proc.stdout.readline().decode()
        timer.cancel()
        if not line.startswith("ready"):
            self.stop()
            raise RuntimeError("fake daemon did not start")

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        for pipe in (self.proc.stdin, self.proc.stdout):
            if pipe:
                pipe.close()
        shutil.rmtree(self.dir, ignore_errors=True)


def admin(fake: "Fake", command: dict) -> None:
    """Send a test-only command (fake_restart, fake_drop) on a connection of its own."""
    sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    sock.connect(fake.socket)
    sock.sendall((json.dumps(command) + "\n").encode())
    time.sleep(0.05)
    sock.close()


def lookup(handler, **kw) -> Tool:
    return Tool("lookup", "Look a word up.", SCHEMA, handler, **kw)


class Base(unittest.TestCase):
    fake_args: tuple = ()

    def setUp(self) -> None:
        self.fake = Fake(*self.fake_args)
        self.clients = []

    def tearDown(self) -> None:
        for c in self.clients:
            c.close()
        self.fake.stop()

    def client(self, **kw) -> exocortex.Client:
        c = exocortex.connect("test-app", socket=self.fake.socket, **kw)
        self.clients.append(c)
        return c


class OneShot(Base):
    def test_run_module_level(self):
        result = exocortex.run("hello", app="test-app", socket=self.fake.socket, system="Be brief.")
        self.assertEqual(result.text, "echo: hello")
        self.assertEqual(result.stop_reason, "end_turn")
        self.assertGreater(result.usage["outputTokens"], 0)
        self.assertEqual(self.client().list(), [])

    def test_app_tools(self):
        c = self.client()
        seen = []

        def handler(args):
            seen.append(args)
            return args["word"] + ": a small blue frog"

        self.assertEqual(c.run('tool lookup {"word":"zorp"}', tools=[lookup(handler)]).text, "lookup -> zorp: a small blue frog")
        self.assertEqual(seen, [{"word": "zorp"}])
        self.assertEqual(c.run('tool lookup {"word":"x"}', tools=[lookup(lambda a, call: {"count": 2})]).text, 'lookup -> {"count": 2}')

        @exocortex.tool("Look a word up.", SCHEMA)
        def lookup_deco(args):  # noqa: ARG001
            raise ValueError("boom")

        lookup_deco.name = "lookup"
        self.assertEqual(c.run('tool lookup {"word":"x"}', tools=[lookup_deco]).text, "lookup error -> boom")
        flagged = c.run('tool lookup {"word":"x"}', tools=[lookup(lambda a: {"output": "nope", "isError": True})])
        self.assertEqual(flagged.text, "lookup error -> nope")

    def test_run_stream(self):
        c = self.client()
        stream = c.run_stream('tool lookup {"word":"a"}', tools=[lookup(lambda a: "b")])
        events = list(stream)
        self.assertEqual([e.type for e in events], ["tool_call", "tool_result", "text", "text"])
        self.assertEqual("".join(e.text for e in events if e.type == "text"), stream.result().text)

    def test_errors(self):
        c = self.client()
        failed = c.run("fail")
        self.assertEqual((failed.stop_reason, failed.error), ("error", "fake failure"))
        with self.assertRaisesRegex(ExocortexError, "teleport"):
            c.run("hi", builtin=["teleport"])


class Conversations(Base):
    def test_send_stream_abort(self):
        c = self.client()
        conv = c.conversation("temporary", title="t", model="m1")
        self.assertEqual(conv.info["lifetime"], "temporary")
        self.assertEqual(conv.send("count").text, "turns: 1")
        self.assertEqual("".join(conv.stream("count").text()), "turns: 2")
        hanging = conv.stream("hang")
        for event in hanging:
            if event.type == "text":
                break
        conv.abort()
        self.assertEqual(hanging.result(5).stop_reason, "aborted")
        with self.assertRaisesRegex(ExocortexError, "Already streaming"):
            busy = conv.stream("hang")
            conv.send("again")
        conv.abort()
        busy.result(5)

    def test_tool_timeout_cancels(self):
        c = self.client()
        reasons = []

        def slow(args, call):
            call.cancelled.wait(5)
            reasons.append(call.reason)
            return "late"

        conv = c.conversation("ephemeral", tools=[lookup(slow, timeout_ms=150)])
        self.assertEqual(conv.send('tool lookup {"word":"x"}').text, "lookup error -> lookup timed out")
        self.assertEqual(reasons, ["timeout"])

    def test_saved_attach_list_delete(self):
        first = self.client()
        conv = first.conversation("saved", builtin=["read"], tools=[lookup(lambda a: "one")])
        self.assertEqual(conv.send('tool lookup {"word":"x"}').text, "lookup -> one")
        first.close()
        second = self.client()
        self.assertEqual(second.list(), [])
        self.assertEqual([i["convId"] for i in second.list(include_saved=True)], [conv.id])
        again = second.attach(conv.id, tools=[lookup(lambda a: "two")])
        self.assertEqual(again.send('tool lookup {"word":"x"}').text, "lookup -> two")
        self.assertEqual(again.send("count").text, "turns: 3")
        again.delete()
        self.assertEqual(again.ended, "deleted")
        self.assertEqual(second.list(include_saved=True), [])
        with self.assertRaisesRegex(ExocortexError, "ended"):
            again.send("hi")

    def test_ephemeral_ends_with_connection(self):
        owner, watcher = self.client(), self.client()
        conv = owner.conversation("ephemeral")
        self.assertEqual([i["convId"] for i in watcher.list()], [conv.id])
        with self.assertRaisesRegex(ExocortexError, "ephemeral"):
            watcher.attach(conv.id)
        owner.close()
        for _ in range(50):
            if not watcher.list():
                break
            time.sleep(0.02)
        self.assertEqual(watcher.list(), [])

    def test_asyncio(self):
        c = self.client()
        conv = c.conversation("temporary")

        async def main():
            r = await conv.asend("count")
            pieces = [e.text async for e in conv.astream("count") if e.type == "text"]
            return r.text, "".join(pieces)

        self.assertEqual(asyncio.run(main()), ("turns: 1", "turns: 2"))
        self.assertEqual(asyncio.run(exocortex.arun("hi", app="test-app", socket=self.fake.socket)).text, "echo: hi")


class Reconnect(Base):
    def test_restart_mid_turn(self):
        c = self.client()
        calls = []
        conv = c.conversation("temporary", tools=[lookup(lambda a: calls.append(a) or "got " + a["word"])])
        result = conv.send('restart tool lookup {"word":"w"}', timeout=15)
        self.assertEqual(result.text, "lookup -> got w")
        self.assertEqual(len(calls), 1)
        self.assertIsNotNone(result.turn_id)
        self.assertEqual(conv.send("count").text, "turns: 2")

    def test_ephemeral_survives_restart(self):
        c = self.client()
        session = c.session
        self.assertTrue(session)
        conv = c.conversation("ephemeral")
        self.assertEqual(conv.send("restart echo", timeout=15).text, "echo: echo")
        self.assertEqual(c.session, session)
        self.assertEqual(conv.send("count").text, "turns: 2")
        # A one-shot run rides a restart too.
        self.assertEqual(c.run("restart again", timeout=15).text, "echo: again")

    def test_requests_and_sends_wait_while_reconnecting(self):
        c = self.client()
        conv = c.conversation("ephemeral")
        admin(self.fake, {"type": "fake_restart", "downMs": 600})
        time.sleep(0.1)
        self.assertEqual(conv.send("count", timeout=15).text, "turns: 1")
        self.assertEqual([i["convId"] for i in c.list()], [conv.id])
        fresh = c.conversation("temporary")
        admin(self.fake, {"type": "fake_drop"})
        self.assertEqual(fresh.send("count", timeout=15).text, "turns: 1")

    def test_dropped_connection_keeps_ephemeral_and_tool_calls(self):
        c = self.client()
        answered = []

        def slow(args, call):
            time.sleep(0.3)
            answered.append(args["word"])
            return "kept " + args["word"]

        conv = c.conversation("ephemeral", tools=[lookup(slow)])
        turn = conv.stream('tool lookup {"word":"q"}')
        time.sleep(0.1)
        admin(self.fake, {"type": "fake_drop"})
        self.assertEqual(turn.result(15).text, "lookup -> kept q")
        self.assertEqual(answered, ["q"])

    def test_crash_loses_conversations_and_reruns_runs(self):
        c = self.client()
        conv = c.conversation("ephemeral")
        hanging = conv.stream("hang")
        time.sleep(0.1)
        calls = []

        def crash_once(args):
            calls.append(args)
            if len(calls) == 1:
                admin(self.fake, {"type": "fake_restart", "crash": True, "downMs": 200})
                time.sleep(0.2)
                return "too late"
            return "second try"

        result = c.run('tool lookup {"word":"x"}', tools=[lookup(crash_once)], timeout=15)
        self.assertEqual(result.text, "lookup -> second try")
        self.assertEqual(len(calls), 2)
        with self.assertRaises(ExocortexError) as caught:
            hanging.result(15)
        self.assertEqual(caught.exception.code, "lost")
        self.assertEqual(conv.ended, "lost")

    def test_route_and_billing_fields(self):
        c = self.client()
        conv = c.conversation("temporary", route={"credits": "never", "whenLimited": "error"})
        self.assertEqual(conv.info["route"], {"credits": "never", "whenLimited": "error"})


class EndedWhileAway(Base):
    fake_args = ("--refuse-after-restart-ms", "400")

    def test_resolves_from_attach(self):
        conv = self.client().conversation("saved")
        result = conv.send("restart echo quick", timeout=15)
        self.assertEqual(result.text, "echo: echo quick")
        self.assertIsNotNone(result.turn_id)


class EndedWhileAwayLost(Base):
    """A daemon from before sessions: nothing is sent again, a result it did not keep is lost."""

    fake_args = ("--refuse-after-restart-ms", "400", "--no-owner-results", "--no-sessions")

    def test_reported_lost(self):
        conv = self.client().conversation("saved")
        with self.assertRaises(ExocortexError) as caught:
            conv.send("restart echo quick", timeout=15)
        self.assertEqual(caught.exception.code, "result_lost")
        self.assertEqual(conv.send("count").text, "turns: 2")

    def test_ephemeral_lost_on_restart(self):
        c = self.client()
        conv = c.conversation("ephemeral")
        with self.assertRaises(ExocortexError) as caught:
            conv.send("restart echo", timeout=15)
        self.assertEqual(caught.exception.code, "lost")
        self.assertEqual(c.run("after", timeout=15).text, "echo: after")


class Connecting(unittest.TestCase):
    def test_version_mismatch(self):
        fake = Fake("--api-version", "2")
        try:
            with self.assertRaises(ExocortexError) as caught:
                exocortex.connect("test-app", socket=fake.socket)
            self.assertEqual(caught.exception.code, "incompatible")
        finally:
            fake.stop()

    def test_too_old(self):
        fake = Fake("--no-welcome")
        try:
            with self.assertRaises(ExocortexError) as caught:
                exocortex.connect("test-app", socket=fake.socket, welcome_timeout=0.2)
            self.assertEqual(caught.exception.code, "too_old")
            self.assertIn(exocortex.INSTALL_COMMAND, str(caught.exception))
        finally:
            fake.stop()

    def test_discovery(self):
        fake = Fake()
        saved = dict(os.environ)
        try:
            os.environ["EXOCORTEX_SOCKET"] = fake.socket
            self.assertEqual(exocortex.find_socket(), fake.socket)
            del os.environ["EXOCORTEX_SOCKET"]
            os.environ["PATH"] = fake.dir
            with self.assertRaises(ExocortexError) as caught:
                exocortex.find_socket()
            self.assertEqual(caught.exception.code, "not_installed")
            self.assertIn(exocortex.INSTALL_COMMAND, str(caught.exception))
            script = os.path.join(fake.dir, "exocortexd")
            with open(script, "w") as f:
                f.write(f'#!/bin/sh\n[ "$1" = socket ] && echo {fake.socket}\n')
            os.chmod(script, 0o755)
            self.assertEqual(exocortex.find_socket(), fake.socket)
            with exocortex.connect("test-app") as c:
                self.assertEqual(c.welcome["instance"], "fake")
            with open(script, "w") as f:
                f.write(f'#!/bin/sh\n[ "$1" = socket ] && echo {fake.dir}/gone.sock\n[ "$1" = doctor ] && echo \'' + DOCTOR + "'\nexit 0\n")
            with self.assertRaises(ExocortexError) as caught:
                exocortex.connect("test-app")
            self.assertEqual(caught.exception.code, "not_running")
            self.assertIn("The daemon is not running. Fix: exocortexd start", str(caught.exception))
        finally:
            os.environ.clear()
            os.environ.update(saved)
            fake.stop()

    def test_not_running(self):
        fake = Fake()
        fake.stop()
        with self.assertRaises(ExocortexError) as caught:
            exocortex.connect("test-app", socket=fake.socket)
        self.assertEqual(caught.exception.code, "not_running")


if __name__ == "__main__":
    unittest.main()
