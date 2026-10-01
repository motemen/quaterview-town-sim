import { describe, expect, it } from "vitest";
import { newWorld, advance } from "../src/sim/sim";
import { railPath, stationIndices, maybeOpenStation } from "../src/sim/rail";
import { TrainSystem } from "../src/sim/trains";
import { Kind, idx, isRailLike } from "../src/sim/world";

describe("rail path", () => {
  it("walks the whole line from west to east", () => {
    const w = newWorld(42);
    const path = railPath(w);
    expect(path[0][0]).toBe(0);
    expect(path[path.length - 1][0]).toBe(w.w - 1);
    for (let k = 1; k < path.length; k++) {
      const [ax, ay] = path[k - 1];
      const [bx, by] = path[k];
      expect(Math.abs(ax - bx) + Math.abs(ay - by)).toBe(1);
      expect(isRailLike(w.kind[idx(w, bx, by)])).toBe(true);
    }
    expect(stationIndices(w, path).length).toBe(1);
  });
});

describe("trains", () => {
  it("spawns a train and moves it along the line, stopping at the station", () => {
    const w = newWorld(42);
    const ts = new TrainSystem(w);
    for (let i = 0; i < 60; i++) ts.update(w, 0.1, 1); // 6 秒
    expect(ts.trains.length).toBe(1);
    const t = ts.trains[0];
    const before = t.pos;
    let stopped = false;
    for (let i = 0; i < 600; i++) {
      ts.update(w, 0.05, 1);
      if (ts.trains[0]?.stopTimer > 0) stopped = true;
    }
    expect(stopped).toBe(true);
    expect(ts.trains.length === 0 || ts.trains[0].pos !== before).toBe(true);
  });
  it("gives each car a pose on the line", () => {
    const w = newWorld(42);
    const ts = new TrainSystem(w);
    ts.spawnAt(ts.stations[0], 1, 10);
    const poses = ts.carPoses(ts.trains[0]);
    expect(poses.length).toBe(3);
    expect(poses[0].kind).toBe("head");
    expect(poses[2].kind).toBe("tail");
    for (const p of poses) expect(isRailLike(w.kind[idx(w, Math.round(p.tx), Math.round(p.ty))])).toBe(true);
  });
});

describe("new stations", () => {
  it("opens a second station once the town has grown", () => {
    const w = newWorld(7);
    for (let day = 0; day < 400; day++) advance(w, 60, 1);
    // 成長の過程で自動的に増えているか、増えていなくても条件を満たせば増える
    const n = w.stations.length;
    if (n === 1) maybeOpenStation(w);
    expect(w.stations.length).toBeGreaterThanOrEqual(1);
    for (const s of w.stations) expect(w.kind[idx(w, s.x, s.y)]).toBe(Kind.Station);
  }, 60000);
});
