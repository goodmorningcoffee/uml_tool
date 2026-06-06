import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  useReactFlow
} from "@xyflow/react";
import {
  createBlankDiagram,
  deriveMetaLinks,
  normalizeDiagram,
  SHAPES,
  slugify
} from "../../shared/diagram.js";

const GRID_SIZE = 20;
const DEFAULT_STYLE = { fill: "#ffffff", stroke: "#334155", text: "#17202a" };
const SHAPE_LABELS = {
  rectangle: "Rectangle",
  rounded_rectangle: "Rounded",
  ellipse: "Ellipse",
  diamond: "Diamond",
  note: "Note"
};

const nodeTypes = { umlNode: UmlNode };

export default function App() {
  const flow = useReactFlow();
  const [diagrams, setDiagrams] = useState([]);
  const [diagramMeta, setDiagramMeta] = useState({ title: "Untitled Diagram", description: "" });
  const [currentId, setCurrentId] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("uml_tool_theme") || "light");
  const [agentBridge, setAgentBridge] = useState({
    connected: false,
    lastExternalUpdate: null,
    operationCount: 0,
    session: null,
    activeAction: ""
  });
  const currentIdRef = useRef(null);
  const selectedRef = useRef(null);
  const agentFocusRef = useRef(null);
  const agentFocusTimerRef = useRef(null);
  const fileInputRef = useRef(null);

  const currentDiagram = useMemo(() => flowToDiagram({ currentId, diagramMeta, nodes, edges }), [currentId, diagramMeta, nodes, edges]);
  const metaLinks = useMemo(() => deriveMetaLinks(currentDiagram), [currentDiagram]);

  useEffect(() => {
    refreshDiagrams();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("uml_tool_theme", theme);
  }, [theme]);

  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => setAgentBridge(existing => ({ ...existing, connected: true }));
    events.onerror = () => setAgentBridge(existing => ({ ...existing, connected: false }));
    events.onmessage = event => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "agent_operation_started" && payload.diagram_id === currentIdRef.current) {
          applyAgentFocus(payload.focus, { message: payload.message || "Agent edit started", center: true });
        }
        if (payload.type === "diagram_updated" && payload.source === "agent" && payload.diagram_id === currentIdRef.current) {
          const updatedAt = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
          const focus = normalizeFocus(payload.focus) || selectedRef.current;
          setAgentBridge(existing => ({
            ...existing,
            activeAction: payload.message || existing.activeAction,
            lastExternalUpdate: payload.timestamp || new Date().toISOString()
          }));
          loadDiagram(payload.diagram_id, {
            preserveSelection: focus,
            focus,
            fit: false,
            message: payload.message || `Updated by agent at ${updatedAt}`
          }).catch(error => setMessage(error.message));
        }
        if (payload.type === "agent_operation_applied" && payload.diagram_id === currentIdRef.current) {
          applyAgentFocus(payload.focus, { message: payload.message || "Agent edit applied", center: true });
        }
        if (payload.type === "operation_logged" && payload.diagram_id === currentIdRef.current) {
          refreshAgentSummary().catch(error => setMessage(error.message));
        }
        if (payload.type === "diagram_deleted") {
          setDiagrams(existing => existing.filter(item => item.id !== payload.diagram_id));
          if (payload.diagram_id === currentIdRef.current) clearCanvas();
        }
        if (payload.type === "diagrams_cleared") {
          setDiagrams([]);
          clearCanvas();
          setMessage(`All charts deleted (${payload.count ?? 0}).`);
        }
      } catch (error) {
        setMessage(error.message);
      }
    };
    return () => events.close();
  }, []);

  useEffect(() => {
    if (!currentId) return;
    const timer = window.setTimeout(() => {
      postSession().catch(error => setMessage(error.message));
      refreshAgentSummary().catch(error => setMessage(error.message));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [currentId, diagramMeta.title, selected?.type, selected?.id]);

  const onNodesChange = useCallback(changes => {
    setNodes(existing => applyNodeChanges(changes, existing));
    setDirty(true);
  }, []);

  const onEdgesChange = useCallback(changes => {
    setEdges(existing => applyEdgeChanges(changes, existing));
    setDirty(true);
  }, []);

  const onConnect = useCallback(params => {
    const edge = {
      ...params,
      id: `edge_${Date.now()}`,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      label: "",
      data: { name: "", notes: "", directed: true, style: { stroke: "#64748b" } },
      style: { stroke: "#64748b", strokeWidth: 1.8 }
    };
    setEdges(existing => addEdge(edge, existing));
    setDirty(true);
  }, []);

  async function refreshDiagrams() {
    const response = await fetch("/api/diagrams");
    const payload = await response.json();
    setDiagrams(payload.diagrams || []);
    if (!currentId && payload.diagrams?.length) {
      await loadDiagram(payload.diagrams[0].id);
    }
  }

  async function loadDiagram(id, options = {}) {
    const response = await fetch(`/api/diagrams/${id}`);
    if (!response.ok) throw new Error(`Could not load ${id}`);
    const diagram = await response.json();
    const nextNodes = toFlowNodes(diagram.nodes);
    const nextEdges = toFlowEdges(diagram.edges);
    const focus = normalizeFocus(options.focus);
    const preserved = preserveSelection(focus || options.preserveSelection, nextNodes, nextEdges);
    setCurrentId(diagram.id);
    setDiagramMeta({ title: diagram.title, description: diagram.description || "" });
    agentFocusRef.current = focus || null;
    setNodes(nextNodes.map(node => decorateNodeFocus(node, preserved, focus)));
    setEdges(nextEdges.map(edge => decorateEdgeFocus(edge, preserved, focus)));
    setSelected(preserved);
    setDirty(false);
    if (options.message) setMessage(options.message);
    if (options.focus) setAgentFocusClearTimer(focus);
    if (options.fit !== false) setTimeout(() => flow.fitView({ padding: 0.22, duration: 250 }), 50);
    if (focus) setTimeout(() => centerSelection(flow, focus, nextNodes, nextEdges), 90);
  }

  function newDiagram() {
    const title = window.prompt("Diagram title", "Untitled Diagram");
    if (!title) return;
    const diagram = createBlankDiagram(title);
    setCurrentId(diagram.id);
    setDiagramMeta({ title: diagram.title, description: "" });
    setNodes([]);
    setEdges([]);
    setSelected(null);
    setDirty(true);
  }

  async function saveDiagram() {
    const diagram = normalizeDiagram(currentDiagram);
    const method = currentId && diagrams.some(item => item.id === currentId) ? "PUT" : "POST";
    const url = method === "PUT" ? `/api/diagrams/${currentId}` : "/api/diagrams";
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(diagram)
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setCurrentId(payload.diagram.id);
    setDiagramMeta({ title: payload.diagram.title, description: payload.diagram.description || "" });
    setNodes(toFlowNodes(payload.diagram.nodes));
    setEdges(toFlowEdges(payload.diagram.edges));
    setDirty(false);
    setMessage(`Saved ${payload.diagram.title}`);
    await postSession({ current_diagram_id: payload.diagram.id, current_diagram_title: payload.diagram.title });
    await refreshDiagrams();
  }

  async function renameDiagram() {
    if (!currentId) return;
    const title = window.prompt("New diagram title", diagramMeta.title);
    if (!title) return;
    const id = window.prompt("Optional new file id. Leave blank to keep the current id.", currentId);
    const response = await fetch(`/api/diagrams/${currentId}/rename`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, id: id || currentId })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setCurrentId(payload.diagram.id);
    setDiagramMeta({ title: payload.diagram.title, description: payload.diagram.description || "" });
    await postSession({ current_diagram_id: payload.diagram.id, current_diagram_title: payload.diagram.title });
    await refreshDiagrams();
    setMessage(`Renamed to ${payload.diagram.title}`);
  }

  async function deleteDiagram(id = currentId) {
    if (!id) return;
    if (!window.confirm(`Delete diagram ${id}?`)) return;
    const response = await fetch(`/api/diagrams/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    setMessage(`Deleted ${id}`);
    setDiagrams(existing => existing.filter(item => item.id !== id));
    if (id === currentId) {
      clearCanvas();
      await postSession({ current_diagram_id: null, current_diagram_title: null, selected_node_id: null, selected_edge_id: null });
    }
    await refreshDiagrams();
  }

  function clearCanvas() {
    setCurrentId(null);
    setDiagramMeta({ title: "Untitled Diagram", description: "" });
    setNodes([]);
    setEdges([]);
    setSelected(null);
    setDirty(false);
  }

  async function deleteAllDiagrams() {
    if (!diagrams.length) { setMessage("No charts to delete."); return; }
    if (!window.confirm(`Delete ALL ${diagrams.length} charts? This removes every saved diagram and cannot be undone.`)) return;
    const response = await fetch("/api/diagrams", { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setDiagrams([]);
    clearCanvas();
    await postSession({ current_diagram_id: null, current_diagram_title: null, selected_node_id: null, selected_edge_id: null });
    setMessage(`Deleted all charts (${payload.count}).`);
  }

  async function importDiagramFromFile(file) {
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      setMessage(`Invalid JSON: ${error.message}`);
      return;
    }
    const diagram = normalizeDiagram(parsed);
    if (!diagram.nodes.length && !diagram.edges.length) {
      setMessage("That JSON has no nodes or edges to view.");
      return;
    }
    setCurrentId(diagram.id);
    setDiagramMeta({ title: diagram.title, description: diagram.description || "" });
    setNodes(toFlowNodes(diagram.nodes));
    setEdges(toFlowEdges(diagram.edges));
    setSelected(null);
    setDirty(true);
    setMessage(`Loaded "${diagram.title}" (${diagram.nodes.length} nodes, ${diagram.edges.length} edges). Press Save to keep it.`);
    setTimeout(() => flow.fitView({ padding: 0.22, duration: 250 }), 60);
  }

  function addShape(shape) {
    const count = nodes.length + 1;
    const id = uniqueNodeId(slugify(`${shape}_${count}`), nodes);
    const position = snapPosition({
      x: 120 + (count % 5) * 210,
      y: 120 + Math.floor(count / 5) * 130
    });
    const node = {
      id,
      type: "umlNode",
      position,
      style: defaultSizeForShape(shape),
      data: {
        id,
        name: id,
        notes: "",
        shape,
        size: defaultSizeForShape(shape),
        style: { ...DEFAULT_STYLE }
      },
      selected: true
    };
    setNodes(existing => existing.map(n => ({ ...n, selected: false })).concat(node));
    setSelected({ type: "node", id });
    setDirty(true);
    setTimeout(() => flow.setCenter(position.x + 90, position.y + 45, { duration: 200, zoom: 1 }), 20);
  }

  function selectNode(id) {
    const node = nodes.find(item => item.id === id);
    if (!node) return;
    setSelected({ type: "node", id });
    setNodes(existing => existing.map(item => ({ ...item, selected: item.id === id })));
    flow.setCenter(node.position.x + (node.data.size?.width || 180) / 2, node.position.y + (node.data.size?.height || 80) / 2, { duration: 240, zoom: Math.max(flow.getZoom(), 1) });
  }

  function selectEdge(id) {
    setSelected({ type: "edge", id });
    setEdges(existing => existing.map(item => ({ ...item, selected: item.id === id })));
  }

  function updateSelectedNode(patch) {
    if (!selected || selected.type !== "node") return;
    setNodes(existing => existing.map(node => {
      if (node.id !== selected.id) return node;
      const nextData = { ...node.data, ...patch };
      const nextStyle = patch.size ? { ...node.style, width: patch.size.width, height: patch.size.height } : node.style;
      return { ...node, data: nextData, style: nextStyle, selected: true };
    }));
    setDirty(true);
  }

  function updateSelectedEdge(patch) {
    if (!selected || selected.type !== "edge") return;
    setEdges(existing => existing.map(edge => {
      if (edge.id !== selected.id) return edge;
      const data = { ...edge.data, ...patch };
      return {
        ...edge,
        label: data.name || "",
        data,
        markerEnd: data.directed !== false ? { type: MarkerType.ArrowClosed } : undefined,
        selected: true
      };
    }));
    setDirty(true);
  }

  function deleteSelected() {
    if (!selected) return;
    if (selected.type === "node") {
      setNodes(existing => existing.filter(node => node.id !== selected.id));
      setEdges(existing => existing.filter(edge => edge.source !== selected.id && edge.target !== selected.id));
    } else {
      setEdges(existing => existing.filter(edge => edge.id !== selected.id));
    }
    setSelected(null);
    setDirty(true);
  }

  useEffect(() => {
    const onKey = event => {
      if (event.target?.tagName === "TEXTAREA" || event.target?.tagName === "INPUT" || event.target?.tagName === "SELECT") return;
      if (event.key === "Delete" || event.key === "Backspace") deleteSelected();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveDiagram().catch(error => setMessage(error.message));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selectedNode = selected?.type === "node" ? nodes.find(node => node.id === selected.id) : null;
  const selectedEdge = selected?.type === "edge" ? edges.find(edge => edge.id === selected.id) : null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>UML Tool</h1>
          <div className="brand-actions">
            <button className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "Light" : "Dark"}</button>
            <span className={dirty ? "dirty" : "saved"}>{dirty ? "unsaved" : "saved"}</span>
          </div>
        </div>
        <div className="button-row">
          <button onClick={newDiagram}>New</button>
          <button onClick={() => saveDiagram().catch(error => setMessage(error.message))}>Save</button>
        </div>
        <div className="button-row">
          <button onClick={renameDiagram} disabled={!currentId}>Rename</button>
          <button className="danger" onClick={() => deleteDiagram()} disabled={!currentId}>Delete</button>
        </div>
        <div className="button-row">
          <button onClick={() => fileInputRef.current?.click()}>Load JSON</button>
          <button className="danger" onClick={() => deleteAllDiagrams().catch(error => setMessage(error.message))} disabled={!diagrams.length}>Delete all</button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            importDiagramFromFile(file).catch(error => setMessage(error.message));
          }}
        />
        <div className="diagram-meta">
          <label>Title<input value={diagramMeta.title} onChange={event => { setDiagramMeta({ ...diagramMeta, title: event.target.value }); setDirty(true); }} /></label>
          <label>Description<textarea rows={3} value={diagramMeta.description} onChange={event => { setDiagramMeta({ ...diagramMeta, description: event.target.value }); setDirty(true); }} /></label>
        </div>
        <h2>Saved Diagrams</h2>
        <div className="diagram-list">
          {diagrams.map(item => (
            <button key={item.id} className={item.id === currentId ? "diagram-button active" : "diagram-button"} onClick={() => loadDiagram(item.id).catch(error => setMessage(error.message))}>
              <strong>{item.title}</strong>
              <span>{item.node_count} nodes · {item.edge_count} edges · {item.meta_link_count} meta</span>
            </button>
          ))}
          {!diagrams.length && <p className="muted">No saved diagrams yet.</p>}
        </div>
        {currentId && (
          <div className="file-links">
            <a href={`/api/diagrams/${currentId}`} target="_blank" rel="noreferrer">Open JSON</a>
            <a href={`/exports/${currentId}.svg`} target="_blank" rel="noreferrer">Open SVG</a>
          </div>
        )}
        <AgentBridgePanel currentId={currentId} selected={selected} bridge={agentBridge} />
        {message && <p className="message">{message}</p>}
      </aside>

      <main className="canvas-column">
        <div className="topbar">
          <div className="shape-tools">
            {SHAPES.map(shape => <button key={shape} onClick={() => addShape(shape)}>{SHAPE_LABELS[shape]}</button>)}
          </div>
          <div className="meta-summary">
            <span>{nodes.length} nodes</span>
            <span>{edges.length} visible edges</span>
            <span>{metaLinks.length} meta links</span>
          </div>
        </div>
        <div className="flow-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => selectNode(node.id)}
            onNodeContextMenu={(event, node) => { event.preventDefault(); selectNode(node.id); }}
            onEdgeClick={(_, edge) => selectEdge(edge.id)}
            onPaneClick={() => setSelected(null)}
            onMoveEnd={(_, viewport) => postSession({ viewport }).catch(error => setMessage(error.message))}
            snapToGrid
            snapGrid={[GRID_SIZE, GRID_SIZE]}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={GRID_SIZE} size={1} color={theme === "dark" ? "#334155" : "#cbd5e1"} />
            <MiniMap pannable zoomable />
            <Controls />
          </ReactFlow>
        </div>
      </main>

      <Inspector
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        nodes={nodes}
        metaLinks={metaLinks}
        onNodeChange={updateSelectedNode}
        onEdgeChange={updateSelectedEdge}
        onDelete={deleteSelected}
        onJump={selectNode}
      />
    </div>
  );

  async function postSession(patch = {}) {
    const has = key => Object.prototype.hasOwnProperty.call(patch, key);
    const session = {
      current_diagram_id: has("current_diagram_id") ? patch.current_diagram_id : currentId,
      current_diagram_title: has("current_diagram_title") ? patch.current_diagram_title : diagramMeta.title,
      selected_node_id: has("selected_node_id") ? patch.selected_node_id : (selected?.type === "node" ? selected.id : null),
      selected_edge_id: has("selected_edge_id") ? patch.selected_edge_id : (selected?.type === "edge" ? selected.id : null),
      viewport: has("viewport") ? patch.viewport : safeViewport(flow)
    };
    const response = await fetch("/api/session/current", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(session)
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setAgentBridge(existing => ({ ...existing, session: payload.session }));
    return payload.session;
  }

  async function refreshAgentSummary() {
    const response = await fetch("/api/agent/current/summary");
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    setAgentBridge(existing => ({
      ...existing,
      session: payload.session || existing.session,
      operationCount: payload.current?.operation_log?.count || 0
    }));
    return payload;
  }

  function applyAgentFocus(rawFocus, { message: nextMessage = "", center = false } = {}) {
    const focus = normalizeFocus(rawFocus);
    agentFocusRef.current = focus;
    if (nextMessage) {
      setMessage(nextMessage);
      setAgentBridge(existing => ({ ...existing, activeAction: nextMessage }));
    }
    setNodes(existing => existing.map(node => decorateNodeFocus(node, focus, focus)));
    setEdges(existing => existing.map(edge => decorateEdgeFocus(edge, focus, focus)));
    if (focus?.type === "node" || focus?.type === "edge") setSelected(focus);
    if (center) setTimeout(() => centerSelection(flow, focus, nodes, edges), 20);
    setAgentFocusClearTimer(focus);
  }

  function setAgentFocusClearTimer(focus) {
    if (agentFocusTimerRef.current) window.clearTimeout(agentFocusTimerRef.current);
    if (!focus) return;
    agentFocusTimerRef.current = window.setTimeout(() => {
      if (agentFocusRef.current?.type !== focus.type || agentFocusRef.current?.id !== focus.id) return;
      agentFocusRef.current = null;
      setNodes(existing => existing.map(node => ({ ...node, data: { ...node.data, agentFocus: false } })));
      setEdges(existing => existing.map(edge => ({ ...edge, data: { ...edge.data, agentFocus: false } })));
    }, 5200);
  }
}

function preserveSelection(selection, nodes, edges) {
  if (!selection) return null;
  if (selection.type === "node" && nodes.some(node => node.id === selection.id)) return selection;
  if (selection.type === "edge" && edges.some(edge => edge.id === selection.id)) return selection;
  return null;
}

function normalizeFocus(focus) {
  if (!focus) return null;
  if (focus.type === "node" && focus.id) return { type: "node", id: focus.id };
  if (focus.type === "edge" && focus.id) return { type: "edge", id: focus.id };
  if (focus.node_id) return { type: "node", id: focus.node_id };
  if (focus.edge_id) return { type: "edge", id: focus.edge_id };
  return null;
}

function decorateNodeFocus(node, selection, focus) {
  const selected = selection?.type === "node" && selection.id === node.id;
  const agentFocus = focus?.type === "node" && focus.id === node.id;
  return { ...node, selected, data: { ...node.data, agentFocus } };
}

function decorateEdgeFocus(edge, selection, focus) {
  const selected = selection?.type === "edge" && selection.id === edge.id;
  const agentFocus = focus?.type === "edge" && focus.id === edge.id;
  return {
    ...edge,
    selected,
    data: { ...edge.data, agentFocus },
    style: {
      ...(edge.style || {}),
      stroke: agentFocus ? "#f59e0b" : edge.data?.style?.stroke || edge.style?.stroke || "#64748b",
      strokeWidth: agentFocus ? 3.4 : 1.8
    }
  };
}

function centerSelection(flow, selection, nodes, edges) {
  if (!selection) return;
  if (selection.type === "node") {
    const node = nodes.find(item => item.id === selection.id);
    if (!node) return;
    flow.setCenter(node.position.x + (node.data?.size?.width || 180) / 2, node.position.y + (node.data?.size?.height || 80) / 2, { duration: 300, zoom: Math.max(flow.getZoom(), 0.85) });
    return;
  }
  if (selection.type === "edge") {
    const edge = edges.find(item => item.id === selection.id);
    const source = nodes.find(item => item.id === edge?.source);
    const target = nodes.find(item => item.id === edge?.target);
    if (!source || !target) return;
    const x = (source.position.x + target.position.x) / 2;
    const y = (source.position.y + target.position.y) / 2;
    flow.setCenter(x, y, { duration: 300, zoom: Math.max(flow.getZoom(), 0.75) });
  }
}

function safeViewport(flow) {
  try {
    return flow.getViewport();
  } catch {
    return null;
  }
}

function AgentBridgePanel({ currentId, selected, bridge }) {
  return (
    <section className="agent-bridge">
      <div className="agent-bridge-heading">
        <h2>Agent Bridge</h2>
        <span className={bridge.connected ? "bridge-pill online" : "bridge-pill offline"}>{bridge.connected ? "live" : "offline"}</span>
      </div>
      <dl>
        <div><dt>Current</dt><dd>{currentId || "none"}</dd></div>
        <div><dt>Selected</dt><dd>{selected ? `${selected.type}:${selected.id}` : "none"}</dd></div>
        <div><dt>Ops</dt><dd>{bridge.operationCount}</dd></div>
        <div><dt>External</dt><dd>{bridge.lastExternalUpdate ? new Date(bridge.lastExternalUpdate).toLocaleTimeString() : "none"}</dd></div>
        <div><dt>Action</dt><dd>{bridge.activeAction || "idle"}</dd></div>
      </dl>
    </section>
  );
}

function UmlNode({ data, selected }) {
  const shape = data.shape || "rectangle";
  const style = data.style || DEFAULT_STYLE;
  return (
    <div className={`uml-node shape-${shape}${data.agentFocus ? " agent-focus" : ""}`} style={{ width: "100%", height: "100%", "--fill": style.fill, "--stroke": style.stroke, "--text": style.text }}>
      <NodeResizer isVisible={selected} minWidth={90} minHeight={54} />
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="node-name" title={data.name}>{data.name}</div>
      <div className={data.notes ? "note-indicator has-notes" : "note-indicator empty-notes"} title={data.notes ? "This node has notes" : "Add notes"}>{data.notes ? "i" : "+"}</div>
    </div>
  );
}

function Inspector({ selectedNode, selectedEdge, nodes, metaLinks, onNodeChange, onEdgeChange, onDelete, onJump }) {
  if (!selectedNode && !selectedEdge) {
    return (
      <aside className="inspector">
        <h2>Inspector</h2>
        <p className="muted">Select a node or edge. Right-click a node to edit its name and notes here.</p>
        <h3>Meta Links</h3>
        <MetaLinkTable links={metaLinks} onJump={onJump} />
      </aside>
    );
  }
  if (selectedNode) {
    const data = selectedNode.data;
    const nodeLinks = metaLinks.filter(link => link.source_node_id === selectedNode.id);
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          <h2>Node</h2>
          <button className="danger" onClick={onDelete}>Delete</button>
        </div>
        <label>Name<input value={data.name || ""} onChange={event => onNodeChange({ name: event.target.value })} /></label>
        <label>Shape
          <select value={data.shape || "rectangle"} onChange={event => onNodeChange({ shape: event.target.value, size: data.size || defaultSizeForShape(event.target.value) })}>
            {SHAPES.map(shape => <option key={shape} value={shape}>{SHAPE_LABELS[shape]}</option>)}
          </select>
        </label>
        <div className="two-col">
          <label>Width<input type="number" value={data.size?.width || 180} onChange={event => onNodeChange({ size: { ...(data.size || {}), width: Number(event.target.value) } })} /></label>
          <label>Height<input type="number" value={data.size?.height || 86} onChange={event => onNodeChange({ size: { ...(data.size || {}), height: Number(event.target.value) } })} /></label>
        </div>
        <div className="two-col">
          <label>Fill<input type="color" value={data.style?.fill || "#ffffff"} onChange={event => onNodeChange({ style: { ...(data.style || DEFAULT_STYLE), fill: event.target.value } })} /></label>
          <label>Stroke<input type="color" value={data.style?.stroke || "#334155"} onChange={event => onNodeChange({ style: { ...(data.style || DEFAULT_STYLE), stroke: event.target.value } })} /></label>
        </div>
        <label>Notes<textarea rows={11} value={data.notes || ""} onChange={event => onNodeChange({ notes: event.target.value })} placeholder="Write details here. Use [[node_name]] to explicitly link another node." /></label>
        <h3>Rendered Notes</h3>
        <LinkedText text={data.notes || ""} nodes={nodes} onJump={onJump} />
        <h3>Outgoing Meta Links</h3>
        <MetaLinkTable links={nodeLinks} onJump={onJump} />
      </aside>
    );
  }
  const edge = selectedEdge;
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <h2>Edge</h2>
        <button className="danger" onClick={onDelete}>Delete</button>
      </div>
      <label>Name<input value={edge.data?.name || ""} onChange={event => onEdgeChange({ name: event.target.value })} /></label>
      <label>Notes<textarea rows={11} value={edge.data?.notes || ""} onChange={event => onEdgeChange({ notes: event.target.value })} /></label>
      <label className="checkbox"><input type="checkbox" checked={edge.data?.directed !== false} onChange={event => onEdgeChange({ directed: event.target.checked })} /> Directed</label>
      <h3>Rendered Notes</h3>
      <LinkedText text={edge.data?.notes || ""} nodes={nodes} onJump={onJump} />
    </aside>
  );
}

function LinkedText({ text, nodes, onJump }) {
  if (!text) return <p className="muted">No notes.</p>;
  const parts = linkifyText(text, nodes);
  return (
    <div className="rendered-notes">
      {parts.map((part, index) => {
        if (!part.target) return <span key={index}>{part.text}</span>;
        return <button key={index} className="inline-link" onClick={() => onJump(part.target.id)}>{part.text}</button>;
      })}
    </div>
  );
}

function MetaLinkTable({ links, onJump }) {
  if (!links.length) return <p className="muted">No meta links.</p>;
  return (
    <table className="meta-table">
      <tbody>
        {links.map((link, index) => (
          <tr key={`${link.target_node_id}-${index}`}>
            <td>{link.source_node_id || link.source_edge_id}</td>
            <td>{link.link_type}</td>
            <td><button className="inline-link" onClick={() => onJump(link.target_node_id)}>{link.target_node_id}</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function toFlowNodes(diagramNodes) {
  return diagramNodes.map(node => ({
    id: node.id,
    type: "umlNode",
    position: node.position,
    data: { ...node },
    style: { width: node.size.width, height: node.size.height }
  }));
}

function toFlowEdges(diagramEdges) {
  return diagramEdges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    label: edge.name || "",
    data: { ...edge },
    markerEnd: edge.directed !== false ? { type: MarkerType.ArrowClosed } : undefined,
    style: { stroke: edge.style?.stroke || "#64748b", strokeWidth: 1.8 }
  }));
}

function flowToDiagram({ currentId, diagramMeta, nodes, edges }) {
  return {
    id: currentId || slugify(diagramMeta.title || "untitled_diagram"),
    title: diagramMeta.title || "Untitled Diagram",
    description: diagramMeta.description || "",
    canvas: { grid_size: GRID_SIZE },
    nodes: nodes.map(node => ({
      id: node.id,
      name: node.data?.name || node.id,
      notes: node.data?.notes || "",
      shape: node.data?.shape || "rectangle",
      position: snapPosition(node.position),
      size: {
        width: Math.round(node.measured?.width || node.width || node.data?.size?.width || 180),
        height: Math.round(node.measured?.height || node.height || node.data?.size?.height || 86)
      },
      style: node.data?.style || DEFAULT_STYLE
    })),
    edges: edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      name: edge.data?.name || edge.label || "",
      notes: edge.data?.notes || "",
      directed: edge.data?.directed !== false,
      style: edge.data?.style || { stroke: edge.style?.stroke || "#64748b" }
    }))
  };
}

function linkifyText(text, nodes) {
  const aliases = [];
  for (const node of nodes) {
    aliases.push({ key: node.id, target: node });
    if (node.data?.name && node.data.name !== node.id) aliases.push({ key: node.data.name, target: node });
  }
  const explicitPattern = /\[\[([^\]]+)\]\]/g;
  const chunks = [];
  let cursor = 0;
  let match;
  while ((match = explicitPattern.exec(text))) {
    if (match.index > cursor) chunks.push({ text: text.slice(cursor, match.index) });
    const target = aliases.find(item => item.key.toLowerCase() === match[1].trim().toLowerCase())?.target;
    chunks.push({ text: match[1], target });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) chunks.push(...autoLinkChunk(text.slice(cursor), aliases));
  return chunks.flatMap(chunk => chunk.target ? [chunk] : autoLinkChunk(chunk.text, aliases));
}

function autoLinkChunk(text, aliases) {
  let chunks = [{ text }];
  for (const alias of aliases.sort((a, b) => b.key.length - a.key.length)) {
    if (alias.key.length < 3) continue;
    const next = [];
    const pattern = new RegExp(`(^|[^A-Za-z0-9_\\-])(${escapeRegex(alias.key)})(?=$|[^A-Za-z0-9_\\-])`, "gi");
    for (const chunk of chunks) {
      if (chunk.target) {
        next.push(chunk);
        continue;
      }
      let cursor = 0;
      let match;
      while ((match = pattern.exec(chunk.text))) {
        const start = match.index + match[1].length;
        if (start > cursor) next.push({ text: chunk.text.slice(cursor, start) });
        next.push({ text: match[2], target: alias.target });
        cursor = start + match[2].length;
      }
      if (cursor < chunk.text.length) next.push({ text: chunk.text.slice(cursor) });
    }
    chunks = next;
  }
  return chunks;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snapPosition(position) {
  return {
    x: Math.round(position.x / GRID_SIZE) * GRID_SIZE,
    y: Math.round(position.y / GRID_SIZE) * GRID_SIZE
  };
}

function defaultSizeForShape(shape) {
  if (shape === "note") return { width: 210, height: 110 };
  if (shape === "diamond") return { width: 160, height: 110 };
  if (shape === "ellipse") return { width: 170, height: 88 };
  return { width: 190, height: 86 };
}

function uniqueNodeId(base, nodes) {
  const taken = new Set(nodes.map(node => node.id));
  let id = base;
  let count = 2;
  while (taken.has(id)) id = `${base}_${count++}`;
  return id;
}
