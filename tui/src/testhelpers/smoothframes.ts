import { render } from "../render";
import type { RenderState } from "../state";

/** Everything one render writes to the terminal. */
export function captureRender(state: RenderState): string {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
  }
  return out;
}

/** Eased moves (OSC 2032 ; m ; dA ; B ; D with B != 0): a glide. */
export const glides = (out: string) => [...out.matchAll(/\x1b\]2032;m;-?\d+;(-?\d+);\d+\x1b\\/g)].filter(match => match[1] !== "0");
