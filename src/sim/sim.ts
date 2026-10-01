import { hourlyStep } from "./growth";
import { generateTerrain } from "./terrain";
import { MINUTES_PER_DAY, MINUTES_PER_REAL_SECOND, toCalendar } from "./time";
import { World, createEmptyWorld } from "./world";
import { computeLandValue, computePopulation } from "./growth";

export function newWorld(seed: number, width?: number, height?: number): World {
  const w = createEmptyWorld(seed, width, height);
  generateTerrain(w);
  computeLandValue(w, 0);
  computePopulation(w);
  return w;
}

/** 現実の経過秒 dt (speed 倍) ぶんワールドを進める。 */
export function advance(w: World, dtSeconds: number, speed: number): void {
  if (speed <= 0 || dtSeconds <= 0) return;
  let delta = dtSeconds * speed * MINUTES_PER_REAL_SECOND;
  // 1 フレームで何日も飛ばさない (タブ復帰時など)
  delta = Math.min(delta, MINUTES_PER_DAY);
  w.minutes += delta;
  const hourNow = Math.floor(w.minutes / 60);
  let guard = 0;
  while (w.lastHour < hourNow && guard++ < 48) {
    w.lastHour++;
    const cal = toCalendar(w.lastHour * 60);
    hourlyStep(w, cal.hour, cal.totalDays);
  }
  if (w.lastHour < hourNow) w.lastHour = hourNow;
}
