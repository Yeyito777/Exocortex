# SSH connection reuse

`/ssh <alias>` and `exocortex --ssh <alias>` run `ssh <alias> exocortexd proxy`.
A fresh OpenSSH connection spends about ten round trips (TCP, key exchange,
authentication, channel) before the remote command starts: at 100 ms RTT
that was most of a cold start (~1.1 s to the first frame). The TUI now shares
one connection per alias through a private OpenSSH ControlMaster, so a later
launch, a reconnect after a daemon restart, or a second TUI skips the
handshake (~0.37 s to the first frame).

- **Where**: `config/runtime/ssh/<alias>.sock` (directory mode 0700). When that
  path is too long for a Unix socket (OpenSSH binds it with a 17-character
  temporary suffix; macOS allows 104 bytes) or contains spaces, a per-user
  directory `$TMPDIR/exocortex-ssh-<uid>/` (mode 0700, checked to be ours)
  holds `<hash of runtime dir and alias>.sock` instead. If neither can be made
  private, the TUI connects without reuse.
- **Lifetime**: `ControlPersist=10m`: the shared connection stays up ten minutes
  after its last session closes, then exits. The first session to find no live
  master becomes one (`ControlMaster=auto`); the master runs in the background
  in its own session, so closing the terminal doesn't end it.
- **Options**: the master is always created by Exocortex with its own options
  (compression, `BatchMode`, `ServerAliveInterval=15`/`CountMax=3`); a master
  from the user's own `~/.ssh/config` is never joined. The daemon's `/proxy`
  links don't use reuse.
- **Stale or dead masters**: a socket left by a master that exited is removed
  by ssh, which then connects afresh. A master whose own connection died
  (a laptop that slept onto another network) still accepts sessions that never
  get an answer until its keepalive gives up (~45 s). A probe that rides an
  existing master and has no reply within 2.5 s therefore starts a second,
  unshared connection; the first to answer wins, and when the fresh one wins
  the old master is told to exit (`ssh -O exit`) so the next connection makes a
  healthy one. Measured with a silently dropped connection: 5.2 s to the first
  frame instead of the 15 s probe timeout.

## Security tradeoff

While a master runs (in use, or up to ten minutes after), **any process running
as the same local user** can open new sessions to that host through the
socket without authenticating: no key, agent prompt or passphrase is asked
again. The directory is private to the user (0700, owner checked), so other
users can't. A process running as the user could already use the same keys
and agent, so this mainly removes re-authentication for the reuse window, and
a hardware key or agent confirmation is not asked for sessions opened through
the master. To end it at once: `ssh -O exit -o ControlPath=<socket> <alias>`,
or remove the socket's directory.

Implementation: `tui/src/ssh-mux.ts` (paths, spawning, fallback policy) and
`sshProxyArgs` / `probeSshProxyWithFallback` in `shared/src/ssh-transport.ts`.
