import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDiagramOperations,
  deriveMetaLinks,
  diagramToSvg,
  normalizeDiagram
} from "../shared/diagram.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("diagram model", () => {
  it("keeps visible edges separate from note meta links", () => {
    const diagram = normalizeDiagram({
      id: "meta_link_test",
      title: "Meta Link Test",
      nodes: [
        {
          id: "database",
          name: "database",
          notes: "",
          shape: "rectangle",
          position: { x: 0, y: 0 },
          size: { width: 160, height: 80 }
        },
        {
          id: "api",
          name: "api",
          notes: "Controls [[database]] and writes to the database by name.",
          shape: "rounded_rectangle",
          position: { x: 260, y: 0 },
          size: { width: 190, height: 90 }
        }
      ],
      edges: [
        {
          id: "visible_flow",
          source: "api",
          target: "database",
          name: "calls",
          notes: ""
        }
      ]
    });
    assert.equal(diagram.edges.length, 1);
    assert.ok(diagram.meta_links.some(link => link.source_node_id === "api" && link.target_node_id === "database" && link.link_type === "explicit"));
    assert.ok(diagram.meta_links.some(link => link.source_node_id === "api" && link.target_node_id === "database" && link.link_type === "auto"));
  });

  it("exports a readable SVG snapshot", () => {
    const svg = diagramToSvg({
      title: "SVG Test",
      nodes: [
        { id: "a", name: "A", shape: "ellipse", position: { x: 10, y: 20 }, size: { width: 120, height: 70 } },
        { id: "b", name: "B", shape: "diamond", position: { x: 240, y: 140 }, size: { width: 130, height: 90 } }
      ],
      edges: [{ id: "a_to_b", source: "a", target: "b", name: "relates" }]
    });
    assert.match(svg, /<svg/);
    assert.match(svg, /SVG Test/);
    assert.match(svg, /relates/);
    assert.match(svg, /marker-end/);
  });

  it("applies structured agent operations and re-derives meta links", () => {
    const original = normalizeDiagram({
      id: "agent_ops_model",
      title: "Agent Ops Model",
      nodes: [
        { id: "database", name: "database", position: { x: 0, y: 0 } },
        { id: "api", name: "api", position: { x: 260, y: 0 } }
      ],
      edges: []
    });
    const result = applyDiagramOperations(original, [
      { op: "update_diagram", patch: { title: "Agent Ops Updated", description: "Updated through operations." } },
      { op: "add_node", node: { id: "cache", name: "cache", notes: "Uses [[database]].", position: { x: 500, y: 0 } } },
      { op: "update_node", id: "api", patch: { notes: "Writes to cache." } },
      { op: "add_edge", edge: { id: "api_to_cache", source: "api", target: "cache", name: "feeds" } },
      { op: "update_edge", id: "api_to_cache", patch: { notes: "Visible edge separate from meta links." } },
      { op: "add_node", node: { id: "temporary", name: "temporary", position: { x: 0, y: 180 } } },
      { op: "delete_node", id: "temporary" }
    ]);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.diagram.title, "Agent Ops Updated");
    assert.equal(result.diagram.nodes.length, 3);
    assert.equal(result.diagram.edges.length, 1);
    assert.ok(result.diagram.meta_links.some(link => link.source_node_id === "cache" && link.target_node_id === "database"));
    assert.ok(result.diagram.meta_links.some(link => link.source_node_id === "api" && link.target_node_id === "cache"));
  });
});

describe("seed diagrams", () => {
  it("provide the example starter charts with JSON and SVG artifacts", async () => {
    const diagramDir = join(root, "data", "diagrams");
    const exportDir = join(root, "data", "exports");
    const expected = [
      "web_app_architecture",
      "user_onboarding_flow",
      "ecommerce_domain_model",
      "uml_tool_overview"
    ];
    const files = await readdir(diagramDir);
    for (const id of expected) {
      assert.ok(files.includes(`${id}.json`), `${id}.json exists`);
      assert.ok(existsSync(join(exportDir, `${id}.svg`)), `${id}.svg exists`);
      const diagram = normalizeDiagram(JSON.parse(await readFile(join(diagramDir, `${id}.json`), "utf8")));
      assert.equal(diagram.id, id);
      assert.ok(diagram.nodes.length >= 5, `${id} has useful nodes`);
      assert.ok(diagram.edges.length >= 4, `${id} has visible edges`);
      assert.ok(Array.isArray(diagram.meta_links), `${id} has meta links array`);
    }
  });
});
