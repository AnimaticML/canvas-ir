import { describe, expect, test } from "bun:test";
import { outlineOf, snapControls, snapSettings } from "../src/index";

describe("inspector", () => {
  test("snapping controls map their groups to the board's snap kinds", () => {
    const c = snapControls();
    expect(snapSettings(c).kinds).toContain("vertex");
    c.kinds.delete("points");
    c.radius = 12;
    const s = snapSettings(c);
    expect(s.kinds).toEqual(["bounds", "path"]);
    expect(s.radius).toBe(12);
  });

  test("the accessibility tree reads as indented lines", () => {
    const tree = [{ id: "a", role: "group", label: "Card", bounds: null, children: [{ id: "b", role: "button", label: "Press", value: 2, bounds: null, children: [] }] }];
    expect(outlineOf(tree as never)).toEqual(['group "Card"', '  button "Press" = 2']);
  });
});
