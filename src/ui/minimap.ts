import { HALF_H, HALF_W, tileOrigin } from "../render/iso";
import { BState, Kind, World, idx } from "../sim/world";
import { Camera } from "./camera";

/** マップ全体を見渡す小さな鳥瞰図。クリックでその場所へ移動する。 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private base: HTMLCanvasElement;
  /** 内部解像度: x は (tx-ty) + w、y は (tx+ty)/2 */
  private iw: number;
  private ih: number;
  visible = true;

  constructor(
    private world: World,
    private cam: Camera,
  ) {
    this.iw = world.w + world.h;
    this.ih = Math.ceil((world.w + world.h) / 2) + 1;
    this.canvas = document.getElementById("minimap") as HTMLCanvasElement;
    this.canvas.width = this.iw;
    this.canvas.height = this.ih;
    this.ctx = this.canvas.getContext("2d")!;
    this.image = new ImageData(this.iw, this.ih);
    this.base = document.createElement("canvas");
    this.base.width = this.iw;
    this.base.height = this.ih;
    this.canvas.addEventListener("pointerdown", (e) => {
      const r = this.canvas.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * this.iw;
      const my = ((e.clientY - r.top) / r.height) * this.ih;
      // 内部座標 → ワールド座標 (ネイティブ px)
      const wx = (mx - this.world.h) * HALF_W;
      const wy = my * 2 * HALF_H;
      this.cam.x = wx - this.cam.viewW / 2;
      this.cam.y = wy - this.cam.viewH / 2;
      e.stopPropagation();
    });
    this.refresh();
  }

  setWorld(world: World): void {
    this.world = world;
    this.refresh();
  }

  toggle(): void {
    this.visible = !this.visible;
    this.canvas.hidden = !this.visible;
  }

  /** タイルの色を描き直す (1 時間ごとなど) */
  refresh(): void {
    const w = this.world;
    const d = this.image.data;
    d.fill(0);
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        const i = idx(w, x, y);
        const [r, g, b] = tileColor(w, i);
        const mx = x - y + w.h;
        const my = (x + y) >> 1;
        for (const dx of [0, 1]) {
          const p = (my * this.iw + mx + dx) * 4;
          if (p < 0 || p >= d.length) continue;
          d[p] = r;
          d[p + 1] = g;
          d[p + 2] = b;
          d[p + 3] = 255;
        }
      }
    }
    this.base.getContext("2d")!.putImageData(this.image, 0, 0);
  }

  /** 毎フレーム: 下地の上に表示範囲の枠を描く */
  draw(): void {
    if (!this.visible) return;
    const w = this.world;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.iw, this.ih);
    ctx.drawImage(this.base, 0, 0);
    // ビューポートの矩形: ワールド px → 内部座標
    const x0 = this.cam.x / HALF_W + w.h;
    const y0 = this.cam.y / (2 * HALF_H);
    const vw = this.cam.viewW / HALF_W;
    const vh = this.cam.viewH / (2 * HALF_H);
    ctx.strokeStyle = "rgba(255, 240, 160, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, vw, vh);
    void tileOrigin;
  }
}

function tileColor(w: World, i: number): [number, number, number] {
  const k = w.kind[i];
  if (w.water[i] && k !== Kind.Rail && k !== Kind.Road) return [60, 120, 204];
  switch (k) {
    case Kind.Forest:
      return [48, 112, 56];
    case Kind.Road:
      return [150, 150, 156];
    case Kind.Rail:
    case Kind.Crossing:
      return [90, 70, 60];
    case Kind.Station:
      return [255, 240, 120];
    case Kind.Building: {
      if (w.bState[i] === BState.Abandoned) return [120, 110, 100];
      const lv = w.bLevel[i];
      if (lv >= 5) return [255, 160, 60];
      return lv >= 3 ? [200, 200, 210] : lv === 2 ? [224, 196, 150] : [220, 150, 120];
    }
    case Kind.Farm:
      return [168, 160, 88];
    case Kind.FarmPath:
      return [180, 168, 128];
    case Kind.Park:
      return [96, 176, 96];
    case Kind.Shrine:
      return [220, 70, 60];
    case Kind.Lot:
      return [160, 140, 110];
    default:
      return [116, 172, 92];
  }
}
