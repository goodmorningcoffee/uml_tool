import express from "express";
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDiagramOperations,
  createBlankDiagram,
  diagramAgentSummary,
  diagramSummary,
  diagramToSvg,
  normalizeDiagram,
  slugify
} from "../shared/diagram.js";

export function createUmlToolContext({ rootDir, dataDir, distDir } = {}) {
  const resolvedRoot = resolve(rootDir || fileURLToPath(new URL("..", import.meta.url)));
  const resolvedData = resolve(dataDir || process.env.DATA_DIR || join(resolvedRoot, "data"));
  return {
    rootDir: resolvedRoot,
    dataDir: resolvedData,
    diagramsDir: join(resolvedData, "diagrams"),
    exportsDir: join(resolvedData, "exports"),
    operationsDir: join(resolvedData, "operations"),
    sessionDir: join(resolvedData, "session"),
    sessionPath: join(resolvedData, "session", "current.json"),
    distDir: resolve(distDir || join(resolvedRoot, "dist")),
    sseClients: new Set()
  };
}

export async function ensureDirs(context) {
  await mkdir(context.diagramsDir, { recursive: true });
  await mkdir(context.exportsDir, { recursive: true });
  await mkdir(context.operationsDir, { recursive: true });
  await mkdir(context.sessionDir, { recursive: true });
}

