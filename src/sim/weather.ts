import { Season } from "./time";
import { World } from "./world";

export const enum Weather {
  Clear = 0,
  Rain = 1,
  Snow = 2,
}

/** 1 時間ごとに天候を更新する。 */
export function updateWeather(w: World, hour: number, month: number, season: Season): void {
  const rng = w.rng;
  const wet = w.weather !== Weather.Clear;
  if (wet) {
    // 降り続ける時間は平均 6〜10 時間
    if (rng.chance(season === "summer" && month === 6 ? 0.08 : 0.14)) w.weather = Weather.Clear;
    return;
  }
  let startChance = 0.012;
  if (season === "spring") startChance = 0.014;
  else if (season === "summer") startChance = month === 6 ? 0.04 : 0.012;
  else if (season === "autumn") startChance = 0.016;
  else startChance = 0.012;
  // 夕方〜夜に降りやすい
  if (hour >= 15 && hour <= 21) startChance *= 1.4;
  if (rng.chance(startChance)) {
    w.weather = season === "winter" || (season === "spring" && month === 3 && rng.chance(0.5)) ? Weather.Snow : Weather.Rain;
    if (w.weather === Weather.Snow && !w.snowSeen) {
      w.snowSeen = true;
      w.events.push("初雪が降りました");
    }
  }
}
