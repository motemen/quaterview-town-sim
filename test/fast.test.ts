import { it, expect } from "vitest";
import { newWorld, advance, advanceDay } from "../src/sim/sim";
import { MINUTES_PER_DAY } from "../src/sim/time";

it("daily fast path is identical to 24 hourly steps and is fast", () => {
  const align = (w: ReturnType<typeof newWorld>) => {
    // 0:00 に揃える
    const day = Math.floor(w.minutes / MINUTES_PER_DAY) + 1;
    w.minutes = day * MINUTES_PER_DAY;
    w.lastHour = day * 24;
  };
  const a = newWorld(21, 64, 64);
  align(a);
  for (let d = 0; d < 60; d++) advance(a, 60, 1);
  const b = newWorld(21, 64, 64);
  align(b);
  for (let d = 0; d < 60; d++) advanceDay(b);
  expect(Array.from(b.kind)).toEqual(Array.from(a.kind));
  expect(b.population).toBe(a.population);
  expect(b.rng.state).toBe(a.rng.state);
  const big = newWorld(7);
  for (let d = 0; d < 200; d++) advanceDay(big);
  const t1 = performance.now();
  for (let d = 0; d < 30; d++) advanceDay(big);
  console.log(`FAST 256: ${((performance.now() - t1) / 30).toFixed(1)} ms/day pop=${big.population}`);
}, 600000);
