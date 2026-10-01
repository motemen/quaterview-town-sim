import { DynamicLayer, MapLayer } from "./render/renderer";
import { TrainSystem } from "./sim/trains";
import { hashString } from "./sim/rng";
import { SAVE_KEY, deserialize, serialize } from "./sim/save";
import { advance, newWorld } from "./sim/sim";
import { Season, nightFactor, seasonOf, skyColor, tintColor, toCalendar } from "./sim/time";
import { Weather } from "./sim/weather";
import { drawPrecipitation } from "./render/effects";
import { World } from "./sim/world";
import { Camera, attachInput } from "./ui/camera";
import { Hud } from "./ui/hud";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

function parseSeed(s: string | null): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) >>> 0;
  return hashString(s);
}

function loadWorld(): World {
  const params = new URLSearchParams(location.search);
  const urlSeed = parseSeed(params.get("seed"));
  let saved: World | null = null;
  try {
    const json = localStorage.getItem(SAVE_KEY);
    if (json) saved = deserialize(json);
  } catch {
    saved = null;
  }
  if (saved && (urlSeed === null || urlSeed === saved.seed)) {
    setSeedInUrl(saved.seed);
    return saved;
  }
  const seed = urlSeed ?? randomSeed();
  setSeedInUrl(seed);
  const w = newWorld(seed);
  // デバッグ用: ?days=N で N 日ぶん進めた状態から始める、?hour=H で時刻を変える
  const days = Number(params.get("days") ?? 0);
  for (let d = 0; d < days; d++) advance(w, 60, 1);
  const month = params.get("month");
  if (month !== null) {
    // 月だけ変える (年初からの日数で指定)
    const dayInMonth = Math.floor(w.minutes / 1440) % 30;
    const year = Math.floor(w.minutes / (1440 * 360));
    const inDay = w.minutes % 1440;
    w.minutes = year * 1440 * 360 + ((Number(month) - 1) * 30 + dayInMonth) * 1440 + inDay;
    w.lastHour = Math.floor(w.minutes / 60);
  }
  const weather = params.get("weather");
  if (weather !== null) w.weather = Number(weather);
  const hour = params.get("hour");
  if (hour !== null) {
    const day = Math.floor(w.minutes / 1440);
    w.minutes = day * 1440 + Number(hour) * 60;
    w.lastHour = Math.floor(w.minutes / 60);
  }
  return w;
}

function setSeedInUrl(seed: number): void {
  const url = new URL(location.href);
  if (url.searchParams.get("seed") !== String(seed)) {
    url.searchParams.set("seed", String(seed));
    history.replaceState(null, "", url.toString());
  }
}

function save(world: World): void {
  try {
    localStorage.setItem(SAVE_KEY, serialize(world));
  } catch {
    // 保存できなくても動作は続ける
  }
}

let world = loadWorld();
let layer = new MapLayer(world);
let trains = new TrainSystem(world);
const dyn = new DynamicLayer();
const cam = new Camera(canvas);
let speed = 1;

const hud = new Hud(
  (s) => {
    speed = s;
  },
  () => {
    if (!confirm("いまの街を消して、新しい街を始めますか？")) return;
    localStorage.removeItem(SAVE_KEY);
    const url = new URL(location.href);
    url.searchParams.set("seed", String(randomSeed()));
    location.href = url.toString();
  },
);

function resize(): void {
  const dpr = 1; // ドット絵なので CSS ピクセル単位で描く
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
}
window.addEventListener("resize", resize);
resize();
{
  const st = world.stations[0];
  cam.zoom = window.innerWidth > 1400 ? 3 : 2;
  cam.centerOnTile(st ? st.x : world.w / 2, st ? st.y : world.h / 2);
}

{
  // デバッグ用: ?train=N で駅から N タイル西に列車を置く
  const tp = new URLSearchParams(location.search).get("train");
  if (tp !== null && trains.stations.length) trains.spawnAt(trains.stations[0] - Number(tp), 1, 60);
}

attachInput(canvas, cam, {
  onClick(cx, cy) {
    const t = cam.pick(world, cx, cy);
    if (t) hud.showTile(world, t[0], t[1]);
  },
});

let lastTime = performance.now();
let lastSave = performance.now();
let lastHour = world.lastHour;
let fpsAcc = 0;
let currentSeason: Season | null = null;
const SEASON_INDEX: Record<Season, 0 | 1 | 2 | 3> = { spring: 0, summer: 1, autumn: 2, winter: 3 };
let elapsed = 0;

function applySeason(): void {
  const season = seasonOf(toCalendar(world.minutes).month);
  if (season === currentSeason) return;
  currentSeason = season;
  layer.painter.season = SEASON_INDEX[season];
  layer.invalidate();
}

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  elapsed += dt;
  advance(world, dt, speed);
  applySeason();
  if (world.lastHour !== lastHour) {
    lastHour = world.lastHour;
    layer.invalidate();
  }
  if (world.stationsChanged) {
    world.stationsChanged = false;
    trains.refresh(world);
  }
  trains.update(world, dt, speed);
  cam.clampTo(world);
  draw();
  hud.update(world);
  hud.pumpNews(world, now);
  if (now - lastSave > 15000) {
    lastSave = now;
    save(world);
  }
  fpsAcc++;
  requestAnimationFrame(frame);
}

function draw(): void {
  const cal = toCalendar(world.minutes);
  const season = seasonOf(cal.month);
  const hour = cal.hour + cal.minute / 60;
  layer.render();
  const W = canvas.width;
  const H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const wet = world.weather !== Weather.Clear;
  let sky = skyColor(hour, season);
  if (wet) sky = [sky[0] * 0.7, sky[1] * 0.72, sky[2] * 0.78];
  ctx.fillStyle = `rgb(${sky[0] | 0},${sky[1] | 0},${sky[2] | 0})`;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, W, H);
  const z = cam.zoom;
  const ox = Math.round(-cam.x * z);
  const oy = Math.round(-cam.y * z);
  ctx.setTransform(z, 0, 0, z, ox, oy);
  ctx.drawImage(layer.canvas, -layer.originX, -layer.originY);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 列車など動くもの
  dyn.render(world, trains, cam.viewW, cam.viewH, cam.x, cam.y, SEASON_INDEX[season]);
  ctx.setTransform(z, 0, 0, z, 0, 0);
  ctx.drawImage(dyn.canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 昼夜の色
  let tint = tintColor(hour, season);
  if (wet) tint = [tint[0] * 0.72, tint[1] * 0.75, tint[2] * 0.84];
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = `rgb(${tint[0] | 0},${tint[1] | 0},${tint[2] | 0})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";
  // 明かり
  const night = nightFactor(hour, season);
  if (night > 0.05) {
    ctx.globalAlpha = Math.min(1, night * 1.2);
    ctx.setTransform(z, 0, 0, z, ox, oy);
    ctx.drawImage(layer.emissive, -layer.originX, -layer.originY);
    ctx.setTransform(z, 0, 0, z, 0, 0);
    ctx.drawImage(dyn.emissive, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
  if (wet) drawPrecipitation(ctx, W, H, world.weather === Weather.Snow ? "snow" : "rain", elapsed, z);
}

window.addEventListener("pagehide", () => save(world));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") save(world);
});

requestAnimationFrame(frame);

// デバッグ用
Object.assign(window as unknown as Record<string, unknown>, {
  __town: {
    get world() {
      return world;
    },
    set world(w: World) {
      world = w;
      layer = new MapLayer(world);
      trains = new TrainSystem(world);
    },
    trains: () => trains,
    layer: () => layer,
    cam,
    fps: () => fpsAcc,
  },
});
