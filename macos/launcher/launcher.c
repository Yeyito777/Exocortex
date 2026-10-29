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
 *        exocortex-daemon --exec PROGRAM [args...]
 *        exocortex-daemon --check-full-disk-access
 *
 * --exec runs any other background job the same way (signals, exit status),
 * so its file access is this app's too: the daemon's model-requested restart
 * executor, for one. PROGRAM is looked up on PATH. The daemon gets this
 * executable's path in EXOCORTEX_LAUNCHER for that.
 *
 * --check-full-disk-access reports whether this app has Full Disk Access, the
 * one grant that covers every file prompt (Desktop, Documents, Downloads,
 * other apps' data, volumes, ...). It prints granted, missing or unknown and
 * exits 0, 1 or 2. It never prompts: it re-runs itself as its own responsible
 * process (so the answer is the app's, not the terminal's that ran it) and
 * opens the user's TCC database, which only Full Disk Access may read and
 * whose denial is silent.
 */

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <dlfcn.h>
#include <mach-o/dyld.h>
#endif

/* Matches run-daemon.sh: configuration errors must not crash-loop silently. */
#define EXIT_CONFIG 78

/* --check-full-disk-access exit statuses. */
#define FDA_GRANTED 0
#define FDA_MISSING 1
#define FDA_UNKNOWN 2

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

/* Open the user's TCC database: readable only with Full Disk Access, and a
 * denial is EPERM without a prompt. EXOCORTEX_FDA_PROBE_PATH is for tests. */
static int probe_full_disk_access(void) {
  char path[PATH_MAX];
  const char *override = getenv("EXOCORTEX_FDA_PROBE_PATH");
  const char *home = getenv("HOME");
  int n = override && *override
    ? snprintf(path, sizeof path, "%s", override)
    : snprintf(path, sizeof path, "%s/Library/Application Support/com.apple.TCC/TCC.db", home ? home : "");
  if (n < 0 || (size_t)n >= sizeof path || (!(override && *override) && !(home && *home))) {
    fail("could not check Full Disk Access", "HOME is not set");
    return FDA_UNKNOWN;
  }
  int fd = open(path, O_RDONLY);
  if (fd >= 0) {
    close(fd);
    return FDA_GRANTED;
  }
  if (errno == EPERM || errno == EACCES) return FDA_MISSING;
  fail("could not check Full Disk Access", strerror(errno));
  return FDA_UNKNOWN;
}

/* Run the probe in a child that is its own responsible process, so TCC judges
 * this app rather than whatever launched us (a terminal, sshd, the daemon). */
static int check_full_disk_access(void) {
#ifdef __APPLE__
  typedef int (*setdisclaim_fn)(posix_spawnattr_t *, int);
  setdisclaim_fn setdisclaim = (setdisclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  char self[PATH_MAX];
  uint32_t size = sizeof self;
  if (!setdisclaim || _NSGetExecutablePath(self, &size) != 0) {
    fail("could not check Full Disk Access", "cannot run the check as this app");
    return FDA_UNKNOWN;
  }
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  int disclaimed = setdisclaim(&attr, 1) == 0;
  char *child_argv[] = { self, "--probe-full-disk-access", NULL };
  pid_t pid;
  int spawn_error = disclaimed ? posix_spawn(&pid, self, NULL, &attr, child_argv, environ) : -1;
  posix_spawnattr_destroy(&attr);
  if (spawn_error != 0) {
    fail("could not check Full Disk Access", disclaimed ? strerror(spawn_error) : "cannot disclaim responsibility");
    return FDA_UNKNOWN;
  }
  int status;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return FDA_UNKNOWN;
  }
  return WIFEXITED(status) && WEXITSTATUS(status) <= FDA_UNKNOWN ? WEXITSTATUS(status) : FDA_UNKNOWN;
#else
  return probe_full_disk_access();
#endif
}

static int report_full_disk_access(int result) {
  puts(result == FDA_GRANTED ? "granted" : result == FDA_MISSING ? "missing" : "unknown");
  return result;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--check-full-disk-access") == 0) return report_full_disk_access(check_full_disk_access());
  if (argc == 2 && strcmp(argv[1], "--probe-full-disk-access") == 0) return probe_full_disk_access();

  const char *repo = NULL;
  int exec_mode = 0;
  int argi = 1;
  while (argi < argc) {
    if (strcmp(argv[argi], "--exec") == 0) {
      exec_mode = 1;
      argi++;
      break;
    } else if (strcmp(argv[argi], "--repo") == 0 && argi + 1 < argc) {
      repo = argv[argi + 1];
      argi += 2;
    } else if (strcmp(argv[argi], "--") == 0) {
      argi++;
      break;
    } else {
      break;
    }
  }
  if (exec_mode && argi >= argc) {
    fail("no program to run", "pass --exec PROGRAM [args...]");
    return EXIT_CONFIG;
  }
  if (!exec_mode && (!repo || !*repo)) {
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
  char **child_argv;
  if (exec_mode) {
    /* argv is NULL-terminated, so its tail is the job's argv as is. */
    child_argv = &argv[argi];
  } else {
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
    if (!prepend_bun_dir_to_path(bun) || setenv("EXOCORTEX_LAUNCHER_PID", pid_value, 1) != 0
      || (argv[0][0] == '/' && setenv("EXOCORTEX_LAUNCHER", argv[0], 1) != 0)) {
      fail("could not prepare the daemon environment", strerror(errno));
      return 1;
    }

    /* /bin/bash is Apple-signed and stable; run-daemon.sh execs bun in place,
     * so after dependency hydration the child PID is the daemon itself. */
    int child_argc = argc - argi;
    child_argv = calloc((size_t)child_argc + 3, sizeof *child_argv);
    if (!child_argv) {
      fail("out of memory", NULL);
      return 1;
    }
    child_argv[0] = "/bin/bash";
    child_argv[1] = script;
    for (int i = 0; i < child_argc; i++) child_argv[i + 2] = argv[argi + i];
  }

  /* The child gets default dispositions and the original mask; it stays in
   * our process group so launchd's job cleanup covers it as before. */
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setsigmask(&attr, &original);
  posix_spawnattr_setsigdefault(&attr, &forwarded);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);

  pid_t pid;
  int spawn_error = exec_mode
    ? posix_spawnp(&pid, child_argv[0], NULL, &attr, child_argv, environ)
    : posix_spawn(&pid, child_argv[0], NULL, &attr, child_argv, environ);
  posix_spawnattr_destroy(&attr);
  if (!exec_mode) free(child_argv);
  if (spawn_error != 0) {
    fail(exec_mode ? "could not start the program" : "could not start the daemon", strerror(spawn_error));
    return exec_mode && spawn_error == ENOENT ? 127 : 1;
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
