// A board in a React app: `useBoard` makes a `Board` (with a `CardLayer` over it) when its stage mounts, hands it to
// the app's setup, and disposes both when it unmounts, so a view that comes and goes leaves nothing listening.
// `BoardStage` is the markup it needs: a stage with the board's canvas, the cards' and the overlay, stacked.
//
// It is the one module that needs React (a peer dependency): import it as `@canvas-ir/toolkit/react`.
import { createElement, type CSSProperties, type ReactElement, type RefObject, useEffect, useRef, useState } from "react";
import { Board, type BoardOptions } from "./board";
import { CardLayer, type LayerOptions } from "./cards";
import { TextSink } from "./controls";

export interface BoardRefs {
  readonly stage: RefObject<HTMLDivElement>;
  readonly canvas: RefObject<HTMLCanvasElement>;
  readonly cards: RefObject<HTMLCanvasElement>;
  readonly overlay: RefObject<HTMLCanvasElement>;
}

export interface UseBoardOptions {
  /** The board's options, but for its elements and its cards, which the hook gives. Read once, when it mounts. */
  readonly board?: Omit<BoardOptions, "stage" | "canvas" | "overlay" | "cards">;
  /** The cards' options; their cursor and focus go to the board unless given. */
  readonly layer?: Partial<LayerOptions>;
  /** What the app puts on the board once it is made; what it returns runs before the board is disposed. */
  readonly setup?: (board: Board, layer: CardLayer) => void | (() => void);
}

export interface UseBoard {
  readonly refs: BoardRefs;
  /** The board, once its stage has mounted; null before and after. */
  readonly board: Board | null;
  readonly layer: CardLayer | null;
}

/** Makes a board when the stage mounts and disposes it when it unmounts. Pass `refs` to a `BoardStage`. */
export const useBoard = (options: UseBoardOptions = {}): UseBoard => {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cards = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [made, setMade] = useState<{ board: Board; layer: CardLayer } | null>(null);
  // The options as they were when the stage mounted: the board is made once.
  const first = useRef(options);
  useEffect(() => {
    const o = first.current;
    if (!stage.current || !canvas.current || !cards.current || !overlay.current) return;
    const el = canvas.current;
    let board: Board | null = null;
    // Text is typed into an input of the stage's own, so it goes when the stage does, unless the app gives one.
    const own = (o.board?.text ?? o.layer?.text) ? null : new TextSink(stage.current);
    const layer = new CardLayer(cards.current, stage.current, {
      recorder: {},
      onCursor: (cursor) => {
        if (board?.pointerOverCards) el.style.cursor = cursor ?? "default";
      },
      onFocus: () => board?.keysToCardsLayer(),
      ...(own ? { text: own } : {}),
      ...o.layer,
    });
    board = new Board({ ...o.board, stage: stage.current, canvas: el, overlay: overlay.current, cards: layer });
    const undo = o.setup?.(board, layer);
    setMade({ board, layer });
    return () => {
      undo?.();
      board!.dispose();
      layer.dispose();
      own?.dispose();
      setMade(null);
    };
  }, []);
  return { refs: { stage, canvas, cards, overlay }, board: made?.board ?? null, layer: made?.layer ?? null };
};

const fill: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none" };

/** The stage a board fills: its canvas, the cards' over it and the overlay over both. Sized by `style` or its parent. */
export const BoardStage = (props: { readonly refs: BoardRefs; readonly style?: CSSProperties; readonly className?: string }): ReactElement =>
  createElement(
    "div",
    { ref: props.refs.stage, className: props.className, style: { position: "relative", overflow: "hidden", ...props.style } },
    createElement("canvas", { ref: props.refs.canvas, style: fill }),
    createElement("canvas", { ref: props.refs.cards, style: { ...fill, pointerEvents: "none" } }),
    createElement("canvas", { ref: props.refs.overlay, style: { ...fill, pointerEvents: "none" } }),
  );
