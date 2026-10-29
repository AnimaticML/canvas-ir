import type { Scene } from "./geometry/scene";
import { applyToPoint } from "./math";
import type { Matrix2D, Op, Rect } from "./types";

/**
 * A node of a drawing's accessibility tree: what a screen reader announces
 * and the keyboard can reach. Groups say what they are through their meta:
 * `role` (an ARIA role such as "button", "slider", "img" or "figure"),
 * `label`, and for sliders `value`, `min` and `max`. Text the drawing shows
 * is read as text. Groups without a role add nothing of their own.
 */
export interface AccessibleNode {
  /** The group (or text op) the node stands for. */
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly value?: number;
  readonly min?: number;
  readonly max?: number;
  /** Where it is on the board, in world space. */
  readonly bounds: Rect | null;
  readonly children: readonly AccessibleNode[];
}

/** Roles whose content is their label: their text isn't read again as children. */
const LEAF_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "slider", "img", "heading", "textbox", "menuitem", "tab", "option"]);
/** Roles the keyboard can reach. */
export const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "slider", "textbox", "menuitem", "tab", "option"]);

interface Branch {
  readonly id: string | null;
  readonly items: (Branch | Op)[];
}

/** The scene's groups and ops as a tree, in drawing order. */
const branches = (scene: Scene): Branch => {
  const root: Branch = { id: null, items: [] };
  const made = new Map<string, Branch>();
  const branch = (id: string): Branch => {
    let b = made.get(id);
    if (b) return b;
    b = { id, items: [] };
    made.set(id, b);
    const parent = scene.getGroup(id)?.parent;
    (parent === undefined ? root : branch(parent)).items.push(b);
    return b;
  };
  for (const op of scene.document.ops) (op.group === undefined ? root : branch(op.group)).items.push(op);
  return root;
};

const textOf = (b: Branch | Op): string[] => {
  if ("kind" in b) return b.kind === "text" ? [b.text] : [];
  return b.items.flatMap(textOf);
};

