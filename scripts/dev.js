import { spawn } from "node:child_process";

const commands = [
  ["server", "node", ["server/index.js"]],
  ["client", "npx", ["vite", "--host", "0.0.0.0", "--port", "5173"]]
];

const children = commands.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" }
  });
  child.stdout.on("data", data => process.stdout.write(`[${name}] ${data}`));
  child.stderr.on("data", data => process.stderr.write(`[${name}] ${data}`));
  child.on("exit", code => {
    if (code && !shuttingDown) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(code);
    }
  });
  return child;
});

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
