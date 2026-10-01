import { describe, expect, it } from "vitest";
import { Rng, hashString } from "../src/sim/rng";
import { newWorld, advance } from "../src/sim/sim";
import { Kind, BState, cornerHeights, slopeOf, Slope, idx, isRoadLike, DX, DY, inBounds } from "../src/sim/world";
import { serialize, deserialize } from "../src/sim/save";
import { toCalendar, nightFactor, MINUTES_PER_DAY } from "../src/sim/time";

describe("rng", () => {
  it("is deterministic for a seed", () => {
    const a = new Rng(123);
    const b = new Rng(123);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it("hashes strings stably", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("hello")).not.toBe(hashString("hellp"));
  });
});

describe("terrain", () => {
  const w = newWorld(42);
  it("keeps adjacent vertex heights within 1", () => {
    const S = w.w + 1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const h = w.height[y * S + x];
        if (x + 1 < S) expect(Math.abs(h - w.height[y * S + x + 1])).toBeLessThanOrEqual(1);
        if (y + 1 < S) expect(Math.abs(h - w.height[(y + 1) * S + x])).toBeLessThanOrEqual(1);
      }
    }
  });
  it("has water at height 0", () => {
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        if (w.water[idx(w, x, y)] && w.kind[idx(w, x, y)] === Kind.Water) expect(Math.max(...cornerHeights(w, x, y))).toBeLessThanOrEqual(1);
      }
    }
  });
  it("has a rail line crossing the map with one station and a plaza", () => {
    let railCount = 0;
    for (let y = 0; y < w.h; y++) {
      if (w.kind[idx(w, 0, y)] === Kind.Rail) railCount++;
    }
    expect(railCount).toBeGreaterThanOrEqual(1);
    expect(w.stations.length).toBe(1);
    const s = w.stations[0];
    expect(w.kind[idx(w, s.x, s.y)]).toBe(Kind.Station);
    expect(w.kind[idx(w, s.x + DX[s.plazaDir], s.y + DY[s.plazaDir])]).toBe(Kind.Road);
  });
  it("only puts rails on flat or along-x/y slopes", () => {
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        const k = w.kind[idx(w, x, y)];
        if (k === Kind.Rail || k === Kind.Station) {
          expect(slopeOf(cornerHeights(w, x, y))).not.toBe(Slope.Irregular);
        }
      }
    }
  });
});

describe("growth", () => {
  it("grows roads and buildings over a year", () => {
    const w = newWorld(7);
    for (let day = 0; day < 240; day++) advance(w, 60, 1);
    let roads = 0;
    let buildings = 0;
    let built = 0;
    for (let i = 0; i < w.w * w.h; i++) {
      if (w.kind[i] === Kind.Road) roads++;
      if (w.kind[i] === Kind.Building) {
        buildings++;
        if (w.bState[i] === BState.Built) built++;
      }
    }
    expect(roads).toBeGreaterThan(20);
    expect(buildings).toBeGreaterThan(20);
    expect(built).toBeGreaterThan(10);
    expect(w.population).toBeGreaterThan(0);
  }, 30000);
  it("keeps roads connected (every road touches another road or station)", () => {
    const w = newWorld(99);
    for (let day = 0; day < 120; day++) advance(w, 60, 1);
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        if (w.kind[idx(w, x, y)] !== Kind.Road) continue;
        let neighbors = 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (!inBounds(w, nx, ny)) continue;
          const k = w.kind[idx(w, nx, ny)];
          if (isRoadLike(k) || k === Kind.Station) neighbors++;
        }
        expect(neighbors).toBeGreaterThanOrEqual(1);
      }
    }
  }, 30000);
  it("never places roads or buildings on irregular slopes", () => {
    const w = newWorld(5);
    for (let day = 0; day < 200; day++) advance(w, 60, 1);
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        const k = w.kind[idx(w, x, y)];
        const s = slopeOf(cornerHeights(w, x, y));
        if (k === Kind.Building) expect(s).toBe(Slope.Flat);
        if (k === Kind.Road) expect(s).not.toBe(Slope.Irregular);
      }
    }
  }, 30000);
});

describe("save", () => {
  it("round-trips a world", () => {
    const w = newWorld(3);
    for (let day = 0; day < 30; day++) advance(w, 60, 1);
    const json = serialize(w);
    const r = deserialize(json)!;
    expect(r).not.toBeNull();
    expect(Array.from(r.kind)).toEqual(Array.from(w.kind));
    expect(Array.from(r.bAge)).toEqual(Array.from(w.bAge));
    expect(r.minutes).toBe(w.minutes);
    expect(r.rng.state).toBe(w.rng.state);
    // 続きを進めても同じ結果になる
    advance(w, 60, 1);
    advance(r, 60, 1);
    expect(Array.from(r.kind)).toEqual(Array.from(w.kind));
  });
});

describe("time", () => {
  it("converts minutes to calendar", () => {
    const c = toCalendar(MINUTES_PER_DAY * 3 + 90);
    expect(c.day).toBe(4);
    expect(c.hour).toBe(1);
    expect(c.minute).toBe(30);
  });
  it("is dark at midnight and bright at noon", () => {
    expect(nightFactor(0)).toBe(1);
    expect(nightFactor(12)).toBe(0);
  });
});
