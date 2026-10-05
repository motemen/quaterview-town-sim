import { DynamicLayer, MapLayer } from "./render/renderer";
import { maintainSpriteAtlas } from "./render/sprites";
import { nextSpriteFrame } from "./render/raster";
import { TrainSystem } from "./sim/trains";
import { hashString } from "./sim/rng";
import { SAVE_KEY, deserialize, serialize } from "./sim/save";
import { advance, advanceDay, newWorld } from "./sim/sim";
import { Season, nightFactor, seasonOf, skyColor, tintColor, toCalendar } from "./sim/time";
import { Weather } from "./sim/weather";
import { drawPrecipitation } from "./render/effects";
import { Fireworks } from "./render/fireworks";
import { SoundSystem } from "./ui/sound";
import { tileOrigin } from "./render/iso";
import { World } from "./sim/world";
import { Camera, attachInput } from "./ui/camera";
import { Hud } from "./ui/hud";
import { Minimap } from "./ui/minimap";

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
  for (let d = 0; d < days; d++) advanceDay(w);
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
const fireworks = new Fireworks();
const sound = new SoundSystem();
let fireworkBursts = 0;
{
  const btn = document.getElementById("btn-sound") as HTMLButtonElement;
  const label = () => {
    btn.textContent = "♪";
    btn.title = sound.enabled ? "環境音 ON" : "環境音 OFF";
    btn.classList.toggle("active", sound.enabled);
  };
  btn.addEventListener("click", () => {
    sound.toggle();
    label();
  });
  window.addEventListener("pointerdown", () => sound.unlock(), { once: true });
  label();
}
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
  (days) => jumpDays(days),
);

/** 時刻はそのままに、日数だけ一気に進める。1 フレームに 1 日ずつ処理して画面を固めない。 */
let jumpQueue = 0;
let jumpTotal = 0;
function jumpDays(days: number): void {
  if (jumpQueue === 0) jumpTotal = 0;
  jumpQueue = Math.min(jumpQueue + days, 3600);
  jumpTotal = jumpQueue;
}

let jumpFrames = 0;
function processJump(): void {
  if (jumpQueue <= 0) return;
  // 1 フレームにまとめて進め、描画の更新は数フレームに 1 回だけにして軽くする
  const t0 = performance.now();
  while (jumpQueue > 0 && performance.now() - t0 < 60) {
    advanceDay(world);
    jumpQueue--;
  }
  jumpFrames++;
  if (world.stationsChanged) {
    world.stationsChanged = false;
    trains.refresh(world);
  }
  if (jumpQueue === 0 || jumpFrames % 12 === 0) {
    layer.detectChanges();
    minimap.refresh();
  }
  if (jumpQueue === 0) {
    save(world);
    const cal = toCalendar(world.minutes);
    hud.flash(`${jumpTotal}日進めました → ${cal.year}年${cal.month}月${cal.day}日`);
  } else {
    hud.flash(`${jumpTotal - jumpQueue}/${jumpTotal}日…`);
  }
}

function resize(): void {
  const dpr = 1; // ドット絵なので CSS ピクセル単位で描く
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
}
window.addEventListener("resize", resize);
resize();
{
  const st = world.stations[0];
  cam.zoom = window.innerWidth > 1400 ? 2.5 : window.innerWidth > 700 ? 2 : 1.5;
  cam.centerOnTile(st ? st.x : world.w / 2, st ? st.y : world.h / 2);
  // デバッグ用: ?at=x,y でカメラの中心を指定
  const at = new URLSearchParams(location.search).get("at");
  if (at && at.startsWith("lm")) {
    // ?at=lm6 でレベル 6 のランドマークへ
    const lv = Number(at.slice(2));
    for (let i = 0; i < world.kind.length; i++) {
      if (world.kind[i] === 7 && world.bLevel[i] === lv) {
        cam.centerOnTile(i % world.w, Math.floor(i / world.w));
        break;
      }
    }
  } else if (at === "branch") {
    const b = world.branches[0];
    if (b) {
      const [bx, by] = b.tiles[Math.floor(b.tiles.length / 2)];
      cam.centerOnTile(bx, by);
    }
  } else if (at === "bridge") {
    for (let i = 0; i < world.kind.length; i++) {
      if (world.kind[i] === 3 && world.water[i]) {
        cam.centerOnTile(i % world.w, Math.floor(i / world.w));
        break;
      }
    }
  } else if (at && at.startsWith("k")) {
    // ?at=k9 で種類 9 (公園) のタイルへ
    const kind = Number(at.slice(1));
    for (let i = 0; i < world.kind.length; i++) {
      if (world.kind[i] === kind) {
        cam.centerOnTile(i % world.w, Math.floor(i / world.w));
        break;
      }
    }
  } else if (at) {
    const [ax, ay] = at.split(",").map(Number);
    cam.centerOnTile(ax, ay);
  }
  // デバッグ用: ?jumps=N で 1 か月ジャンプを N 回、フレームごとに実行する
  const jumps = Number(new URLSearchParams(location.search).get("jumps") ?? 0);
  if (jumps > 0) {
    let left = jumps;
    const tick = () => {
      if (left-- <= 0) return;
      jumpDays(30);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  if (new URLSearchParams(location.search).get("fw")) {
    const [ax, ay] = tileOrigin(st ? st.x : 32, st ? st.y : 32);
    fireworks.burstNow(ax + 16, ay - 100);
    fireworks.burstNow(ax - 80, ay - 140);
    fireworks.update(0.5, false, 0, 0);
  }
}

{
  // デバッグ用: ?train=N で駅から N タイル西に列車を置く
  const tp = new URLSearchParams(location.search).get("train");
  if (tp !== null && trains.stations.length) trains.spawnAt(trains.stations[0] - Number(tp), 1, 60);
}

const minimap = new Minimap(world, cam);
window.addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") minimap.toggle();
});
document.getElementById("btn-map")!.addEventListener("click", () => minimap.toggle());

