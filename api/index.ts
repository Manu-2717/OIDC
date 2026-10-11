import { createApp } from "../src/app.js";
import clientDefinitions from "../clients.json" with { type: "json" };
import { loadConfig } from "../src/config.js";
import { buildDeps } from "../src/deps.js";
import { log } from "../src/log.js";

/** The Vercel entry point: one Express app, built once per instance, answering every path (see vercel.json). */
const config = loadConfig();
const deps = buildDeps(config, clientDefinitions);
for (const problem of deps.clients.errors) log("error", "app not registered", { problem });

export default createApp(deps);
