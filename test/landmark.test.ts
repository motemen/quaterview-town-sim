import { expect, it } from "vitest";
import { newWorld, advance } from "../src/sim/sim";
import { Kind } from "../src/sim/world";
it("builds landmarks as the town grows", () => {
  const w = newWorld(7);
  for (let day = 0; day < 500; day++) advance(w, 60, 1);
  let landmarks = 0;
  for (let i = 0; i < w.kind.length; i++) if (w.kind[i] === Kind.Building && w.bLevel[i] >= 5) landmarks++;
  expect(w.population).toBeGreaterThan(1500);
  expect(landmarks).toBeGreaterThanOrEqual(1);
  expect(w.flags & 4).toBe(4);
}, 60000);
