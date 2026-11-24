// What a board's controls do, by id, in one place, so a click, a tap, Enter on the accessibility mirror and an agent
// that discovered the control all run the same function. The host registers its own functions; their meaning, and
// what they change in its document, stays with it.

export interface Action {
  /** What it does, for a screen reader or an agent listing what can be done. */
  readonly label?: string;
  readonly run: () => void;
}

export class Actions {
  private readonly byId = new Map<string, Action>();

  /** Registers an action for a control's id; returns what removes it. */
  set(id: string, action: Action | (() => void)): () => void {
    const a = typeof action === "function" ? { run: action } : action;
    this.byId.set(id, a);
    return () => {
      if (this.byId.get(id) === a) this.byId.delete(id);
    };
  }

  delete(id: string): void {
    this.byId.delete(id);
  }

  clear(): void {
    this.byId.clear();
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Runs the action of the first id that has one, innermost first: a hit's group path, or one id. False if none did. */
  run(ids: string | readonly string[]): boolean {
    for (const id of typeof ids === "string" ? [ids] : ids) {
      const a = this.byId.get(id);
      if (a) {
        a.run();
        return true;
      }
    }
    return false;
  }

  /** What can be done now, for an agent or a command palette. */
  list(): { id: string; label?: string }[] {
    return [...this.byId].map(([id, a]) => (a.label === undefined ? { id } : { id, label: a.label }));
  }
}