const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The accessibility tree of a scene: top-level nodes in drawing order. */
export const accessibilityTree = (scene: Scene): AccessibleNode[] => {
  // Index boxes: placing an element over a node needs no exact outline, and a long stroke's is costly to build.
  const walk = (items: readonly (Branch | Op)[]): AccessibleNode[] => {
    const out: AccessibleNode[] = [];
    // Text ops next to each other in one group read as one run, like the lines of a paragraph.
    let run: { ops: Op[]; text: string[] } | null = null;
    const flush = (): void => {
      if (!run) return;
      const first = run.ops[0]!;
      const label = run.text.join(" ").replace(/\s+/g, " ").trim();
      if (label !== "") out.push({ id: first.id, role: "text", label, bounds: boundsOf(run.ops.map((o) => o.id)), children: [] });
      run = null;
    };
    const boundsOf = (ids: readonly string[]): Rect | null => {
      let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
      for (const id of ids) {
        const b = scene.bounds(id, "index");
        if (!b) continue;
        box = box
          ? { minX: Math.min(box.minX, b.x), minY: Math.min(box.minY, b.y), maxX: Math.max(box.maxX, b.x + b.width), maxY: Math.max(box.maxY, b.y + b.height) }
          : { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
      }
      return box ? { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY } : null;
    };
    const addText = (op: Op & { kind: "text" }): void => {
      run ??= { ops: [], text: [] };
      // The same text filled and stroked at one place is read once.
      const last = run.ops[run.ops.length - 1];
      if (last?.kind === "text" && last.text === op.text && last.x === op.x && last.y === op.y) return;
      run.ops.push(op);
      run.text.push(op.text);
    };
    for (const item of items) {
      if ("kind" in item) {
        if (item.kind === "text") addText(item);
        else if (item.kind === "embed") {
          flush();
          const label = item.content["label"] ?? item.content["type"];
          out.push({ id: item.id, role: "group", label: typeof label === "string" ? label : "embedded element", bounds: scene.bounds(item.id, "index"), children: [] });
        }
        continue;
      }
      const meta = scene.getGroup(item.id!)?.meta;
      const role = meta?.["role"];
      // A group of text alone, such as a line of a paragraph, continues the text around it.
      if (typeof role !== "string" && item.items.length > 0 && item.items.every((i) => "kind" in i && i.kind === "text")) {
        for (const i of item.items) addText(i as Op & { kind: "text" });
        continue;
      }
      flush();
      if (typeof role !== "string") {
        out.push(...walk(item.items));
        continue;
      }
      const given = meta?.["label"];
      const leaf = LEAF_ROLES.has(role);
      const label = typeof given === "string" ? given : leaf ? textOf(item).join(" ").trim() : "";
      const value = numberOf(meta?.["value"]);
      const min = numberOf(meta?.["min"]);
      const max = numberOf(meta?.["max"]);
      out.push({
        id: item.id!,
        role,
        label,
        ...(value !== undefined ? { value } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        bounds: scene.bounds(item.id!, "index"),
        children: leaf ? [] : walk(item.items),
      });
    }
    flush();
    return out;
  };
  return walk(branches(scene).items);
};

export interface AccessibilityLayerOptions {
  /** The keyboard moved to a node (Tab, or a screen reader's cursor). */
  readonly onFocus?: (id: string | null) => void;
  /** Enter or Space on a button, link or other control. */
  readonly onActivate?: (id: string) => void;
  /** The tree changed: nodes, labels or values, not only where they are. */
  readonly onChange?: (tree: readonly AccessibleNode[]) => void;
  /** How long edits settle before the tree is read again, in ms, so a drag doesn't rebuild it every frame. Default 120. */
  readonly delay?: number;
}

/**
 * Mirrors a scene's accessibility tree as DOM elements over the canvas, each
 * placed where its node is drawn: screen readers read them, Tab moves through
 * the controls, and a focus ring shows where the keyboard is. The elements are
 * transparent and let the pointer through. Style focus with
 * `.canvas-ir-a11y :focus-visible`.
 */
export class AccessibilityLayer {
  readonly root: HTMLElement;
  private view: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  private unsubscribe: (() => void) | null = null;
  private pending = false;
  private nodes: AccessibleNode[] = [];
  private shape = "";
  private readonly elements = new Map<string, { element: HTMLElement; node: AccessibleNode }>();

  constructor(
    private scene: Scene,
    container: HTMLElement,
    private readonly options: AccessibilityLayerOptions = {},
  ) {
    this.root = document.createElement("div");
    this.root.className = "canvas-ir-a11y";
    this.root.setAttribute("role", "application");
    this.root.setAttribute("aria-label", "Drawing");
    this.root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    container.append(this.root);
    this.setScene(scene);
  }

  setScene(scene: Scene): void {
    this.scene = scene;
    this.unsubscribe?.();
    this.unsubscribe = scene.onChange(() => this.schedule());
    this.update();
  }

  /** The view from world space to the container's CSS pixels. */
  setView(view: Matrix2D): void {
    this.view = view;
    for (const { element, node } of this.elements.values()) if (node.children.length === 0) this.place(element, node);
  }

  /** The tree last mirrored. */
  get tree(): readonly AccessibleNode[] {
    return this.nodes;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.root.remove();
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.update();
    }, this.options.delay ?? 120);
  }

  /** Builds the tree again; the DOM is rebuilt only when nodes, labels or values changed, and otherwise only moved. */
  update(): void {
    this.nodes = accessibilityTree(this.scene);
    const shape = JSON.stringify(this.nodes, (key, value: unknown) => (key === "bounds" ? undefined : value));
    if (shape === this.shape) {
      const visit = (nodes: readonly AccessibleNode[]): void => {
        for (const node of nodes) {
          const placed = this.elements.get(node.id);
          if (placed) {
            placed.node = node;
            if (node.children.length === 0) this.place(placed.element, node);
          }
          visit(node.children);
        }
      };
      visit(this.nodes);
      return;
    }
    this.shape = shape;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.["node"];
    this.elements.clear();
    this.root.replaceChildren(...this.nodes.map((n) => this.build(n)));
    if (focused !== undefined) this.elements.get(focused)?.element.focus({ preventScroll: true });
    this.options.onChange?.(this.nodes);
  }

  private build(node: AccessibleNode): HTMLElement {
    const element = document.createElement("div");
    element.dataset["node"] = node.id;
    element.setAttribute("role", node.role === "text" ? "paragraph" : node.role);
    if (node.role === "text") element.textContent = node.label;
    else if (node.label !== "") element.setAttribute("aria-label", node.label);
    if (node.value !== undefined) element.setAttribute("aria-valuenow", String(node.value));
    if (node.min !== undefined) element.setAttribute("aria-valuemin", String(node.min));
    if (node.max !== undefined) element.setAttribute("aria-valuemax", String(node.max));
    // Text stays readable to screen readers but doesn't show; the canvas draws it.
    element.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;color:transparent;font-size:1px;overflow:hidden;pointer-events:none";
    if (INTERACTIVE_ROLES.has(node.role)) {
      element.tabIndex = 0;
      element.addEventListener("focus", () => this.options.onFocus?.(node.id));
      element.addEventListener("blur", () => {
        if (!this.root.contains(document.activeElement)) this.options.onFocus?.(null);
      });
      element.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || (e.key === " " && node.role !== "slider")) {
          e.preventDefault();
          e.stopPropagation();
          this.options.onActivate?.(node.id);
        }
      });
    }
    this.elements.set(node.id, { element, node });
    if (node.children.length === 0) {
      this.place(element, node);
      return element;
    }
    // A container isn't positioned, so its children place themselves against the root, inside it in the DOM.
    element.style.cssText = "position:static";
    element.append(...node.children.map((child) => this.build(child)));
    return element;
  }

  private place(element: HTMLElement, node: AccessibleNode): void {
    const b = node.bounds;
    if (!b) {
      element.style.width = "0";
      element.style.height = "0";
      return;
    }
    const p = applyToPoint(this.view, b.x, b.y);
    const q = applyToPoint(this.view, b.x + b.width, b.y + b.height);
    element.style.transform = `translate(${Math.min(p.x, q.x)}px, ${Math.min(p.y, q.y)}px)`;
    element.style.width = `${Math.abs(q.x - p.x)}px`;
    element.style.height = `${Math.abs(q.y - p.y)}px`;
  }
}
