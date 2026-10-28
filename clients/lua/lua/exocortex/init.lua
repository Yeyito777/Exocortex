--- exocortex: use the user's Exocortex daemon from Neovim (docs/app-api.md).
---
--- Non-blocking (vim.uv). Every daemon event is handled on the main loop
--- (vim.schedule), so callbacks and app tool handlers may call any Neovim API.
--- Async functions take a callback `function(err, result)` as their last
--- argument; inside `exo.async(function() ... end)` use `exo.await(fn, ...)`.
---
---   local exo = require("exocortex")
---   exo.run("Name three primes.", { app = "nvim", system = "Answer tersely." }, function(err, r)
---     print(err and tostring(err) or r.text)
---   end)
local M = {}

M.APP_API_VERSION = 1
M.INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Yeyito777/Exocortex/main/install.sh | bash"

local uv = vim.uv or vim.loop
local unpack = table.unpack or unpack

-- ── Errors ───────────────────────────────────────────────────────────────

local Error = {}
Error.__index = Error
Error.__tostring = function(e) return e.message end

--- code: not_installed, not_running, too_old, incompatible, daemon, disconnected, closed, ended, timeout, result_lost
local function err(code, message)
  return setmetatable({ code = code, message = message }, Error)
end
M.error = err

local function is_error(value) return getmetatable(value) == Error end
M.is_error = is_error

-- ── Coroutines ───────────────────────────────────────────────────────────

local error_handlers = setmetatable({}, { __mode = "k" })

local function resume(co, ...)
  local ok, e = coroutine.resume(co, ...)
  if not ok then
    local handler = error_handlers[co]
    if handler then handler(e) else vim.notify("exocortex: " .. tostring(e), vim.log.levels.ERROR) end
  end
end

--- Run `fn` in a coroutine; errors are reported with vim.notify unless `on_error` is given.
function M.async(fn, on_error)
  local co = coroutine.create(fn)
  error_handlers[co] = on_error
  resume(co)
  return co
end

--- Inside exo.async: call `fn(..., callback)` and wait. Returns the result; raises the error.
function M.await(fn, ...)
  local co = coroutine.running()
  assert(co, "exocortex.await must run inside exocortex.async")
  local args = { ... }
  local n = select("#", ...)
  local done, results = false, nil
  local yielded = false
  args[n + 1] = function(...)
    if done then return end
    done, results = true, { n = select("#", ...), ... }
    if yielded then resume(co) end
  end
  fn(unpack(args, 1, n + 1))
  if not done then
    yielded = true
    coroutine.yield()
  end
  if results[1] ~= nil then error(results[1], 0) end
  return unpack(results, 2, results.n)
end

-- ── Helpers ──────────────────────────────────────────────────────────────

local json_opts = { luanil = { object = true, array = true } }

local function encode(value) return vim.json.encode(value) end

local function decode(line)
  local ok, value = pcall(vim.json.decode, line, json_opts)
  if ok and type(value) == "table" and type(value.type) == "string" then return value end
end

local function now_ms()
  local sec, usec = uv.gettimeofday()
  return sec * 1000 + math.floor(usec / 1000)
end

local function timer(ms, fn)
  local t = uv.new_timer()
  t:start(ms, 0, vim.schedule_wrap(function()
    if not t:is_closing() then t:close() end
    fn()
  end))
  return t
end

local function cancel(t)
  if t and not t:is_closing() then t:stop(); t:close() end
end

local function system_spec(system, base)
  if system == nil and base == nil then return nil end
  local spec = type(system) == "string" and { text = system } or vim.deepcopy(system or {})
  if base then spec.base = base end
  return spec
end

local function tool_defs(tools)
  if not tools then return nil end
  local defs = {}
  for _, t in ipairs(tools) do
    defs[#defs + 1] = {
      name = t.name, description = t.description,
      inputSchema = t.input_schema or t.inputSchema or { type = "object", properties = vim.empty_dict() },
      timeoutMs = t.timeout_ms or t.timeoutMs,
    }
  end
  return defs
end

