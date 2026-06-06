# UML Tool

A portable, browser-based UML / co-design diagramming tool — system maps,
workflow charts, class/entity models, taxonomies, and design-intent diagrams.

It's intentionally smaller and simpler than draw.io. The point isn't to be a
full diagram suite; it's to be a **shared co-design surface for a human and an
AI agent**. You drop `uml_tool` into whatever repo you're working in, run it
locally, and draw. Your AI coding agent (Claude, Codex, etc.) — running in that
same repo — can then *read* the exact chart you see as structured JSON, and
*edit* it through a small operations API. Edits the agent makes stream back into
your open browser live, so you watch the diagram change as you talk.

The diagram JSON is the source of truth and carries enough visual layout
metadata (positions, shapes, sizes, notes, edges, meta-links) for an agent to
understand what a chart is actually expressing — not just its raw structure.
Nothing in the tool is tied to any particular project.

## What It Does

- browser diagram editor with pan, zoom, grid, snap-to-grid, and connectors
- persisted light/dark mode toggle
- basic node shapes: rectangle, rounded rectangle, ellipse, diamond, note
- visible node `name` plus hidden/editable `notes`
- inspector sidebar for editing node/edge names and notes
- visible edges between nodes
- meta links derived from note references such as `[[api]]`
- diagram create, save, load, rename, delete, and list
- JSON source files in `data/diagrams`
- SVG visual exports in `data/exports`
- generic example diagrams so a fresh install isn't empty
- current-session tracking for the chart open in the browser
- agent bridge APIs for current chart inspection and structured edits
- operation logs in `data/operations`
- Server-Sent Events live refresh when agent/API edits land
- Dockerfile and docker-compose for portable startup

There is no true simultaneous multiplayer editing. Normal user editing is
still save-oriented, while agent/API edits can refresh the open browser chart
through the live bridge.

## Local Startup

Install dependencies:

```bash
npm install
```

Seed the example diagrams:

```bash
npm run seed
```

Run the development app:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

The Vite frontend proxies `/api` and `/exports` to the Express backend on port
`8789`.

## Docker Startup

From this directory:

```bash
docker compose up --build
```

Open:

```text
http://127.0.0.1:8790
```

Use a different host port:

```bash
UML_TOOL_PORT=8791 docker compose up --build
```

## Data Format

JSON is the source of truth:

```text
data/diagrams/*.json
```

SVG exports are snapshots:

```text
data/exports/*.svg
```

Each diagram stores:

- `id`, `title`, `description`
- `canvas.grid_size`
- `nodes`: id, visible name, hidden notes, shape, position, size, style
- `edges`: source, target, visible edge name, notes, directed flag, style
- `meta_links`: note-derived semantic links that are separate from visible edges
- timestamps

Example node:

```json
{
  "id": "api",
  "name": "API Server",
  "notes": "Handles business logic and talks to the [[database]].",
  "shape": "rounded_rectangle",
  "position": { "x": 360, "y": 240 },
  "size": { "width": 200, "height": 90 },
  "style": { "fill": "#dcfce7", "stroke": "#166534", "text": "#17202a" }
}
```

## Meta Links

Visible edges are the relationships drawn on the canvas.

Meta links are semantic references found inside node or edge notes. They are
stored separately so agents can analyze hidden conceptual dependencies without
confusing them for the visual graph.

Supported forms:

- explicit: `[[api]]`
- automatic exact-name links where practical: `api`

Clicking a linked node name in the inspector selects and centers that node.

## Example Diagrams

`npm run seed` (already run for you on a fresh clone) creates a few generic
example charts so the app isn't empty on first launch. They show different
diagram styles and exercise every node shape, edges, notes, and meta-links:

- `web_app_architecture` — a system/component map (boxes and arrows)
- `user_onboarding_flow` — a flowchart with decision diamonds and branches
- `ecommerce_domain_model` — a UML-style class/entity diagram with multiplicities
- `uml_tool_overview` — how this tool works and how a human + agent co-design

Open them, edit them, or delete them and start your own. None of them are tied
to any particular project. Your own saved diagrams live in `data/` and are git-
ignored, so they stay on your machine.

## Agent Inspection

Agents should inspect:

```text
data/diagrams/<diagram_id>.json
```

The JSON has enough layout data to understand the human visual map:

