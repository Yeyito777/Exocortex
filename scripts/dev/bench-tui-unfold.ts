// Read-only benchmark: the render that shows a loaded conversation's folded
// work (Ctrl+O) or detail view (Ctrl+I), against an explicitly supplied
// database. Prints timings, never transcript text.
//
//   EXOCORTEX_CONFIG_DIR=$(mktemp -d) bun scripts/dev/bench-tui-unfold.ts DATABASE CONV_ID [--turns N] [--cols C] [--rows R] [--runs N]
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";
import { createInitialState } from "../../tui/src/state";
import { pushDisplayEntries } from "../../tui/src/events/display";
import { render } from "../../tui/src/render";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const [path, convId] = args;
if (!path || !convId) throw new Error("Usage: bun scripts/dev/bench-tui-unfold.ts DATABASE CONV_ID [--turns N] [--cols C] [--rows R] [--runs N]");
const store = new SqliteConversationStore({ path, readonly: true });
const page = store.loadDisplayPage(convId, flag("--turns", 100))!;
store.close();
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as typeof process.stdout.write;
const results: Record<string, number[]> = { ctrlO: [], ctrlOScrolled: [], ctrlI: [], fold: [] };
let lines = 0;
for (let run = 0; run < flag("--runs", 5); run++) {
  const fresh = () => {
    const state = createInitialState();
    state.cols = flag("--cols", 200); state.rows = flag("--rows", 50); state.convId = convId;
    state.showTurnWork = false; state.showToolOutput = false;
    // A reopened conversation's objects are new, as the render caches see them.
    pushDisplayEntries(state, JSON.parse(JSON.stringify([...page.pinnedEntries, ...page.entries])));
    render(state);
    return state;
  };
  const time = (name: string, state: ReturnType<typeof fresh>, mutate: () => void) => {
    mutate();
    const t = performance.now();
    render(state);
    results[name]!.push(performance.now() - t);
  };
  let state = fresh();
  time("ctrlO", state, () => { state.showTurnWork = true; });
  lines = state.historyLines.length;
  time("fold", state, () => { state.showTurnWork = false; });
  state = fresh();
  state.scrollOffset = 200;
  time("ctrlOScrolled", state, () => { state.showTurnWork = true; });
  state = fresh();
  time("ctrlI", state, () => { state.showToolOutput = true; });
}
const stat = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: +sorted[Math.floor(sorted.length / 2)]!.toFixed(1), max: +sorted.at(-1)!.toFixed(1) };
};
realWrite(JSON.stringify({ convId, entries: page.entries.length, unfoldedLines: lines,
  ...Object.fromEntries(Object.entries(results).map(([name, values]) => [name, stat(values)])) }) + "\n");
