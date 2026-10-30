-- Tests against clients/testing/fake-daemon.ts (needs bun):
--   nvim --headless -u NONE -l clients/lua/test/run.lua [name-filter]
local here = vim.fs.dirname(vim.fs.normalize(debug.getinfo(1, "S").source:sub(2)))
-- This checkout's module, not one on the runtimepath (Neovim's loader searches that before package.path).
package.loaded.exocortex = dofile(vim.fs.normalize(here .. "/../lua/exocortex/init.lua"))
local exo = require("exocortex")
local await = exo.await
local FAKE = vim.fs.normalize(here .. "/../../testing/fake-daemon.ts")
local filter = _G.arg and _G.arg[1]

local function start_fake(args)
  local dir = vim.fn.tempname() .. "-exo-lua"
  vim.fn.mkdir(dir, "p")
  local socket = dir .. "/d.sock"
  local ready = false
  local cmd = { "bun", FAKE, "--socket", socket }
  vim.list_extend(cmd, args or {})
  -- stdin stays open: the fake exits on EOF if this test process dies.
  local proc = vim.system(cmd, { stdin = true, stdout = function(_, data) if data and data:find("^ready") then ready = true end end })
  assert(vim.wait(5000, function() return ready end, 10), "fake daemon did not start")
  return {
    socket = socket, dir = dir,
    stop = function()
      pcall(function() proc:kill("sigterm") end)
      proc:wait(5000)
      vim.fn.delete(dir, "rf")
    end,
  }
end

local function eq(actual, expected, what)
  if not vim.deep_equal(actual, expected) then
    error((what or "value") .. ": expected " .. vim.inspect(expected) .. ", got " .. vim.inspect(actual), 2)
  end
end

