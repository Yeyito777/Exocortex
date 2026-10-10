import { chronoShortId } from "@exocortex/shared/chrono";
import { CHRONO_USAGE, parseChronoArgs } from "../chronoschedule";
import { clearPrompt } from "../promptstate";
import { formatQueueDueTime } from "../queue";
import { pushSystemMessage } from "../state";
import type { CompletionItem, SlashCommand } from "./types";

function scheduleCompletionItems(state: Parameters<SlashCommand["handler"]>[1]): CompletionItem[] {
  const tasks = state.sidebar.conversations.find(conversation => conversation.id === state.convId)?.tasks ?? [];
  const schedules = tasks.filter(task => task.kind === "chrono" && task.chronoMode === "wake" && task.id.startsWith("chrono:"));
  return [
    ...schedules.map(task => ({
      name: chronoShortId(task.id),
      desc: task.dueAt === undefined ? task.title : `${formatQueueDueTime(task.dueAt)} · ${task.title}`,
    })),
    ...(schedules.length ? [{ name: "all", desc: "cancel every schedule in this conversation" }] : []),
  ];
}

export const CHRONO_COMMAND: SlashCommand = {
  name: "/chrono",
  description: "Schedule a message or shell command, once or repeating",
  getArgs: (state) => ({
    "/chrono": [
      { name: "list", desc: "show this conversation's schedules" },
      { name: "cancel", desc: "cancel a schedule" },
      { name: "in", desc: "once after a delay: in 2h 30m <message>" },
      { name: "at", desc: "once at a time: at tomorrow 9am <message>" },
      { name: "every", desc: "repeat: every day at 9am <message>" },
      { name: "help", desc: "show the time syntax" },
    ],
    "/chrono cancel": scheduleCompletionItems(state),
    "/chrono every": [
      { name: "day", desc: "every day at 9am <message>" },
      { name: "weekday", desc: "Monday to Friday: every weekday at 8:30 <message>" },
      { name: "weekend", desc: "Saturday and Sunday" },
      { name: "week", desc: "every week at fri 17:00 <message>" },
      { name: "month", desc: "every month at 2026-11-01 9am <message>" },
      { name: "hour", desc: "every hour, or every 2h, 90m …" },
    ],
  }),
  handler(text, state) {
    const args = text.slice("/chrono".length);
    if (args.trim() === "help") {
      pushSystemMessage(state, CHRONO_USAGE);
      clearPrompt(state);
      return { type: "handled" };
    }
    const parsed = parseChronoArgs(args);
    if ("error" in parsed) {
      pushSystemMessage(state, parsed.error === CHRONO_USAGE ? parsed.error : `${parsed.error}\n${CHRONO_USAGE}`);
      return { type: "handled" };
    }
    return { type: "chrono", request: parsed };
  },
};
