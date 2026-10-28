"""Use the user's Exocortex daemon from a Python program (docs/app-api.md).

One module, standard library only, Python 3.9+. The API is synchronous
(a reader thread routes the daemon's events; app tool handlers run on a small
thread pool); ``arun``, ``Conversation.asend`` and ``Conversation.astream``
wrap it for asyncio.

    import exocortex
    print(exocortex.run("Name three primes.", app="myapp", system="Answer tersely.").text)
"""

import asyncio
import inspect
import itertools
import json
import os
import queue
import re
import socket as _socket
import subprocess
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as _FutureTimeout
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Optional, Union

__all__ = [
    "APP_API_VERSION", "INSTALL_COMMAND", "ExocortexError", "Tool", "tool", "TurnResult",
    "StreamEvent", "TurnStream", "Conversation", "Client", "connect", "run", "arun", "find_socket",
]

APP_API_VERSION = 1
INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Yeyito777/Exocortex/main/install.sh | bash"
_APP_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


class ExocortexError(Exception):
    """``code`` is one of not_installed, not_running, too_old, incompatible, daemon,
    disconnected, closed, ended, timeout, result_lost."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ── Tools ───────────────────────────────────────────────────────────────


@dataclass
class ToolCall:
    """What a handler may take as its second argument."""

    conv_id: str
    call_id: str
    name: str
    #: Set when the daemon cancels the call (turn aborted, timed out, conversation ended).
    cancelled: threading.Event = field(default_factory=threading.Event)
    reason: Optional[str] = None


@dataclass
class Tool:
    """A tool the app defines and answers. ``handler(input)`` or ``handler(input, call)``
    returns text, ``{"output": str, "isError": bool}``, or anything JSON-serializable;
    raising gives the model an error result."""

    name: str
    description: str
    input_schema: Dict[str, Any]
    handler: Callable[..., Any]
    timeout_ms: Optional[int] = None

    def wire(self) -> Dict[str, Any]:
        d = {"name": self.name, "description": self.description, "inputSchema": self.input_schema}
        if self.timeout_ms:
            d["timeoutMs"] = self.timeout_ms
        return d

    def call(self, args: Dict[str, Any], call: ToolCall) -> Any:
        try:
            params = [p for p in inspect.signature(self.handler).parameters.values()
                      if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)]
            takes_call = len(params) >= 2 or any(p.kind == p.VAR_POSITIONAL for p in params)
        except (TypeError, ValueError):
            takes_call = False
        return self.handler(args, call) if takes_call else self.handler(args)


def tool(description: str, schema: Optional[Dict[str, Any]] = None, name: Optional[str] = None,
         timeout_ms: Optional[int] = None) -> Callable[[Callable[..., Any]], Tool]:
    """Decorator: ``@exocortex.tool("Look a word up.", {"type": "object", ...})``."""

    def wrap(fn: Callable[..., Any]) -> Tool:
        return Tool(name or fn.__name__, description, schema or {"type": "object", "properties": {}}, fn, timeout_ms)

    return wrap


def _normalize_output(value: Any) -> Dict[str, Any]:
    if isinstance(value, str):
        return {"output": value, "isError": False}
    if isinstance(value, dict) and isinstance(value.get("output"), str):
        return {"output": value["output"], "isError": bool(value.get("isError") or value.get("is_error"))}
    if value is None:
        return {"output": "", "isError": False}
    return {"output": json.dumps(value), "isError": False}


# ── Results and streams ─────────────────────────────────────────────────


@dataclass
class TurnResult:
    conv_id: str
    text: str
    stop_reason: str  # end_turn | aborted | error
    error: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None
    turn_id: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_event(cls, event: Dict[str, Any]) -> "TurnResult":
        return cls(event.get("convId", ""), event.get("text") or "", event.get("stopReason", ""),
                   event.get("error"), event.get("usage"), event.get("turnId"), event)


@dataclass
class StreamEvent:
    """``type``: text, thinking, tool_call or tool_result."""

    type: str
    text: Optional[str] = None
    id: Optional[str] = None
    name: Optional[str] = None
    input: Optional[Dict[str, Any]] = None
    output: Optional[str] = None
    is_error: bool = False


_END = object()


class TurnStream:
    """Iterate for StreamEvents until the turn ends; ``result()`` waits for the TurnResult."""

    def __init__(self, future: "Future[TurnResult]"):
        self._future = future
        self._queue: "queue.Queue[Any]" = queue.Queue()
        future.add_done_callback(lambda _f: self._queue.put(_END))

    def _push(self, event: StreamEvent) -> None:
        self._queue.put(event)

    def __iter__(self) -> Iterator[StreamEvent]:
        while True:
            item = self._queue.get()
            if item is _END:
                self._queue.put(_END)
                self._future.result()  # raises the turn's error, if any
                return
            yield item

    def text(self) -> Iterator[str]:
        """Just the reply's text deltas."""
        for event in self:
            if event.type == "text":
                yield event.text or ""

    def result(self, timeout: Optional[float] = None) -> TurnResult:
        return self._future.result(timeout)


