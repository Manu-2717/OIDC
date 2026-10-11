import { createApp } from "./create-app.js";
import clientDefinitions from "../clients.json" with { type: "json" };
import { loadConfig } from "./config.js";
import { buildDeps } from "./deps.js";
import { log } from "./log.js";

/** Runs the service as an ordinary Node process: on a laptop, or on any server. (On Vercel, api/index.ts is the entry point.) */
const config = loadConfig();
const deps = buildDeps(config, clientDefinitions);
for (const problem of deps.clients.errors) log("error", "app not registered", { problem });

const port = Number(process.env.PORT ?? 3000);
createApp(deps).listen(port, () => {
  log("info", "listening", { port, issuer: config.issuer, apps: deps.clients.metadata.length });
});
