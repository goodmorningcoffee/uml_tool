import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createApp, createUmlToolContext, ensureDirs } from "../server/app.js";

const root = resolve(new URL("..", import.meta.url).pathname);

describe("agent bridge API", () => {
  it("tracks current session, summarizes current diagram, applies operations, writes logs, and updates SVG", async t => {
    await withServer(t, async ({ base, context }) => {
      const created = await jsonFetch(`${base}/api/diagrams`, {
        method: "POST",
        body: {
          id: "agent_bridge_probe",
          title: "Agent Bridge Probe",
          nodes: [
            { id: "alpha", name: "alpha", notes: "", position: { x: 40, y: 60 } },
            { id: "beta", name: "beta", notes: "Mentions alpha.", position: { x: 300, y: 60 } }
          ],
          edges: [{ id: "alpha_to_beta", source: "alpha", target: "beta", name: "starts" }]
        }
      });
      assert.equal(created.diagram.id, "agent_bridge_probe");

      const sessionPayload = await jsonFetch(`${base}/api/session/current`, {
        method: "POST",
        body: {
          current_diagram_id: "agent_bridge_probe",
          current_diagram_title: "Agent Bridge Probe",
          selected_node_id: "beta",
          viewport: { x: 10, y: 20, zoom: 0.8 }
        }
      });
      assert.equal(sessionPayload.session.current_diagram_id, "agent_bridge_probe");
      assert.equal(sessionPayload.session.selected_node_id, "beta");

      const summaryPayload = await jsonFetch(`${base}/api/agent/current/summary`);
      assert.equal(summaryPayload.current.id, "agent_bridge_probe");
      assert.equal(summaryPayload.current.selected.node_id, "beta");
      assert.equal(summaryPayload.current.nodes.length, 2);

      const operationsPayload = await jsonFetch(`${base}/api/agent/current/operations`, {
        method: "POST",
        body: {
          author: "codex-test",
          reason: "Exercise every MVP operation type.",
          operations: [
            { op: "update_diagram", patch: { title: "Agent Bridge Updated", description: "Updated by agent API." } },
            { op: "add_node", node: { id: "gamma", name: "gamma", notes: "Consumes [[alpha]].", position: { x: 560, y: 60 } } },
            { op: "update_node", id: "beta", patch: { notes: "beta sends data to gamma." } },
            { op: "add_edge", edge: { id: "beta_to_gamma", source: "beta", target: "gamma", name: "feeds" } },
            { op: "update_edge", id: "beta_to_gamma", patch: { name: "feeds evidence", notes: "Visible relation." } },
            { op: "add_node", node: { id: "trash_node", name: "trash_node", position: { x: 40, y: 220 } } },
            { op: "add_edge", edge: { id: "trash_edge", source: "gamma", target: "trash_node", name: "temporary" } },
            { op: "delete_edge", id: "trash_edge" },
            { op: "delete_node", id: "trash_node" }
          ]
        }
      });

      assert.equal(operationsPayload.warnings.length, 0);
      assert.equal(operationsPayload.steps.length, 9);
      assert.deepEqual(operationsPayload.steps[1].focus, { type: "node", id: "gamma" });
      assert.deepEqual(operationsPayload.steps[3].focus, { type: "edge", id: "beta_to_gamma" });
      assert.equal(operationsPayload.diagram.title, "Agent Bridge Updated");
      assert.equal(operationsPayload.diagram.nodes.length, 3);
      assert.equal(operationsPayload.diagram.edges.length, 2);
      assert.ok(operationsPayload.diagram.meta_links.some(link => link.source_node_id === "gamma" && link.target_node_id === "alpha"));
      assert.ok(operationsPayload.diagram.meta_links.some(link => link.source_node_id === "beta" && link.target_node_id === "gamma"));

      const savedJson = JSON.parse(await readFile(join(context.diagramsDir, "agent_bridge_probe.json"), "utf8"));
      assert.equal(savedJson.title, "Agent Bridge Updated");
      assert.ok(existsSync(join(context.exportsDir, "agent_bridge_probe.svg")));
      assert.match(await readFile(join(context.exportsDir, "agent_bridge_probe.svg"), "utf8"), /Agent Bridge Updated/);

      const operationLog = await jsonFetch(`${base}/api/agent/operations/agent_bridge_probe`);
      assert.equal(operationLog.operations.length, 1);
      assert.equal(operationLog.operations[0].author, "codex-test");
      assert.equal(operationLog.operations[0].operation_count, 9);
      assert.ok(existsSync(join(context.operationsDir, "agent_bridge_probe.jsonl")));

      const allOperations = await jsonFetch(`${base}/api/agent/operations`);
      assert.equal(allOperations.operations.length, 1);
    });
  });

  it("exposes an SSE event stream for browser live updates", async t => {
    await withServer(t, async ({ base }) => {
      const controller = new AbortController();
      const response = await fetch(`${base}/api/events`, { signal: controller.signal });
      assert.equal(response.ok, true);
      const reader = response.body.getReader();
      const { value } = await reader.read();
      controller.abort();
      const chunk = new TextDecoder().decode(value);
      assert.match(chunk, /"type":"connected"/);
    });
  });
});

async function withServer(t, fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "uml-agent-bridge-"));
  const context = createUmlToolContext({ rootDir: root, dataDir, distDir: join(dataDir, "missing-dist") });
  await ensureDirs(context);
  const server = createApp(context).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await fn({ base: `http://127.0.0.1:${port}`, context });
}

async function jsonFetch(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text);
}
