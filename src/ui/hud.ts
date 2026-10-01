import { LEVEL_CAPACITY } from "../sim/growth";
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
};

const LEVEL_LABEL = ["", "住宅", "商店・アパート", "中層ビル", "高層ビル"];

export class Hud {
  private dateEl = document.getElementById("hud-date")!;
  private clockEl = document.getElementById("hud-clock")!;
  private popEl = document.getElementById("hud-pop")!;
  private infoEl = document.getElementById("hud-info")!;
  private speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#hud button[data-speed]"));
  private lastText = "";

  constructor(
    private onSpeed: (speed: number) => void,
    onReset: () => void,
  ) {
    for (const b of this.speedButtons) {
      b.addEventListener("click", () => this.setSpeed(Number(b.dataset.speed)));
    }
    document.getElementById("btn-reset")!.addEventListener("click", onReset);
    window.addEventListener("keydown", (e) => {
      if (e.key === " ") {
        e.preventDefault();
        this.setSpeed(this.currentSpeed === 0 ? 1 : 0);
      } else if (e.key === "1") this.setSpeed(1);
      else if (e.key === "2") this.setSpeed(4);
      else if (e.key === "3") this.setSpeed(16);
    });
  }

  currentSpeed = 1;

  setSpeed(speed: number): void {
    this.currentSpeed = speed;
    for (const b of this.speedButtons) b.classList.toggle("active", Number(b.dataset.speed) === speed);
    this.onSpeed(speed);
  }

  update(world: World): void {
    const c = toCalendar(world.minutes);
    const text = `${c.year}年${c.month}月${c.day}日 (${SEASON_LABEL[seasonOf(c.month)]}) ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} ${world.population}`;
    if (text === this.lastText) return;
    this.lastText = text;
    this.dateEl.textContent = `${c.year}年 ${c.month}月 ${c.day}日 (${SEASON_LABEL[seasonOf(c.month)]})`;
    this.clockEl.textContent = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
    this.popEl.textContent = `人口 ${world.population.toLocaleString("ja-JP")}人`;
  }

  showTile(world: World, x: number, y: number): void {
    const i = idx(world, x, y);
    const k = world.kind[i];
    let s = `(${x},${y}) ${KIND_LABEL[k] ?? "?"}`;
    if (k === Kind.Building) {
      const state = world.bState[i];
      s += ` ${LEVEL_LABEL[world.bLevel[i]]}`;
      if (state === BState.Constructing) s += ` 建設中 ${Math.round((world.bProgress[i] / 255) * 100)}%`;
      else if (state === BState.Abandoned) s += " 空き家";
      else s += ` 築${world.bAge[i]}日 ${LEVEL_CAPACITY[world.bLevel[i]]}人`;
    }
    if (k === Kind.Road && world.water[i]) s = `(${x},${y}) 橋`;
    if (k === Kind.Rail && world.water[i]) s = `(${x},${y}) 鉄橋`;
    s += ` / 地価 ${world.value[i]}`;
    this.infoEl.textContent = s;
  }
}
