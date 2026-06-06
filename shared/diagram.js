export const DIAGRAM_SCHEMA = "uml_tool_diagram_v1";
export const DEFAULT_GRID_SIZE = 20;
export const SHAPES = ["rectangle", "rounded_rectangle", "ellipse", "diamond", "note"];

export function nowIso() {
  return new Date().toISOString();
}

export function slugify(value, fallback = "diagram") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function createBlankDiagram(title = "Untitled Diagram") {
  const timestamp = nowIso();
  const id = slugify(title, "untitled_diagram");
  return normalizeDiagram({
    diagram_schema: DIAGRAM_SCHEMA,
    id,
    title,
    description: "",
    canvas: { grid_size: DEFAULT_GRID_SIZE },
    nodes: [],
    edges: [],
    meta_links: [],
    created_at: timestamp,
    updated_at: timestamp
  });
}

export function normalizeDiagram(input = {}) {
  const timestamp = nowIso();
  const title = String(input.title || "Untitled Diagram").trim() || "Untitled Diagram";
  const id = slugify(input.id || title, "untitled_diagram");
  const canvas = {
    grid_size: Number(input.canvas?.grid_size || DEFAULT_GRID_SIZE) || DEFAULT_GRID_SIZE
  };

  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).map((node, index) => {
    const name = String(node.name || node.label || `node_${index + 1}`).trim() || `node_${index + 1}`;
    const nodeId = slugify(node.id || name, `node_${index + 1}`);
    const shape = SHAPES.includes(node.shape) ? node.shape : "rectangle";
    return {
      id: nodeId,
      name,
      notes: String(node.notes || ""),
      shape,
      position: {
        x: Number(node.position?.x ?? 80 + index * 30),
        y: Number(node.position?.y ?? 80 + index * 30)
      },
      size: {
        width: Math.max(80, Number(node.size?.width ?? node.width ?? 180)),
        height: Math.max(50, Number(node.size?.height ?? node.height ?? 86))
      },
      style: {
        fill: node.style?.fill || "#ffffff",
        stroke: node.style?.stroke || "#334155",
        text: node.style?.text || "#17202a"
      }
    };
  });

  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = (Array.isArray(input.edges) ? input.edges : [])
    .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge, index) => ({
      id: slugify(edge.id || `edge_${index + 1}`, `edge_${index + 1}`),
      source: edge.source,
      target: edge.target,
      name: String(edge.name || edge.label || ""),
      notes: String(edge.notes || ""),
      directed: edge.directed !== false,
      style: {
        stroke: edge.style?.stroke || "#64748b"
      }
    }));

  const diagram = {
    diagram_schema: DIAGRAM_SCHEMA,
    id,
    title,
    description: String(input.description || ""),
    canvas,
    nodes,
    edges,
    meta_links: [],
    created_at: input.created_at || timestamp,
    updated_at: timestamp
  };
  diagram.meta_links = deriveMetaLinks(diagram);
  return diagram;
}

export function deriveMetaLinks(diagram) {
  const nodes = Array.isArray(diagram.nodes) ? diagram.nodes : [];
  const aliases = new Map();
  for (const node of nodes) {
    aliases.set(String(node.id).toLowerCase(), node);
    aliases.set(String(node.name).toLowerCase(), node);
  }

  const links = [];
  const seen = new Set();

  function addLink({ sourceNodeId, sourceEdgeId, target, matchedText, sourceField, linkType }) {
    if (!target) return;
    if (sourceNodeId && target.id === sourceNodeId) return;
    const key = [sourceNodeId || "", sourceEdgeId || "", target.id, matchedText, sourceField, linkType].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      source_node_id: sourceNodeId || null,
      source_edge_id: sourceEdgeId || null,
      target_node_id: target.id,
      matched_text: matchedText,
      source_field: sourceField,
      link_type: linkType
    });
  }

  function scanText(text, source) {
    const value = String(text || "");
    const explicit = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = explicit.exec(value))) {
      const target = aliases.get(String(match[1]).trim().toLowerCase());
      addLink({ ...source, target, matchedText: match[1], linkType: "explicit" });
    }

    for (const target of nodes) {
      const names = [target.id, target.name].filter(Boolean);
      for (const name of names) {
        if (String(name).length < 3) continue;
        const escaped = escapeRegex(String(name));
        const pattern = new RegExp(`(^|[^A-Za-z0-9_\\-])(${escaped})(?=$|[^A-Za-z0-9_\\-])`, "gi");
        let autoMatch;
        while ((autoMatch = pattern.exec(value))) {
          addLink({
            ...source,
            target,
            matchedText: autoMatch[2],
            linkType: "auto"
          });
        }
      }
    }
  }

  for (const node of nodes) {
    scanText(node.notes, { sourceNodeId: node.id, sourceField: "notes" });
  }
  for (const edge of diagram.edges || []) {
    scanText(edge.notes, { sourceEdgeId: edge.id, sourceField: "edge_notes" });
    scanText(edge.name, { sourceEdgeId: edge.id, sourceField: "edge_name" });
  }
  return links;
}

