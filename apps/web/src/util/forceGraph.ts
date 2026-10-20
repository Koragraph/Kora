/**
 * A self-contained force-directed graph renderer on a 2D canvas — built to draw the FULL
 * code graph (tens of thousands of nodes), not a 600-node sample.
 *
 * Physics: Barnes-Hut. Repulsion is approximated with a quadtree (O(n log n)) instead of
 * the old all-pairs O(n²) loop, which is what made large graphs unrenderable. Attraction is
 * along edges (O(e)); a mild gravity keeps components framed. A cooling schedule caps
 * per-tick movement so the layout converges, then the RAF loop FREEZES — a settled graph
 * repaints zero frames (Kora' no-idle-animation rule). It wakes only for interaction.
 *
 * Look: pure black, monochrome. Importance is encoded by node SIZE and brightness (degree),
 * not by a rainbow of directory colors — so a dense graph reads as a clean constellation
 * rather than a noisy one. Edges are a single faint batched stroke; hover lights up a node
 * and its neighbours.
 */

export interface FGNode {
  readonly id: number;
  readonly label: string;
  readonly file: string;
  readonly kind: string;
  readonly cluster: string;
  readonly degree: number;
}
export interface FGEdge {
  readonly source: number;
  readonly target: number;
  readonly kind: string;
}

export interface ForceGraphData {
  readonly nodes: ReadonlyArray<FGNode>;
  readonly edges: ReadonlyArray<FGEdge>;
}

export interface ForceGraphOptions {
  /** Called when the hovered node changes (null when the pointer leaves all nodes). */
  readonly onHover?: (node: (FGNode & { sx: number; sy: number }) | null) => void;
  /** Called when a node is clicked. */
  readonly onSelect?: (node: FGNode | null) => void;
  /** Brightness 0..1 for a node's group (the report's areas); absent = brightness by degree alone. */
  readonly toneOf?: (node: FGNode) => number | null;
}

interface SimNode extends FGNode {
  x: number;
  y: number;
  dx: number;
  dy: number;
  r: number;
  mass: number; // ForceAtlas2 mass = degree + 1: hubs repel harder and resist being pulled
  pinned: boolean;
}

export interface ForceGraphController {
  destroy(): void;
  reheat(): void;
  resize(): void;
  /** Keep only these nodes lit (the rest dim); null clears it. */
  emphasize(ids: ReadonlySet<number> | null): void;
}

// ---- Barnes-Hut quadtree ----
interface Cell {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  mass: number;
  node: SimNode | null;
  kids: [Cell, Cell, Cell, Cell] | null;
}
function makeCell(x0: number, y0: number, x1: number, y1: number): Cell {
  return { x0, y0, x1, y1, cx: 0, cy: 0, mass: 0, node: null, kids: null };
}