- `position` preserves approximate human layout
- `shape` preserves visual intent
- `size` helps distinguish emphasis
- visible `edges` preserve drawn relationships
- `meta_links` preserve note-level references
- SVG exports provide a quick visual snapshot

Agents can create or edit diagrams by writing the same schema and saving
through the API/UI, which regenerates the SVG export.

## Agent Live-Edit Bridge

The browser reports the currently open chart and current selection to the
backend:

```text
GET  /api/session/current
POST /api/session/current
```

An AI coding agent (Claude, Codex, etc.) running in the same repo can then
inspect and edit the active chart:

```text
GET  /api/agent/current
GET  /api/agent/current/summary
PUT  /api/agent/current
POST /api/agent/current/operations
GET  /api/agent/operations
GET  /api/agent/operations/:diagram_id
GET  /api/events
```

`/api/agent/current/summary` is the compact agent-readable view. It includes
diagram metadata, nodes with visual layout, visible edges, meta-links, selected
node/edge, graph stats, artifact paths, and operation-log count.

Apply structured edits:

```bash
curl -fsS -X POST http://127.0.0.1:8789/api/agent/current/operations \
  -H 'content-type: application/json' \
  -d '{
    "author": "claude",
    "reason": "Add a metrics service and wire the API to it.",
    "operations": [
      {
        "op": "add_node",
        "node": {
          "id": "metrics",
          "name": "Metrics / Logs",
          "notes": "Collects traces and metrics from the [[api]].",
          "shape": "rounded_rectangle",
          "position": { "x": 960, "y": 360 },
          "size": { "width": 200, "height": 96 }
        }
      },
      {
        "op": "add_edge",
        "edge": {
          "id": "api_to_metrics",
          "source": "api",
          "target": "metrics",
          "name": "emit telemetry"
        }
      }
    ]
  }'
```

Supported operation types:

- `update_diagram`
- `add_node`
- `update_node`
- `delete_node`
- `add_edge`
- `update_edge`
- `delete_edge`

Agent operation requests regenerate:

- `data/diagrams/<diagram_id>.json`
- `data/exports/<diagram_id>.svg`
- `data/operations/<diagram_id>.jsonl`
- `data/operations/all.jsonl`

The browser listens to `GET /api/events`. If an agent updates the currently
open diagram, the browser reloads that diagram and shows an Agent Bridge status
message.

For `POST /api/agent/current/operations`, the server saves after each
operation and broadcasts step-level events with a `focus` payload. The browser
uses that payload to select, center, and highlight the node or edge currently
being touched by the agent.

To make a sequence visibly slower for demos, include `step_delay_ms`:

```json
{
  "author": "claude",
  "reason": "Demo live step highlights.",
  "step_delay_ms": 900,
  "operations": [
    { "op": "update_node", "id": "api", "patch": { "notes": "First visible note update." } },
    { "op": "update_node", "id": "database", "patch": { "notes": "Second visible note update." } }
  ]
}
```

### Agent Reachability

Same workspace/container:

```text
http://127.0.0.1:<port>
```

From a Docker container to a host-running UML tool, if supported by the local
Docker runtime:

```text
http://host.docker.internal:<port>
```

Filesystem fallback:

```text
data/diagrams/*.json
data/exports/*.svg
data/operations/*.jsonl
```

The bridge is intentionally portable: if `uml_tool` is moved into another repo,
the local API and file layout remain the same.

## API

```text
GET    /api/health
GET    /api/diagrams
GET    /api/diagrams/:id
POST   /api/diagrams
PUT    /api/diagrams/:id
PATCH  /api/diagrams/:id/rename
DELETE /api/diagrams/:id
GET    /api/session/current
POST   /api/session/current
GET    /api/agent/current
GET    /api/agent/current/summary
PUT    /api/agent/current
POST   /api/agent/current/operations
GET    /api/agent/operations
GET    /api/agent/operations/:diagram_id
GET    /api/events
GET    /exports/:id.svg
```

## Verification

```bash
npm run seed
npm test
npm run build
npm start
```

Then probe:

```bash
curl -fsS http://127.0.0.1:8789/api/health
curl -fsS http://127.0.0.1:8789/api/diagrams
curl -fsS http://127.0.0.1:8789/api/session/current
curl -fsS http://127.0.0.1:8789/api/agent/current/summary
```

## License

MIT — see [LICENSE](./LICENSE). Free to use, modify, and distribute, including
commercially.