export function diagramSummary(diagram) {
  return {
    id: diagram.id,
    title: diagram.title,
    description: diagram.description || "",
    updated_at: diagram.updated_at || null,
    created_at: diagram.created_at || null,
    node_count: diagram.nodes?.length || 0,
    edge_count: diagram.edges?.length || 0,
    meta_link_count: diagram.meta_links?.length || 0,
    json_path: `data/diagrams/${diagram.id}.json`,
    svg_path: `data/exports/${diagram.id}.svg`,
    svg_url: `/exports/${diagram.id}.svg`
  };
}

export function diagramAgentSummary(diagram, session = {}, operations = []) {
  const normalized = normalizeDiagram(diagram);
  const latestOperation = operations.length ? operations[operations.length - 1] : null;
  return {
    ...diagramSummary(normalized),
    selected: {
      node_id: session.selected_node_id || null,
      edge_id: session.selected_edge_id || null
    },
    viewport: session.viewport || null,
    stats: {
      nodes: normalized.nodes.length,
      visible_edges: normalized.edges.length,
      meta_links: normalized.meta_links.length,
      nodes_with_notes: normalized.nodes.filter(node => Boolean(node.notes)).length,
      edges_with_notes: normalized.edges.filter(edge => Boolean(edge.notes)).length
    },
    nodes: normalized.nodes.map(node => ({
      id: node.id,
      name: node.name,
      shape: node.shape,
      position: node.position,
      size: node.size,
      style: node.style,
      has_notes: Boolean(node.notes),
      notes_summary: compactText(node.notes)
    })),
    visible_edges: normalized.edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      name: edge.name,
      directed: edge.directed,
      has_notes: Boolean(edge.notes),
      notes_summary: compactText(edge.notes)
    })),
    meta_links: normalized.meta_links,
    operation_log: {
      count: operations.length,
      latest: latestOperation
        ? {
            timestamp: latestOperation.timestamp || null,
            author: latestOperation.author || null,
            reason: latestOperation.reason || "",
            operation_count: latestOperation.operation_count || latestOperation.operations?.length || 0
          }
        : null
    }
  };
}