export function createForceGraph(
  canvas: HTMLCanvasElement,
  data: ForceGraphData,
  options: ForceGraphOptions,
): ForceGraphController {
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const nodeById = new Map<number, SimNode>();

  let maxDegree = 1;
  for (const n of data.nodes) if (n.degree > maxDegree) maxDegree = n.degree;

  const nodes: SimNode[] = data.nodes.map((n) => {
    // Random seed (not a golden-angle spiral) — a symmetric seed settles into a symmetric disc;
    // a random one lets the graph's own structure decide the shape.
    const angle = Math.random() * Math.PI * 2;
    const radius = 240 * Math.sqrt(Math.random());
    const sn: SimNode = {
      ...n,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      dx: 0,
      dy: 0,
      r: 1.2 + Math.sqrt(n.degree) * 1.15, // hubs noticeably larger (Obsidian-style)
      mass: n.degree + 1,
      pinned: false,
    };
    nodeById.set(n.id, sn);
    return sn;
  });
  const edges = data.edges
    .map((e) => ({ a: nodeById.get(e.source), b: nodeById.get(e.target) }))
    .filter((e): e is { a: SimNode; b: SimNode } => e.a !== undefined && e.b !== undefined);

  // Adjacency for hover highlight (precomputed once, not O(e) per pointer move).
  const adjacency = new Map<number, number[]>();
  for (const e of edges) {
    (adjacency.get(e.a.id) ?? adjacency.set(e.a.id, []).get(e.a.id)!).push(e.b.id);
    (adjacency.get(e.b.id) ?? adjacency.set(e.b.id, []).get(e.b.id)!).push(e.a.id);
  }

  let scale = 1;
  let offsetX = canvas.clientWidth / 2;
  let offsetY = canvas.clientHeight / 2;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  // ForceAtlas2 model (Gephi/Obsidian look): repulsion is DEGREE-WEIGHTED — hubs push each other
  // apart, so instead of every hub piling into one center (a symmetric disc) they scatter and each
  // anchors its own cluster → an organic, multi-lobe shape. Attraction is LinLog (log) so
  // communities stay tight but separate. Gravity is a weak CONSTANT pull (not distance-scaled), just
  // enough to keep disconnected bits from drifting off — not enough to round the whole thing out.
  const REPULSION = 0.9; // F = REPULSION · mass_a · mass_b / d
  const ATTRACT = 3.5; // LinLog attraction (f = ATTRACT·ln(1+d))
  const GRAVITY = 3.0; // weak constant centering (per unit mass)
  const THETA2 = 0.8 * 0.8; // Barnes-Hut opening criterion
  const TEMP_START = 30;
  const TEMP_MIN = 0.25;
  const COOLING = 0.985;
  // A big graph benefits from more settling work per frame; a small one converges in one tick.
  const TICKS_PER_FRAME = nodes.length > 6000 ? 2 : 1;
  /** Few enough nodes that every one gets its name drawn (and the view leaves room for them). */
  const showAllLabels = nodes.length <= 80;
  const LABEL_SEPARATION = 70;
  let temp = TEMP_START;

  let raf = 0;
  let running = false;
  let hovered: SimNode | null = null;
  let userAdjustedView = false;
  let highlightSet: Set<number> | null = null;
  let emphasized: ReadonlySet<number> | null = null;

  // ---- one simulation tick ----
  function insert(cell: Cell, n: SimNode, depth: number): void {
    cell.cx = (cell.cx * cell.mass + n.x * n.mass) / (cell.mass + n.mass);
    cell.cy = (cell.cy * cell.mass + n.y * n.mass) / (cell.mass + n.mass);
    cell.mass += n.mass;
    if (cell.kids === null && cell.node === null) {
      cell.node = n;
      return;
    }
    if (cell.kids === null) {
      if (depth > 24) return; // coincident cluster — stop subdividing, COM already captured
      const mx = (cell.x0 + cell.x1) / 2;
      const my = (cell.y0 + cell.y1) / 2;
      cell.kids = [
        makeCell(cell.x0, cell.y0, mx, my),
        makeCell(mx, cell.y0, cell.x1, my),
        makeCell(cell.x0, my, mx, cell.y1),
        makeCell(mx, my, cell.x1, cell.y1),
      ];
      const existing = cell.node;
      cell.node = null;
      if (existing) place(cell, existing, depth);
    }
    place(cell, n, depth);
  }
  function place(cell: Cell, n: SimNode, depth: number): void {
    const mx = (cell.x0 + cell.x1) / 2;
    const my = (cell.y0 + cell.y1) / 2;
    const q = (n.x < mx ? 0 : 1) + (n.y < my ? 0 : 2);
    insert(cell.kids![q]!, n, depth + 1);
  }
  function repel(cell: Cell, n: SimNode): void {
    if (cell.mass === 0) return;
    const ex = n.x - cell.cx;
    const ey = n.y - cell.cy;
    const d2 = ex * ex + ey * ey || 0.01;
    // Full-range Barnes-Hut (no cutoff): long-range hub↔hub repulsion is exactly what spreads the
    // clusters into separate lobes. The degree-weighting keeps low-degree nodes from being flung.
    if (cell.node !== null) {
      if (cell.node === n) return;
      applyRepulsion(n, cell.cx, cell.cy, cell.mass);
      return;
    }
    const width = cell.x1 - cell.x0;
    if (width * width < THETA2 * d2) {
      applyRepulsion(n, cell.cx, cell.cy, cell.mass);
    } else if (cell.kids !== null) {
      repel(cell.kids[0], n);
      repel(cell.kids[1], n);
      repel(cell.kids[2], n);
      repel(cell.kids[3], n);
    }
  }
  function applyRepulsion(n: SimNode, cx: number, cy: number, mass: number): void {
    let ex = n.x - cx;
    let ey = n.y - cy;
    let d = Math.sqrt(ex * ex + ey * ey);
    if (d < 0.01) {
      ex = (Math.random() - 0.5) * 0.1;
      ey = (Math.random() - 0.5) * 0.1;
      d = 0.01;
    }
    const f = (REPULSION * n.mass * mass) / d; // degree-weighted (ForceAtlas2)
    n.dx += (ex / d) * f;
    n.dy += (ey / d) * f;
  }

  function tick() {
    for (const n of nodes) {
      n.dx = 0;
      n.dy = 0;
    }
    // Build the quadtree over the current positions.
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const span = Math.max(maxX - minX, maxY - minY, 1) + 1;
    const root = makeCell(minX, minY, minX + span, minY + span);
    for (const n of nodes) insert(root, n, 0);
    // Repulsion via the tree (O(n log n)).
    for (const n of nodes) repel(root, n);
    // Attraction along edges — LinLog (logarithmic), so tight communities stay tight but the
    // graph as a whole opens up instead of collapsing to a single dense ball.
    for (const e of edges) {
      let ex = e.a.x - e.b.x;
      let ey = e.a.y - e.b.y;
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
      const f = ATTRACT * Math.log(1 + d);
      const ux = (ex / d) * f;
      const uy = (ey / d) * f;
      e.a.dx -= ux;
      e.a.dy -= uy;
      e.b.dx += ux;
      e.b.dy += uy;
    }
    // Weak CONSTANT centering (magnitude ∝ mass, not distance) — keeps the graph on-frame without
    // rounding it into a disc the way distance-scaled gravity did.
    for (const n of nodes) {
      const d = Math.sqrt(n.x * n.x + n.y * n.y) || 0.01;
      const g = GRAVITY * n.mass;
      n.dx -= (n.x / d) * g;
      n.dy -= (n.y / d) * g;
    }
    // A small graph shows every name, so neighbours must not sit on top of each other: push any pair closer than
    // LABEL_SEPARATION apart (O(n²), fine at ≤ 80 nodes).
    if (showAllLabels) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          let ex = a.x - b.x;
          let ey = a.y - b.y;
          let d = Math.sqrt(ex * ex + ey * ey);
          if (d >= LABEL_SEPARATION) continue;
          if (d < 0.01) {
            ex = Math.random() - 0.5;
            ey = Math.random() - 0.5;
            d = Math.sqrt(ex * ex + ey * ey) || 0.01;
          }
          const push = ((LABEL_SEPARATION - d) / d) * 0.5;
          a.dx += ex * push * a.mass;
          a.dy += ey * push * a.mass;
          b.dx -= ex * push * b.mass;
          b.dy -= ey * push * b.mass;
        }
      }
    }
    // Apply. ForceAtlas2: displacement = force / mass (heavy hubs move less and stay put as
    // anchors), then cap the magnitude by the cooling temperature so it converges.
    for (const n of nodes) {
      if (n.pinned) continue;
      let mx = n.dx / n.mass;
      let my = n.dy / n.mass;
      const len = Math.sqrt(mx * mx + my * my);
      if (len > temp) {
        mx = (mx / len) * temp;
        my = (my / len) * temp;
      }
      n.x += mx;
      n.y += my;
    }
    temp *= COOLING;
  }

  function fitView() {
    if (nodes.length === 0) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const gw = Math.max(1, maxX - minX);
    const gh = Math.max(1, maxY - minY);
    // Screen-space margins: a node on the hull never touches (or is cut by) the panel edge, and a small graph keeps
    // room for its labels, which run to the right of each node.
    const padX = showAllLabels ? 96 : 24;
    const padY = showAllLabels ? 40 : 24;
    scale = Math.min(
      Math.max(40, w - padX * 2) / gw,
      Math.max(40, h - padY * 2) / gh,
      showAllLabels ? 1.6 : 3,
    );
    offsetX = w / 2 - ((minX + maxX) / 2) * scale;
    offsetY = h / 2 - ((minY + maxY) / 2) * scale;
  }

  // ---- rendering (monochrome, batched) ----
  // The sky is the host surface's --background token (the Graph Explorer's always-dark panel),
  // read once so the opaque canvas and its chrome never disagree; black without a host token.
  const BG = getComputedStyle(canvas).getPropertyValue("--background").trim() || "#000000";
  // Brightness by degree: readable slate for leaves → near-white for hubs (floor kept high so
  // even a leaf is clearly visible on black at a full-graph zoom).
  function nodeShade(n: SimNode, dim: boolean): string {
    const t = Math.min(1, Math.sqrt(n.degree) / Math.sqrt(maxDegree));
    const tone = options.toneOf?.(n) ?? null;
    const l = tone === null ? 180 + Math.round(75 * t) : 70 + Math.round(185 * tone); // 180..255, or by area (see toneToGrey)
    const a = dim ? 0.22 : 1;
    return `rgba(${l},${l + 6},${Math.min(255, l + 18)},${a})`;
  }
  // Nodes never shrink below this many screen pixels, so the whole graph stays legible when
  // the view is framed to fit thousands of nodes (the "I can barely see it" case).
  const MIN_NODE_PX = 1.9;

  function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Edges — one batched stroke per style band. Cull to viewport-ish by skipping when
    // both ends are far outside (cheap: rely on the transform; at scale edges are thin).
    ctx.lineWidth = 0.7 / scale;
    if (highlightSet === null) {
      ctx.strokeStyle = "rgba(160,152,144,0.16)";
      ctx.beginPath();
      for (const e of edges) {
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
      }
      ctx.stroke();
    } else {
      // dim everything, then the active edges bright — two batched passes.
      ctx.strokeStyle = "rgba(140,132,124,0.04)";
      ctx.beginPath();
      for (const e of edges) {
        if (highlightSet.has(e.a.id) || highlightSet.has(e.b.id)) continue;
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(238,233,227,0.5)";
      ctx.lineWidth = 0.9 / scale;
      ctx.beginPath();
      for (const e of edges) {
        if (!highlightSet.has(e.a.id) && !highlightSet.has(e.b.id)) continue;
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
      }
      ctx.stroke();
    }

    // Nodes — monochrome, size by degree. Fill per node (no path batching for arcs) but
    // only a color string is computed; at tens of thousands this stays a few ms.
    const minR = MIN_NODE_PX / scale; // world-space floor that maps to MIN_NODE_PX on screen
    for (const n of nodes) {
      const dim =
        (highlightSet !== null && !highlightSet.has(n.id)) ||
        (emphasized !== null && !emphasized.has(n.id));
      ctx.fillStyle = nodeShade(n, dim);
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(n.r, minR), 0, Math.PI * 2);
      ctx.fill();
    }
    // Hover accent ring on the focused node.
    if (hovered) {
      ctx.strokeStyle = "rgba(238,233,227,0.95)";
      ctx.lineWidth = 1.4 / scale;
      ctx.beginPath();
      ctx.arc(hovered.x, hovered.y, Math.max(hovered.r, minR) + 1.5 / scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // Names: every node in a small graph (a handful of dots says nothing on its own); in a big one only the hubs,
    // once zoomed in far enough that they have room. Screen space, so the text stays crisp at any zoom.
    ctx.font = "11px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    const labelHubDegree = showAllLabels ? 0 : Math.max(4, maxDegree * 0.35);
    if (showAllLabels || scale >= 1.2) {
      for (const n of nodes) {
        if (!showAllLabels && n.degree < labelHubDegree) continue;
        const dim =
          (highlightSet !== null && !highlightSet.has(n.id)) ||
          (emphasized !== null && !emphasized.has(n.id));
        if (dim) continue;
        const sx = n.x * scale + offsetX;
        const sy = n.y * scale + offsetY;
        if (sx < -50 || sy < -20 || sx > w + 50 || sy > h + 20) continue;
        const r = Math.max(n.r * scale, MIN_NODE_PX);
        ctx.fillStyle = n === hovered ? "rgba(238,233,227,0.95)" : "rgba(200,196,190,0.62)";
        ctx.fillText(n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label, sx + r + 4, sy);
      }
    }
  }

  function frame() {
    for (let i = 0; i < TICKS_PER_FRAME; i++) tick();
    if (!userAdjustedView) fitView();
    draw();
    if (temp > TEMP_MIN) {
      raf = requestAnimationFrame(frame);
    } else {
      running = false;
    }
  }
  function ensureRunning() {
    if (!running) {
      running = true;
      raf = requestAnimationFrame(frame);
    }
  }

  // ---- interaction ----
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - offsetX) / scale,
      y: (clientY - rect.top - offsetY) / scale,
    };
  };
  const nodeAt = (clientX: number, clientY: number): SimNode | null => {
    const p = toWorld(clientX, clientY);
    let best: SimNode | null = null;
    let bestD = Infinity;
    const pad = 4 / scale;
    for (const n of nodes) {
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      const d = dx * dx + dy * dy;
      const hit = (n.r + pad) * (n.r + pad);
      if (d < hit && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  };

  let dragging: SimNode | null = null;
  let panning = false;
  let panStart = { x: 0, y: 0, ox: 0, oy: 0 };

  const onPointerMove = (ev: PointerEvent) => {
    if (dragging) {
      const p = toWorld(ev.clientX, ev.clientY);
      dragging.x = p.x;
      dragging.y = p.y;
      dragging.pinned = true;
      temp = Math.max(temp, 6);
      ensureRunning();
      return;
    }
    if (panning) {
      userAdjustedView = true;
      offsetX = panStart.ox + (ev.clientX - panStart.x);
      offsetY = panStart.oy + (ev.clientY - panStart.y);
      if (!running) draw();
      return;
    }
    const n = nodeAt(ev.clientX, ev.clientY);
    if (n !== hovered) {
      hovered = n;
      highlightSet = n ? new Set([n.id, ...(adjacency.get(n.id) ?? [])]) : null;
      canvas.style.cursor = n ? "pointer" : "grab";
      options.onHover?.(n ? { ...n, sx: n.x * scale + offsetX, sy: n.y * scale + offsetY } : null);
      if (!running) draw();
    } else if (n) {
      options.onHover?.({ ...n, sx: n.x * scale + offsetX, sy: n.y * scale + offsetY });
    }
  };
  const onPointerDown = (ev: PointerEvent) => {
    canvas.setPointerCapture(ev.pointerId);
    const n = nodeAt(ev.clientX, ev.clientY);
    if (n) {
      dragging = n;
      options.onSelect?.(n);
    } else {
      panning = true;
      panStart = { x: ev.clientX, y: ev.clientY, ox: offsetX, oy: offsetY };
      canvas.style.cursor = "grabbing";
      options.onSelect?.(null);
    }
  };
  const onPointerUp = (ev: PointerEvent) => {
    if (dragging) dragging.pinned = false;
    dragging = null;
    panning = false;
    canvas.style.cursor = "grab";
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    userAdjustedView = true;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const newScale = Math.min(Math.max(scale * factor, 0.05), 8);
    offsetX = mx - ((mx - offsetX) * newScale) / scale;
    offsetY = my - ((my - offsetY) * newScale) / scale;
    scale = newScale;
    if (!running) draw();
  };

  canvas.style.cursor = "grab";
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  ensureRunning();

  return {
    destroy() {
      cancelAnimationFrame(raf);
      running = false;
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    },
    reheat() {
      temp = Math.max(temp, TEMP_START * 0.5);
      ensureRunning();
    },
    emphasize(ids) {
      emphasized = ids;
      if (!running) draw();
    },
    resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (!running) draw();
    },
  };
}
