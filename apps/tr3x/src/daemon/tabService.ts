// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The daemon runs on Bun outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { Tr3xPaths } from "../paths.ts";
import { describeError } from "../redact.ts";
import { makeRexClient, parseRexEvent, type RexEvent, resolveRexCli } from "../rex/rex.ts";
import { createViewConnection } from "../view/connection.ts";
import { resolveProject } from "../view/resolveProject.ts";
import { sessionBearer } from "../view/sessionBearer.ts";
import type { ControlRequest } from "./control.ts";
import { type LaunchFile, newLaunchFilePath, writeLaunchFile } from "./launchFile.ts";
import {
  issueLocalSession,
  type IssuedSession,
  listLocalSessions,
  revokeLocalSession,
} from "./localSession.ts";
import {
  blockingRequestId,
  nextBlockedThread,
  planShell,
  rexLabel,
  tabBlockLabel,
  type ThreadShell,
  threadIdOfBlockLabel,
} from "./tabs.ts";

const CLI = NodeURL.fileURLToPath(new URL("../cli.ts", import.meta.url));
const SESSION_TTL = "1h";
const SESSION_REFRESH_MS = 5 * 60_000;
/** A launch file no view has read by then is deleted. */
const LAUNCH_FILE_TTL_MS = 60_000;
const REX_RETRY_MS = 2_000;
const TAB_SUBJECT_PREFIX = "tr3x-tab:";
const DAEMON_SUBJECT = "tr3x-daemon";

export interface TabServiceOptions {
  readonly paths: Tr3xPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly server: LaunchFile["server"];
  readonly log: (line: string) => void;
}

interface Tab {
  readonly threadId: string;
  readonly sessionId: string;
  readonly windowId: string;
  readonly blockId: string;
  label: string;
  lastSeen: ThreadShell | undefined;
}

/** Where `open`, `new` and `next-blocked` put the thread, so the Rex glue can show that session. */
export interface OpenedTab {
  readonly threadId: string;
  readonly sessionId: string;
  readonly windowId: string;
}

export interface ThreadEntry {
  readonly threadId: string;
  readonly title: string;
  readonly project: string;
  readonly open: boolean;
  readonly blocked: boolean;
}

export interface TabService {
  readonly handle: (request: ControlRequest) => Promise<unknown>;
  readonly stop: () => Promise<void>;
}

const tabSubject = (threadId: string) => `${TAB_SUBJECT_PREFIX}${threadId}`;

/**
 * One Rex tab per open thread, one Rex session per project. A tab the user
 * closes hides its thread (never archives it); every closed tab's sessions are
 * revoked. A restarted daemon finds its tabs again by their block labels.
 */
