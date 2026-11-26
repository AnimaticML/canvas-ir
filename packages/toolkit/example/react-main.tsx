// The board in a React app: `useBoard` makes it when the stage mounts and disposes it when it unmounts.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardStage, useBoard } from "../src/react";

const log: string[] = [];

const Sketch = () => {
  const { refs, board } = useBoard({
    setup: (board) => {
      log.push("setup");
      board.drawGroup("hello", (c) => {
        c.fillStyle = "#2563eb";
        c.fillRect(80, 80, 160, 100);
      });
      return () => {
        log.push("cleanup");
        (window as any).reactExample.board = null;
      };
    },
  });
  if (board) (window as any).reactExample.board = board;
  return <BoardStage refs={refs} style={{ position: "fixed", inset: "40px 0 0 0" }} />;
};

const App = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <header>
        <strong>Toolkit in React</strong>
        <button id="toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "Close the board" : "Open the board"}
        </button>
      </header>
      {open && <Sketch />}
    </>
  );
};

(window as any).reactExample = { log, board: null };
createRoot(document.getElementById("root")!).render(<App />);