export function applyDiagramOperations(inputDiagram, operations = []) {
  const warnings = [];
  let diagram = normalizeDiagram(inputDiagram);
  const applied = [];

  for (const rawOperation of Array.isArray(operations) ? operations : []) {
    const operation = rawOperation || {};
    const op = String(operation.op || "").trim();
    if (!op) {
      warnings.push("Skipped operation without op");
      continue;
    }

    if (op === "update_diagram") {
      const patch = operation.patch || {};
      diagram = normalizeDiagram({
        ...diagram,
        title: patch.title ?? diagram.title,
        description: patch.description ?? diagram.description,
        canvas: { ...diagram.canvas, ...(patch.canvas || {}) },
        created_at: diagram.created_at
      });
      applied.push({ op });
      continue;
    }

    if (op === "add_node") {
      const node = operation.node || {};
      const id = uniqueId(slugify(node.id || node.name || "node"), new Set(diagram.nodes.map(item => item.id)));
      diagram = normalizeDiagram({
        ...diagram,
        nodes: diagram.nodes.concat({ ...node, id }),
        created_at: diagram.created_at
      });
      applied.push({ op, id });
      continue;
    }

    if (op === "update_node") {
      const id = slugify(operation.id || "");
      const patch = operation.patch || {};
      let found = false;
      const nodes = diagram.nodes.map(node => {
        if (node.id !== id) return node;
        found = true;
        if (patch.id && slugify(patch.id) !== node.id) warnings.push(`Ignoring node id change for ${node.id}`);
        return {
          ...node,
          name: patch.name ?? node.name,
          notes: patch.notes ?? node.notes,
          shape: patch.shape ?? node.shape,
          position: patch.position ? { ...node.position, ...numberPatch(patch.position) } : node.position,
          size: patch.size ? { ...node.size, ...numberPatch(patch.size) } : node.size,
          style: patch.style ? { ...node.style, ...patch.style } : node.style
        };
      });
      if (!found) {
        warnings.push(`Node not found: ${operation.id}`);
        continue;
      }
      diagram = normalizeDiagram({ ...diagram, nodes, created_at: diagram.created_at });
      applied.push({ op, id });
      continue;
    }

    if (op === "delete_node") {
      const id = slugify(operation.id || "");
      const before = diagram.nodes.length;
      const nodes = diagram.nodes.filter(node => node.id !== id);
      if (nodes.length === before) {
        warnings.push(`Node not found: ${operation.id}`);
        continue;
      }
      const edges = diagram.edges.filter(edge => edge.source !== id && edge.target !== id);
      diagram = normalizeDiagram({ ...diagram, nodes, edges, created_at: diagram.created_at });
      applied.push({ op, id });
      continue;
    }

    if (op === "add_edge") {
      const edge = operation.edge || {};
      const source = slugify(edge.source || "");
      const target = slugify(edge.target || "");
      const nodeIds = new Set(diagram.nodes.map(node => node.id));
      if (!nodeIds.has(source) || !nodeIds.has(target)) {
        warnings.push(`Cannot add edge ${edge.id || ""}: missing source or target`);
        continue;
      }
      const id = uniqueId(slugify(edge.id || `${source}_to_${target}`), new Set(diagram.edges.map(item => item.id)));
      diagram = normalizeDiagram({
        ...diagram,
        edges: diagram.edges.concat({ ...edge, id, source, target }),
        created_at: diagram.created_at
      });
      applied.push({ op, id });
      continue;
    }

    if (op === "update_edge") {
      const id = slugify(operation.id || "");
      const patch = operation.patch || {};
      let found = false;
      const edges = diagram.edges.map(edge => {
        if (edge.id !== id) return edge;
        found = true;
        if (patch.id && slugify(patch.id) !== edge.id) warnings.push(`Ignoring edge id change for ${edge.id}`);
        return {
          ...edge,
          source: patch.source ? slugify(patch.source) : edge.source,
          target: patch.target ? slugify(patch.target) : edge.target,
          name: patch.name ?? edge.name,
          notes: patch.notes ?? edge.notes,
          directed: patch.directed ?? edge.directed,
          style: patch.style ? { ...edge.style, ...patch.style } : edge.style
        };
      });
      if (!found) {
        warnings.push(`Edge not found: ${operation.id}`);
        continue;
      }
      diagram = normalizeDiagram({ ...diagram, edges, created_at: diagram.created_at });
      applied.push({ op, id });
      continue;
    }

    if (op === "delete_edge") {
      const id = slugify(operation.id || "");
      const before = diagram.edges.length;
      const edges = diagram.edges.filter(edge => edge.id !== id);
      if (edges.length === before) {
        warnings.push(`Edge not found: ${operation.id}`);
        continue;
      }
      diagram = normalizeDiagram({ ...diagram, edges, created_at: diagram.created_at });
      applied.push({ op, id });
      continue;
    }

    warnings.push(`Unsupported operation: ${op}`);
  }

  return {
    diagram: normalizeDiagram({ ...diagram, created_at: diagram.created_at }),
    applied,
    warnings
  };
}