export async function startTabService(options: TabServiceOptions): Promise<TabService> {
  const { paths, env, log } = options;
  const startedAt = Date.now();
  const stopController = new AbortController();
  const { signal } = stopController;
  const rex = resolveRexCli(env) === undefined ? undefined : makeRexClient(env);
  if (rex === undefined) log("Rex CLI not found; threads won't open as tabs. Set TR3X_REX_BIN.");

  const connection = createViewConnection({
    ...options.server,
    environmentId: EnvironmentId.make(options.server.environmentId),
    bearerToken: sessionBearer(
      () =>
        issueLocalSession({
          baseDir: paths.home,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          ttl: SESSION_TTL,
          label: "tr3x daemon",
          subject: DAEMON_SUBJECT,
          env,
        }),
      SESSION_REFRESH_MS,
    ),
  });

  const tabs = new Map<string, Tab>();
  const threadOfBlock = new Map<string, string>();
  const projectSessions = new Map<string, string>();
  /** Threads whose tab the user closed, with the request they were blocked on then. */
  const hidden = new Map<string, string | null>();
  const launchFiles = new Set<string>();
  let lastNextBlocked: string | undefined;
  let mapped = false;

  // Every change to the map runs here, one at a time, so events never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <A>(task: () => Promise<A>): Promise<A> => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  const shellState = () => connection.registry.get(connection.shellStateAtom);
  const requireShell = (): OrchestrationV2ShellSnapshot => {
    const snapshot = Option.getOrNull(shellState().snapshot);
    if (snapshot === null) throw new Error("The tr3x daemon hasn't loaded threads yet; try again.");
    return snapshot;
  };

  const forget = (tab: Tab) => {
    tabs.delete(tab.threadId);
    threadOfBlock.delete(tab.blockId);
  };

  /** Revokes every session minted for the thread's tabs up to `before`, when its tab closed. */
  const revokeTabSessions = async (threadId: string, before: number) => {
    const sessions = await listLocalSessions(paths.home, env);
    const stale = sessions.filter(
      (session) =>
        session.subject === tabSubject(threadId) && Date.parse(session.issuedAt) <= before,
    );
    for (const session of stale) await revokeLocalSession(paths.home, session.sessionId, env);
    log(`revoked ${stale.length} session(s) for thread ${threadId}`);
  };
  const revokeLater = (threadId: string, before: number) =>
    void revokeTabSessions(threadId, before).catch((error: unknown) =>
      log(`could not revoke thread ${threadId}'s sessions: ${describeError(error)}`),
    );

  const mintTabSession = (threadId: string): Promise<IssuedSession> =>
    issueLocalSession({
      baseDir: paths.home,
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      ttl: SESSION_TTL,
      label: "tr3x tab",
      subject: tabSubject(threadId),
      env,
    });

  /**
   * Mints the tab's session while its view starts, then writes the launch file
   * the view waits for. A tab closed meanwhile gets no file, and its session is revoked.
   */
  const handOff = async (tab: Tab, launchPath: string, newThreadProjectId: string | undefined) => {
    let session: IssuedSession;
    try {
      session = await mintTabSession(tab.threadId);
    } catch (error) {
      log(`could not start a session for thread ${tab.threadId}: ${describeError(error)}`);
      await serial(async () => {
        if (tabs.get(tab.threadId) !== tab) return;
        forget(tab);
        await rex?.closeWindow(tab.sessionId, tab.windowId).catch(() => {});
      });
      return;
    }
    if (tabs.get(tab.threadId) !== tab) {
      await revokeLocalSession(paths.home, session.sessionId, env).catch(() => {});
      return;
    }
    writeLaunchFile(launchPath, {
      version: 1,
      server: options.server,
      threadId: tab.threadId,
      ...(newThreadProjectId === undefined ? {} : { newThreadProjectId }),
      bearer: { token: session.token, expiresAt: session.expiresAt },
      controlSocket: paths.controlSocketPath,
    });
    launchFiles.add(launchPath);
    log(`handed thread ${tab.threadId}'s tab its session`);
    setTimeout(() => {
      launchFiles.delete(launchPath);
      NodeFS.rmSync(launchPath, { force: true });
    }, LAUNCH_FILE_TTL_MS).unref();
  };

  /** The project's session: the one tr3x used for it, else one labelled with its title. */
  const sessionForProject = async (projectId: string, label: string) => {
    const known = projectSessions.get(projectId);
    if (known !== undefined) return known;
    const sessions = await rex!.listSessions();
    return sessions.find((session) => session.label === label)?.sessionId;
  };

  const openTab = async (input: {
    readonly threadId: string;
    readonly title: string;
    readonly projectId: string;
    readonly projectTitle: string;
    readonly cwd: string;
    readonly focus: boolean;
    readonly newThread: boolean;
  }): Promise<OpenedTab> => {
    if (rex === undefined) throw new Error("tr3x can't find the Rex CLI. Set TR3X_REX_BIN.");
    const existing = tabs.get(input.threadId);
    if (existing !== undefined) {
      if (input.focus) await rex.focusWindow(existing.sessionId, existing.windowId);
      return existing;
    }
    hidden.delete(input.threadId);
    const launchPath = newLaunchFilePath(paths.launchDir);
    // Rex passes no environment to a block, and argv shows in `ps`: only the file's path goes here.
    const command = {
      argv: ["env", `TR3X_LAUNCH=${launchPath}`, process.execPath, CLI, "view"],
      cwd: input.cwd,
    };
    const label = rexLabel(input.title);
    const sessionLabel = rexLabel(input.projectTitle, "tr3x");
    const window = {
      windowLabel: label,
      blockLabel: tabBlockLabel(input.threadId),
      command,
    };
    const sessionId = await sessionForProject(input.projectId, sessionLabel);
    const placement =
      sessionId === undefined
        ? await rex.createSession({ label: sessionLabel, ...window })
        : await rex
            .createWindow({ sessionId, focus: input.focus, ...window })
            .catch(async (error: unknown) => {
              // The session went away since tr3x last saw it.
              log(`could not add a tab to session ${sessionId}: ${describeError(error)}`);
              projectSessions.delete(input.projectId);
              return await rex.createSession({ label: sessionLabel, ...window });
            });
    projectSessions.set(input.projectId, placement.sessionId);
    const tab: Tab = { threadId: input.threadId, ...placement, label, lastSeen: undefined };
    tabs.set(tab.threadId, tab);
    threadOfBlock.set(tab.blockId, tab.threadId);
    log(`opened thread ${tab.threadId} in session ${tab.sessionId}`);
    void handOff(tab, launchPath, input.newThread ? input.projectId : undefined);
    return tab;
  };

  const openThread = (
    snapshot: OrchestrationV2ShellSnapshot,
    thread: ThreadShell,
    focus: boolean,
  ) => {
    const project = snapshot.projects.find((candidate) => candidate.id === thread.projectId);
    return openTab({
      threadId: thread.id,
      title: thread.title,
      projectId: thread.projectId,
      projectTitle: project?.title ?? "tr3x",
      cwd: project?.workspaceRoot ?? paths.home,
      focus,
      newThread: false,
    });
  };

  const closeTab = async (tab: Tab, why: string) => {
    forget(tab);
    log(`closing thread ${tab.threadId}'s tab: ${why}`);
    await rex?.closeWindow(tab.sessionId, tab.windowId).catch((error: unknown) => {
      log(`could not close thread ${tab.threadId}'s tab: ${describeError(error)}`);
    });
    revokeLater(tab.threadId, Date.now());
  };

  const reconcile = async () => {
    if (!mapped) return;
    const state = shellState();
    const snapshot = Option.getOrNull(state.snapshot);
    if (snapshot === null) return;
    const plan = planShell(tabs, hidden, {
      threads: snapshot.threads,
      removed: new Set(state.removedAt.keys()),
      olderSettledBefore:
        snapshot.olderSettled === undefined ? undefined : Date.parse(snapshot.olderSettled.before),
    });
    for (const threadId of plan.close) {
      const tab = tabs.get(threadId);
      if (tab !== undefined) await closeTab(tab, "the thread was archived or deleted");
    }
    for (const { threadId, label } of plan.relabel) {
      const tab = tabs.get(threadId);
      if (tab === undefined) continue;
      await rex?.setWindowLabel(tab.sessionId, tab.windowId, label).then(
        () => {
          tab.label = label;
          log(`relabelled thread ${threadId}'s tab`);
        },
        (error: unknown) =>
          log(`could not relabel thread ${threadId}'s tab: ${describeError(error)}`),
      );
    }
    for (const threadId of plan.openBlocked) {
      const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
      if (thread !== undefined) {
        await openThread(snapshot, thread, false).catch((error: unknown) =>
          log(`could not open blocked thread ${threadId}: ${describeError(error)}`),
        );
      }
    }
    for (const thread of snapshot.threads) {
      const tab = tabs.get(thread.id);
      if (tab !== undefined) tab.lastSeen = thread;
    }
  };
  let reconcileQueued = false;
  const scheduleReconcile = () => {
    if (reconcileQueued) return;
    reconcileQueued = true;
    void serial(async () => {
      reconcileQueued = false;
      await reconcile();
    }).catch((error: unknown) => log(`could not update tabs: ${describeError(error)}`));
  };

  /** Rebuilds the map from the blocks Rex has, so a restarted daemon finds its tabs again. */
  const rebuild = async () => {
    const sessions = await rex!.listSessions();
    const found = new Map<string, Tab>();
    for (const session of sessions) {
      for (const block of await rex!.listBlocks(session.sessionId)) {
        const threadId = threadIdOfBlockLabel(block.label);
        if (threadId === undefined || found.has(threadId)) continue;
        // Keep a known tab's own object: a hand-off in flight checks it's still the same tab.
        const previous = tabs.get(threadId);
        found.set(
          threadId,
          previous?.blockId === block.blockId
            ? previous
            : {
                threadId,
                sessionId: block.sessionId,
                windowId: block.windowId,
                blockId: block.blockId,
                label: "",
                lastSeen: undefined,
              },
        );
      }
    }
    const firstMap = !mapped;
    tabs.clear();
    threadOfBlock.clear();
    for (const tab of found.values()) {
      tabs.set(tab.threadId, tab);
      threadOfBlock.set(tab.blockId, tab.threadId);
    }
    const live = new Set(sessions.map((session) => session.sessionId));
    for (const [projectId, sessionId] of projectSessions) {
      if (!live.has(sessionId)) projectSessions.delete(projectId);
    }
    const threads = Option.getOrNull(shellState().snapshot)?.threads ?? [];
    for (const thread of threads) {
      const tab = tabs.get(thread.id);
      if (tab !== undefined && !projectSessions.has(thread.projectId)) {
        projectSessions.set(thread.projectId, tab.sessionId);
      }
    }
    mapped = true;
    log(`found ${tabs.size} thread tab(s) in Rex`);
    if (firstMap) void revokeLeftovers(Date.now());
    await reconcile();
  };

  /**
   * Sessions earlier daemons left: their own, and those of tabs closed while
   * no daemon ran to see it.
   */
  const revokeLeftovers = async (now: number) => {
    try {
      const listed = await listLocalSessions(paths.home, env);
      const stale = listed.filter(
        (session) =>
          (session.subject === DAEMON_SUBJECT && Date.parse(session.issuedAt) < startedAt) ||
          (session.subject.startsWith(TAB_SUBJECT_PREFIX) &&
            !tabs.has(session.subject.slice(TAB_SUBJECT_PREFIX.length)) &&
            Date.parse(session.issuedAt) <= now),
      );
      for (const session of stale) await revokeLocalSession(paths.home, session.sessionId, env);
      if (stale.length > 0) log(`revoked ${stale.length} leftover session(s)`);
    } catch (error) {
      log(`could not check for leftover sessions: ${describeError(error)}`);
    }
  };

  const onRexEvent = (event: RexEvent) => {
    const at = Date.now();
    void serial(async () => {
      if (event.kind === "session_destroyed") {
        for (const [projectId, sessionId] of projectSessions) {
          if (sessionId === event.sessionId) projectSessions.delete(projectId);
        }
        return;
      }
      const threadId = threadOfBlock.get(event.blockId);
      const tab = threadId === undefined ? undefined : tabs.get(threadId);
      if (tab === undefined) return;
      forget(tab);
      const thread = Option.getOrNull(shellState().snapshot)?.threads.find(
        (candidate) => candidate.id === tab.threadId,
      );
      hidden.set(tab.threadId, thread === undefined ? null : (blockingRequestId(thread) ?? null));
      log(`thread ${tab.threadId}'s tab was closed; hiding the thread`);
      revokeLater(tab.threadId, at);
    });
  };

  // Rex restarts lose every tab, and the events stream with them: map again once it's back.
  const followRex = async () => {
    if (rex === undefined) return;
    let reported = false;
    while (!signal.aborted) {
      const stream = rex.streamEvents((line) => {
        const event = parseRexEvent(line);
        if (event !== undefined) onRexEvent(event);
      }, signal);
      await stream.started;
      try {
        await serial(rebuild);
        reported = false;
      } catch (error) {
        if (!reported) log(`can't reach Rex: ${describeError(error)}; retrying`);
        reported = true;
      }
      await stream.ended;
      if (signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, REX_RETRY_MS));
    }
  };

  NodeFS.rmSync(paths.launchDir, { recursive: true, force: true });
  const unmount = connection.registry.mount(connection.shellStateAtom);
  const unsubscribe = connection.registry.subscribe(connection.shellStateAtom, scheduleReconcile);
  // The map needs the shell's projects; Rex comes after it.
  const following = connection.shellSnapshot(signal).then(followRex, (error: unknown) => {
    if (!signal.aborted) log(`could not load threads: ${describeError(error)}`);
  });

  const handle = async (request: ControlRequest): Promise<unknown> => {
    switch (request.op) {
      case "new": {
        const projectId = await resolveProject(connection, request.cwd, signal);
        const root = NodeFS.realpathSync(request.cwd);
        const project = requireShell().projects.find((candidate) => candidate.id === projectId);
        return await serial(() =>
          openTab({
            threadId: NodeCrypto.randomUUID(),
            title: "New thread",
            projectId,
            projectTitle: project?.title ?? NodePath.basename(root),
            cwd: project?.workspaceRoot ?? root,
            focus: true,
            newThread: true,
          }),
        ).then(({ threadId, sessionId, windowId }) => ({ threadId, sessionId, windowId }));
      }
      case "open": {
        const thread = requireShell().threads.find(
          (candidate) => candidate.id === request.threadId,
        );
        if (thread === undefined) throw new Error(`No open thread ${request.threadId}.`);
        return await serial(() => openThread(requireShell(), thread, true)).then(
          ({ threadId, sessionId, windowId }) => ({ threadId, sessionId, windowId }),
        );
      }
      case "next-blocked": {
        const thread = nextBlockedThread(requireShell().threads, lastNextBlocked);
        if (thread === undefined) return null;
        lastNextBlocked = thread.id;
        return await serial(() => openThread(requireShell(), thread, true)).then(
          ({ threadId, sessionId, windowId }) => ({ threadId, sessionId, windowId }),
        );
      }
      case "threads": {
        const snapshot = requireShell();
        const projects = new Map(snapshot.projects.map((project) => [project.id, project.title]));
        return snapshot.threads
          .filter(
            (thread) =>
              thread.lineage.relationshipToParent !== "subagent" && thread.deletedAt === null,
          )
          .map((thread): ThreadEntry => ({
            threadId: thread.id,
            title: thread.title,
            project: projects.get(thread.projectId) ?? "",
            open: tabs.has(thread.id),
            blocked: blockingRequestId(thread) !== undefined,
          }));
      }
      case "bearer": {
        if (threadIdOfBlockLabel(tabBlockLabel(request.threadId)) === undefined) {
          throw new Error("That isn't a thread id.");
        }
        return await mintTabSession(request.threadId);
      }
    }
  };

  return {
    handle,
    stop: async () => {
      stopController.abort();
      await following;
      await queue;
      unsubscribe();
      unmount();
      connection.dispose();
      for (const path of launchFiles) NodeFS.rmSync(path, { force: true });
    },
  };
}
