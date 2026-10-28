// @effect-diagnostics nodeBuiltinImport:off -- Drives real tr3x, T3 server and Rex processes, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveTr3xPaths } from "../paths.ts";
import { CLI, spawnBun, waitForLine } from "../testing/bunProcess.ts";
import { startDaemon } from "../testing/daemonFixture.ts";
import { installFakeProviders } from "../testing/fakeProviders.ts";
import { startScratchRex } from "../testing/rexFixture.ts";
import { createViewConnection } from "../view/connection.ts";
import { readDaemonState } from "./daemonState.ts";
import { issueLocalSession, listLocalSessions } from "./localSession.ts";

// Runs whatever happens to the test, last step first: daemons, then Rex (which
// ends the views in its tabs), then the directory they ran in.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const NODE_ENV = { TR3X_NODE_BIN: process.execPath };

async function setUp() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-tabs-"));
  cleanup.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const home = NodePath.join(dir, "home");
  const work = NodePath.join(dir, "work");
  NodeFS.mkdirSync(work);
  installFakeProviders(home, "Hello from the fake provider.");
  const rex = await startScratchRex(dir);
  cleanup.push(() => rex.stop());
  const env = { TR3X_REX_SERVER: rex.server };
  const daemon = () => {
    const fixture = startDaemon(home, env);
    cleanup.push(async () => void (await fixture.stop()));
    return fixture;
  };
  /** Runs a `tr3x` command against the daemon and returns what it printed. */
  const tr3x = async (...args: ReadonlyArray<string>) => {
    const run = spawnBun([CLI, ...args], { ...env, TR3X_HOME: home }, (step) => cleanup.push(step));
    const code = await run.exited;
    expect(code, run.output()).toBe(0);
    return run.output();
  };
  const tabs = () => rex.labelledBlocks().filter((block) => block.label.startsWith("tr3x:"));
  const tabSessions = async (threadId: string) =>
    (await listLocalSessions(home, NODE_ENV)).filter(
      (session) => session.subject === `tr3x-tab:${threadId}`,
    );
  /** A client of the daemon's server, as web would be: its own session, through the T3 API. */
  const apiConnection = async () => {
    const state = readDaemonState(resolveTr3xPaths({ TR3X_HOME: home }).daemonStatePath)!;
    const bearer = await issueLocalSession({
      baseDir: home,
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      ttl: "5m",
      label: "tr3x test",
      env: NODE_ENV,
    });
    const connection = createViewConnection({
      environmentId: EnvironmentId.make(state.environmentId),
      label: "tr3x test",
      httpBaseUrl: state.httpBaseUrl,
      wsBaseUrl: state.wsBaseUrl,
      bearerToken: async () => bearer.token,
    });
    cleanup.push(() => connection.dispose());
    // Commands need a live connection; the shell subscription holds one open.
    cleanup.push(connection.registry.mount(connection.shellStateAtom));
    await connection.shellSnapshot(AbortSignal.timeout(20_000));
    return connection;
  };
  return { home, work, rex, daemon, tr3x, tabs, tabSessions, apiConnection };
}

/** Command lines of every process whose arguments mention `text`. */
function processesMentioning(text: string): ReadonlyArray<string> {
  return NodeChildProcess.execFileSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(text));
}

