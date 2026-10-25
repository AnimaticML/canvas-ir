// A force-directed graph: d3-force lays it out, and each node is a group on
// the board moved by a live transform. The edges are one path, drawn again
// each tick; the nodes are drawn once.
import { type ComponentSpec, type Point, RecordingContext, type Scene } from "canvas-ir";
import { type Simulation, type SimulationLinkDatum, type SimulationNodeDatum, forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";

export const GRAPH_ID = "graph";
export const GRAPH_AT = { x: 500, y: 1050 };
const W = 560;
const H = 420;
const COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2"];

interface Node extends SimulationNodeDatum {
  readonly id: string;
  readonly cluster: number;
  readonly r: number;
}

export interface ForceGraph {
  readonly simulation: Simulation<Node, SimulationLinkDatum<Node>>;
  readonly nodes: readonly Node[];
  /** The node a group id belongs to. */
  nodeOf(id: string): Node | undefined;
  grab(id: string, at: Point): void;
  drag(at: Point): void;
  release(): void;
  /** Nodes placed per tick, and how long the last tick took to place, in ms. */
  readonly stats: { ticks: number; ms: number };
  stop(): void;
}

const random = (() => {
  let seed = 11;
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
})();

/**
 * Draws the graph on the scene `board()` returns and starts the layout. When
 * the board is replayed into a new scene, the graph draws itself there again.
 */
export const createGraph = (board: () => Scene, onTick: () => void): ForceGraph => {
  const nodes: Node[] = [];
  const links: SimulationLinkDatum<Node>[] = [];
  // Six clusters, each a small tree with a few extra links, and a few links between clusters.
  for (let c = 0; c < 6; c++) {
    const first = nodes.length;
    const size = 14 + Math.floor(random() * 10);
    for (let i = 0; i < size; i++) {
      nodes.push({ id: `${GRAPH_ID}/n${nodes.length}`, cluster: c, r: i === 0 ? 11 : 5 + random() * 3, x: GRAPH_AT.x + W / 2 + (random() - 0.5) * 200, y: GRAPH_AT.y + H / 2 + (random() - 0.5) * 200 });
      if (i > 0) links.push({ source: nodes[first + Math.floor(random() * i)]!, target: nodes.at(-1)! });
    }
    for (let k = 0; k < 3; k++) links.push({ source: nodes[first + Math.floor(random() * size)]!, target: nodes[first + Math.floor(random() * size)]! });
    if (c > 0) links.push({ source: nodes[first]!, target: nodes[Math.floor(random() * first)]! });
  }

  const drawEdges = (c: RecordingContext): void => {
    c.beginGroup({ id: `${GRAPH_ID}/edges`, meta: { name: "edges" } });
    c.strokeStyle = "rgba(148, 163, 184, 0.55)";
    c.lineWidth = 1.25;
    c.beginPath();
    for (const l of links) {
      const s = l.source as Node;
      const t = l.target as Node;
      c.moveTo(s.x!, s.y!);
      c.lineTo(t.x!, t.y!);
    }
    c.stroke();
    c.endGroup();
  };
  // The frame and the edges first, so the edges draw under the nodes.
  let scene = board();
  const record = (): void => {
    const ctx = new RecordingContext();
    ctx.beginGroup({ id: GRAPH_ID, meta: { source: "force graph" } });
    ctx.beginGroup({ id: `${GRAPH_ID}/frame`, meta: { name: "frame", snap: false } });
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.roundRect(GRAPH_AT.x, GRAPH_AT.y, W, H, 12);
    ctx.fill();
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillStyle = "#cbd5e1";
    ctx.textBaseline = "top";
    ctx.fillText(`Force graph: d3-force, ${nodes.length} nodes, ${links.length} links. Drag a node.`, GRAPH_AT.x + 16, GRAPH_AT.y + 14);
    ctx.endGroup();
    drawEdges(ctx);
    // Each node is drawn once, at the origin; its live transform places it.
    for (const n of nodes) {
      ctx.beginGroup({ id: n.id, meta: { name: "node", role: "img", label: `node ${n.id.slice(GRAPH_ID.length + 2)} in cluster ${n.cluster + 1}` } });
      ctx.fillStyle = COLORS[n.cluster]!;
      ctx.beginPath();
      ctx.arc(0, 0, n.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.endGroup();
    }
    ctx.endGroup();
    scene.replaceGroup(GRAPH_ID, ctx.getDocument());
  };
  record();

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stats = { ticks: 0, ms: 0 };
  const inset = 18;
  const place = (): void => {
    if (board() !== scene) {
      scene = board();
      // The replayed board holds the nodes where they were drawn; draw them again at the origin to move them.
      if (scene.getGroup(GRAPH_ID)) scene.remove(GRAPH_ID);
      record();
    }
    if (!scene.getGroup(GRAPH_ID)) {
      simulation.stop();
      return;
    }
    const start = performance.now();
    for (const n of nodes) {
      // Keep nodes inside the frame.
      n.x = Math.min(GRAPH_AT.x + W - inset, Math.max(GRAPH_AT.x + inset, n.x!));
      n.y = Math.min(GRAPH_AT.y + H - inset, Math.max(GRAPH_AT.y + 40, n.y!));
      scene.setTransform(n.id, { a: 1, b: 0, c: 0, d: 1, e: n.x, f: n.y });
    }
    const edges = new RecordingContext();
    drawEdges(edges);
    scene.replaceGroup(`${GRAPH_ID}/edges`, edges.getDocument());
    stats.ticks++;
    stats.ms = performance.now() - start;
    onTick();
  };
  const simulation = forceSimulation(nodes)
    .force("link", forceLink(links).distance((l) => ((l.source as Node).cluster === (l.target as Node).cluster ? 26 : 90)).strength(0.6))
    .force("charge", forceManyBody().strength(-40))
    .force("collide", forceCollide<Node>((n) => n.r + 2))
    .force("center", forceCenter(GRAPH_AT.x + W / 2, GRAPH_AT.y + H / 2 + 14))
    .force("x", forceX(GRAPH_AT.x + W / 2).strength(0.03))
    .force("y", forceY(GRAPH_AT.y + H / 2).strength(0.05))
    .on("tick", place);
  place();

  let held: Node | null = null;
  let offset = { x: 0, y: 0 };
  return {
    simulation,
    nodes,
    stats,
    nodeOf: (id) => byId.get(id),
    grab(id, at) {
      held = byId.get(id) ?? null;
      if (!held) return;
      offset = { x: held.x! - at.x, y: held.y! - at.y };
      held.fx = held.x;
      held.fy = held.y;
      simulation.alphaTarget(0.3).restart();
    },
    drag(at) {
      if (!held) return;
      held.fx = at.x + offset.x;
      held.fy = at.y + offset.y;
    },
    release() {
      if (!held) return;
      held.fx = null;
      held.fy = null;
      held = null;
      simulation.alphaTarget(0);
    },
    stop: () => simulation.stop(),
  };
};

/** A Shake button under the graph: kicks the layout so it settles again. */
export const graphButton = (onShake: () => void): ComponentSpec<{ ms: number }> => {
  const x = GRAPH_AT.x;
  const y = GRAPH_AT.y + H + 24;
  return {
    id: "graph-shake",
    state: { ms: 0 },
    meta: { source: "graph controls", role: "button", label: "Shake the graph" },
    cursor: "pointer",
    draw: (c, { ms }, ui) => {
      c.fillStyle = ui.pressed ? "#1e3a8a" : ui.hovered ? "#3b82f6" : "#1d4ed8";
      c.beginPath();
      c.roundRect(x, y - 16, 86, 32, 16);
      c.fill();
      if (ui.focused) {
        c.strokeStyle = "#bfdbfe";
        c.lineWidth = 2;
        c.stroke();
      }
      c.fillStyle = "#ffffff";
      c.font = "600 13px system-ui, sans-serif";
      c.textBaseline = "middle";
      c.fillText("Shake", x + 22, y + 1);
      c.fillStyle = "#6b7280";
      c.font = "12px system-ui, sans-serif";
      c.fillText(ms > 0 ? `each tick moves every node and redraws the edges in ${ms.toFixed(1)} ms` : "nodes are drawn once; ticks only move them", x + 102, y + 1);
    },
    on: {
      click: (e) => {
        e.stopPropagation();
        onShake();
      },
    },
  };
};
