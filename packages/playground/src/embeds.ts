// HTML and WebGL elements on the board. The drawing holds an embed op where
// each goes; the element sits beneath the canvas and shows through the hole
// the op cuts, so shapes drawn later cover it and shapes drawn earlier don't.
import type { EmbedOp } from "canvas-ir";
import type { Sample } from "./samples";

const at = { x: 40, y: 1340 };

export const embedSample: Sample = {
  name: "HTML and 3D",
  draw: (ctx) => {
    // Drawn before the embeds: covered by them where they overlap.
    ctx.beginGroup({ meta: { source: "embeds backdrop" } });
    ctx.fillStyle = "#c4b5fd";
    ctx.beginPath();
    ctx.ellipse(at.x + 300, at.y + 150, 330, 120, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.endGroup();
    const card = (title: string, x: number, y: number, w: number, h: number, content: { type: string; label: string }): void => {
      ctx.beginGroup({ meta: { source: title } });
      ctx.fillStyle = "#1f2937";
      ctx.beginPath();
      ctx.roundRect(x, y, w, h + 28, 8);
      ctx.fill();
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillStyle = "#f9fafb";
      ctx.textBaseline = "middle";
      ctx.fillText(`${title}  ·  drag me here`, x + 10, y + 14);
      ctx.embed(x + 4, y + 28, w - 8, h - 4, content);
      ctx.endGroup();
    };
    card("An HTML form", at.x, at.y, 280, 200, { type: "form", label: "A form" });
    ctx.save();
    ctx.translate(at.x + 420, at.y + 140);
    ctx.rotate(0.06);
    card("WebGL", -110, -120, 220, 220, { type: "webgl", label: "A spinning cube" });
    ctx.restore();
    // Drawn after: on top of the elements.
    ctx.beginGroup({ meta: { source: "sticker over the embeds" } });
    ctx.fillStyle = "#f97316";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const r = i % 2 === 0 ? 44 : 30;
      const a = (i * Math.PI) / 8;
      ctx.lineTo(at.x + 262 + r * Math.cos(a), at.y + 210 + r * Math.sin(a));
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = "700 13px system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("on top", at.x + 262, at.y + 210);
    ctx.endGroup();
  },
};

const form = (): HTMLElement => {
  const el = document.createElement("form");
  el.style.cssText = "background:#fff;padding:12px;font:13px system-ui,sans-serif;display:flex;flex-direction:column;gap:8px;border-radius:0 0 6px 6px";
  el.innerHTML = `
    <label>Name <input name="name" placeholder="Type here" style="width:100%"></label>
    <label><input type="checkbox" name="news"> Real checkbox</label>
    <select name="pick"><option>Real select</option><option>Second</option></select>
    <button type="submit">Submit</button>
    <output style="color:#6b7280"></output>`;
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(el);
    el.querySelector("output")!.textContent = `Hello, ${String(data.get("name") || "stranger")}`;
  });
  return el;
};

/** A spinning cube in plain WebGL, with a face per color. */
const webgl = (): HTMLElement | null => {
  const canvas = document.createElement("canvas");
  canvas.width = 424;
  canvas.height = 424;
  canvas.style.background = "#0f172a";
  const gl = canvas.getContext("webgl");
  if (!gl) return null;
  const shader = (type: number, source: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, "attribute vec3 p; attribute vec3 c; uniform mat4 m; varying vec3 v; void main() { gl_Position = m * vec4(p, 1.0); v = c; }"));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, "precision mediump float; varying vec3 v; void main() { gl_FragColor = vec4(v, 1.0); }"));
  gl.linkProgram(program);
  gl.useProgram(program);
  const faces: [number[], number[]][] = [
    [[0, 0, 1], [0.39, 0.4, 0.95]],
    [[0, 0, -1], [0.98, 0.45, 0.09]],
    [[0, 1, 0], [0.13, 0.77, 0.37]],
    [[0, -1, 0], [0.92, 0.7, 0.03]],
    [[1, 0, 0], [0.93, 0.27, 0.6]],
    [[-1, 0, 0], [0.05, 0.65, 0.91]],
  ];
  const data: number[] = [];
  for (const [n, color] of faces) {
    // Two axes across the face.
    const u = n[0] !== 0 ? [0, 1, 0] : [1, 0, 0];
    const w = [n[1]! * u[2]! - n[2]! * u[1]!, n[2]! * u[0]! - n[0]! * u[2]!, n[0]! * u[1]! - n[1]! * u[0]!];
    const corner = (a: number, b: number) => [0, 1, 2].map((i) => 0.5 * (n[i]! + a * u[i]! + b * w[i]!));
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]] as const) data.push(...corner(a, b), ...color);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  const p = gl.getAttribLocation(program, "p");
  const c = gl.getAttribLocation(program, "c");
  gl.enableVertexAttribArray(p);
  gl.enableVertexAttribArray(c);
  gl.vertexAttribPointer(p, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribPointer(c, 3, gl.FLOAT, false, 24, 12);
  gl.enable(gl.DEPTH_TEST);
  const m = gl.getUniformLocation(program, "m");
  let frame = 0;
  const draw = (time: number): void => {
    const a = time / 1400;
    const b = time / 2300;
    const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    // Turn about y, then x: rows of R = Rx(b) Ry(a). Then a little perspective: nearer (larger z) means a smaller w.
    const R = [
      [ca, 0, sa],
      [sb * sa, cb, -sb * ca],
      [-cb * sa, sb, cb * ca],
    ];
    const rows = [R[0]!.map((v) => 0.75 * v).concat(0), R[1]!.map((v) => 0.75 * v).concat(0), R[2]!.map((v) => -0.5 * v).concat(0), R[2]!.map((v) => -0.3 * v).concat(1.6)];
    // WebGL takes the matrix column by column.
    const matrix = new Float32Array([0, 1, 2, 3].flatMap((col) => rows.map((row) => row[col]!)));
    gl.uniformMatrix4fv(m, false, matrix);
    gl.clearColor(0.06, 0.09, 0.16, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  (canvas as HTMLCanvasElement & { stop?: () => void }).stop = () => cancelAnimationFrame(frame);
  return canvas;
};

/** The element for an embed op on the board. */
export const createEmbed = (op: EmbedOp): HTMLElement | null => {
  switch (op.content["type"]) {
    case "form":
      return form();
    case "webgl":
      return webgl();
    default:
      return null;
  }
};

export const destroyEmbed = (element: HTMLElement): void => (element as HTMLElement & { stop?: () => void }).stop?.();
