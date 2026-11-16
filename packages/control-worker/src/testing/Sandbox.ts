import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

// A stand-in for an agent sandbox in tests: a temporary HOME with real git.

const run = promisify(execFile);

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Sandbox {
  readonly home: string;
  /** The wiki checkout, `<home>/docs`. */
  readonly docs: string;
  /** Run a command in the sandbox's home. A non-zero exit resolves, it doesn't reject. */
  readonly exec: (command: string, args: readonly string[], env?: Record<string, string>) => Promise<CommandResult>;
  /** `git -C docs ...`, rejecting on failure. */
  readonly git: (...args: string[]) => Promise<string>;
  readonly write: (path: string, content: string) => Promise<void>;
  readonly read: (path: string) => Promise<string>;
  readonly close: () => Promise<void>;
}

export const makeSandbox = async (env: Record<string, string> = {}): Promise<Sandbox> => {
  const home = await mkdtemp(join(tmpdir(), "pecia-sandbox-"));
  const docs = join(home, "docs");
  const baseEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    // Fail instead of prompting when the credential helper returns nothing.
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "agent",
    GIT_AUTHOR_EMAIL: "agent@example.com",
    GIT_COMMITTER_NAME: "agent",
    GIT_COMMITTER_EMAIL: "agent@example.com",
    ...env,
  };

  const exec: Sandbox["exec"] = (command, args, extraEnv = {}) =>
    run(command, [...args], { cwd: home, env: { ...baseEnv, ...extraEnv } }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (error: { code?: number | string; message?: string; stdout?: string; stderr?: string }) => ({
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message ?? "",
      }),
    );

  return {
    home,
    docs,
    exec,
    git: async (...args) => {
      const result = await exec("git", ["-C", docs, ...args]);
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout.trim();
    },
    write: (path, content) => writeFile(join(docs, path), content),
    read: (path) => readFile(join(docs, path), "utf8"),
    close: () => rm(dirname(docs), { recursive: true, force: true }),
  };
};
