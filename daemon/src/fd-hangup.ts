/**
 * Asks poll(2) whether a file descriptor's peer has gone. Streams can't tell:
 * a broken pipe only surfaces on the next write, and a paused socket never
 * reads far enough to see its peer's close.
 */

const POLLIN = 0x1;
const POLLOUT = 0x4;
const POLLERR = 0x8;
const POLLHUP = 0x10;
const POLLNVAL = 0x20;

type PollFn = (fd: number) => number;

function loadPoll(): PollFn | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
      poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    });
    const pollfd = new DataView(new ArrayBuffer(8));
    const pointer = ptr(pollfd);
    return (fd) => {
      pollfd.setInt32(0, fd, true);
      // macOS reports nothing at all for an fd polled with no events.
      pollfd.setInt16(4, POLLIN | POLLOUT, true);
      pollfd.setInt16(6, 0, true);
      libc.symbols.poll(pointer, 1, 0);
      return pollfd.getInt16(6, true);
    };
  } catch {
    return null;
  }
}

let poll: PollFn | null | undefined;

/** Loaded on the first call, so a short-lived caller doesn't pay for it. Always false where libc can't be loaded. */
export function hasHungUp(fd: number): boolean {
  poll ??= loadPoll();
  return poll !== null && (poll(fd) & (POLLERR | POLLHUP | POLLNVAL)) !== 0;
}