class _Turn:
    def __init__(self, req_id: str, conv_id: Optional[str], generation: int, on_event, run_tools=None):
        self.req_id = req_id
        self.conv_id = conv_id
        self.turn_id: Optional[str] = None
        self.generation = generation
        self.future: "Future[TurnResult]" = Future()
        self.on_event = on_event
        self.stream: Optional[TurnStream] = None
        self.run_tools = run_tools
        self.run_lifetime: Optional[str] = None
        self.fallback_timer: Optional[threading.Timer] = None


# ── Conversation ────────────────────────────────────────────────────────


class Conversation:
    """An app conversation this client owns."""

    def __init__(self, client: "Client", info: Dict[str, Any], tools: Optional[List[Tool]]):
        self._client = client
        self.id: str = info["convId"]
        #: How the daemon last reported it (AppConversationInfo).
        self.info: Dict[str, Any] = info
        #: Why it ended (deleted, expired, owner_disconnected, ...), or None while alive.
        self.ended: Optional[str] = None
        self._set_tools(tools)

    def _set_tools(self, tools: Optional[List[Tool]]) -> None:
        self.tools = tools
        self.handlers = {t.name: t for t in tools or []}

    def send(self, prompt: str, images: Optional[list] = None, on_event: Optional[Callable] = None,
             timeout: Optional[float] = None) -> TurnResult:
        """Send a prompt and wait for the turn's result."""
        return self._client._send_turn(self, prompt, images, on_event, stream=False).future.result(timeout)

    def stream(self, prompt: str, images: Optional[list] = None, on_event: Optional[Callable] = None) -> TurnStream:
        """Send a prompt and stream the reply."""
        return self._client._send_turn(self, prompt, images, on_event, stream=True).stream  # type: ignore[return-value]

    def abort(self) -> None:
        self._client.request({"type": "abort", "convId": self.id}, lambda e: e["type"] == "ack")

    def set_tools(self, tools: List[Tool]) -> None:
        """Replace the app tools (handlers and definitions) from the next turn on."""
        self._set_tools(tools)
        self._client._attach_existing(self)

    def delete(self) -> None:
        """Delete it for good."""
        self._client.delete(self.id)

    async def asend(self, prompt: str, **kwargs: Any) -> TurnResult:
        turn = self._client._send_turn(self, prompt, kwargs.get("images"), kwargs.get("on_event"), stream=False)
        return await asyncio.wrap_future(turn.future)

    async def astream(self, prompt: str, **kwargs: Any):
        """Async generator of StreamEvents."""
        stream = self.stream(prompt, kwargs.get("images"), kwargs.get("on_event"))
        iterator = iter(stream)
        loop = asyncio.get_running_loop()
        while True:
            item = await loop.run_in_executor(None, next, iterator, _END)
            if item is _END:
                return
            yield item


# ── Discovery ───────────────────────────────────────────────────────────


