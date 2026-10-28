import { ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  nextBlockedThread,
  planShell,
  rexLabel,
  type TabView,
  parseTabBlockLabel,
  tabBlockLabel,
  type ThreadShell,
} from "./tabs.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function thread(id: string, overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Title ${id}`,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    pendingRuntimeRequest: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function blocked(
  id: string,
  requestId: string,
  createdAt: string,
  overrides: Partial<ThreadShell> = {},
) {
  return thread(id, {
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(requestId),
      kind: "user_input",
      createdAt: at(createdAt),
    },
    ...overrides,
  });
}

/** A tab whose thread the daemon saw as `lastSeen`, labelled with its title. */
const tab = (lastSeen?: ThreadShell): TabView => ({
  label: lastSeen === undefined ? "New thread" : rexLabel(lastSeen.title),
  lastSeen,
});

const shell = (
  threads: ReadonlyArray<ThreadShell>,
  removed: ReadonlyArray<string> = [],
  olderSettledBefore?: number,
) => ({ threads, removed: new Set(removed), olderSettledBefore });

describe("planShell", () => {
  it("closes tabs of archived and deleted threads, and keeps tabs of threads the shell left out", () => {
    const settled = thread("settled", {
      settledOverride: "settled",
      settledAt: at("2026-10-01T00:00:00.000Z"),
    });
    const tabs = new Map<string, TabView>([
      ["archived", tab(thread("archived"))],
      ["deleted-in-place", tab(thread("deleted-in-place"))],
      ["gone-after-resync", tab(thread("gone-after-resync"))],
      ["older-settled", tab(settled)],
      ["not-launched-yet", tab()],
      ["unknown-after-restart", tab()],
      ["live", tab(thread("live"))],
    ]);
    const plan = planShell(
      tabs,
      new Map(),
      shell(
        [thread("deleted-in-place", { deletedAt: at("2026-10-28T00:00:00.000Z") }), thread("live")],
        ["archived"],
        Date.parse("2026-10-20T00:00:00.000Z"),
      ),
    );
    expect(plan.close).toEqual(["archived", "deleted-in-place", "gone-after-resync"]);
    expect(plan.relabel).toEqual([]);
    expect(plan.openBlocked).toEqual([]);
  });

  it("relabels tabs whose thread was renamed", () => {
    const plan = planShell(
      new Map([["t1", tab()]]),
      new Map(),
      shell([thread("t1", { title: "Fix\u0007 login" })]),
    );
    expect(plan.relabel).toEqual([{ threadId: "t1", label: "Fix  login" }]);
  });

  it("opens blocked threads without tabs, unless the user closed the tab on that same request", () => {
    const threads = [
      blocked("waiting", "r1", "2026-10-28T00:00:00.000Z"),
      blocked("has-tab", "r2", "2026-10-28T00:00:00.000Z"),
      blocked("closed-on-r3", "r3", "2026-10-28T00:00:00.000Z"),
      blocked("closed-on-old", "r5", "2026-10-28T00:00:00.000Z"),
      blocked("subagent", "r6", "2026-10-28T00:00:00.000Z", {
        lineage: {
          parentThreadId: ThreadId.make("waiting"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("waiting"),
        },
      }),
      thread("async-question", {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("r7"),
          kind: "user_input",
          createdAt: at("2026-10-28T00:00:00.000Z"),
          blocking: false,
        },
      }),
    ];
    const plan = planShell(
      new Map([["has-tab", tab(threads[1])]]),
      new Map([
        ["closed-on-r3", "r3"],
        ["closed-on-old", "r4"],
      ]),
      shell(threads),
    );
    expect(plan.openBlocked).toEqual(["waiting", "closed-on-old"]);
  });
});

describe("nextBlockedThread", () => {
  it("goes oldest request first and wraps around", () => {
    const threads = [
      blocked("newer", "r2", "2026-10-28T00:02:00.000Z"),
      thread("idle"),
      blocked("older", "r1", "2026-10-28T00:01:00.000Z"),
    ];
    expect(nextBlockedThread(threads, undefined)?.id).toBe("older");
    expect(nextBlockedThread(threads, "older")?.id).toBe("newer");
    expect(nextBlockedThread(threads, "newer")?.id).toBe("older");
    expect(nextBlockedThread([thread("idle")], undefined)).toBeUndefined();
  });
});

describe("tab labels", () => {
  it("finds the thread and its project in a tab's block label", () => {
    expect(parseTabBlockLabel(tabBlockLabel("1b2c-3d", "p-9"))).toEqual({
      threadId: "1b2c-3d",
      projectId: "p-9",
    });
    expect(parseTabBlockLabel("tr3x:1b2c-3d")).toEqual({
      threadId: "1b2c-3d",
      projectId: undefined,
    });
    expect(parseTabBlockLabel("shell")).toBeUndefined();
    expect(parseTabBlockLabel("tr3x:")).toBeUndefined();
    expect(parseTabBlockLabel("tr3x:a b")).toBeUndefined();
  });

  it("keeps window labels within Rex's limit and never empty", () => {
    expect(rexLabel("x".repeat(200))).toHaveLength(128);
    expect(rexLabel("x".repeat(200)).endsWith("…")).toBe(true);
    expect(rexLabel(" \u0000 ")).toBe("New thread");
  });
});
