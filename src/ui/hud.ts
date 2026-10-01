import { LEVEL_CAPACITY, isMixedUse } from "../sim/growth";
import { SEASON_LABEL, seasonOf, toCalendar } from "../sim/time";
import { BState, Kind, World, idx } from "../sim/world";

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
};

const LEVEL_LABEL = ["", "住宅", "商店・アパート", "中層ビル", "高層ビル", "市役所", "タワー", "観覧車"];

export class Hud {
  private dateEl = document.getElementById("hud-date")!;
  private clockEl = document.getElementById("hud-clock")!;
  private popEl = document.getElementById("hud-pop")!;
  private infoEl = document.getElementById("hud-info")!;
  private newsEl = document.getElementById("hud-news")!;
  private townEl = document.getElementById("hud-town")!;
  private newsQueue: string[] = [];
  private newsUntil = 0;
  private speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#hud button[data-speed]"));
  private lastText = "";

  constructor(
    private onSpeed: (speed: number) => void,
    onReset: () => void,
    private onJump: (days: number) => void,
  ) {
    for (const b of this.speedButtons) {
      b.addEventListener("click", () => this.setSpeed(Number(b.dataset.speed)));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>("#hud button[data-jump]")) {
      b.addEventListener("click", () => this.onJump(Number(b.dataset.jump)));
    }
    document.getElementById("btn-reset")!.addEventListener("click", onReset);
    window.addEventListener("keydown", (e) => {
      if (e.key === " ") {
        e.preventDefault();
        this.setSpeed(this.currentSpeed === 0 ? 1 : 0);
      } else if (e.key === "1") this.setSpeed(1);
      else if (e.key === "2") this.setSpeed(4);
      else if (e.key === "3") this.setSpeed(16);
      else if (e.key === "j") this.onJump(1);
      else if (e.key === "J") this.onJump(10);
      else if (e.key === "l" || e.key === "L") this.onJump(30);
    });
  }

  currentSpeed = 1;

  setSpeed(speed: number): void {
    this.currentSpeed = speed;
    for (const b of this.speedButtons) b.classList.toggle("active", Number(b.dataset.speed) === speed);
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

  /** 情報欄に一時的なメッセージを出す */
  flash(text: string): void {
    this.infoEl.textContent = text;
  }

  showTile(world: World, x: number, y: number): void {
    const i = idx(world, x, y);
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
    if (k === Kind.Farm) s = `(${x},${y}) ${["田んぼ", "畑", "花畑", "果樹園"][world.bStyle[i] & 3]}`;
    if (k === Kind.Road && world.water[i]) s = `(${x},${y}) 橋`;
    if (k === Kind.Rail && world.water[i]) s = `(${x},${y}) 鉄橋`;
    s += ` / 地価 ${world.value[i]}`;
    this.infoEl.textContent = s;
  }
}