export function createApp(context = createUmlToolContext()) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      app: "uml_tool",
      data_dir: context.dataDir,
      diagrams_dir: context.diagramsDir,
      exports_dir: context.exportsDir,
      operations_dir: context.operationsDir,
      session_path: context.sessionPath
    });
  });

  app.get("/api/events", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    writeSse(res, {
      type: "connected",
      timestamp: nowIso(),
      data_dir: context.dataDir
    });
    context.sseClients.add(res);
    req.on("close", () => context.sseClients.delete(res));
  });

  app.get("/api/session/current", async (_req, res, next) => {
    try {
      res.json({ session: await readSession(context) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/current", async (req, res, next) => {
    try {
      const session = await updateSession(context, req.body || {});
      broadcastEvent(context, {
        type: "session_updated",
        source: "browser",
        timestamp: session.updated_at,
        session
      });
      res.json({ session });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/diagrams", async (_req, res, next) => {
    try {
      const diagrams = await readAllDiagrams(context);
      res.json({
        diagrams: diagrams
          .map(diagramSummary)
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/diagrams/:id", async (req, res, next) => {
    try {
      const diagram = await readDiagram(context, req.params.id);
      if (!diagram) return res.status(404).json({ error: "diagram not found" });
      res.json(diagram);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/diagrams", async (req, res, next) => {
    try {
      const input = Object.keys(req.body || {}).length ? req.body : createBlankDiagram("Untitled Diagram");
      const diagram = await saveDiagram(context, input, { source: "ui" });
      res.status(201).json({ diagram, summary: diagramSummary(diagram) });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/diagrams/:id", async (req, res, next) => {
    try {
      const current = await readDiagram(context, req.params.id);
      if (!current) return res.status(404).json({ error: "diagram not found" });
      const diagram = await saveDiagram(context, { ...req.body, id: req.params.id, created_at: req.body.created_at || current.created_at }, { source: "ui" });
      res.json({ diagram, summary: diagramSummary(diagram) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/diagrams/:id/rename", async (req, res, next) => {
    try {
      const current = await readDiagram(context, req.params.id);
      if (!current) return res.status(404).json({ error: "diagram not found" });
      const title = String(req.body?.title || "").trim();
      if (!title) return res.status(400).json({ error: "title is required" });
      const requestedId = req.body?.id ? slugify(req.body.id) : current.id;
      const renamed = normalizeDiagram({ ...current, id: requestedId, title });
      if (requestedId !== current.id) {
        const oldJson = diagramPath(context, current.id);
        const oldSvg = exportPath(context, current.id);
        const newJson = diagramPath(context, requestedId);
        const newSvg = exportPath(context, requestedId);
        if (existsSync(newJson)) return res.status(409).json({ error: "target diagram id already exists" });
        await rename(oldJson, newJson);
        if (existsSync(oldSvg)) await rename(oldSvg, newSvg);
      }
      const diagram = await saveDiagram(context, renamed, { source: "ui" });
      await updateSessionForRename(context, current.id, diagram);
      res.json({ diagram, summary: diagramSummary(diagram) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/diagrams", async (_req, res, next) => {
    try {
      await mkdir(context.diagramsDir, { recursive: true });
      const files = (await readdir(context.diagramsDir)).filter(file => file.endsWith(".json"));
      const ids = [];
      for (const file of files) {
        const id = slugify(file.replace(/\.json$/, ""));
        await unlink(join(context.diagramsDir, file)).catch(() => {});
        const svgPath = exportPath(context, id);
        if (existsSync(svgPath)) await unlink(svgPath).catch(() => {});
        const opsPath = operationPath(context, id);
        if (existsSync(opsPath)) await unlink(opsPath).catch(() => {});
        ids.push(id);
      }
      await updateSession(context, { current_diagram_id: null, current_diagram_title: null, selected_node_id: null, selected_edge_id: null });
      broadcastEvent(context, { type: "diagrams_cleared", count: ids.length, source: "ui", timestamp: nowIso() });
      res.json({ status: "deleted_all", count: ids.length, ids });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/diagrams/:id", async (req, res, next) => {
    try {
      const id = slugify(req.params.id);
      const jsonPath = diagramPath(context, id);
      if (!existsSync(jsonPath)) return res.status(404).json({ error: "diagram not found" });
      await unlink(jsonPath);
      const svgPath = exportPath(context, id);
      if (existsSync(svgPath)) await unlink(svgPath);
      const opsPath = operationPath(context, id);
      if (existsSync(opsPath)) await unlink(opsPath).catch(() => {});
      await clearSessionIfCurrent(context, id);
      broadcastEvent(context, { type: "diagram_deleted", diagram_id: id, source: "ui", timestamp: nowIso() });
      res.json({ status: "deleted", id });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/current", async (_req, res, next) => {
    try {
      const { diagram, session, source } = await readCurrentDiagram(context);
      if (!diagram) return res.status(404).json({ error: "no current diagram" });
      res.json({ diagram, session, source });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/current/summary", async (_req, res, next) => {
    try {
      const { diagram, session, source } = await readCurrentDiagram(context);
      if (!diagram) return res.json({ current: null, session, source, message: "no current diagram" });
      const operations = await readOperationLog(context, diagram.id);
      res.json({ current: diagramAgentSummary(diagram, session, operations), session, source });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/agent/current", async (req, res, next) => {
    try {
      const { diagram: current, session } = await readCurrentDiagram(context);
      if (!current) return res.status(404).json({ error: "no current diagram" });
      const beforeSummary = diagramAgentSummary(current, session, await readOperationLog(context, current.id));
      const input = { ...req.body, id: req.body?.id || current.id, created_at: req.body?.created_at || current.created_at };
      const diagram = await saveDiagram(context, input, { source: "agent" });
      const logEntry = await appendOperationLog(context, {
        author: req.body?.author || "agent",
        diagram_id: diagram.id,
        reason: req.body?.reason || "Replaced current diagram through agent API.",
        operations: [{ op: "replace_diagram" }],
        before_summary: beforeSummary,
        after_summary: diagramAgentSummary(diagram, session, []),
        warnings: []
      });
      await updateSession(context, { current_diagram_id: diagram.id, current_diagram_title: diagram.title });
      broadcastEvent(context, { type: "operation_logged", diagram_id: diagram.id, source: "agent", timestamp: logEntry.timestamp, log_entry: logEntry });
      res.json({ diagram, summary: diagramSummary(diagram), log_entry: logEntry });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/current/operations", async (req, res, next) => {
    try {
      const { diagram: current, session } = await readCurrentDiagram(context);
      if (!current) return res.status(404).json({ error: "no current diagram" });
      const operations = Array.isArray(req.body?.operations) ? req.body.operations : [];
      const stepDelayMs = clampDelay(req.body?.step_delay_ms);
      const priorOps = await readOperationLog(context, current.id);
      const beforeSummary = diagramAgentSummary(current, session, priorOps);
      let workingDiagram = current;
      const applied = [];
      const warnings = [];
      const steps = [];

      broadcastEvent(context, {
        type: "agent_operation_batch_started",
        diagram_id: current.id,
        source: "agent",
        author: req.body?.author || "agent",
        reason: req.body?.reason || "",
        operation_count: operations.length,
        timestamp: nowIso()
      });

      for (const [index, operation] of operations.entries()) {
        const startedFocus = operationFocus(operation);
        const step = { index: index + 1, total: operations.length };
        broadcastEvent(context, {
          type: "agent_operation_started",
          diagram_id: workingDiagram.id,
          source: "agent",
          author: req.body?.author || "agent",
          operation,
          focus: startedFocus,
          message: operationMessage(operation, startedFocus, "started"),
          step,
          timestamp: nowIso()
        });

        const result = applyDiagramOperations(workingDiagram, [operation]);
        applied.push(...result.applied);
        warnings.push(...result.warnings);
        const focus = operationFocus(operation, result.applied);
        workingDiagram = await saveDiagram(context, result.diagram, {
          source: "agent",
          focus,
          operation,
          step,
          message: operationMessage(operation, focus, "applied")
        });
        steps.push({ ...step, operation, applied: result.applied, warnings: result.warnings, focus });
        broadcastEvent(context, {
          type: "agent_operation_applied",
          diagram_id: workingDiagram.id,
          source: "agent",
          author: req.body?.author || "agent",
          operation,
          focus,
          applied: result.applied,
          warnings: result.warnings,
          message: operationMessage(operation, focus, "applied"),
          step,
          timestamp: workingDiagram.updated_at
        });
        if (stepDelayMs) await sleep(stepDelayMs);
      }

      const diagram = workingDiagram;
      const afterOps = await readOperationLog(context, diagram.id);
      const afterSummary = diagramAgentSummary(diagram, session, afterOps);
      const logEntry = await appendOperationLog(context, {
        author: req.body?.author || "agent",
        diagram_id: diagram.id,
        reason: req.body?.reason || "",
        operations,
        applied,
        operation_count: operations.length,
        before_summary: beforeSummary,
        after_summary: afterSummary,
        warnings
      });
      await updateSession(context, { current_diagram_id: diagram.id, current_diagram_title: diagram.title });
      broadcastEvent(context, { type: "operation_logged", diagram_id: diagram.id, source: "agent", timestamp: logEntry.timestamp, log_entry: logEntry });
      res.json({
        diagram,
        summary: diagramAgentSummary(diagram, await readSession(context), await readOperationLog(context, diagram.id)),
        log_entry: logEntry,
        applied,
        warnings,
        steps
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/operations", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit || 200);
      const operations = await readAllOperations(context, limit);
      res.json({ operations });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/operations/:diagram_id", async (req, res, next) => {
    try {
      const operations = await readOperationLog(context, req.params.diagram_id);
      res.json({ diagram_id: slugify(req.params.diagram_id), operations });
    } catch (error) {
      next(error);
    }
  });

  app.get("/exports/:id.svg", async (req, res, next) => {
    try {
      const id = slugify(req.params.id);
      const svgPath = exportPath(context, id);
      if (!existsSync(svgPath)) {
        const diagram = await readDiagram(context, id);
        if (!diagram) return res.status(404).json({ error: "export not found" });
        await writeFile(svgPath, diagramToSvg(diagram), "utf8");
      }
      res.type("image/svg+xml").send(await readFile(svgPath, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  if (existsSync(context.distDir)) {
    app.use(express.static(context.distDir));
    app.use((_req, res) => {
      res.sendFile(join(context.distDir, "index.html"));
    });
  }

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: error.message || "internal server error" });
  });

  return app;
}

export async function readAllDiagrams(context) {
  await mkdir(context.diagramsDir, { recursive: true });
  const files = (await readdir(context.diagramsDir)).filter(file => file.endsWith(".json"));
  const diagrams = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(context.diagramsDir, file), "utf8"));
      diagrams.push(normalizeDiagram(raw));
    } catch (error) {
      console.warn(`Skipping invalid diagram ${file}: ${error.message}`);
    }
  }
  return diagrams;
}

export async function readDiagram(context, id) {
  const path = diagramPath(context, id);
  if (!existsSync(path)) return null;
  return normalizeDiagram(JSON.parse(await readFile(path, "utf8")));
}

export async function saveDiagram(context, input, { source = "system", focus = null, operation = null, step = null, message = "" } = {}) {
  const diagram = normalizeDiagram(input);
  await ensureDirs(context);
  await writeFileAtomic(diagramPath(context, diagram.id), `${JSON.stringify(diagram, null, 2)}\n`);
  await writeFileAtomic(exportPath(context, diagram.id), diagramToSvg(diagram));
  broadcastEvent(context, {
    type: "diagram_updated",
    diagram_id: diagram.id,
    diagram_title: diagram.title,
    source,
    focus,
    operation,
    step,
    message,
    timestamp: diagram.updated_at
  });
  return diagram;
}

export function diagramPath(context, id) {
  return join(context.diagramsDir, `${slugify(id)}.json`);
}

export function exportPath(context, id) {
  return join(context.exportsDir, `${slugify(id)}.svg`);
}

async function readSession(context) {
  if (!existsSync(context.sessionPath)) return defaultSession();
  try {
    return normalizeSession(JSON.parse(await readFile(context.sessionPath, "utf8")));
  } catch (error) {
    console.warn(`Session file unreadable (${error.message}); resetting to default.`);
    return defaultSession();
  }
}

async function updateSession(context, patch = {}) {
  await ensureDirs(context);
  const previous = await readSession(context);
  const session = normalizeSession({ ...previous, ...patch, updated_at: nowIso() });
  await writeFileAtomic(context.sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  return session;
}

async function clearSessionIfCurrent(context, id) {
  const session = await readSession(context);
  if (session.current_diagram_id === slugify(id)) {
    await updateSession(context, { current_diagram_id: null, current_diagram_title: null, selected_node_id: null, selected_edge_id: null });
  }
}

async function writeFileAtomic(path, contents) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

async function updateSessionForRename(context, oldId, diagram) {
  const session = await readSession(context);
  if (session.current_diagram_id !== oldId) return;
  await updateSession(context, { current_diagram_id: diagram.id, current_diagram_title: diagram.title });
}

async function readCurrentDiagram(context) {
  let session = await readSession(context);
  if (session.current_diagram_id) {
    const diagram = await readDiagram(context, session.current_diagram_id);
    if (diagram) return { diagram, session, source: "session" };
  }
  const diagrams = await readAllDiagrams(context);
  const latest = diagrams.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
  if (!latest) return { diagram: null, session, source: "empty" };
  session = await updateSession(context, { current_diagram_id: latest.id, current_diagram_title: latest.title });
  return { diagram: latest, session, source: "fallback_latest_saved_diagram" };
}

function defaultSession() {
  return {
    current_diagram_id: null,
    current_diagram_title: null,
    selected_node_id: null,
    selected_edge_id: null,
    viewport: null,
    updated_at: null
  };
}

function normalizeSession(input = {}) {
  return {
    current_diagram_id: input.current_diagram_id ? slugify(input.current_diagram_id) : null,
    current_diagram_title: input.current_diagram_title || null,
    selected_node_id: input.selected_node_id ? slugify(input.selected_node_id) : null,
    selected_edge_id: input.selected_edge_id ? slugify(input.selected_edge_id) : null,
    viewport: input.viewport || null,
    updated_at: input.updated_at || null
  };
}

async function appendOperationLog(context, entry) {
  await ensureDirs(context);
  const timestamp = nowIso();
  const logEntry = {
    timestamp,
    author: entry.author || "agent",
    diagram_id: slugify(entry.diagram_id),
    operation_count: Number(entry.operation_count ?? entry.operations?.length ?? 0),
    reason: String(entry.reason || ""),
    operations: entry.operations || [],
    applied: entry.applied || [],
    warnings: entry.warnings || [],
    before_summary: entry.before_summary || null,
    after_summary: entry.after_summary || null
  };
  const line = `${JSON.stringify(logEntry)}\n`;
  await appendFile(operationPath(context, logEntry.diagram_id), line, "utf8");
  await appendFile(operationPath(context, "all"), line, "utf8");
  return logEntry;
}

async function readOperationLog(context, diagramId) {
  const path = operationPath(context, diagramId);
  if (!existsSync(path)) return [];
  try {
    return parseJsonl(await readFile(path, "utf8"));
  } catch (error) {
    console.warn(`Could not read operation log ${path}: ${error.message}`);
    return [];
  }
}

async function readAllOperations(context, limit = 200) {
  const operations = await readOperationLog(context, "all");
  return operations.slice(Math.max(0, operations.length - limit));
}

function operationPath(context, diagramId) {
  return join(context.operationsDir, `${slugify(diagramId, "all")}.jsonl`);
}

function parseJsonl(text) {
  const entries = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (error) {
      console.warn(`Skipping malformed operation-log line: ${error.message}`);
    }
  }
  return entries;
}

function broadcastEvent(context, event) {
  for (const client of context.sseClients) {
    writeSse(client, event);
  }
}

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function operationFocus(operation = {}, applied = []) {
  const op = String(operation.op || "");
  if (op === "add_node") return { type: "node", id: applied[0]?.id || slugify(operation.node?.id || operation.node?.name || "node") };
  if (op === "update_node" || op === "delete_node") return { type: "node", id: slugify(operation.id || "") };
  if (op === "add_edge") return { type: "edge", id: applied[0]?.id || slugify(operation.edge?.id || `${operation.edge?.source || "source"}_to_${operation.edge?.target || "target"}`) };
  if (op === "update_edge" || op === "delete_edge") return { type: "edge", id: slugify(operation.id || "") };
  if (op === "update_diagram") return { type: "diagram", id: null };
  return null;
}

function operationMessage(operation = {}, focus = null, phase = "applied") {
  const op = String(operation.op || "operation");
  const target = focus?.id ? ` ${focus.type}:${focus.id}` : "";
  if (op === "update_node" && operation.patch?.notes !== undefined) return `${phase} notes on${target}`;
  if (op === "update_node") return `${phase} node${target}`;
  if (op === "add_node") return `${phase} new node${target}`;
  if (op === "delete_node") return `${phase} node delete${target}`;
  if (op === "update_edge") return `${phase} edge${target}`;
  if (op === "add_edge") return `${phase} new edge${target}`;
  if (op === "delete_edge") return `${phase} edge delete${target}`;
  if (op === "update_diagram") return `${phase} diagram metadata`;
  return `${phase} ${op}${target}`;
}

function clampDelay(value) {
  const delay = Number(value || 0);
  if (!Number.isFinite(delay) || delay <= 0) return 0;
  return Math.min(2500, Math.round(delay));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
