// Ralph Loop — Copilot CLI / app extension (spec §8, FR-1, FR-6).
//
// Adds the ralph_* tools for the agent, the /ralph-* slash commands for the
// user, and token metering from assistant.usage events. The loop itself is
// driven by the agentStop hook; this extension *arms* it, kicks iteration 1
// with session.send(), and re-kicks after the CLI's 8-consecutive-block cap.
// The hook-and-skill core works without this extension (it is experimental).

import { joinSession } from "@microsoft/copilot-sdk/extension";
import {
  initLoop, stopLoop, resumeLoop, readStatus, readState, writeState, appendProgress,
  addUsage, buildIterationPrompt, completeStory, nextStory, readPrd, hasLoop,
} from "../../../lib/core.mjs";
import { parseArgs } from "../../../lib/args.mjs";

const cwd = () => process.env.RALPH_CWD || process.cwd();
let session;

function fmtStatus(s) {
  if (!s.active && !s.status) return s.message;
  const lines = [
    `Ralph loop: ${s.status} (iteration ${s.iteration}/${s.maxIterations}, mode ${s.mode})`,
    `Stories: ${s.stories.done}/${s.stories.total} passing` + (s.nextStory ? ` — next: ${s.nextStory.id} ${s.nextStory.title}` : ""),
    `Tokens: ${s.tokens.toLocaleString()} / ${s.maxTokens.toLocaleString()}   Branch: ${s.branch ?? "(none)"}   Last: ${s.lastReason}`,
  ];
  return lines.join("\n");
}

async function kick(note) {
  const st = readState(cwd());
  const prompt = buildIterationPrompt(cwd(), st, {});
  if (note) await session.log(note, { level: "info" });
  await session.send({ prompt });
}

session = await joinSession({
  tools: {
    definitions: [
      {
        name: "ralph_status",
        description: "Return the current Ralph loop status: iteration, limits, token use and remaining stories.",
        parameters: { type: "object", properties: {} },
        handler: async () => JSON.stringify(readStatus(cwd()), null, 2),
      },
      {
        name: "ralph_log_learning",
        description: "Append a concise learning (what was done, learned, or what failed) to .ralph/progress.md.",
        parameters: { type: "object", properties: { text: { type: "string", description: "The learning, 1-5 lines" } }, required: ["text"] },
        handler: async ({ text }) => { appendProgress(cwd(), text); return "ok"; },
      },
      {
        name: "ralph_next_story",
        description: "Return the single highest-priority story whose passes is false, or null when all pass.",
        parameters: { type: "object", properties: {} },
        handler: async () => JSON.stringify(nextStory(readPrd(cwd()))),
      },
      {
        name: "ralph_complete_story",
        description: "Mark a story as passing in .ralph/prd.json. Only call after the verification command is green.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: async ({ id }) => JSON.stringify(completeStory(cwd(), id, true)),
      },
    ],
  },
  interaction: {
    commands: [
      {
        name: "ralph-start",
        description: "Start a Ralph loop: /ralph-start <spec-or-prd-path> [--max N] [--budget TOKENS] [--verify \"cmd\"] [--review]",
        handler: async (ctx) => {
          try {
            const a = parseArgs(ctx.args || "");
            const st = initLoop(cwd(), { source: a.positional[0], limits: a.limits, mode: "in-session", branch: a.branch, force: a.force });
            await session.log(`Ralph loop armed on ${st.branch ?? "current branch"} — max ${st.limits.maxIterations} iterations, verify: ${st.limits.verifyCmd}`, { level: "info" });
            if (a.dryRun) { stopLoop(cwd(), "dry_run"); await session.log(buildIterationPrompt(cwd(), st, {}), { level: "info" }); return; }
            await kick();
          } catch (e) { await session.log(`ralph-start failed: ${e.message}`, { level: "error" }); }
        },
      },
      {
        name: "ralph-stop",
        description: "Stop the active Ralph loop (the agent may finish its current turn).",
        handler: async () => {
          if (!hasLoop(cwd())) return session.log("No Ralph loop here.", { level: "warning" });
          stopLoop(cwd(), "user");
          await session.log("Ralph loop stopped.", { level: "info" });
        },
      },
      {
        name: "ralph-status",
        description: "Show Ralph loop status.",
        handler: async () => session.log(fmtStatus(readStatus(cwd())), { level: "info" }),
      },
      {
        name: "ralph-resume",
        description: "Resume a stopped/paused Ralph loop from .ralph/state.json.",
        handler: async () => {
          try { resumeLoop(cwd()); await kick("Ralph loop resumed."); }
          catch (e) { await session.log(`ralph-resume failed: ${e.message}`, { level: "error" }); }
        },
      },
    ],
  },
});

// Token metering (FR-5): assistant.usage -> .ralph/usage.json (read by the hook).
session.on("assistant.usage", (e) => {
  try {
    if (!hasLoop(cwd()) || readState(cwd()).status !== "running") return;
    addUsage(cwd(), e.data?.inputTokens ?? 0, e.data?.outputTokens ?? 0);
  } catch { /* metering must never break the session */ }
});

// The CLI ends a turn after 8 consecutive agentStop blocks; re-kick if the
// controller still wants to continue.
session.on("session.idle", async () => {
  try {
    if (!hasLoop(cwd())) return;
    const st = readState(cwd());
    if (st.status !== "running" || st.mode !== "in-session" || !st.needsKick) return;
    st.needsKick = false; st.consecutiveBlocks = 0; writeState(cwd(), st);
    await kick(`Ralph: continuing after the CLI's per-turn continuation cap (iteration ${st.iteration}).`);
  } catch (e) { await session.log(`ralph re-kick failed: ${e.message}`, { level: "warning" }); }
});
