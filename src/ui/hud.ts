import { LEVEL_CAPACITY, isMixedUse } from "../sim/growth";
import { SEASON_LABEL, seasonOf, toCalendar } from "../sim/time";
import { BState, Kind, World, idx, partAnchor } from "../sim/world";

const KIND_LABEL: Record<number, string> = {
  [Kind.Grass]: "草地",
  [Kind.Forest]: "森",
  [Kind.Water]: "水面",
  [Kind.Road]: "道路",
  [Kind.Rail]: "線路",
  [Kind.Crossing]: "踏切",
  [Kind.Station]: "駅",
  [Kind.Building]: "建物",
  [Kind.Lot]: "空き地",
  [Kind.Park]: "公園",
  [Kind.Farm]: "田畑",
  [Kind.FarmPath]: "農道",
  [Kind.Shrine]: "神社",
  [Kind.BuildingPart]: "建物",
};

const LEVEL_LABEL = ["", "住宅", "商店・アパート", "中層ビル", "高層ビル", "市役所", "タワー", "観覧車", "超高層タワー"];

export class Hud {
  private dateEl = document.getElementById("hud-date")!;
  private clockEl = document.getElementById("hud-clock")!;
  private popEl = document.getElementById("hud-pop")!;
  private infoEl = document.getElementById("tile-info")!;
  private speedBtn = document.getElementById("btn-speed") as HTMLButtonElement;
  private infoUntil = 0;
  private newsEl = document.getElementById("hud-news")!;
  private townEl = document.getElementById("hud-town")!;
  private newsQueue: string[] = [];
  private newsUntil = 0;
  private static SPEEDS = [0, 1, 4, 16];
  private static SPEED_LABEL: Record<number, string> = { 0: "❚❚", 1: "▶", 4: "▶▶", 16: "▶▶▶" };
  private lastText = "";
  private recBtn = document.getElementById("btn-rec") as HTMLButtonElement;
  /** 📷 ボタン / P キー */
  onScreenshot: () => void = () => {};
  /** ⏺ ボタン / R キー */
  onRecord: () => void = () => {};