--- opts: lifetime, idle_ttl_ms, title, system (string or {text, base}), base, builtin, tools,
--- provider, model, effort, cwd, conv_id
local function create_fields(opts)
  local fields = {
    lifetime = opts.lifetime, idleTtlMs = opts.idle_ttl_ms, title = opts.title,
    system = system_spec(opts.system, opts.base), provider = opts.provider, model = opts.model,
    effort = opts.effort, cwd = opts.cwd, convId = opts.conv_id,
  }
  if opts.builtin ~= nil or opts.tools then
    fields.tools = { builtin = opts.builtin, app = tool_defs(opts.tools) }
  end
  return fields
end

local function to_result(ev)
  return {
    conv_id = ev.convId, text = ev.text or "", stop_reason = ev.stopReason, error = ev.error,
    usage = ev.usage, turn_id = ev.turnId, raw = ev,
  }
end

local function normalize_output(value)
  if type(value) == "string" then return { output = value, isError = false } end
  if type(value) == "table" and type(value.output) == "string" then
    return { output = value.output, isError = value.isError == true or value.is_error == true }
  end
  if value == nil then return { output = "", isError = false } end
  return { output = encode(value), isError = false }
end

-- ── Streams ──────────────────────────────────────────────────────────────

local Stream = {}
Stream.__index = Stream

local function new_stream()
  return setmetatable({ queue = {}, done = false, waiters = {}, iter_co = nil }, Stream)
end

function Stream:_push(event)
  if self.done then return end
  table.insert(self.queue, event)
  self:_wake()
end

function Stream:_finish(e, result)
  if self.done then return end
  self.done, self.err, self.result = true, e, result
  self:_wake()
  for _, cb in ipairs(self.waiters) do cb(e, result) end
  self.waiters = {}
end

function Stream:_wake()
  local co = self.iter_co
  if co then
    self.iter_co = nil
    resume(co)
  end
end

--- Inside exo.async: `for event in stream:iter() do ... end` (events: text, thinking, tool_call, tool_result).
--- Raises the turn's error at the end, if any.
function Stream:iter()
  return function()
    while true do
      if #self.queue > 0 then return table.remove(self.queue, 1) end
      if self.done then
        if self.err then error(self.err, 0) end
        return nil
      end
      self.iter_co = assert(coroutine.running(), "stream:iter() must run inside exocortex.async")
      coroutine.yield()
    end
  end
end

--- Callback with (err, result) when the turn ends (exo.await(stream.wait, stream) works too).
function Stream:wait(cb)
  if self.done then cb(self.err, self.result) else table.insert(self.waiters, cb) end
end

-- ── Conversation ─────────────────────────────────────────────────────────

local Conversation = {}
Conversation.__index = Conversation

local function new_conversation(client, info, tools)
  local conv = setmetatable({ client = client, id = info.convId, info = info, ended = nil }, Conversation)
  conv:_set_tools(tools)
  return conv
end

function Conversation:_set_tools(tools)
  self.tools = tools
  self.handlers = {}
  for _, t in ipairs(tools or {}) do self.handlers[t.name] = t end
end

--- Send a prompt; cb(err, result) when the turn ends.
--- opts: on_text(delta), on_event(event) for stream events, on_raw(daemon_event), images
function Conversation:send(prompt, opts, cb)
  if type(opts) == "function" then opts, cb = nil, opts end
  return self.client:_send_turn(self, prompt, opts or {}, cb)
end

--- Send a prompt and get a Stream (iterate it inside exo.async, or stream:wait(cb)).
function Conversation:stream(prompt, opts)
  local stream = new_stream()
  self.client:_send_turn(self, prompt, opts or {}, function(e, r) stream:_finish(e, r) end, stream)
  return stream
end

function Conversation:abort(cb)
  self.client:request({ type = "abort", convId = self.id }, function(ev) return ev.type == "ack" end, function(e)
    if cb then cb(e) end
  end)
end

--- Replace the app tools (handlers and definitions) from the next turn on.
function Conversation:set_tools(tools, cb)
  self:_set_tools(tools)
  self.client:_attach_existing(self, function(e) if cb then cb(e) end end)
end

--- Delete it for good.
function Conversation:delete(cb)
  self.client:delete(self.id, cb)
end

-- ── Client ───────────────────────────────────────────────────────────────

local Client = {}
Client.__index = Client