describe("tr3x daemon tabs", () => {
  it("opens, relabels, hides, reopens and closes a thread's tab, across a daemon restart", async () => {
    const { home, work, rex, daemon, tr3x, tabs, tabSessions, apiConnection } = await setUp();
    const paths = resolveTr3xPaths({ TR3X_HOME: home });
    const first = daemon();
    await waitForLine(first.daemon, /found 0 thread tab\(s\) in Rex/u);

    // New Thread opens a tab, labelled for the thread, in the project's session.
    const opened = JSON.parse(await tr3x("new", "--cwd", work)) as {
      threadId: string;
      sessionId: string;
      windowId: string;
    };
    const { threadId } = opened;
    await waitForLine(first.daemon, new RegExp(`handed thread ${threadId}'s tab its session`, "u"));
    const [tab] = tabs();
    expect(tabs()).toEqual([
      expect.objectContaining({
        label: `tr3x:${threadId}`,
        sessionId: opened.sessionId,
        sessionLabel: "work",
        windowId: opened.windowId,
        windowLabel: "New thread",
      }),
    ]);
    await rex.waitForProgramStatus(tab!.sessionId, tab!.blockId);

    // The view took its bearer from the one-shot launch file: only the file's path is in argv.
    expect(NodeFS.readdirSync(paths.launchDir)).toEqual([]);
    const launched = processesMentioning(paths.launchDir);
    expect(launched.length).toBeGreaterThan(0);
    for (const line of launched) {
      expect(line).toMatch(/env TR3X_LAUNCH=\S+\/[\w-]+\.json \S+ \S+\/cli\.ts view$/u);
    }
    for (const line of processesMentioning(home)) expect(line).not.toMatch(/token|bearer|eyJ/iu);
    expect(await tabSessions(threadId)).toHaveLength(1);

    // The first message launches the thread; its title becomes the tab's label.
    rex.rex("send", "-s", tab!.sessionId, "-b", tab!.blockId, "Say hello");
    rex.rex("send-key", "-s", tab!.sessionId, "-b", tab!.blockId, "enter");
    await waitForLine(first.daemon, new RegExp(`relabelled thread ${threadId}'s tab`, "u"));
    expect(tabs()).toEqual([expect.objectContaining({ windowLabel: "Say hello" })]);

    // Closing the tab hides the thread, without archiving it, and revokes the tab's session.
    let mark = first.daemon.output().length;
    rex.rex("window", "close", "-s", tab!.sessionId, tab!.windowId);
    await waitForLine(
      first.daemon,
      new RegExp(`revoked 1 session\\(s\\) for thread ${threadId}`, "u"),
      mark,
    );
    expect(first.daemon.output().slice(mark)).toContain("hiding the thread");
    expect(tabs()).toEqual([]);
    expect(await tabSessions(threadId)).toEqual([]);

    // Open brings it back in a new tab with a new session.
    mark = first.daemon.output().length;
    await tr3x("open", threadId);
    await waitForLine(
      first.daemon,
      new RegExp(`handed thread ${threadId}'s tab its session`, "u"),
      mark,
    );
    const [reopened] = tabs();
    expect(reopened).toEqual(
      expect.objectContaining({ label: `tr3x:${threadId}`, windowLabel: "Say hello" }),
    );
    expect(reopened!.blockId).not.toBe(tab!.blockId);

    // A daemon killed outright, then started again, finds the tab instead of opening another.
    first.daemon.child.kill("SIGKILL");
    await first.stop();
    const second = daemon();
    await waitForLine(second.daemon, /found 1 thread tab\(s\) in Rex/u);
    expect(tabs()).toEqual([expect.objectContaining({ blockId: reopened!.blockId })]);

    // Archiving through the T3 API closes the tab and revokes its session.
    const connection = await apiConnection();
    mark = second.daemon.output().length;
    expect(await connection.archiveThread({ threadId: ThreadId.make(threadId) })).toEqual({
      ok: true,
    });
    await waitForLine(
      second.daemon,
      new RegExp(`revoked 1 session\\(s\\) for thread ${threadId}`, "u"),
      mark,
    );
    expect(second.daemon.output().slice(mark)).toContain("the thread was archived or deleted");
    expect(tabs()).toEqual([]);
    expect(await tabSessions(threadId)).toEqual([]);
  });

  it("opens a background tab for a thread that blocks without one, and Next Blocked goes there", async () => {
    const { work, daemon, tr3x, tabs, apiConnection } = await setUp();
    const owner = daemon();
    await waitForLine(owner.daemon, /found 0 thread tab\(s\) in Rex/u);
    expect(JSON.parse(await tr3x("next-blocked"))).toBeNull();

    // A thread started elsewhere, e.g. in web, on a provider that asks before running a command.
    const connection = await apiConnection();
    const projectId = ProjectId.make(NodeCrypto.randomUUID());
    expect(
      await connection.createProject({ projectId, title: "work", workspaceRoot: work }),
    ).toEqual({ ok: true });
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const modelSelection = { instanceId: ProviderInstanceId.make("grokB"), model: "grok-4.6" };
    expect(
      await connection.startTurn({
        threadId,
        message: {
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          role: "user",
          text: "Run the tool",
          attachments: [],
        },
        modelSelection,
        titleSeed: "Run the tool",
        runtimeMode: "approval-required",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            title: "Run the tool",
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-10-28T00:00:00.000Z",
          },
        },
      }),
    ).toEqual({ ok: true });

    await waitForLine(owner.daemon, new RegExp(`handed thread ${threadId}'s tab its session`, "u"));
    expect(tabs()).toEqual([
      expect.objectContaining({ label: `tr3x:${threadId}`, sessionLabel: "work" }),
    ]);
    const next = JSON.parse(await tr3x("next-blocked")) as { threadId: string };
    expect(next.threadId).toBe(threadId);
    expect(tabs()).toHaveLength(1);
  });
});