  constructor(
    private onSpeed: (speed: number) => void,
    onReset: () => void,
    private onJump: (days: number) => void,
  ) {
    this.speedBtn.addEventListener("click", () => {
      const i = Hud.SPEEDS.indexOf(this.currentSpeed);
      this.setSpeed(Hud.SPEEDS[(i + 1) % Hud.SPEEDS.length]);
    });
    this.infoEl.addEventListener("click", () => (this.infoEl.hidden = true));
    for (const b of document.querySelectorAll<HTMLButtonElement>("#hud button[data-jump]")) {
      b.addEventListener("click", () => this.onJump(Number(b.dataset.jump)));
    }
    document.getElementById("btn-reset")!.addEventListener("click", onReset);
    document.getElementById("btn-shot")!.addEventListener("click", () => this.onScreenshot());
    this.recBtn.addEventListener("click", () => this.onRecord());
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        this.setSpeed(this.currentSpeed === 0 ? 1 : 0);
      } else if (e.key === "1") this.setSpeed(1);
      else if (e.key === "2") this.setSpeed(4);
      else if (e.key === "3") this.setSpeed(16);
      else if (e.key === "j" && !e.repeat) this.onJump(30);
      else if (e.key === "J" && !e.repeat) this.onJump(90);
      else if ((e.key === "l" || e.key === "L") && !e.repeat) this.onJump(360);
      else if ((e.key === "p" || e.key === "P") && !e.repeat) this.onScreenshot();
      else if ((e.key === "r" || e.key === "R") && !e.repeat) this.onRecord();
      else if (e.key === "?") this.toggleHelp();
      else if (e.key === "Escape") this.toggleHelp(false);
    });
    document.getElementById("help")!.addEventListener("click", () => this.toggleHelp(false));
  }

  currentSpeed = 1;

  setSpeed(speed: number): void {
    this.currentSpeed = speed;
    this.speedBtn.textContent = Hud.SPEED_LABEL[speed] ?? "▶";
    this.speedBtn.classList.toggle("active", speed > 0);
    this.onSpeed(speed);
  }

  /** ワールドに溜まった出来事を取り出してテロップに流す */
  pumpNews(world: World, now: number): void {
    while (world.events.length) this.newsQueue.push(world.events.shift()!);
    if (now > this.newsUntil) {
      const next = this.newsQueue.shift();
      if (next) {
        this.newsEl.textContent = "📰 " + next;
        this.newsEl.classList.add("show");
        this.newsUntil = now + 7000;
      } else if (this.newsEl.classList.contains("show")) {
        this.newsEl.classList.remove("show");
      }
    }
  }

  update(world: World): void {
    const town = world.stations[0]?.name ?? "";
    if (this.townEl.textContent !== town) this.townEl.textContent = town;
    const c = toCalendar(world.minutes);
    const minute = Math.floor(c.minute / 10) * 10; // 10分刻み
    const clock = `${String(c.hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const text = `${c.year}年${c.month}月${c.day}日 (${SEASON_LABEL[seasonOf(c.month)]}) ${clock} ${world.population}`;
    if (text === this.lastText) return;
    this.lastText = text;
    this.dateEl.textContent = `${c.year}年 ${c.month}月 ${c.day}日 (${SEASON_LABEL[seasonOf(c.month)]})`;
    this.clockEl.textContent = clock;
    this.popEl.textContent = `人口 ${world.population.toLocaleString("ja-JP")}人`;
  }

  /** 録画中の表示 */
  setRecording(on: boolean): void {
    this.recBtn.textContent = on ? "⏹" : "⏺";
    this.recBtn.title = on ? "録画を止めて保存 (R)" : "録画 (R)";
    this.recBtn.classList.toggle("rec", on);
  }

  toggleHelp(show?: boolean): void {
    const el = document.getElementById("help")!;
    el.hidden = show === undefined ? !el.hidden : !show;
  }

  /** 情報欄に一時的なメッセージを出す */
  flash(text: string): void {
    this.infoEl.textContent = text;
    this.infoEl.hidden = false;
    this.infoUntil = performance.now() + 6000;
  }

  /** 一時的なメッセージの自動消去 (毎フレーム呼ぶ) */
  tick(now: number): void {
    if (this.infoUntil && now > this.infoUntil) {
      this.infoUntil = 0;
      this.infoEl.hidden = true;
    }
  }

  showTile(world: World, x: number, y: number): void {
    let i = idx(world, x, y);
    if (world.kind[i] === Kind.BuildingPart) i = partAnchor(world, i);
    const k = world.kind[i];
    let s = `(${x},${y}) ${KIND_LABEL[k] ?? "?"}`;
    if (k === Kind.Building) {
      const state = world.bState[i];
      const lv = world.bLevel[i];
      s += ` ${lv === 2 || lv === 3 ? (isMixedUse(lv, world.bStyle[i]) ? "雑居ビル" : LEVEL_LABEL[lv]) : LEVEL_LABEL[lv]}`;
      if (state === BState.Constructing) s += ` 建設中 ${Math.round((world.bProgress[i] / 255) * 100)}%`;
      else if (state === BState.Abandoned) s += " 空き家";
      else s += ` 築${world.bAge[i]}日 ${LEVEL_CAPACITY[world.bLevel[i]]}人`;
    }
    if (k === Kind.Station) s += ["", " (駅舎あり)", " (橋上駅舎)"][world.bLevel[i]] ?? "";
    if (k === Kind.Farm) s = `(${x},${y}) ${["田んぼ", "畑", "花畑", "果樹園"][world.bStyle[i] & 3]}`;
    if (k === Kind.Road && world.water[i]) s = `(${x},${y}) 橋`;
    if (k === Kind.Rail && world.water[i]) s = `(${x},${y}) 鉄橋`;
    s += ` / 地価 ${world.value[i]}`;
    this.infoEl.textContent = s;
    this.infoEl.hidden = false;
    this.infoUntil = 0;
  }
}