--- The daemon's socket: $EXOCORTEX_SOCKET, else `exocortexd socket`. cb(err, path).
function M.find_socket(cb)
  local env = vim.env.EXOCORTEX_SOCKET
  if env and vim.trim(env) ~= "" then return cb(nil, vim.trim(env)) end
  if vim.fn.executable("exocortexd") ~= 1 then
    return cb(err("not_installed", "Exocortex is not installed (no `exocortexd` on PATH). Install it with:\n  " .. M.INSTALL_COMMAND))
  end
  vim.system({ "exocortexd", "socket" }, { text = true, timeout = 10000 }, vim.schedule_wrap(function(out)
    local path = vim.trim(out.stdout or "")
    if out.code ~= 0 then
      return cb(err("not_running", "`exocortexd socket` failed: " .. vim.trim(out.stderr or ("exit " .. out.code))))
    end
    if path == "" then return cb(err("not_running", "`exocortexd socket` printed nothing; is Exocortex installed correctly?")) end
    if not uv.fs_stat(path) then
      return cb(err("not_running", "The Exocortex daemon is not running (no socket at " .. path .. "). Start it with: exocortexd start"))
    end
    cb(nil, path)
  end))
end

--- Connect as `opts.app`. opts: app, version, socket, reconnect (default true),
--- reconnect_timeout_ms (60000), welcome_timeout_ms (5000), request_timeout_ms (30000).
--- cb(err, client)
function M.connect(opts, cb)
  assert(type(opts) == "table" and opts.app, "exocortex.connect: opts.app is required")
  if not opts.app:match("^[a-z0-9][a-z0-9%-]*$") or #opts.app > 40 then
    return cb(err("daemon", "Invalid app name " .. vim.inspect(opts.app) .. ": use lowercase letters, digits and dashes"))
  end
  local client = setmetatable({
    app = opts.app, version = opts.version, socket_path = opts.socket,
    reconnect = opts.reconnect ~= false,
    reconnect_timeout_ms = opts.reconnect_timeout_ms or 60000,
    welcome_timeout_ms = opts.welcome_timeout_ms or 5000,
    request_timeout_ms = opts.request_timeout_ms or 30000,
    pipe = nil, generation = 0, next_id = 0, last_started_at = 0, closed = false, reconnecting = false,
    requests = {}, turns = {}, conversations = {}, calls = {}, listeners = {},
  }, Client)
  local function open(path)
    client.socket_path = path
    client:_handshake(function(e)
      if e then client:close(); return cb(e) end
      cb(nil, client)
    end)
  end
  if client.socket_path then return open(client.socket_path) end
  M.find_socket(function(e, path)
    if e then return cb(e) end
    open(path)
  end)
end

function Client:_id()
  self.next_id = self.next_id + 1
  return "n" .. self.next_id
end

--- The prompt's time, unique per client: it is the turn's identity (turn_result.turnId).
function Client:_started_at()
  self.last_started_at = math.max(now_ms(), self.last_started_at + 1)
  return self.last_started_at
end

function Client:_handshake(cb)
  local pipe = uv.new_pipe(false)
  pipe:connect(self.socket_path, vim.schedule_wrap(function(connect_err)
    if connect_err then
      if not pipe:is_closing() then pipe:close() end
      return cb(err("not_running", "The Exocortex daemon is not running (cannot connect to " .. self.socket_path
        .. ": " .. connect_err .. "). Start it with: exocortexd start"))
    end
    self.generation = self.generation + 1
    local generation = self.generation
    self.pipe = pipe
    local ready = false
    local buffer = ""
    pipe:read_start(function(read_err, chunk)
      vim.schedule(function()
        if self.pipe ~= pipe then return end
        if chunk then
          buffer = buffer .. chunk
          while true do
            local i = buffer:find("\n", 1, true)
            if not i then break end
            local line = buffer:sub(1, i - 1)
            buffer = buffer:sub(i + 1)
            local ev = line:match("%S") and decode(line)
            if ev then
              local ok, e = pcall(self._dispatch, self, ev)
              if not ok then vim.notify("exocortex: " .. tostring(e), vim.log.levels.ERROR) end
            end
          end
          return
        end
        -- EOF or error: the connection is gone.
        self.pipe = nil
        if not pipe:is_closing() then pipe:close() end
        if ready then return self:_on_close(generation) end
        self:_fail_requests(err("disconnected", "The daemon closed the connection before app_welcome"))
        local _ = read_err
      end)
    end)
    local caps = { type = "client_capabilities", capabilities = {}, app = { name = self.app, version = self.version } }
    self:request(caps, function(ev) return ev.type == "app_welcome" end, function(e, welcome)
      if e then
        if self.pipe == pipe then self.pipe = nil end
        if not pipe:is_closing() then pipe:close() end
        if e.code == "timeout" then
          return cb(err("too_old", "The Exocortex daemon did not answer app_welcome: it is too old for the app API. Update it with:\n  " .. M.INSTALL_COMMAND))
        end
        return cb(e)
      end
      if welcome.appApiVersion ~= M.APP_API_VERSION then
        self.pipe = nil
        if not pipe:is_closing() then pipe:close() end
        local v = welcome.appApiVersion
        local msg = type(v) == "number" and v > M.APP_API_VERSION
          and ("The Exocortex daemon speaks app API v" .. v .. "; this client knows v" .. M.APP_API_VERSION .. ". Update exocortex.nvim.")
          or ("The Exocortex daemon speaks app API v" .. tostring(v) .. "; this client needs v" .. M.APP_API_VERSION .. ". Update Exocortex:\n  " .. M.INSTALL_COMMAND)
        return cb(err("incompatible", msg))
      end
      self.welcome = welcome
      ready = true
      cb(nil)
    end, self.welcome_timeout_ms)
  end))
