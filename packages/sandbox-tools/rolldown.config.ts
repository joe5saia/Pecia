import { type BuildOptions, defineConfig } from "rolldown";
import { fileURLToPath } from "node:url";

// Each tool becomes one self-contained Node script for the sandbox image. They
// are CommonJS so that a file with no extension runs on any supported Node.

const source = (file: string) => fileURLToPath(new URL(`./src/${file}`, import.meta.url));

export const tools = { "wiki-credential": source("credential.ts"), "wiki-land": source("land.ts") };

export const configs = (dir: string): BuildOptions[] =>
  Object.entries(tools).map(([name, input]) => ({
    input,
    platform: "node",
    logLevel: "warn",
    output: { file: `${dir}/${name}`, format: "cjs", banner: "#!/usr/bin/env node", codeSplitting: false },
  }));

export default defineConfig(configs(fileURLToPath(new URL("./dist", import.meta.url))));
