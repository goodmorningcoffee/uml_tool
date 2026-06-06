import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagramToSvg, normalizeDiagram } from "../shared/diagram.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const diagramsDir = join(root, "data", "diagrams");
const exportsDir = join(root, "data", "exports");

await mkdir(diagramsDir, { recursive: true });
await mkdir(exportsDir, { recursive: true });

const colors = {
  blue: { fill: "#e0f2fe", stroke: "#075985", text: "#17202a" },
  green: { fill: "#dcfce7", stroke: "#166534", text: "#17202a" },
  red: { fill: "#fee2e2", stroke: "#991b1b", text: "#17202a" },
  amber: { fill: "#fef3c7", stroke: "#92400e", text: "#17202a" },
  purple: { fill: "#ede9fe", stroke: "#6d28d9", text: "#17202a" },
  cyan: { fill: "#cffafe", stroke: "#0e7490", text: "#17202a" },
  slate: { fill: "#f1f5f9", stroke: "#334155", text: "#17202a" }
};

for (const diagram of seedDiagrams()) {
  const normalized = normalizeDiagram(diagram);
  await writeFile(join(diagramsDir, `${normalized.id}.json`), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await writeFile(join(exportsDir, `${normalized.id}.svg`), diagramToSvg(normalized), "utf8");
  console.log(`seeded ${normalized.id}`);
}

// Generic example diagrams. They exist so a fresh install isn't empty and so
// new users can see what the tool can do. Open them, edit them, or delete
// them and start your own. None of this is tied to any specific project.
function seedDiagrams() {
  return [
    webAppArchitecture(),
    userOnboardingFlow(),
    ecommerceDomainModel(),
    umlToolOverview()
  ];
}

// System / component map: boxes and arrows for a typical web stack.
function webAppArchitecture() {
  return diagram("web_app_architecture", "Web App Architecture", "Example system map: how a typical web application's pieces fit together.", [
    node("browser", "Browser / Client", "Single-page app. Renders the UI and calls the [[api]] over HTTPS.", "rounded_rectangle", 80, 240, 190, 90, colors.blue),
    node("cdn", "CDN / Static Host", "Serves the built frontend assets: HTML, JS, CSS, images.", "rectangle", 360, 80, 200, 86, colors.slate),
    node("api", "API Server", "Business logic and request validation. Talks to the database, cache, and auth service.", "rounded_rectangle", 360, 240, 200, 90, colors.green),
    node("auth", "Auth Service", "Issues and verifies tokens / sessions for the [[api]].", "rectangle", 660, 70, 190, 86, colors.purple),
    node("cache", "Cache", "In-memory cache such as Redis for hot reads and rate limiting.", "ellipse", 660, 200, 180, 96, colors.amber),
    node("database", "Database", "Primary store of record, for example PostgreSQL.", "rectangle", 660, 350, 190, 86, colors.cyan),
    node("queue", "Job Queue", "Background work: sending email, generating exports, scheduled tasks.", "note", 960, 210, 200, 110, colors.red)
  ], [
    edge("browser_to_cdn", "browser", "cdn", "loads assets"),
    edge("browser_to_api", "browser", "api", "API calls"),
    edge("api_to_auth", "api", "auth", "verify token"),
    edge("api_to_cache", "api", "cache", "read / write"),
    edge("api_to_database", "api", "database", "queries"),
    edge("api_to_queue", "api", "queue", "enqueue jobs")
  ]);
}

// Activity / flowchart: a process with decision diamonds and branches.
function userOnboardingFlow() {
  return diagram("user_onboarding_flow", "User Onboarding Flow", "Example flowchart: a sign-up process with decision branches.", [
    node("start", "Sign Up", "The user clicks Sign Up to begin.", "rounded_rectangle", 80, 250, 180, 86, colors.green),
    node("enter", "Enter Email + Password", "Collect credentials from the user.", "rectangle", 320, 250, 200, 86, colors.blue),
    node("valid", "Email Valid?", "Decision: is the email format acceptable and not already taken?", "diamond", 580, 240, 190, 120, colors.amber),
    node("send_verify", "Send Verification Email", "Email a one-time verification link.", "rectangle", 840, 120, 210, 86, colors.blue),
    node("show_error", "Show Error", "Display an inline error and let the user try again.", "note", 580, 430, 200, 100, colors.red),
    node("verified", "Verified In Time?", "Decision: did the user click the link before it expired?", "diamond", 1110, 110, 190, 120, colors.amber),
    node("create_account", "Create Account", "Persist the account and starter profile.", "rectangle", 1110, 300, 200, 86, colors.green),
    node("welcome", "Welcome Screen", "Send the user into the product for the first time.", "rounded_rectangle", 1370, 300, 200, 90, colors.cyan)
  ], [
    edge("start_to_enter", "start", "enter", ""),
    edge("enter_to_valid", "enter", "valid", ""),
    edge("valid_to_send", "valid", "send_verify", "yes"),
    edge("valid_to_error", "valid", "show_error", "no"),
    edge("send_to_verified", "send_verify", "verified", ""),
    edge("verified_to_create", "verified", "create_account", "yes"),
    edge("verified_to_error", "verified", "show_error", "no / expired"),
    edge("create_to_welcome", "create_account", "welcome", "")
  ]);
}

// Class / entity model: UML-style entities with fields and multiplicities.
function ecommerceDomainModel() {
  return diagram("ecommerce_domain_model", "E-commerce Domain Model", "Example class/entity diagram: core entities of an online store and how they relate.", [
    node("customer", "Customer", "Fields: id, name, email. A customer places [[order]]s.", "rectangle", 100, 130, 200, 92, colors.blue),
    node("order", "Order", "Fields: id, status, total. Belongs to a [[customer]] and has many [[order_item]]s.", "rectangle", 430, 130, 210, 92, colors.green),
    node("order_item", "OrderItem", "Fields: quantity, unit_price. Links one [[order]] line to one [[product]].", "rectangle", 760, 130, 210, 92, colors.slate),
    node("product", "Product", "Fields: id, name, price, sku.", "rectangle", 1090, 130, 200, 92, colors.purple),
    node("category", "Category", "Groups [[product]]s into a browsable hierarchy.", "ellipse", 1090, 320, 200, 96, colors.amber),
    node("payment", "Payment", "Fields: amount, method, status. Settles an [[order]].", "rectangle", 430, 320, 210, 92, colors.cyan)
  ], [
    edge("customer_to_order", "customer", "order", "places  1..*"),
    edge("order_to_item", "order", "order_item", "contains  1..*"),
    edge("item_to_product", "order_item", "product", "refers to  *..1"),
    edge("product_to_category", "product", "category", "in  0..*"),
    edge("order_to_payment", "order", "payment", "paid by  1..1")
  ]);
}

// Orientation chart: how this tool works and how a human + agent co-design.
function umlToolOverview() {
  return diagram("uml_tool_overview", "UML Tool — How It Works", "How this tool stores diagrams and lets a human and an AI agent edit the same chart together.", [
    node("browser_gui", "Browser GUI", "React Flow canvas: drag nodes, draw edges, snap to grid, and edit names and [[node_notes]] in the inspector.", "rounded_rectangle", 90, 200, 220, 95, colors.blue),
    node("node_notes", "Node Notes", "Details live in notes, not crammed into the shape. Notes can reference other nodes with [[meta_links]].", "note", 90, 400, 220, 115, colors.amber),
    node("express_api", "Express API", "Filesystem CRUD for diagrams plus SVG export. The diagram JSON is the source of truth.", "rectangle", 440, 200, 220, 95, colors.green),
    node("diagram_json", "Diagram JSON", "Agent-readable: nodes, positions, shapes, notes, visible edges, and meta_links.", "rounded_rectangle", 780, 110, 230, 100, colors.cyan),
    node("live_bridge", "Live Bridge (SSE)", "Server-Sent Events push agent edits to the open browser, so you watch changes land in real time.", "ellipse", 780, 330, 220, 110, colors.purple),
    node("ai_agent", "AI Agent", "An AI coding agent (Claude, Codex, etc.) running in your repo reads the current chart and applies structured edits through the agent API.", "ellipse", 1120, 210, 230, 110, colors.red)
  ], [
    edge("gui_to_api", "browser_gui", "express_api", "save / load"),
    edge("notes_to_json", "node_notes", "diagram_json", "meta layer"),
    edge("api_to_json", "express_api", "diagram_json", "write source"),
    edge("json_to_agent", "diagram_json", "ai_agent", "inspect"),
    edge("agent_to_api", "ai_agent", "express_api", "structured edits"),
    edge("api_to_bridge", "express_api", "live_bridge", "broadcast"),
    edge("bridge_to_gui", "live_bridge", "browser_gui", "live refresh")
  ]);
}

function diagram(id, title, description, nodes, edges) {
  return {
    id,
    title,
    description,
    canvas: { grid_size: 20 },
    nodes,
    edges
  };
}

function node(id, name, notes, shape, x, y, width, height, style) {
  return {
    id,
    name,
    notes,
    shape,
    position: { x, y },
    size: { width, height },
    style
  };
}

function edge(id, source, target, name, notes = "") {
  return {
    id,
    source,
    target,
    name,
    notes,
    directed: true,
    style: { stroke: "#64748b" }
  };
}