end

--- Call `listener(event)` with every raw daemon event. Returns an unsubscribe function.
function Client:on_event(listener)
  self.listeners[listener] = true
  return function() self.listeners[listener] = nil end
end

function Client:_write(cmd)
  if self.closed then return err("closed", "The client was closed") end
  if not self.pipe then return err("disconnected", "Not connected to the Exocortex daemon (reconnecting)") end
  self.pipe:write(encode(cmd) .. "\n")
end

--- Send a raw command; cb(err, event) with the answer `match(event)` accepts (or an `error` with its reqId).
function Client:request(cmd, match, cb, timeout_ms)
  local req_id = cmd.reqId or self:_id()
  cmd = vim.tbl_extend("force", cmd, { reqId = req_id })
  local pending = { match = match, cb = cb }
  local ms = timeout_ms or self.request_timeout_ms
  if ms > 0 then
    pending.timer = timer(ms, function()
      if self.requests[req_id] ~= pending then return end
      self.requests[req_id] = nil
      cb(err("timeout", "No answer to " .. cmd.type .. " within " .. ms .. " ms"))
    end)
  end
  self.requests[req_id] = pending
  local e = self:_write(cmd)
  if e then
    self.requests[req_id] = nil
    cancel(pending.timer)
    cb(e)
  end
end

--- Create a conversation. opts: see create_fields; cb(err, conversation)
function Client:conversation(opts, cb)
  if type(opts) == "function" then opts, cb = {}, opts end
  opts = opts or {}
  local cmd = vim.tbl_extend("force", { type = "new_conversation" }, create_fields(opts))
  self:request(cmd, function(ev) return ev.type == "conversation_created" end, function(e, ev)
    if e then return cb(e) end
    local conv = new_conversation(self, ev.app, opts.tools)
    self.conversations[conv.id] = conv
    cb(nil, conv)
  end)
end

--- Own an existing saved or temporary conversation; opts.tools replaces its app tools. cb(err, conversation)
function Client:attach(conv_id, opts, cb)
  if type(opts) == "function" then opts, cb = {}, opts end
  opts = opts or {}
  local cmd = { type = "attach_app_conversation", convId = conv_id }
  if opts.tools then cmd.tools = { app = tool_defs(opts.tools) } end
  self:request(cmd, function(ev) return ev.type == "app_conversation_attached" end, function(e, ev)
    if e then return cb(e) end
    local conv = self.conversations[conv_id]
    if conv then
      conv.info = ev.conversation
      if opts.tools then conv:_set_tools(opts.tools) end
    else
      conv = new_conversation(self, ev.conversation, opts.tools)
      self.conversations[conv_id] = conv
    end
    cb(nil, conv)
  end)
end

function Client:_attach_existing(conv, cb)
  local cmd = { type = "attach_app_conversation", convId = conv.id }
  if conv.tools then cmd.tools = { app = tool_defs(conv.tools) } end
  self:request(cmd, function(ev) return ev.type == "app_conversation_attached" end, function(e, ev)
    if not e then conv.info = ev.conversation end
    cb(e, ev)
  end)
end

