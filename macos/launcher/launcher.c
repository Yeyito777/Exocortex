/*
 * Exocortex Daemon launcher (macOS).
 *
 * launchd runs this signed executable inside "Exocortex Daemon.app" as the
 * com.exocortex.daemon LaunchAgent program. It stays alive as the parent of
 * the daemon so TCC treats this bundle (dev.yeyito.exocortex.daemon), not the
 * ad-hoc signed Homebrew bash/bun, as the responsible process for everything
 * the daemon spawns. Privacy consents then stick across restarts and upgrades.
 *
 * It resolves bun at launch time (so Homebrew/bun upgrades need no rebuild),
 * posix_spawns scripts/setup/run-daemon.sh exactly like `exocortexd` with no
 * subcommand, forwards termination signals to the child, and exits with the
 * child's status so launchd KeepAlive, `launchctl kickstart -k`, `exocortexd
 * stop` and the daemon's restart exit code (75) behave as before.
 *
 * Usage: exocortex-daemon --repo DIR [--] [daemon args...]
 */

#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/* Matches run-daemon.sh: configuration errors must not crash-loop silently. */
#define EXIT_CONFIG 78

extern char **environ;

static const int forwarded_signals[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2 };
#define FORWARDED_COUNT (sizeof forwarded_signals / sizeof forwarded_signals[0])

static volatile pid_t child_pid = 0;

static void forward_signal(int sig) {
  pid_t pid = child_pid;
  if (pid > 0) kill(pid, sig);
}

static void fail(const char *message, const char *detail) {
  fprintf(stderr, "exocortex-daemon: %s%s%s\n", message, detail ? ": " : "", detail ? detail : "");
}

static int is_executable_file(const char *path) {
  struct stat st;
  return path && *path && stat(path, &st) == 0 && S_ISREG(st.st_mode) && access(path, X_OK) == 0;
}

/* EXOCORTEX_BUN, then PATH, then the usual install locations. */
static int resolve_bun(char *out, size_t size) {
  const char *explicit_bun = getenv("EXOCORTEX_BUN");
  if (explicit_bun && *explicit_bun) {
    if (!is_executable_file(explicit_bun)) return 0;
    return snprintf(out, size, "%s", explicit_bun) < (int)size;
  }

  const char *path = getenv("PATH");
  if (path) {
    const char *start = path;
    for (;;) {
      const char *end = strchr(start, ':');
      size_t len = end ? (size_t)(end - start) : strlen(start);
      if (len > 0 && start[0] == '/') {
        int n = snprintf(out, size, "%.*s/bun", (int)len, start);
        if (n > 0 && (size_t)n < size && is_executable_file(out)) return 1;
      }
      if (!end) break;
      start = end + 1;
    }
  }

  const char *home = getenv("HOME");
  const char *home_candidates[] = { "/.bun/bin/bun", "/.local/bin/bun" };
  for (size_t i = 0; home && i < sizeof home_candidates / sizeof home_candidates[0]; i++) {
    int n = snprintf(out, size, "%s%s", home, home_candidates[i]);
    if (n > 0 && (size_t)n < size && is_executable_file(out)) return 1;
  }
  const char *system_candidates[] = { "/opt/homebrew/bin/bun", "/usr/local/bin/bun" };
  for (size_t i = 0; i < sizeof system_candidates / sizeof system_candidates[0]; i++) {
    if (is_executable_file(system_candidates[i])) return snprintf(out, size, "%s", system_candidates[i]) < (int)size;
  }
  return 0;
}

/* Put bun's directory first on PATH so the daemon and its scripts use it. */
static int prepend_bun_dir_to_path(const char *bun) {
  const char *slash = strrchr(bun, '/');
  if (!slash || slash == bun) return 1;
  size_t dir_len = (size_t)(slash - bun);
  const char *path = getenv("PATH");
  if (path && strncmp(path, bun, dir_len) == 0 && (path[dir_len] == ':' || path[dir_len] == '\0')) return 1;

  size_t size = dir_len + 1 + (path ? strlen(path) : 0) + 1;
  char *value = malloc(size);
  if (!value) return 0;
  if (path && *path) snprintf(value, size, "%.*s:%s", (int)dir_len, bun, path);
  else snprintf(value, size, "%.*s", (int)dir_len, bun);
  int ok = setenv("PATH", value, 1) == 0;
  free(value);
  return ok;
}