export function diagramToSvg(input) {
  const diagram = normalizeDiagram(input);
  const bounds = diagramBounds(diagram);
  const width = Math.max(900, Math.ceil(bounds.maxX - bounds.minX + 96));
  const height = Math.max(620, Math.ceil(bounds.maxY - bounds.minY + 96));
  const offsetX = 48 - bounds.minX;
  const offsetY = 48 - bounds.minY;
  const nodeById = Object.fromEntries(diagram.nodes.map(node => [node.id, node]));

  const edges = diagram.edges.map(edge => {
    const source = nodeById[edge.source];
    const target = nodeById[edge.target];
    if (!source || !target) return "";
    const a = centerOf(source, offsetX, offsetY);
    const b = centerOf(target, offsetX, offsetY);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const marker = edge.directed ? ' marker-end="url(#arrow)"' : "";
    const label = edge.name
      ? `<text class="edge-label" x="${midX}" y="${midY - 8}" text-anchor="middle">${escapeXml(edge.name)}</text>`
      : "";
    return `<line class="edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${escapeXml(edge.style.stroke)}"${marker}><title>${escapeXml(edge.notes || edge.name || edge.id)}</title></line>${label}`;
  }).join("\n");

  const nodes = diagram.nodes.map(node => nodeToSvg(node, offsetX, offsetY)).join("\n");
  const metaLinks = diagram.meta_links.length
    ? `<text class="meta" x="18" y="${height - 18}">${diagram.meta_links.length} meta link(s) in notes</text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(diagram.title)}">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#64748b" />
    </marker>
    <style>
      .title { font: 700 18px system-ui, -apple-system, Segoe UI, sans-serif; fill: #17202a; }
      .node-label { font: 600 13px system-ui, -apple-system, Segoe UI, sans-serif; fill: #17202a; }
      .edge-label { font: 12px system-ui, -apple-system, Segoe UI, sans-serif; fill: #334155; paint-order: stroke; stroke: #fff; stroke-width: 4px; stroke-linejoin: round; }
      .edge { stroke-width: 1.8px; stroke-linecap: round; }
      .meta { font: 11px system-ui, -apple-system, Segoe UI, sans-serif; fill: #64748b; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="#f8fafc" />
  <text class="title" x="18" y="30">${escapeXml(diagram.title)}</text>
  <g>${edges}</g>
  <g>${nodes}</g>
  ${metaLinks}
</svg>`;
}

function compactText(value, maxLength = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function uniqueId(base, taken) {
  let id = slugify(base, "item");
  let count = 2;
  while (taken.has(id)) id = `${slugify(base, "item")}_${count++}`;
  return id;
}

function numberPatch(patch = {}) {
  return Object.fromEntries(
    Object.entries(patch)
      .map(([key, value]) => [key, Number(value)])
      .filter(([, value]) => Number.isFinite(value))
  );
}

function nodeToSvg(node, offsetX, offsetY) {
  const x = node.position.x + offsetX;
  const y = node.position.y + offsetY;
  const w = node.size.width;
  const h = node.size.height;
  const fill = escapeXml(node.style.fill);
  const stroke = escapeXml(node.style.stroke);
  const label = escapeXml(node.name);
  const title = escapeXml(node.notes || node.name || node.id);
  const text = `<text class="node-label" x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${label}</text>`;
  const note = node.notes ? `<circle cx="${x + w - 13}" cy="${y + 13}" r="7" fill="#fef3c7" stroke="#d97706" /><text x="${x + w - 13}" y="${y + 17}" text-anchor="middle" font-size="10" fill="#92400e">i</text>` : "";
  if (node.shape === "ellipse") {
    return `<g><ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"><title>${title}</title></ellipse>${text}${note}</g>`;
  }
  if (node.shape === "diamond") {
    const points = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
    return `<g><polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="2"><title>${title}</title></polygon>${text}${note}</g>`;
  }
  if (node.shape === "note") {
    const fold = Math.min(24, w * 0.18, h * 0.28);
    const points = `${x},${y} ${x + w - fold},${y} ${x + w},${y + fold} ${x + w},${y + h} ${x},${y + h}`;
    return `<g><polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="2"><title>${title}</title></polygon><polyline points="${x + w - fold},${y} ${x + w - fold},${y + fold} ${x + w},${y + fold}" fill="none" stroke="${stroke}" stroke-width="1.4" />${text}${note}</g>`;
  }
  const radius = node.shape === "rounded_rectangle" ? 10 : 0;
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2"><title>${title}</title></rect>${text}${note}</g>`;
}

function diagramBounds(diagram) {
  if (!diagram.nodes.length) return { minX: 0, minY: 0, maxX: 820, maxY: 520 };
  return diagram.nodes.reduce((acc, node) => ({
    minX: Math.min(acc.minX, node.position.x),
    minY: Math.min(acc.minY, node.position.y),
    maxX: Math.max(acc.maxX, node.position.x + node.size.width),
    maxY: Math.max(acc.maxY, node.position.y + node.size.height)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function centerOf(node, offsetX, offsetY) {
  return {
    x: node.position.x + offsetX + node.size.width / 2,
    y: node.position.y + offsetY + node.size.height / 2
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeXml(value) {
  return String(value ?? "").replace(/[<>&'"]/g, char => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  })[char]);
}
