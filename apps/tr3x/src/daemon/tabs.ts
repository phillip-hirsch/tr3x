import { isOlderSettledThreadShell, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Which T3 threads have Rex tabs, decided from the server's shell and the
 * blocks Rex reports. Pure: the daemon's tab service carries the decisions out.
 */

export type ThreadShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "pendingRuntimeRequest"
  | "settledOverride"
  | "settledAt"
  | "deletedAt"
>;

const BLOCK_LABEL_PREFIX = "tr3x:";
/** Rex's limit on window labels. */
const MAX_LABEL = 128;

/** The label that marks a block as a thread's tab, so a restarted daemon finds it again. */
export function tabBlockLabel(threadId: string): string {
  return `${BLOCK_LABEL_PREFIX}${threadId}`;
}

/** The thread a block shows, when its label marks it as a tab. */
export function threadIdOfBlockLabel(label: string): string | undefined {
  const threadId = label.startsWith(BLOCK_LABEL_PREFIX)
    ? label.slice(BLOCK_LABEL_PREFIX.length)
    : "";
  return /^[\w-]+$/u.test(threadId) ? threadId : undefined;
}

/** A Rex label for a title: no control characters, within Rex's limit, never empty. */
export function rexLabel(title: string, fallback = "New thread"): string {
  // Rex refuses labels with control characters.
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
  if (clean.length === 0) return fallback;
  const chars = Array.from(clean);
  return chars.length <= MAX_LABEL ? clean : `${chars.slice(0, MAX_LABEL - 1).join("")}…`;
}

/** What a tab's thread looked like when the daemon last saw it in the shell. */
export interface TabView {
  readonly label: string;
  readonly lastSeen: ThreadShell | undefined;
}

export interface ShellView {
  readonly threads: ReadonlyArray<ThreadShell>;
  /** Threads the shell removed since its last full snapshot: archived or deleted. */
  readonly removed: ReadonlySet<string>;
  /** Where a shell that leaves out older settled threads cut them off, in epoch ms. */
  readonly olderSettledBefore: number | undefined;
}

export interface ShellPlan {
  readonly close: ReadonlyArray<string>;
  readonly relabel: ReadonlyArray<{ readonly threadId: string; readonly label: string }>;
  readonly openBlocked: ReadonlyArray<string>;
}

/** A top-level thread waiting on the user, with the request it waits on. */
export function blockingRequestId(thread: ThreadShell): string | undefined {
  const request = thread.pendingRuntimeRequest;
  if (request === null || request.blocking === false) return undefined;
  if (thread.lineage.relationshipToParent === "subagent" || thread.deletedAt !== null) {
    return undefined;
  }
  return request.id;
}

/**
 * Close tabs of archived or deleted threads, but not of threads the shell left
 * out (older settled ones) or hasn't seen yet (a new thread before its first
 * message). Relabel renamed threads. Open blocked threads without a tab, unless
 * the user closed it while the thread waited on that same request.
 */
export function planShell(
  tabs: ReadonlyMap<string, TabView>,
  hidden: ReadonlyMap<string, string | null>,
  shell: ShellView,
): ShellPlan {
  const threads = new Map(shell.threads.map((thread) => [thread.id as string, thread]));
  const close: string[] = [];
  const relabel: Array<{ threadId: string; label: string }> = [];
  for (const [threadId, tab] of tabs) {
    const thread = threads.get(threadId);
    if (thread !== undefined && thread.deletedAt === null) {
      const label = rexLabel(thread.title);
      if (label !== tab.label) relabel.push({ threadId, label });
      continue;
    }
    const omitted =
      tab.lastSeen !== undefined &&
      shell.olderSettledBefore !== undefined &&
      isOlderSettledThreadShell(tab.lastSeen, shell.olderSettledBefore);
    if (
      shell.removed.has(threadId) ||
      thread !== undefined ||
      (tab.lastSeen !== undefined && !omitted)
    ) {
      close.push(threadId);
    }
  }
  const openBlocked = shell.threads
    .filter((thread) => {
      const request = blockingRequestId(thread);
      return request !== undefined && !tabs.has(thread.id) && hidden.get(thread.id) !== request;
    })
    .map((thread) => thread.id as string);
  return { close, relabel, openBlocked };
}

/**
 * The blocked thread after `previous`, oldest request first, wrapping around.
 * Undefined when nothing is blocked.
 */
export function nextBlockedThread(
  threads: ReadonlyArray<ThreadShell>,
  previous: string | undefined,
): ThreadShell | undefined {
  const blocked = threads
    .filter((thread) => blockingRequestId(thread) !== undefined)
    .toSorted(
      (a, b) =>
        DateTime.toEpochMillis(a.pendingRuntimeRequest!.createdAt) -
        DateTime.toEpochMillis(b.pendingRuntimeRequest!.createdAt),
    );
  const index = blocked.findIndex((thread) => thread.id === previous);
  return blocked[(index + 1) % Math.max(blocked.length, 1)];
}
