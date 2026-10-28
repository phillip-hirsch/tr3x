// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures on disk, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

const MOCK_AGENT = NodeURL.fileURLToPath(
  new URL("../../../server/scripts/acp-mock-agent.ts", import.meta.url),
);

const MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
  "",
].join("\n");

/** Where each fake provider process records its pid, so teardown can find and reap it. */
function pidDir(home: string): string {
  return NodePath.join(home, "fake-bin", "pids");
}

/**
 * Upstream's mock ACP agent minus its config options: they list no Grok slugs, so
 * the server would refuse every Grok model. The mock gets `pids` as an argument
 * so its command line names the home.
 */
const MOCK_WITHOUT_CONFIG_OPTIONS = (pids: string) =>
  [
    'import { spawn } from "node:child_process";',
    'import { createInterface } from "node:readline";',
    `const mock = spawn(process.execPath, [${JSON.stringify(MOCK_AGENT)}, ${JSON.stringify(pids)}], { stdio: ["inherit", "pipe", "inherit"] });`,
    `writePid(${JSON.stringify(pids)} + "/" + mock.pid, "");`,
    'const strip = (_key, value) => (_key === "configOptions" ? [] : value);',
    'createInterface({ input: mock.stdout }).on("line", (line) => {',
    "  let out = line;",
    "  try { out = JSON.stringify(JSON.parse(line, strip)); } catch {}",
    '  process.stdout.write(out + "\\n");',
    "});",
    'for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => mock.kill(name));',
    // exitCode, not exit(): stdout drains before the process ends.
    'mock.on("close", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });',
  ].join("\n");

/**
 * A stand-in Grok CLI: canned `--version` and `models`, and upstream's mock ACP
 * agent for `agent`. Each process records its pid in `pids`.
 */
function writeFakeGrok(
  directory: string,
  pids: string,
  env: Readonly<Record<string, string>>,
): string {
  return writeFakeCli({
    directory,
    name: "grok",
    env,
    source: [
      'import { mkdirSync as makePidDir, writeFileSync as writePid } from "node:fs";',
      'if (process.argv[2] === "--version") { process.stdout.write("grok 1.0.13\\n"); process.exit(0); }',
      `if (process.argv[2] === "models") { process.stdout.write(${JSON.stringify(MODELS_OUTPUT)}); process.exit(0); }`,
      // Approval modes put `--permission-mode <mode>` before `agent`.
      'if (!process.argv.includes("agent")) process.exit(1);',
      `makePidDir(${JSON.stringify(pids)}, { recursive: true });`,
      `writePid(${JSON.stringify(pids)} + "/" + process.pid, "");`,
      MOCK_WITHOUT_CONFIG_OPTIONS(pids),
    ].join("\n"),
  });
}

/**
 * Fake provider processes from `home` that still run. A recorded pid counts
 * only while its command line still names `home`, so a reused pid is never ours.
 */
export function liveFakeProviders(home: string): ReadonlyArray<number> {
  let names: ReadonlyArray<string>;
  try {
    names = NodeFS.readdirSync(pidDir(home));
  } catch {
    return [];
  }
  return names
    .map((name) => Number.parseInt(name, 10))
    .filter((pid) => Number.isInteger(pid) && commandLine(pid)?.includes(home) === true);
}

/** A process's command line, or undefined once it's gone. */
export function commandLine(pid: number): string | undefined {
  const result = NodeChildProcess.spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export interface FakeProviders {
  /** Raw ACP frames the second provider received, prompts included. */
  readonly secondRequestLog: string;
}

/**
 * Writes the server's settings in `home` so it runs two fake providers and no
 * real ones: "Grok" answers with `firstReply`; "Grok B" asks to run a command,
 * then replies "hello from mock".
 */
export function installFakeProviders(home: string, firstReply: string): FakeProviders {
  const bin = NodePath.join(home, "fake-bin");
  const secondRequestLog = NodePath.join(bin, "grok-b-requests.ndjson");
  const first = writeFakeGrok(NodePath.join(bin, "a"), pidDir(home), {
    T3_ACP_PROMPT_RESPONSE_TEXT: firstReply,
  });
  const second = writeFakeGrok(NodePath.join(bin, "b"), pidDir(home), {
    T3_ACP_EMIT_TOOL_CALLS: "1",
    T3_ACP_REQUEST_LOG_PATH: secondRequestLog,
  });
  const userdata = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    JSON.stringify({
      providerInstances: {
        codex: { driver: "codex", enabled: false },
        claudeAgent: { driver: "claudeAgent", enabled: false },
        grok: { driver: "grok", enabled: true, config: { enabled: true, binaryPath: first } },
        grokB: {
          driver: "grok",
          displayName: "Grok B",
          enabled: true,
          config: { enabled: true, binaryPath: second },
        },
      },
    }),
  );
  return { secondRequestLog };
}