--- One-shot: create (ephemeral by default), send, await. opts: create options plus keep, images,
--- on_text, on_event, on_raw. cb(err, result)
function Client:run(prompt, opts, cb)
  if type(opts) == "function" then opts, cb = {}, opts end
  opts = opts or {}
  local turn = self:_new_turn(nil, opts, cb)
  turn.run_tools = opts.tools
  local cmd = vim.tbl_extend("force", { type = "app_run", reqId = turn.req_id, prompt = prompt, startedAt = turn.started_at, images = opts.images, keep = opts.keep or nil }, create_fields(opts))
  self:_start(turn, cmd)
end

--- One-shot, as a Stream.
function Client:run_stream(prompt, opts)
  opts = opts or {}
  local stream = new_stream()
  local turn = self:_new_turn(nil, opts, function(e, r) stream:_finish(e, r) end, stream)
  turn.run_tools = opts.tools
  local cmd = vim.tbl_extend("force", { type = "app_run", reqId = turn.req_id, prompt = prompt, startedAt = turn.started_at, images = opts.images, keep = opts.keep or nil }, create_fields(opts))
  self:_start(turn, cmd)
  return stream
end

--- Live hidden app conversations (this app's unless opts.all_apps), and saved ones with opts.include_saved.
function Client:list(opts, cb)
  if type(opts) == "function" then opts, cb = {}, opts end
  opts = opts or {}
  local cmd = { type = "list_app_conversations", includeSaved = opts.include_saved or nil }
  if not opts.all_apps then cmd.app = opts.app or self.app end
  self:request(cmd, function(ev) return ev.type == "app_conversations_list" end, function(e, ev)
    cb(e, ev and ev.conversations)
  end)
end

--- Delete an app conversation for good. cb(err)
function Client:delete(conv_id, cb)
  self:request({ type = "delete_conversation", convId = conv_id },
    function(ev) return ev.type == "conversation_deleted" and ev.convId == conv_id end,
    function(e)
      if not e then self:_end_conversation(conv_id, "deleted") end
      if cb then cb(e) end
    end)
end

--- Close the connection. Ephemeral conversations end with it; saved and temporary ones stay.
function Client:close()
  if self.closed then return end
  self.closed = true
  self:_fail_all(err("closed", "The client was closed"))
  local pipe = self.pipe
  self.pipe = nil
  if pipe and not pipe:is_closing() then
    pipe:shutdown(function() if not pipe:is_closing() then pipe:close() end end)
  end
end

-- ── turns ──

function Client:_new_turn(conv_id, opts, cb, stream)
  local started_at = self:_started_at()
  local turn = {
    req_id = self:_id(), conv_id = conv_id, started_at = started_at, turn_id = string.format("%d", started_at),
    generation = self.generation, cb = cb, stream = stream,
    on_text = opts.on_text, on_event = opts.on_event, on_raw = opts.on_raw,
  }
  self.turns[turn.req_id] = turn
  return turn
end

function Client:_start(turn, cmd)
  local e = self:_write(cmd)
  if e then
    self.turns[turn.req_id] = nil
    turn.cb(e)
  end
end

function Client:_send_turn(conv, prompt, opts, cb, stream)
  cb = cb or function() end
  if conv.ended then
    local e = err("ended", "Conversation " .. conv.id .. " has ended (" .. conv.ended .. ")")
    return vim.schedule(function() cb(e) end)
  end
  local turn = self:_new_turn(conv.id, opts, cb, stream)
  self:_start(turn, {
    type = "send_message", reqId = turn.req_id, convId = conv.id, text = prompt,
    startedAt = turn.started_at, awaitResult = true, images = opts.images,
  })
end

function Client:_settle(turn, e, result)
  if self.turns[turn.req_id] ~= turn then return end
  self.turns[turn.req_id] = nil
  cancel(turn.fallback_timer)
  turn.cb(e, result)
end

-- ── incoming ──

local function stream_event(ev)
  local t = ev.type
  if t == "text_chunk" then return { type = "text", text = ev.text } end
  if t == "thinking_chunk" then return { type = "thinking", text = ev.text } end
  if t == "tool_call" then return { type = "tool_call", id = ev.toolCallId, name = ev.toolName, input = ev.input } end
  if t == "tool_result" then
    return { type = "tool_result", id = ev.toolCallId, name = ev.toolName, output = ev.output, is_error = ev.isError == true }
  end
end

function Client:_dispatch(ev)
  for listener in pairs(self.listeners) do listener(ev) end
  local t, req_id = ev.type, ev.reqId
  local turn = req_id and self.turns[req_id]
  if turn and turn.generation == self.generation then
    if t == "error" then return self:_settle(turn, err("daemon", ev.message or "error")) end
    if t == "conversation_created" and not turn.conv_id then
      local conv = new_conversation(self, ev.app, turn.run_tools)
      self.conversations[conv.id] = conv
      turn.conv_id = conv.id
      return
    end
    if t == "turn_result" then return self:_settle(turn, nil, to_result(ev)) end
  end
  local request = req_id and self.requests[req_id]
  if request then
    if t == "error" or request.match(ev) then
      self.requests[req_id] = nil
      cancel(request.timer)
      if t == "error" then request.cb(err("daemon", ev.message or "error")) else request.cb(nil, ev) end
      return
    end
  end

  local conv_id = ev.convId
  if not conv_id then return end
  if t == "app_tool_call" then return self:_on_tool_call(ev) end
  if t == "app_tool_cancel" then
    local entry = self.calls[ev.callId]
    self.calls[ev.callId] = nil
    if entry then entry.call:_cancel(ev.reason) end
    return
  end
  if t == "conversation_deleted" then return self:_end_conversation(conv_id, ev.reason or "deleted") end
  for _, tr in pairs(self.turns) do
    if tr.conv_id == conv_id then
      if t == "turn_result" then
        if not ev.turnId or tr.turn_id == ev.turnId then self:_settle(tr, nil, to_result(ev)) end
      else
        if tr.on_raw then tr.on_raw(ev) end
        local se = stream_event(ev)
        if se then
          if tr.on_event then tr.on_event(se) end
          if se.type == "text" and tr.on_text then tr.on_text(se.text) end
          if tr.stream then tr.stream:_push(se) end
        end
        if tr.generation ~= self.generation then self:_fallback(tr, ev) end
      end
    end
  end
end

--- After a reconnect, a daemon that sends no owner turn_result still ends the turn with these.
function Client:_fallback(turn, ev)
  local result
  if ev.type == "message_complete" then
    local text = ""
    for _, block in ipairs(ev.blocks or {}) do if block.type == "text" then text = block.text end end
    result = { conv_id = turn.conv_id, text = text, stop_reason = "end_turn", raw = vim.tbl_extend("force", ev, { reconstructed = true }) }
  elseif ev.type == "streaming_stopped" and not ev.reason then
    result = { conv_id = turn.conv_id, text = "", stop_reason = "aborted", raw = vim.tbl_extend("force", ev, { reconstructed = true }) }
  end
  if not result then return end
  cancel(turn.fallback_timer)
  -- A daemon that does send the owner turn_result sends it right after; prefer it.
  turn.fallback_timer = timer(500, function() self:_settle(turn, nil, result) end)
end

local Call = {}
Call.__index = Call

--- Answer an `async = true` tool's call: text or {output, isError}.
function Call:respond(value) if self._respond then self._respond(normalize_output(value)) end end
--- Register `fn(reason)` for a cancel (turn aborted, timed out, conversation ended).
function Call:on_cancel(fn)
  if self.cancelled then fn(self.reason) else table.insert(self._on_cancel, fn) end
end
function Call:_cancel(reason)
  if self.cancelled then return end
  self.cancelled, self.reason = true, reason
  for _, fn in ipairs(self._on_cancel) do pcall(fn, reason) end
end

function Client:_on_tool_call(ev)
  local conv_id, call_id, name = ev.convId, ev.callId, ev.name
  local known = self.calls[call_id]
  if known then
    -- Re-sent after a re-attach: answer again if it already finished, else keep running it.
    if known.result then self:_write(vim.tbl_extend("force", { type = "app_tool_result", convId = conv_id, callId = call_id }, known.result)) end
    return
  end
  local call = setmetatable({ conv_id = conv_id, call_id = call_id, name = name, cancelled = false, _on_cancel = {} }, Call)
  local entry = { call = call, conv_id = conv_id }
  self.calls[call_id] = entry
  local function finish(result)
    if call.cancelled or self.calls[call_id] ~= entry or entry.result then return end
    entry.result = result
    self:_write(vim.tbl_extend("force", { type = "app_tool_result", convId = conv_id, callId = call_id }, result))
    -- Keep the answer a while in case the daemon re-sends the call after a reconnect.
    timer(120000, function() if self.calls[call_id] == entry then self.calls[call_id] = nil end end)
  end
  call._respond = finish
  local conv = self.conversations[conv_id]
  local tool = conv and conv.handlers[name]
  if not tool then return finish({ output = self.app .. " has no handler for tool " .. tostring(name), isError = true }) end
  local ok, value = pcall(tool.handler, ev.input or {}, call)
  if not ok then return finish({ output = tostring(value), isError = true }) end
  if not tool.async then finish(normalize_output(value)) end
end

function Client:_end_conversation(conv_id, reason)
  local conv = self.conversations[conv_id]
  self.conversations[conv_id] = nil
  if conv then conv.ended = reason end
  for call_id, entry in pairs(self.calls) do
    if entry.conv_id == conv_id then
      self.calls[call_id] = nil
      entry.call:_cancel("ended")
    end
  end
  for _, tr in pairs(self.turns) do
    if tr.conv_id == conv_id then self:_settle(tr, err("ended", "Conversation " .. conv_id .. " has ended (" .. reason .. ")")) end
  end
end

-- ── connection loss ──

function Client:_fail_requests(e)
  local requests = self.requests
  self.requests = {}
  for _, r in pairs(requests) do cancel(r.timer); r.cb(e) end
end

function Client:_on_close(generation)
  if self.closed or generation ~= self.generation then return end
  local lost = err("disconnected", "Lost the connection to the Exocortex daemon")
  self:_fail_requests(lost)
  for call_id, entry in pairs(self.calls) do
    if not entry.result then self.calls[call_id] = nil; entry.call:_cancel("disconnected") end
  end
  for id, conv in pairs(self.conversations) do
    if conv.info.lifetime == "ephemeral" then self:_end_conversation(id, "owner_disconnected") end
  end
  for _, tr in pairs(self.turns) do if not tr.conv_id then self:_settle(tr, lost) end end
  if not self.reconnect then
    self.closed = true
    return self:_fail_all(lost)
  end
  if self.reconnecting then return end
  self.reconnecting = true
  local deadline = uv.now() + self.reconnect_timeout_ms
  local delay = 100
  local function attempt()
    if self.closed then self.reconnecting = false; return end
    self:_handshake(function(e)
      if e then
        if e.code == "incompatible" or uv.now() + delay > deadline then
          self.reconnecting = false
          self.closed = true
          return self:_fail_all(e.code == "incompatible" and e
            or err("disconnected", "Could not reconnect to the Exocortex daemon within " .. self.reconnect_timeout_ms .. " ms"))
        end
        timer(delay, attempt)
        delay = math.min(delay * 2, 2000)
        return
      end
      self.reconnecting = false
      self:_reattach()
    end)
  end
  attempt()
end

function Client:_reattach()
  for id, conv in pairs(self.conversations) do
    self:_attach_existing(conv, function(e, ev)
      if e then
        if e.code ~= "disconnected" then self:_end_conversation(id, tostring(e)) end
        return
      end
      if ev.conversation and ev.conversation.streaming then return end
      -- The turn ended while we were away.
      local last = ev.lastTurnResult
      for _, tr in pairs(self.turns) do
        if tr.conv_id == id then
          if last and last.turnId == tr.turn_id then
            self:_settle(tr, nil, to_result(last))
          else
            self:_settle(tr, err("result_lost", "The turn on " .. id .. " ended while the client was disconnected, and the daemon did not report its result"))
          end
        end
      end
    end)
  end
end

function Client:_fail_all(e)
  self:_fail_requests(e)
  for _, tr in pairs(self.turns) do self:_settle(tr, e) end
  for call_id, entry in pairs(self.calls) do
    self.calls[call_id] = nil
    entry.call:_cancel("closed")
  end
end

--- One-shot from anywhere: connect (opts.app, opts.socket, opts.version), run, close. cb(err, result)
function M.run(prompt, opts, cb)
  M.connect({ app = opts.app, socket = opts.socket, version = opts.version, reconnect = false }, function(e, client)
    if e then return cb(e) end
    client:run(prompt, opts, function(run_err, result)
      client:close()
      cb(run_err, result)
    end)
  end)
end

M.Client = Client
M.Conversation = Conversation
return M