attachInput(canvas, cam, {
  onClick(cx, cy) {
    const t = cam.pick(world, cx, cy);
    if (t) hud.showTile(world, t[0], t[1]);
  },
});

let lastTime = performance.now();
let lastSave = performance.now();
let lastFullRefresh = performance.now();
let lastHour = world.lastHour;
let fpsAcc = 0;
let currentSeason: Season | null = null;
const SEASON_INDEX: Record<Season, 0 | 1 | 2 | 3> = { spring: 0, summer: 1, autumn: 2, winter: 3 };
let elapsed = 0;

let currentIllumination = false;

function applySeason(): void {
  const cal = toCalendar(world.minutes);
  const season = seasonOf(cal.month);
  const illumination = cal.month === 12;
  if (season === currentSeason && illumination === currentIllumination) return;
  currentSeason = season;
  currentIllumination = illumination;
  layer.season = SEASON_INDEX[season];
  layer.illumination = illumination;
  layer.invalidate();
}

/** 花火の季節 (7月20日〜8月末の夜) か */
function fireworksActive(): boolean {
  const cal = toCalendar(world.minutes);
  const h = cal.hour + cal.minute / 60;
  const summerNight = (cal.month === 8 || (cal.month === 7 && cal.day >= 20)) && h >= 19.5 && h <= 21.5;
  return summerNight && world.weather === Weather.Clear;
}

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  elapsed += dt;
  // スプライトのアトラスが埋まりそうなら、最近使っていないものを捨てて詰め直す
  nextSpriteFrame();
  if (maintainSpriteAtlas() === "cleared") layer.invalidate();
  // 念のため定期的に静的レイヤーを描き直す (キャンバスの中身が失われたときの保険)
  if (now - lastFullRefresh > 60000) {
    lastFullRefresh = now;
    layer.invalidate();
  }
  if (jumpQueue > 0) processJump();
  else advance(world, dt, speed);
  applySeason();
  if (world.lastHour !== lastHour) {
    lastHour = world.lastHour;
    layer.detectChanges();
    minimap.refresh();
  }
  if (world.stationsChanged) {
    world.stationsChanged = false;
    trains.refresh(world);
  }
  if (world.terrainChanged) {
    world.terrainChanged = false;
    layer.invalidate();
    minimap.refresh();
  }
  trains.update(world, dt, speed);
  {
    const st = world.stations[0];
    const [ax, ay] = st ? tileOrigin(st.x, st.y) : [0, 0];
    const wasActive = fireworks.active;
    fireworks.update(speed > 0 ? dt : 0, fireworksActive() && speed > 0, ax + 16, ay + 8);
    if (!wasActive && fireworks.active) fireworkBursts++;
  }
  updateSound();
  cam.clampTo(world);
  draw();
  hud.update(world);
  hud.pumpNews(world, now);
  hud.tick(now);
  minimap.draw();
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
  // 静的レイヤー (チャンク) と動的レイヤー
  ctx.setTransform(z, 0, 0, z, ox, oy);
  layer.draw(ctx, null, cam.x, cam.y, cam.viewW, cam.viewH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  dyn.render(world, trains, cam.viewW, cam.viewH, cam.x, cam.y, SEASON_INDEX[season], currentIllumination);
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
    layer.drawEmissive(ctx, cam.x, cam.y, cam.viewW, cam.viewH);
    ctx.setTransform(z, 0, 0, z, 0, 0);
    ctx.drawImage(dyn.emissive, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
  if (fireworks.active) {
    ctx.setTransform(z, 0, 0, z, ox, oy);
    fireworks.draw(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (wet) drawPrecipitation(ctx, W, H, world.weather === Weather.Snow ? "snow" : "rain", elapsed, z);
  else if (cal.month === 4 && cal.day <= 20) drawPrecipitation(ctx, W, H, "petals", elapsed, z);
}

function updateSound(): void {
  if (!sound.enabled) return;
  const cal = toCalendar(world.minutes);
  const season = seasonOf(cal.month);
  const h = cal.hour + cal.minute / 60;
  // 画面内の列車
  let train = 0;
  for (const [line, t] of trains.allTrains()) {
    for (const pose of trains.carPoses(t, line)) {
      const [px, py] = tileOrigin(pose.tx, pose.ty);
      const sx = px - cam.x;
      const sy = py - cam.y;
      if (sx > -200 && sx < cam.viewW + 200 && sy > -200 && sy < cam.viewH + 200) {
        train = Math.max(train, t.stopTimer > 0 ? 0.15 : 1);
      }
    }
  }
  let crossing = false;
  for (const i of trains.activeCrossings) {
    const [px, py] = tileOrigin(i % world.w, Math.floor(i / world.w));
    const sx = px - cam.x;
    const sy = py - cam.y;
    if (sx > -100 && sx < cam.viewW + 100 && sy > -100 && sy < cam.viewH + 100) crossing = true;
  }
  sound.update({
    train: train * (speed > 4 ? 0.6 : 1),
    crossing,
    rain: world.weather === Weather.Rain,
    birds: (season === "spring" || season === "summer") && h >= 5 && h <= 17 && world.weather === Weather.Clear && speed <= 1,
    insects: season === "summer" && (h >= 19 || h <= 4) && world.weather === Weather.Clear,
    fireworkBursts,
    paused: speed === 0,
  });
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
      minimap.setWorld(world);
    },
    trains: () => trains,
    layer: () => layer,
    cam,
    fps: () => fpsAcc,
  },
});