def find_socket() -> str:
    """$EXOCORTEX_SOCKET, else ``exocortexd socket``; raises a clear ExocortexError otherwise."""
    env = os.environ.get("EXOCORTEX_SOCKET", "").strip()
    if env:
        return env
    try:
        out = subprocess.run(["exocortexd", "socket"], capture_output=True, text=True, timeout=10)
    except FileNotFoundError:
        raise ExocortexError("not_installed", "Exocortex is not installed (no `exocortexd` on PATH). "
                             "Install it with:\n  " + INSTALL_COMMAND) from None
    path = out.stdout.strip()
    if out.returncode != 0:
        raise ExocortexError("not_running", "`exocortexd socket` failed: " + (out.stderr.strip() or f"exit {out.returncode}"))
    if not path:
        raise ExocortexError("not_running", "`exocortexd socket` printed nothing; is Exocortex installed correctly?")
    if not os.path.exists(path):
        raise ExocortexError("not_running", f"The Exocortex daemon is not running (no socket at {path}). Start it with: exocortexd start")
    return path


def _system(system: Union[str, Dict[str, Any], None], base: Optional[str]) -> Optional[Dict[str, Any]]:
    if system is None and base is None:
        return None
    spec = {"text": system} if isinstance(system, str) else dict(system or {})
    if base:
        spec["base"] = base
    return spec


def _create_fields(lifetime=None, idle_ttl_ms=None, title=None, system=None, base=None, builtin=None,
                   tools=None, provider=None, model=None, effort=None, cwd=None, conv_id=None) -> Dict[str, Any]:
    fields: Dict[str, Any] = {
        "lifetime": lifetime, "idleTtlMs": idle_ttl_ms, "title": title, "system": _system(system, base),
        "provider": provider, "model": model, "effort": effort, "cwd": cwd, "convId": conv_id,
    }
    if builtin is not None or tools:
        fields["tools"] = {k: v for k, v in (("builtin", builtin), ("app", [t.wire() for t in tools] if tools else None)) if v is not None}
    return {k: v for k, v in fields.items() if v is not None}


# ── Client ──────────────────────────────────────────────────────────────