local function fails(fn, pattern, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error matching " .. pattern, 2) end
  local text = tostring(type(e) == "table" and (e.code .. ": " .. e.message) or e)
  if not text:find(pattern) then error("error " .. vim.inspect(text) .. " does not match " .. pattern, 2) end
  return e
end

local function sleep(ms) await(function(cb) vim.defer_fn(cb, ms) end) end

--- Waits until `check()` holds; fails fast after `ms`.
local function until_(check, ms)
  local deadline = vim.uv.now() + (ms or 5000)
  while not check() do
    if vim.uv.now() > deadline then error("timed out waiting", 2) end
    sleep(10)
  end
end

--- Send a test-only command (fake_restart, fake_drop) on a connection of its own; cb() once answered or dropped.
local function admin(f, command, cb)
  local pipe = vim.uv.new_pipe(false)
  local finished = false
  local function finish()
    if finished then return end
    finished = true
    if not pipe:is_closing() then pipe:close() end
    vim.schedule(cb)
  end
  pipe:connect(f.socket, function(e)
    if e then return finish() end
    pipe:read_start(function() finish() end)
    pipe:write(vim.json.encode(command) .. "\n")
  end)
end

local schema = { type = "object", properties = { word = { type = "string" } }, required = { "word" } }
local function lookup(handler, extra)
  return vim.tbl_extend("force", { name = "lookup", description = "Look a word up.", input_schema = schema, handler = handler }, extra or {})
end

local tests = {}
local function test(name, fn, fake_args) table.insert(tests, { name = name, fn = fn, args = fake_args }) end

test("one-shot run, module level", function(f)
  local r = await(exo.run, "hello", { app = "test-app", socket = f.socket, system = "Be brief." })
  eq(r.text, "echo: hello")
  eq(r.stop_reason, "end_turn")
  local c = await(exo.connect, { app = "test-app", socket = f.socket })
  eq(#await(c.list, c), 0, "live conversations")
  c:close()
end)

test("app tools: values, tables, errors, async handlers, buffers", function(f, c)
  local seen
  local r = await(c.run, c, 'tool lookup {"word":"zorp"}', { tools = { lookup(function(input) seen = input; return input.word .. ": frog" end) } })
  eq(r.text, "lookup -> zorp: frog")
  eq(seen, { word = "zorp" })
  eq(await(c.run, c, 'tool lookup {"word":"x"}', { tools = { lookup(function() return { count = 2 } end) } }).text, 'lookup -> {"count":2}')
  eq(await(c.run, c, 'tool lookup {"word":"x"}', { tools = { lookup(function() error("boom", 0) end) } }).text, "lookup error -> boom")
  eq(await(c.run, c, 'tool lookup {"word":"x"}', { tools = { lookup(function() return { output = "nope", isError = true } end) } }).text, "lookup error -> nope")
  local async_tool = lookup(function(_, call) vim.defer_fn(function() call:respond("later") end, 20) end, { async = true })
  eq(await(c.run, c, 'tool lookup {"word":"x"}', { tools = { async_tool } }).text, "lookup -> later")
  -- Handlers run on the main loop: the Neovim API is usable.
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "line one", "line two" })
  local get_buffer = lookup(function() return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") end)
  eq(await(c.run, c, 'tool lookup {"word":"x"}', { tools = { get_buffer } }).text, "lookup -> line one\nline two")
end)

test("run_stream and callbacks", function(f, c)
  local stream = c:run_stream('tool lookup {"word":"a"}', { tools = { lookup(function() return "b" end) } })
  local types, text = {}, ""
  for event in stream:iter() do
    table.insert(types, event.type)
    if event.type == "text" then text = text .. event.text end
  end
  eq(types, { "tool_call", "tool_result", "text", "text" })
  eq(text, await(stream.wait, stream).text)
  local deltas = {}
  local r = await(c.run, c, "hi", { on_text = function(d) table.insert(deltas, d) end })
  eq(table.concat(deltas), r.text)
end)

test("failed turns and validation errors", function(f, c)
  local r = await(c.run, c, "fail")
  eq({ r.stop_reason, r.error }, { "error", "fake failure" })
  fails(await, "teleport", c.run, c, "hi", { builtin = { "teleport" } })
end)

test("conversation: history, stream, abort, busy", function(f, c)
  local conv = await(c.conversation, c, { lifetime = "temporary", title = "t", model = "m1" })
  eq(conv.info.lifetime, "temporary")
  eq(await(conv.send, conv, "count").text, "turns: 1")
  local text = ""
  for event in conv:stream("count"):iter() do if event.type == "text" then text = text .. event.text end end
  eq(text, "turns: 2")
  local hanging = conv:stream("hang")
  for event in hanging:iter() do if event.type == "text" then break end end
  await(conv.abort, conv)
  eq(await(hanging.wait, hanging).stop_reason, "aborted")
  local busy = conv:stream("hang")
  fails(await, "Already streaming", conv.send, conv, "again")
  await(conv.abort, conv)
  await(busy.wait, busy)
end)

test("tool timeout cancels the call", function(f, c)
  local reason
  local tool = lookup(function(_, call) call:on_cancel(function(r) reason = r end) end, { async = true, timeout_ms = 150 })
  local conv = await(c.conversation, c, { lifetime = "ephemeral", tools = { tool } })
  eq(await(conv.send, conv, 'tool lookup {"word":"x"}').text, "lookup error -> lookup timed out")
  eq(reason, "timeout")
end)

test("saved: outlives the client, attach, list, delete", function(f, first)
  local conv = await(first.conversation, first, { lifetime = "saved", builtin = { "read" }, tools = { lookup(function() return "one" end) } })
  eq(await(conv.send, conv, 'tool lookup {"word":"x"}').text, "lookup -> one")
  first:close()
  local second = await(exo.connect, { app = "test-app", socket = f.socket })
  eq(#await(second.list, second), 0)
  local saved = await(second.list, second, { include_saved = true })
  eq(saved[1].convId, conv.id)
  local again = await(second.attach, second, conv.id, { tools = { lookup(function() return "two" end) } })
  eq(await(again.send, again, 'tool lookup {"word":"x"}').text, "lookup -> two")
  eq(await(again.send, again, "count").text, "turns: 3")
  await(again.delete, again)
  eq(again.ended, "deleted")
  eq(#await(second.list, second, { include_saved = true }), 0)
  fails(await, "ended", again.send, again, "hi")
  second:close()
end)

test("ephemeral ends with its connection", function(f, owner)
  local watcher = await(exo.connect, { app = "test-app", socket = f.socket })
  local conv = await(owner.conversation, owner, { lifetime = "ephemeral" })
  eq(await(watcher.list, watcher)[1].convId, conv.id)
  fails(await, "ephemeral", watcher.attach, watcher, conv.id)
  owner:close()
  for _ = 1, 50 do
    if #await(watcher.list, watcher) == 0 then break end
    sleep(20)
  end
  eq(#await(watcher.list, watcher), 0)
  watcher:close()
end)

test("restart mid-turn: re-attach, the tool runs, the owner turn_result resolves the send", function(f, c)
  local calls = 0
  local conv = await(c.conversation, c, { lifetime = "temporary", tools = { lookup(function(input) calls = calls + 1; return "got " .. input.word end) } })
    local r = await(conv.send, conv, 'restart tool lookup {"word":"w"}')
    eq(r.text, "lookup -> got w")
    eq(calls, 1)
    assert(r.turn_id, "turn_id")
    eq(await(conv.send, conv, "count").text, "turns: 2")
end)

test("a turn that ended while away resolves from the attach answer", function(f, c)
  local conv = await(c.conversation, c, { lifetime = "saved" })
  local r = await(conv.send, conv, "restart echo quick")
  eq(r.text, "echo: echo quick")
  assert(r.turn_id)
end, { "--refuse-after-restart-ms", "400" })

test("an ephemeral conversation and a one-shot run survive a graceful restart", function(f, c)
  local session = c.session
  assert(session, "session")
  local conv = await(c.conversation, c, { lifetime = "ephemeral" })
  eq(await(conv.send, conv, "restart echo").text, "echo: echo")
  eq(c.session, session)
  eq(await(conv.send, conv, "count").text, "turns: 2")
  eq(await(c.run, c, "restart again").text, "echo: again")
end)

test("requests and sends made while reconnecting wait for the connection", function(f, c)
  local conv = await(c.conversation, c, { lifetime = "ephemeral" })
  await(admin, f, { type = "fake_restart", downMs = 600 })
  until_(function() return not c.connected end)
  eq(await(conv.send, conv, "count").text, "turns: 1")
  local ids = vim.tbl_map(function(i) return i.convId end, await(c.list, c))
  eq(ids, { conv.id })
  local fresh = await(c.conversation, c, { lifetime = "temporary" })
  await(admin, f, { type = "fake_drop" })
  eq(await(fresh.send, fresh, "count").text, "turns: 1")
  eq(#await(c.list, c), 2)
end)

test("a dropped connection keeps the ephemeral conversation and its running tool call", function(f, c)
  local answered, started = {}, false
  local slow = lookup(function(input, call)
    started = true
    vim.defer_fn(function() table.insert(answered, input.word); call:respond("kept " .. input.word) end, 300)
  end, { async = true })
  local conv = await(c.conversation, c, { lifetime = "ephemeral", tools = { slow } })
  local turn = conv:stream('tool lookup {"word":"q"}')
  until_(function() return started end)
  await(admin, f, { type = "fake_drop" })
  eq(await(turn.wait, turn).text, "lookup -> kept q")
  eq(answered, { "q" })
end)

test("a crash loses the conversations; a one-shot run runs again on a new one", function(f, c)
  local conv = await(c.conversation, c, { lifetime = "ephemeral" })
  local hanging = conv:stream("hang")
  for event in hanging:iter() do if event.type == "text" then break end end
  local calls = 0
  local crash_once = lookup(function(_, call)
    calls = calls + 1
    if calls > 1 then return call:respond("second try") end
    admin(f, { type = "fake_restart", crash = true, downMs = 200 }, function()
      vim.defer_fn(function() call:respond("too late") end, 200)
    end)
  end, { async = true })
  eq(await(c.run, c, 'tool lookup {"word":"x"}', { tools = { crash_once } }).text, "lookup -> second try")
  eq(calls, 2)
  fails(await, "^lost", hanging.wait, hanging)
  eq(conv.ended, "lost")
end)

test("a connection that drops again while conversations are re-attached still reconnects", function(f, c)
  local convs = {}
  for i = 1, 4 do convs[i] = await(c.conversation, c, { lifetime = "temporary" }) end
  local armed = 0
  c:on_event(function(ev)
    -- The first re-attach answer after the first drop: drop again while the others are in flight.
    if ev.type == "app_conversation_attached" and armed == 1 then
      armed = 2
      admin(f, { type = "fake_drop" }, function() end)
    end
  end)
  armed = 1
  await(admin, f, { type = "fake_drop" })
  local result
  convs[1]:send("count", function(e, r) result = e or r end)
  until_(function() return result ~= nil end, 6000)
  eq(result.text, "turns: 1")
  eq(armed, 2)
end)

test("route passes through to the conversation", function(f, c)
  local conv = await(c.conversation, c, { lifetime = "temporary", route = { credits = "never", whenLimited = "error" } })
  eq(conv.info.route, { credits = "never", whenLimited = "error" })
  eq(await(c.run, c, "hi", { route = { credits = "allow" } }).text, "echo: hi")
  local state = await(c.request, c, { type = "fake_state" }, function(ev) return ev.type == "fake_state" end)
  for _, cmd in ipairs(state.received) do
    if cmd.type == "app_run" then eq(cmd.route, { credits = "allow" }) end
  end
end)

test("without sessions: a turn whose result the daemon did not keep is reported lost", function(f, c)
  eq(c.session, nil)
  local conv = await(c.conversation, c, { lifetime = "saved" })
  fails(await, "result_lost", conv.send, conv, "restart echo quick")
  eq(await(conv.send, conv, "count").text, "turns: 2")
end, { "--refuse-after-restart-ms", "400", "--no-owner-results", "--no-sessions" })

test("without sessions: an ephemeral conversation is lost on a restart; the client keeps working", function(f, c)
  local conv = await(c.conversation, c, { lifetime = "ephemeral" })
  fails(await, "^lost", conv.send, conv, "restart echo")
  eq(await(c.run, c, "after").text, "echo: after")
end, { "--no-sessions" })

test("version mismatch is refused", function(f)
  fails(await, "incompatible", exo.connect, { app = "test-app", socket = f.socket })
end, { "--api-version", "2" })

test("no app_welcome means too old", function(f)
  local e = fails(await, "too_old", exo.connect, { app = "test-app", socket = f.socket, welcome_timeout_ms = 200 })
  assert(e.message:find(exo.INSTALL_COMMAND, 1, true))
end, { "--no-welcome" })

test("discovery: EXOCORTEX_SOCKET, `exocortexd socket`, install line", function(f)
  local saved_socket, saved_path = vim.env.EXOCORTEX_SOCKET, vim.env.PATH
  local ok, e = pcall(function()
    vim.env.EXOCORTEX_SOCKET = f.socket
    eq(await(exo.find_socket), f.socket)
    vim.env.EXOCORTEX_SOCKET = nil
    vim.env.PATH = f.dir
    local missing = fails(await, "not_installed", exo.find_socket)
    assert(missing.message:find(exo.INSTALL_COMMAND, 1, true))
    local bin = f.dir .. "/exocortexd"
    vim.fn.writefile({ "#!/bin/sh", '[ "$1" = socket ] && echo ' .. f.socket }, bin)
    vim.fn.setfperm(bin, "rwxr-xr-x")
    eq(await(exo.find_socket), f.socket)
    local c = await(exo.connect, { app = "test-app" })
    eq(c.welcome.instance, "fake")
    c:close()
    vim.fn.writefile({ "#!/bin/sh", '[ "$1" = socket ] && echo ' .. f.dir .. "/gone.sock", [=[[ "$1" = doctor ] && echo '{"ok":false,"problems":[{"id":"daemon","severity":"error","message":"The daemon is not running.","fix":"exocortexd start"}]}']=], "exit 0" }, bin)
    local down = fails(await, "not_running", exo.connect, { app = "test-app" })
    assert(down.message:find("The daemon is not running. Fix: exocortexd start", 1, true), down.message)
  end)
  vim.env.EXOCORTEX_SOCKET, vim.env.PATH = saved_socket, saved_path
  if not ok then error(e, 0) end
end)

test("a stopped daemon is not running", function(f)
  f.stop()
  fails(await, "not_running", exo.connect, { app = "test-app", socket = f.socket })
end)

-- ── runner ──

local failed, ran = 0, 0
-- ── following a turn (turn catch-ups) ──

local function numbers(n)
  local out = {}
  for i = 1, n do out[i] = i .. " " end
  return table.concat(out)
end

--- Collect a turn's stream events through on_event while it runs; returns the list and a text() reader.
local function recorder()
  local events = {}
  local function text()
    local out = {}
    for _, e in ipairs(events) do if e.type == "text" then table.insert(out, e.text) end end
    return table.concat(out)
  end
  return events, text
end

test("a stream that loses its connection mid-reply shows the whole reply exactly once", function(f, c)
  eq(c.welcome.turnCatchup, true)
  local conv = await(c.conversation, c, {})
  local events, text = recorder()
  local result
  conv:send("slow 40", { on_event = function(e) table.insert(events, e) end }, function(e, r) result = e or r end)
  until_(function() return #text() > 10 end)
  await(admin, f, { type = "fake_drop", refuseMs = 150 })
  until_(function() return result ~= nil end, 15000)
  eq(text(), numbers(40))
  eq(result.text, numbers(40))
end, { "--chunk-delay-ms", "8" })

test("a graceful daemon restart mid-reply: the replay goes on from what was shown, nothing twice", function(f, c)
  local conv = await(c.conversation, c, { lifetime = "ephemeral" })
  local events, text = recorder()
  local stream = conv:stream("slow 40")
  local done = false
  exo.async(function()
    for e in stream:iter() do table.insert(events, e) end
    done = true
  end)
  until_(function() return #events > 5 end)
  await(admin, f, { type = "fake_restart", downMs = 200 })
  until_(function() return done end, 15000)
  for _, e in ipairs(events) do if e.type == "reset" then error("unexpected reset") end end
  eq(text(), numbers(40))
end, { "--chunk-delay-ms", "8" })

test("a replay that sends the turn again from its start: the stream waits until it passes what was shown", function(f, c)
  local conv = await(c.conversation, c, { lifetime = "ephemeral" })
  local events, text = recorder()
  local result
  conv:send("slow 40", { on_event = function(e) table.insert(events, e) end }, function(e, r) result = e or r end)
  until_(function() return #events > 5 end)
  await(admin, f, { type = "fake_restart", downMs = 200 })
  until_(function() return result ~= nil end, 15000)
  for _, e in ipairs(events) do if e.type == "reset" then error("unexpected reset") end end
  eq(text(), numbers(40))
end, { "--chunk-delay-ms", "8", "--replay-from-start" })

test("a turn that ends while the client is away: the held turn_result completes its stream", function(f, c)
  local conv = await(c.conversation, c, {})
  local deltas = {}
  local result
  conv:send("slow 30", { on_text = function(d) table.insert(deltas, d) end }, function(e, r) result = e or r end)
  until_(function() return #deltas >= 3 end)
  await(admin, f, { type = "fake_drop", refuseMs = 600 })
  until_(function() return result ~= nil end, 15000)
  eq(table.concat(deltas), numbers(30))
  if #deltas >= 30 then error("expected the rest in one piece from the held turn_result") end
end, { "--chunk-delay-ms", "5" })

test("follow() streams a turn running when this client attached, from its start", function(f, a)
  local conv = await(a.conversation, a, { lifetime = "temporary" })
  local events_a, text_a = recorder()
  local result_a
  conv:send("slow 30", { on_event = function(e) table.insert(events_a, e) end }, function(e, r) result_a = e or r end)
  until_(function() return #text_a() > 10 end)
  local b = await(exo.connect, { app = "test-app", socket = f.socket })
  local attached = await(b.attach, b, conv.id, {})
  eq(attached.info.streaming, true)
  local followed = attached:follow()
  assert(followed, "follow() returned nil")
  local text = ""
  for e in followed:iter() do
    if e.type == "reset" then error("unexpected reset") end
    if e.type == "text" then text = text .. e.text end
  end
  eq(text, numbers(30))
  until_(function() return result_a ~= nil end, 15000)
  eq(text_a(), numbers(30))
  eq(attached:follow(), nil)
  b:close()
end, { "--chunk-delay-ms", "8" })

test("text the daemon replaces (a provider retry) is announced with a reset, then shown anew", function(f, c)
  local conv = await(c.conversation, c, {})
  local seen = {}
  for e in conv:stream("retry"):iter() do table.insert(seen, e.type == "reset" and "reset" or e.text) end
  eq(seen, { "draft", "reset", "final ", "answer" })
end)

test("a daemon without catch-ups: streams work as before and follow() has nothing to follow", function(f, c)
  eq(c.welcome.turnCatchup, nil)
  local conv = await(c.conversation, c, {})
  local stream = conv:stream("slow 10")
  eq(conv:follow(), nil)
  local text = ""
  for e in stream:iter() do if e.type == "text" then text = text .. e.text end end
  eq(text, numbers(10))
end, { "--no-turn-catchup", "--chunk-delay-ms", "5" })

for _, t in ipairs(tests) do
  if not filter or t.name:find(filter, 1, true) then
    ran = ran + 1
    local f = start_fake(t.args)
    local done, problem = false, nil
    local client
    exo.async(function()
      local needs_client = not t.args or not (vim.tbl_contains(t.args, "--no-welcome") or vim.tbl_contains(t.args, "--api-version"))
      if needs_client and t.name ~= "a stopped daemon is not running" then
        client = await(exo.connect, { app = "test-app", socket = f.socket })
      end
      t.fn(f, client)
      done = true
    end, function(e)
      problem = e
      done = true
    end)
    if not vim.wait(20000, function() return done end, 10) then problem = "timed out" end
    if client then client:close() end
    f.stop()
    if problem then
      failed = failed + 1
      io.stdout:write("FAIL " .. t.name .. "\n  " .. tostring(type(problem) == "table" and (problem.code .. ": " .. problem.message) or problem) .. "\n")
    else
      io.stdout:write("ok   " .. t.name .. "\n")
    end
  end
end
io.stdout:write(("%d tests, %d failed\n"):format(ran, failed))
os.exit(failed == 0 and ran > 0 and 0 or 1)
