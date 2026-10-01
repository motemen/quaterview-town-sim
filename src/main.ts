import { MapLayer } from "./render/renderer";
import { hashString } from "./sim/rng";
import { SAVE_KEY, deserialize, serialize } from "./sim/save";
import { advance, newWorld } from "./sim/sim";
import { nightFactor, seasonOf, skyColor, tintColor, toCalendar } from "./sim/time";
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

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  advance(world, dt, speed);
  if (world.lastHour !== lastHour) {
    lastHour = world.lastHour;
    layer.invalidate();
  }
  cam.clampTo(world);
  draw();
  hud.update(world);
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
  const sky = skyColor(hour, season);
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
  // 昼夜の色
  const tint = tintColor(hour, season);
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
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
    },
    layer: () => layer,
    cam,
    fps: () => fpsAcc,
  },
});
