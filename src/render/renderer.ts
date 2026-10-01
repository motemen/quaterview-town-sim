import { visibleFloors } from "../sim/growth";
import { hash2 } from "../sim/rng";
import { BState, Kind, Slope, World, cornerHeights, idx, railConnections, roadConnections, DIR_E, DIR_W } from "../sim/world";
import { HALF_H, HALF_W, LEVEL_H, TILE_H, TILE_W, heightAt, tileOrigin, uvToPixel } from "./iso";
import { PAL } from "./palette";
import { Sprite } from "./raster";
import {
  GroundKind,
  buildingSprite,
  crossingSprite,
  groundSprite,
  railSprite,
  roadEmissive,
  roadSprite,
  stationSprite,
  treeSprite,
} from "./sprites";

/** マップ全体を 1 枚の静的レイヤーとして描き、更新があったときだけ描き直す。 */
export class MapLayer {
  readonly canvas: HTMLCanvasElement;
  readonly emissive: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ectx: CanvasRenderingContext2D;
  /** ワールド座標 (タイル原点系) → キャンバス座標のオフセット */
  readonly originX: number;
  readonly originY: number;
  dirty = true;
  /** 季節による木の色 (0=緑 1=桜 2=紅葉 3=雪) */
  treeTint = 0;

  constructor(readonly world: World) {
    this.originX = (world.h - 1) * HALF_W;
    this.originY = 3 * LEVEL_H + 96;
    const w = (world.w + world.h) * HALF_W;
    const h = (world.w + world.h) * HALF_H + this.originY + 40;
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.emissive = document.createElement("canvas");
    this.emissive.width = w;
    this.emissive.height = h;
    this.ctx = this.canvas.getContext("2d")!;
    this.ectx = this.emissive.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.ectx.imageSmoothingEnabled = false;
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const w = this.world;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ectx.clearRect(0, 0, this.emissive.width, this.emissive.height);
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        this.drawTile(x, y);
      }
    }
  }

  /** スプライトを両方のレイヤーに描く (発光レイヤーには遮蔽として) */
  private blit(s: Sprite, px: number, py: number, rel?: readonly [number, number, number, number]): void {
    if (rel && (rel[0] | rel[1] | rel[2] | rel[3]) !== 0) {
      const t = shearTransform(px, py, s.oy, rel);
      this.ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      this.ctx.drawImage(s.canvas, 0, 0);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ectx.globalCompositeOperation = "destination-out";
      this.ectx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      this.ectx.drawImage(s.canvas, 0, 0);
      this.ectx.setTransform(1, 0, 0, 1, 0, 0);
      this.ectx.globalCompositeOperation = "source-over";
      return;
    }
    this.ctx.drawImage(s.canvas, px - s.ox, py - s.oy);
    this.ectx.globalCompositeOperation = "destination-out";
    this.ectx.drawImage(s.canvas, px - s.ox, py - s.oy);
    this.ectx.globalCompositeOperation = "source-over";
  }

  private blitEmissive(s: Sprite, px: number, py: number): void {
    this.ectx.drawImage(s.canvas, px - s.ox, py - s.oy);
  }

  private drawTile(x: number, y: number): void {
    const w = this.world;
    const i = idx(w, x, y);
    const k = w.kind[i];
    const c = cornerHeights(w, x, y);
    const hmin = Math.min(c[0], c[1], c[2], c[3]);
    const rel = [c[0] - hmin, c[1] - hmin, c[2] - hmin, c[3] - hmin] as const;
    const [ox0, oy0] = tileOrigin(x, y);
    const px = ox0 + this.originX;
    const py = oy0 + this.originY - hmin * LEVEL_H;
    const variant = Math.floor(hash2(w.seed, x, y) * 8);
    const water = w.water[i] === 1;

    // 地面
    let ground: GroundKind = "grass";
    if (water) ground = "water";
    else if (k === Kind.Lot) ground = w.lotTimer[i] < 20 ? "rubble" : "lot";
    else if (k === Kind.Park) ground = "park";
    else if (k === Kind.Building) ground = w.bLevel[i] >= 2 ? "concrete" : "grass";
    this.blit(groundSprite(ground, rel, variant), px, py);

    // マップの縁の断面
    if (x === w.w - 1 || y === w.h - 1) this.drawEdgeFace(x, y, px, py, rel);

    switch (k) {
      case Kind.Forest: {
        const spots: [number, number][] = [
          [0.3, 0.3],
          [0.7, 0.45],
          [0.4, 0.75],
        ];
        for (let n = 0; n < spots.length; n++) {
          if (hash2(w.seed + n, x, y) < 0.15) continue;
          const [u, v] = spots[n];
          const ju = u + (hash2(w.seed + 11 + n, x, y) - 0.5) * 0.2;
          const jv = v + (hash2(w.seed + 17 + n, x, y) - 0.5) * 0.2;
          this.drawTree(px, py, rel, ju, jv, variant * 3 + n);
        }
        break;
      }
      case Kind.Park:
        this.drawTree(px, py, rel, 0.3, 0.3, variant);
        this.drawTree(px, py, rel, 0.72, 0.7, variant + 1);
        break;
      case Kind.Road: {
        const mask = roadConnections(w, x, y);
        this.blit(roadSprite(mask, water), px, py, rel);
        const em = roadEmissive(mask);
        if (em) this.blitEmissive(em, px, py);
        break;
      }
      case Kind.Rail:
        this.blit(railSprite(railConnections(w, x, y), water), px, py, rel);
        break;
      case Kind.Crossing:
        this.blit(crossingSprite(railConnections(w, x, y), roadConnections(w, x, y)), px, py, rel);
        break;
      case Kind.Station: {
        const st = w.stations.find((s) => s.x === x && s.y === y);
        const sp = stationSprite(st ? st.plazaDir : 2);
        this.blit(sp.base, px, py);
        if (sp.emissive) this.blitEmissive(sp.emissive, px, py);
        break;
      }
      case Kind.Building: {
        const sp = buildingSprite({
          level: w.bLevel[i],
          style: w.bStyle[i],
          floors: visibleFloors(w, i),
          state: w.bState[i] as BState,
          lights: w.lights[i],
        });
        this.blit(sp.base, px, py);
        if (sp.emissive) this.blitEmissive(sp.emissive, px, py);
        break;
      }
      default:
        break;
    }
  }

  private drawTree(px: number, py: number, rel: readonly [number, number, number, number], u: number, v: number, variant: number): void {
    const [lx, ly] = uvToPixel(u, v);
    const h = heightAt(rel, u, v) * LEVEL_H;
    this.blit(treeSprite(variant, this.treeTint), px + Math.round(lx), py + Math.round(ly - h));
  }

  private drawEdgeFace(x: number, y: number, px: number, py: number, rel: readonly [number, number, number, number]): void {
    const w = this.world;
    const depth = 26;
    const T: [number, number] = [px + HALF_W, py - rel[0] * LEVEL_H];
    const R: [number, number] = [px + TILE_W, py + HALF_H - rel[1] * LEVEL_H];
    const B: [number, number] = [px + HALF_W, py + TILE_H - rel[2] * LEVEL_H];
    const L: [number, number] = [px, py + HALF_H - rel[3] * LEVEL_H];
    const base = py + TILE_H + depth;
    void T;
    const ctx = this.ctx;
    const face = (a: [number, number], b: [number, number], color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(b[0], base);
      ctx.lineTo(a[0], base);
      ctx.closePath();
      ctx.fill();
      // 発光レイヤーでは遮蔽
      this.ectx.globalCompositeOperation = "destination-out";
      this.ectx.beginPath();
      this.ectx.moveTo(a[0], a[1]);
      this.ectx.lineTo(b[0], b[1]);
      this.ectx.lineTo(b[0], base);
      this.ectx.lineTo(a[0], base);
      this.ectx.closePath();
      this.ectx.fill();
      this.ectx.globalCompositeOperation = "source-over";
    };
    const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
    if (y === w.h - 1) face(L, B, rgb(PAL.earth));
    if (x === w.w - 1) face(B, R, rgb(PAL.earthDark));
  }
}

/**
 * 平らな 32x16 ダイヤを描くスプライトを、傾いたタイル (東西 or 南北の坂) に合わせて
 * せん断する変換行列 [m11, m12, m21, m22, e, f] を返す。
 */
function shearTransform(px: number, py: number, oy: number, rel: readonly [number, number, number, number]): number[] {
  const Tx = px + HALF_W;
  const Ty = py - rel[0] * LEVEL_H;
  const Rx = px + TILE_W;
  const Ry = py + HALF_H - rel[1] * LEVEL_H;
  const Lx = px;
  const Ly = py + HALF_H - rel[3] * LEVEL_H;
  const ax = Rx - Tx;
  const ay = Ry - Ty;
  const bx = Lx - Tx;
  const by = Ly - Ty;
  const m11 = ax / 32 - bx / 32;
  const m12 = ay / 32 - by / 32;
  const m21 = ax / 16 + bx / 16;
  const m22 = ay / 16 + by / 16;
  const e = Tx + ax * (-0.5 - oy / 16) + bx * (0.5 - oy / 16);
  const f = Ty + ay * (-0.5 - oy / 16) + by * (0.5 - oy / 16);
  return [m11, m12, m21, m22, e, f];
}

export { DIR_E, DIR_W, Slope };
