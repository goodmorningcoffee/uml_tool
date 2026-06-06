import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, createUmlToolContext, ensureDirs } from "./app.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8789);
const host = process.env.HOST || "0.0.0.0";
const context = createUmlToolContext({ rootDir });

await ensureDirs(context);

const app = createApp(context);
app.listen(port, host, () => {
  console.log(`UML Tool listening on http://${host}:${port}`);
  console.log(`Data directory: ${context.dataDir}`);
});