int main(int argc, char **argv) {
  const char *repo = NULL;
  int argi = 1;
  while (argi < argc) {
    if (strcmp(argv[argi], "--repo") == 0 && argi + 1 < argc) {
      repo = argv[argi + 1];
      argi += 2;
    } else if (strcmp(argv[argi], "--") == 0) {
      argi++;
      break;
    } else {
      break;
    }
  }
  if (!repo || !*repo) {
    fail("no repository directory", "pass --repo DIR");
    return EXIT_CONFIG;
  }

  /* Block forwarded signals until the child's PID is recorded; any that
   * arrive meanwhile stay pending and are forwarded once unblocked. */
  sigset_t forwarded, original;
  sigemptyset(&forwarded);
  for (size_t i = 0; i < FORWARDED_COUNT; i++) sigaddset(&forwarded, forwarded_signals[i]);
  sigprocmask(SIG_BLOCK, &forwarded, &original);

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  for (size_t i = 0; i < FORWARDED_COUNT; i++) sigaction(forwarded_signals[i], &action, NULL);

  char script[PATH_MAX];
  if (snprintf(script, sizeof script, "%s/scripts/setup/run-daemon.sh", repo) >= (int)sizeof script || !is_executable_file(script)) {
    fail("daemon script not found or not executable", script);
    return EXIT_CONFIG;
  }

  char bun[PATH_MAX];
  if (!resolve_bun(bun, sizeof bun)) {
    fail("bun not found", "set EXOCORTEX_BUN or add bun's directory to PATH in the LaunchAgent");
    return EXIT_CONFIG;
  }
  char pid_value[32];
  snprintf(pid_value, sizeof pid_value, "%ld", (long)getpid());
  if (!prepend_bun_dir_to_path(bun) || setenv("EXOCORTEX_LAUNCHER_PID", pid_value, 1) != 0) {
    fail("could not prepare the daemon environment", strerror(errno));
    return 1;
  }

  /* /bin/bash is Apple-signed and stable; run-daemon.sh execs bun in place,
   * so after dependency hydration the child PID is the daemon itself. */
  int child_argc = argc - argi;
  char **child_argv = calloc((size_t)child_argc + 3, sizeof *child_argv);
  if (!child_argv) {
    fail("out of memory", NULL);
    return 1;
  }
  child_argv[0] = "/bin/bash";
  child_argv[1] = script;
  for (int i = 0; i < child_argc; i++) child_argv[i + 2] = argv[argi + i];

  /* The child gets default dispositions and the original mask; it stays in
   * our process group so launchd's job cleanup covers it as before. */
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setsigmask(&attr, &original);
  posix_spawnattr_setsigdefault(&attr, &forwarded);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);

  pid_t pid;
  int spawn_error = posix_spawn(&pid, child_argv[0], NULL, &attr, child_argv, environ);
  posix_spawnattr_destroy(&attr);
  free(child_argv);
  if (spawn_error != 0) {
    fail("could not start the daemon", strerror(spawn_error));
    return 1;
  }
  child_pid = pid;
  sigprocmask(SIG_SETMASK, &original, NULL);

  int status;
  for (;;) {
    pid_t waited = waitpid(pid, &status, 0);
    if (waited == pid) break;
    if (waited < 0 && errno == EINTR) continue;
    fail("waitpid failed", strerror(errno));
    return 1;
  }

  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    /* Die the same way so launchd sees the same termination. */
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    sigset_t only;
    sigemptyset(&only);
    sigaddset(&only, sig);
    sigprocmask(SIG_UNBLOCK, &only, NULL);
    raise(sig);
    return 128 + sig;
  }
  return 1;
}
