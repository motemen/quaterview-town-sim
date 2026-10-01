import { describe, expect, it } from "vitest";
import { newWorld, advance } from "../src/sim/sim";
import { Kind, idx, isRailLike, slopeOf, cornerHeights, Slope, R8_BIT, DX8, DY8 } from "../src/sim/world";
import { TrainSystem } from "../src/sim/trains";

describe("branch lines", () => {
  it("plans, builds and opens a branch with a terminal station", () => {
    const w = newWorld(7, 64, 64);
    let days = 0;
    while (days < 900 && !(w.branches.length > 0 && w.branches[0].done)) {
      advance(w, 60, 1);
      days++;
    }
    expect(w.branches.length).toBeGreaterThan(0);
    const b = w.branches[0];
    expect(b.done).toBe(true);
    // 経路は 8 近傍で連続し、線路になっている。接続マスクは双方向
    for (let k = 1; k < b.tiles.length; k++) {
      const [ax, ay] = b.tiles[k - 1];
      const [bx, by] = b.tiles[k];
      expect(Math.max(Math.abs(ax - bx), Math.abs(ay - by))).toBe(1);
      expect(isRailLike(w.kind[idx(w, bx, by)])).toBe(true);
      const d = DX8.findIndex((dx, i) => dx === bx - ax && DY8[i] === by - ay);
      expect(w.railMask[idx(w, ax, ay)] & R8_BIT[d]).toBeTruthy();
    }
    // 終点は駅で平地
    const [tx, ty] = b.tiles[b.tiles.length - 1];
    expect(w.kind[idx(w, tx, ty)]).toBe(Kind.Station);
    expect(slopeOf(cornerHeights(w, tx, ty))).toBe(Slope.Flat);
    expect(w.stations.some((s) => s.x === tx && s.y === ty)).toBe(true);
    // 列車システムは 2 路線を持ち、支線の列車が往復する
    const ts = new TrainSystem(w);
    expect(ts.lines.length).toBe(2);
    for (let i = 0; i < 400; i++) ts.update(w, 0.1, 1);
    const sh = ts.lines[1];
    expect(sh.trains.length).toBe(1);
    expect(sh.trains[0].pos).toBeGreaterThanOrEqual(0);
    expect(sh.trains[0].pos).toBeLessThanOrEqual(sh.path.length - 1);
  }, 240000);
});