class Client:
    """A connection to the daemon, declared as one app. Use ``connect()``."""

    def __init__(self, app: str, version: Optional[str] = None, socket: Optional[str] = None,
                 reconnect: bool = True, reconnect_timeout: float = 60.0, welcome_timeout: float = 5.0,
                 request_timeout: float = 30.0, tool_workers: int = 8):
        if not _APP_NAME.match(app or ""):
            raise ValueError(f"Invalid app name {app!r}: use lowercase letters, digits and dashes")
        self.app = app
        self.version = version
        self.welcome: Dict[str, Any] = {}
        self._socket_path = socket
        self._reconnect = reconnect
        self._reconnect_timeout = reconnect_timeout
        self._welcome_timeout = welcome_timeout
        self._request_timeout = request_timeout
        self._sock: Optional[_socket.socket] = None
        self._generation = 0
        self._ids = itertools.count(1)
        self._last_started_at = 0
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._closed = False
        self._reconnecting = False
        self._requests: Dict[str, Any] = {}  # reqId -> (match, Future)
        self._turns: Dict[str, _Turn] = {}
        self._conversations: Dict[str, Conversation] = {}
        self._calls: Dict[str, Dict[str, Any]] = {}  # callId -> {call, result, conv_id}
        self._listeners: List[Callable[[Dict[str, Any]], None]] = []
        self._pool = ThreadPoolExecutor(max_workers=tool_workers, thread_name_prefix=f"exocortex-{app}-tool")

    # ── connection ──

    def _open(self) -> None:
        if not self._socket_path:
            self._socket_path = find_socket()
        self._handshake()

    def _handshake(self) -> None:
        path = self._socket_path or ""
        sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        try:
            sock.connect(path)
        except (FileNotFoundError, ConnectionRefusedError):
            sock.close()
            raise ExocortexError("not_running", f"The Exocortex daemon is not running (cannot connect to {self._socket_path}). "
                                 "Start it with: exocortexd start") from None
        with self._lock:
            self._generation += 1
            generation = self._generation
            self._sock = sock
        ready = threading.Event()
        threading.Thread(target=self._reader, args=(sock, generation, ready), daemon=True,
                         name=f"exocortex-{self.app}-reader").start()
        caps = {"type": "client_capabilities", "capabilities": [], "app": {"name": self.app}}
        if self.version:
            caps["app"]["version"] = self.version
        try:
            welcome = self.request(caps, lambda e: e["type"] == "app_welcome", self._welcome_timeout)
        except ExocortexError as error:
            sock.close()
            if error.code == "timeout":
                raise ExocortexError("too_old", "The Exocortex daemon did not answer app_welcome: it is too old for the app API. "
                                     "Update it with:\n  " + INSTALL_COMMAND) from None
            raise
        if welcome.get("appApiVersion") != APP_API_VERSION:
            sock.close()
            v = welcome.get("appApiVersion")
            if isinstance(v, int) and v > APP_API_VERSION:
                msg = f"The Exocortex daemon speaks app API v{v}; this client knows v{APP_API_VERSION}. Update exocortex.py."
            else:
                msg = f"The Exocortex daemon speaks app API v{v}; this client needs v{APP_API_VERSION}. Update Exocortex:\n  {INSTALL_COMMAND}"
            raise ExocortexError("incompatible", msg)
        self.welcome = welcome
        ready.set()
        if self._sock is not sock:
            raise ExocortexError("disconnected", "The daemon closed the connection")

    def _reader(self, sock: _socket.socket, generation: int, ready: threading.Event) -> None:
        buffer = b""
        try:
            while True:
                data = sock.recv(65536)
                if not data:
                    break
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line.decode("utf-8"))
                    except ValueError:
                        continue
                    if isinstance(event, dict) and isinstance(event.get("type"), str):
                        try:
                            self._dispatch(event)
                        except Exception:  # a listener's bug must not kill the reader
                            import traceback
                            traceback.print_exc()
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass
        with self._lock:
            if self._sock is not sock:
                return
            self._sock = None
        if ready.is_set():
            self._on_close(generation)
        else:
            self._fail_requests(ExocortexError("disconnected", "The daemon closed the connection before app_welcome"))

    def close(self) -> None:
        """Close the connection. Ephemeral conversations end with it; saved and temporary ones stay."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            sock, self._sock = self._sock, None
        self._fail_all(ExocortexError("closed", "The client was closed"))
        if sock:
            try:
                sock.shutdown(_socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        self._pool.shutdown(wait=False)

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def on_event(self, listener: Callable[[Dict[str, Any]], None]) -> Callable[[], None]:
        """Call ``listener`` with every daemon event (on the reader thread). Returns an unsubscribe function."""
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    # ── requests ──

    def _next_id(self) -> str:
        return f"p{next(self._ids)}"

    def _next_started_at(self) -> int:
        """The prompt's time, unique per client: it is the turn's identity (turn_result.turnId)."""
        with self._lock:
            self._last_started_at = max(int(time.time() * 1000), self._last_started_at + 1)
            return self._last_started_at

    def _write(self, command: Dict[str, Any]) -> None:
        if self._closed:
            raise ExocortexError("closed", "The client was closed")
        sock = self._sock
        if sock is None:
            raise ExocortexError("disconnected", "Not connected to the Exocortex daemon (reconnecting)")
        data = (json.dumps(command) + "\n").encode("utf-8")
        with self._write_lock:
            try:
                sock.sendall(data)
            except OSError as error:
                raise ExocortexError("disconnected", f"Lost the connection to the Exocortex daemon: {error}") from None

    def _write_quietly(self, command: Dict[str, Any]) -> None:
        try:
            self._write(command)
        except ExocortexError:
            pass  # a re-attach re-sends unanswered calls

    def request(self, command: Dict[str, Any], match: Callable[[Dict[str, Any]], bool],
                timeout: Optional[float] = None) -> Dict[str, Any]:
        """Send a raw command; return the answer ``match`` accepts (or raise on an ``error`` with its reqId)."""
        req_id = command.get("reqId") or self._next_id()
        future: "Future[Dict[str, Any]]" = Future()
        with self._lock:
            self._requests[req_id] = (match, future)
        try:
            self._write({**command, "reqId": req_id})
            return future.result(self._request_timeout if timeout is None else timeout)
        except _FutureTimeout:  # the builtin TimeoutError from 3.11 on
            raise ExocortexError("timeout", f"No answer to {command['type']} within {timeout or self._request_timeout} s") from None
        finally:
            with self._lock:
                self._requests.pop(req_id, None)

    # ── public API ──

    def conversation(self, lifetime: Optional[str] = None, *, idle_ttl_ms: Optional[int] = None,
                     title: Optional[str] = None, system: Union[str, Dict[str, Any], None] = None,
                     base: Optional[str] = None, builtin: Union[List[str], str, None] = None,
                     tools: Optional[List[Tool]] = None, provider: Optional[str] = None,
                     model: Optional[str] = None, effort: Optional[str] = None, cwd: Optional[str] = None,
                     conv_id: Optional[str] = None) -> Conversation:
        """Create a conversation (``lifetime`` saved by default, or temporary/ephemeral)."""
        fields = _create_fields(lifetime, idle_ttl_ms, title, system, base, builtin, tools, provider, model, effort, cwd, conv_id)
        event = self.request({"type": "new_conversation", **fields}, lambda e: e["type"] == "conversation_created")
        conv = Conversation(self, event["app"], tools)
        with self._lock:
            self._conversations[conv.id] = conv
        return conv

    def attach(self, conv_id: str, tools: Optional[List[Tool]] = None) -> Conversation:
        """Own an existing saved or temporary conversation; ``tools`` replaces its app tools."""
        command: Dict[str, Any] = {"type": "attach_app_conversation", "convId": conv_id}
        if tools is not None:
            command["tools"] = {"app": [t.wire() for t in tools]}
        event = self.request(command, lambda e: e["type"] == "app_conversation_attached")
        with self._lock:
            conv = self._conversations.get(conv_id)
            if conv is None:
                conv = self._conversations[conv_id] = Conversation(self, event["conversation"], tools)
            else:
                conv.info = event["conversation"]
                if tools is not None:
                    conv._set_tools(tools)
        return conv

    def _attach_existing(self, conv: Conversation) -> Dict[str, Any]:
        command: Dict[str, Any] = {"type": "attach_app_conversation", "convId": conv.id}
        if conv.tools is not None:
            command["tools"] = {"app": [t.wire() for t in conv.tools]}
        event = self.request(command, lambda e: e["type"] == "app_conversation_attached")
        conv.info = event["conversation"]
        return event

    def run(self, prompt: str, lifetime: Optional[str] = None, *, keep: bool = False, images: Optional[list] = None,
            on_event: Optional[Callable] = None, timeout: Optional[float] = None, **options: Any) -> TurnResult:
        """One-shot: create (ephemeral by default), send, await. Takes ``conversation()``'s options."""
        return self._start_run(prompt, lifetime, keep, images, on_event, False, options).future.result(timeout)

    def run_stream(self, prompt: str, lifetime: Optional[str] = None, *, keep: bool = False,
                   images: Optional[list] = None, on_event: Optional[Callable] = None, **options: Any) -> TurnStream:
        return self._start_run(prompt, lifetime, keep, images, on_event, True, options).stream  # type: ignore[return-value]

    def list(self, include_saved: bool = False, all_apps: bool = False, app: Optional[str] = None) -> List[Dict[str, Any]]:
        """Live hidden app conversations (this app's unless ``all_apps``), plus saved ones with ``include_saved``."""
        command: Dict[str, Any] = {"type": "list_app_conversations"}
        if not all_apps:
            command["app"] = app or self.app
        if include_saved:
            command["includeSaved"] = True
        return self.request(command, lambda e: e["type"] == "app_conversations_list")["conversations"]

    def delete(self, conv_id: str) -> None:
        """Delete an app conversation for good."""
        self.request({"type": "delete_conversation", "convId": conv_id},
                     lambda e: e["type"] == "conversation_deleted" and e.get("convId") == conv_id)
        self._end_conversation(conv_id, "deleted")

    # ── turns ──

    def _send_turn(self, conv: Conversation, prompt: str, images, on_event, stream: bool) -> _Turn:
        if conv.ended:
            raise ExocortexError("ended", f"Conversation {conv.id} has ended ({conv.ended})")
        turn = _Turn(self._next_id(), conv.id, self._generation, on_event)
        started_at = self._next_started_at()
        turn.turn_id = str(started_at)
        if stream:
            turn.stream = TurnStream(turn.future)
        with self._lock:
            self._turns[turn.req_id] = turn
        command = {"type": "send_message", "reqId": turn.req_id, "convId": conv.id, "text": prompt,
                   "startedAt": started_at, "awaitResult": True}
        if images:
            command["images"] = images
        try:
            self._write(command)
        except ExocortexError:
            with self._lock:
                self._turns.pop(turn.req_id, None)
            raise
        return turn

    def _start_run(self, prompt, lifetime, keep, images, on_event, stream, options) -> _Turn:
        tools = options.get("tools")
        turn = _Turn(self._next_id(), None, self._generation, on_event, run_tools=tools)
        started_at = self._next_started_at()
        turn.turn_id = str(started_at)
        if stream:
            turn.stream = TurnStream(turn.future)
        fields = _create_fields(lifetime=lifetime, **options)
        command = {"type": "app_run", "reqId": turn.req_id, **fields, "prompt": prompt, "startedAt": started_at}
        if images:
            command["images"] = images
        if keep:
            command["keep"] = True
        with self._lock:
            self._turns[turn.req_id] = turn
        try:
            self._write(command)
        except ExocortexError:
            with self._lock:
                self._turns.pop(turn.req_id, None)
            raise
        return turn

    def _settle(self, turn: _Turn, outcome: Union[TurnResult, Exception]) -> None:
        with self._lock:
            if self._turns.pop(turn.req_id, None) is None:
                return
        if turn.fallback_timer:
            turn.fallback_timer.cancel()
        if isinstance(outcome, Exception):
            turn.future.set_exception(outcome)
        else:
            turn.future.set_result(outcome)

    # ── incoming ──

    def _dispatch(self, event: Dict[str, Any]) -> None:
        for listener in list(self._listeners):
            listener(event)
        etype = event["type"]
        req_id = event.get("reqId")
        with self._lock:
            turn = self._turns.get(req_id) if req_id else None
            request = self._requests.get(req_id) if req_id else None
        if turn is not None and turn.generation == self._generation:
            if etype == "error":
                return self._settle(turn, ExocortexError("daemon", event.get("message", "error")))
            if etype == "conversation_created" and turn.conv_id is None:
                conv = Conversation(self, event["app"], turn.run_tools)
                with self._lock:
                    self._conversations[conv.id] = conv
                turn.conv_id = conv.id
                return
            if etype == "turn_result":
                return self._settle(turn, TurnResult.from_event(event))
        if request is not None:
            match, future = request
            if etype == "error":
                future.set_exception(ExocortexError("daemon", event.get("message", "error")))
                return
            if match(event):
                if not future.done():
                    future.set_result(event)
                return

        conv_id = event.get("convId")
        if not conv_id:
            return
        if etype == "app_tool_call":
            return self._on_tool_call(event)
        if etype == "app_tool_cancel":
            with self._lock:
                entry = self._calls.pop(event.get("callId") or "", None)
            if entry:
                entry["call"].reason = event.get("reason")
                entry["call"].cancelled.set()
            return
        if etype == "conversation_deleted":
            return self._end_conversation(conv_id, event.get("reason") or "deleted")
        with self._lock:
            turns = [t for t in self._turns.values() if t.conv_id == conv_id]
        for t in turns:
            if etype == "turn_result":
                if not event.get("turnId") or t.turn_id == event.get("turnId"):
                    self._settle(t, TurnResult.from_event(event))
                continue
            if t.on_event:
                t.on_event(event)
            if t.stream is not None:
                if etype == "text_chunk":
                    t.stream._push(StreamEvent("text", text=event.get("text", "")))
                elif etype == "thinking_chunk":
                    t.stream._push(StreamEvent("thinking", text=event.get("text", "")))
                elif etype == "tool_call":
                    t.stream._push(StreamEvent("tool_call", id=event.get("toolCallId"), name=event.get("toolName"), input=event.get("input")))
                elif etype == "tool_result":
                    t.stream._push(StreamEvent("tool_result", id=event.get("toolCallId"), name=event.get("toolName"),
                                               output=event.get("output"), is_error=bool(event.get("isError"))))
            if t.generation != self._generation:
                self._fallback(t, event)

    def _fallback(self, turn: _Turn, event: Dict[str, Any]) -> None:
        """After a reconnect, a daemon that sends no owner turn_result still ends the turn with these."""
        result = None
        if event["type"] == "message_complete":
            texts = [b for b in event.get("blocks") or [] if b.get("type") == "text"]
            result = TurnResult(turn.conv_id or "", texts[-1]["text"] if texts else "", "end_turn", raw={**event, "reconstructed": True})
        elif event["type"] == "streaming_stopped" and not event.get("reason"):
            result = TurnResult(turn.conv_id or "", "", "aborted", raw={**event, "reconstructed": True})
        if result is None:
            return
        if turn.fallback_timer:
            turn.fallback_timer.cancel()
        # A daemon that does send the owner turn_result sends it right after; prefer it.
        turn.fallback_timer = threading.Timer(0.5, self._settle, (turn, result))
        turn.fallback_timer.daemon = True
        turn.fallback_timer.start()

    def _on_tool_call(self, event: Dict[str, Any]) -> None:
        conv_id, call_id, name = event["convId"], event["callId"], event.get("name", "")
        call = ToolCall(conv_id, call_id, name)
        entry: Dict[str, Any] = {"call": call, "result": None, "conv_id": conv_id}
        with self._lock:
            known = self._calls.get(call_id)
            if known is None:
                self._calls[call_id] = entry
            conv = self._conversations.get(conv_id)
        if known is not None:
            # Re-sent after a re-attach: answer again if it already finished, else keep running it.
            if known["result"] is not None:
                self._write_quietly({"type": "app_tool_result", "convId": conv_id, "callId": call_id, **known["result"]})
            return
        handler = conv.handlers.get(name) if conv else None

        def finish(result: Dict[str, Any]) -> None:
            with self._lock:
                if call.cancelled.is_set() or self._calls.get(call_id) is not entry:
                    return
                entry["result"] = result
            self._write_quietly({"type": "app_tool_result", "convId": conv_id, "callId": call_id, **result})
            # Keep the answer a while in case the daemon re-sends the call after a reconnect.
            timer = threading.Timer(120, lambda: self._calls.pop(call_id, None) if self._calls.get(call_id) is entry else None)
            timer.daemon = True
            timer.start()

        if handler is None:
            return finish({"output": f"{self.app} has no handler for tool {name}", "isError": True})

        def work() -> None:
            try:
                result = _normalize_output(handler.call(event.get("input") or {}, call))
            except Exception as error:  # the model gets the error
                result = {"output": str(error) or type(error).__name__, "isError": True}
            finish(result)

        try:
            self._pool.submit(work)
        except RuntimeError:  # pool shut down: the client is closing
            pass

    def _end_conversation(self, conv_id: str, reason: str) -> None:
        with self._lock:
            conv = self._conversations.pop(conv_id, None)
            calls = [(k, v) for k, v in self._calls.items() if v["conv_id"] == conv_id]
            for k, _ in calls:
                self._calls.pop(k, None)
            turns = [t for t in self._turns.values() if t.conv_id == conv_id]
        if conv:
            conv.ended = reason
        for _, entry in calls:
            entry["call"].reason = "ended"
            entry["call"].cancelled.set()
        for t in turns:
            self._settle(t, ExocortexError("ended", f"Conversation {conv_id} has ended ({reason})"))

    # ── connection loss ──

    def _fail_requests(self, error: Exception) -> None:
        with self._lock:
            requests = list(self._requests.values())
        for _match, future in requests:
            if not future.done():
                future.set_exception(error)

    def _on_close(self, generation: int) -> None:
        if self._closed or generation != self._generation:
            return
        lost = ExocortexError("disconnected", "Lost the connection to the Exocortex daemon")
        self._fail_requests(lost)
        with self._lock:
            for call_id, entry in list(self._calls.items()):
                if entry["result"] is None:
                    entry["call"].reason = "disconnected"
                    entry["call"].cancelled.set()
                    self._calls.pop(call_id, None)
            ephemeral = [c.id for c in self._conversations.values() if c.info.get("lifetime") == "ephemeral"]
            orphans = [t for t in self._turns.values() if t.conv_id is None]
        for conv_id in ephemeral:
            self._end_conversation(conv_id, "owner_disconnected")
        for t in orphans:
            self._settle(t, lost)
        if not self._reconnect:
            self._closed = True
            self._fail_all(lost)
            return
        with self._lock:
            if self._reconnecting:
                return
            self._reconnecting = True
        threading.Thread(target=self._reconnect_loop, daemon=True, name=f"exocortex-{self.app}-reconnect").start()

    def _reconnect_loop(self) -> None:
        try:
            deadline = time.monotonic() + self._reconnect_timeout
            delay = 0.1
            while not self._closed:
                try:
                    self._handshake()
                    break
                except ExocortexError as error:
                    if error.code == "incompatible":
                        self._closed = True
                        return self._fail_all(error)
                    if time.monotonic() + delay > deadline:
                        self._closed = True
                        return self._fail_all(ExocortexError(
                            "disconnected", f"Could not reconnect to the Exocortex daemon within {self._reconnect_timeout} s"))
                    time.sleep(delay)
                    delay = min(delay * 2, 2.0)
            if self._closed:
                return
            with self._lock:
                conversations = list(self._conversations.values())
            for conv in conversations:
                try:
                    event = self._attach_existing(conv)
                except ExocortexError as error:
                    if error.code == "disconnected":
                        return  # the next close retries
                    self._end_conversation(conv.id, str(error))
                    continue
                if (event.get("conversation") or {}).get("streaming"):
                    continue
                # The turn ended while we were away.
                last = event.get("lastTurnResult")
                with self._lock:
                    turns = [t for t in self._turns.values() if t.conv_id == conv.id]
                for t in turns:
                    if last and last.get("turnId") == t.turn_id:
                        self._settle(t, TurnResult.from_event(last))
                    else:
                        self._settle(t, ExocortexError("result_lost", f"The turn on {conv.id} ended while the client was "
                                                       "disconnected, and the daemon did not report its result"))
        finally:
            with self._lock:
                self._reconnecting = False

    def _fail_all(self, error: Exception) -> None:
        self._fail_requests(error)
        with self._lock:
            turns = list(self._turns.values())
            calls = list(self._calls.values())
            self._calls.clear()
        for t in turns:
            self._settle(t, error)
        for entry in calls:
            entry["call"].reason = "closed"
            entry["call"].cancelled.set()


def connect(app: str, **options: Any) -> Client:
    """Connect to the user's daemon as ``app``. Options: version, socket, reconnect,
    reconnect_timeout, welcome_timeout, request_timeout, tool_workers."""
    client = Client(app, **options)
    try:
        client._open()
    except BaseException:
        client.close()
        raise
    return client


def run(prompt: str, app: str, *, socket: Optional[str] = None, version: Optional[str] = None,
        **options: Any) -> TurnResult:
    """One-shot from anywhere: connect, run (ephemeral by default), close."""
    with connect(app, socket=socket, version=version, reconnect=False) as client:
        return client.run(prompt, **options)


async def arun(prompt: str, app: str, **options: Any) -> TurnResult:
    """``run`` for asyncio (in a worker thread)."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: run(prompt, app, **options))
