export type RGB = readonly [number, number, number];

export function shade(c: RGB, f: number): RGB {
  return [Math.min(255, Math.round(c[0] * f)), Math.min(255, Math.round(c[1] * f)), Math.min(255, Math.round(c[2] * f))];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/** ピクセル単位で描ける小さなビットマップ */
export class Raster {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  }
  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }
  /** 半透明合成 */
  blend(x: number, y: number, c: RGB, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const da = this.data[i + 3] / 255;
    const sa = a / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    for (let k = 0; k < 3; k++) {
      this.data[i + k] = Math.round((c[k] * sa + this.data[i + k] * da * (1 - sa)) / oa);
    }
    this.data[i + 3] = Math.round(oa * 255);
  }
  alpha(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[(y * this.w + x) * 4 + 3];
  }
  fillRect(x: number, y: number, w: number, h: number, c: RGB, a = 255): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c, a);
  }
  vline(x: number, y0: number, y1: number, c: RGB): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.set(x, y, c);
  }
  hline(x0: number, x1: number, y: number, c: RGB): void {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, c);
  }
  /** 塗りつぶし円 */
  disc(cx: number, cy: number, r: number, c: RGB): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) this.set(x, y, c);
      }
    }
  }
}

export interface Sprite {
  /** アトラスのページ */
  canvas: HTMLCanvasElement;
  /** アトラス内の位置と大きさ */
  sx: number;
  sy: number;
  w: number;
  h: number;
  /** 描画位置 = タイル原点 - (ox, oy) */
  ox: number;
  oy: number;
  /** 最後に描画に使われたフレーム (compact で残すかどうかの判断に使う) */
  used: number;
}

/** 描画フレームの通し番号。毎フレーム nextSpriteFrame() で進める */
let spriteFrame = 0;
export function nextSpriteFrame(): number {
  return ++spriteFrame;
}
export function currentSpriteFrame(): number {
  return spriteFrame;
}
/** スプライトを使ったことを記録する (blit のたびに呼ぶ) */
export function touch(s: Sprite): void {
  s.used = spriteFrame;
}

interface Page {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** 高さの区分ごとに、いま詰めている棚 */
  shelves: Map<number, { y: number; x: number }>;
  /** 次の棚を作る y */
  nextY: number;
}

/**
 * スプライトを少数の大きなキャンバス (アトラス) に詰める。
 * 小さなキャンバスを何千も作ると GPU メモリを圧迫してコンテキストを失うため。
 * 棚は高さの区分 (8px 刻み) ごとに持ち、高さの違うスプライトが混ざって隙間ができないようにする。
 */
class Atlas {
  static readonly PAGE = 1024;
  static readonly MAX_PAGES = 16;
  private pages: Page[] = [];
  /** 満杯になって中身を捨てた (キャッシュ中のスプライトが無効になった) */
  overflowed = false;

  /** 残りが少ない (compact するか、全部作り直すべき) */
  get nearlyFull(): boolean {
    return this.overflowed || this.pages.length >= Atlas.MAX_PAGES - 2;
  }

  alloc(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; sx: number; sy: number } {
    const bucket = Math.ceil(h / 8) * 8;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const p of this.pages) {
        const slot = this.place(p, w, bucket);
        if (slot) return { canvas: p.canvas, ctx: p.ctx, sx: slot[0], sy: slot[1] };
      }
      if (this.pages.length < Atlas.MAX_PAGES) {
        const canvas = document.createElement("canvas");
        canvas.width = Atlas.PAGE;
        canvas.height = Atlas.PAGE;
        const ctx = canvas.getContext("2d")!;
        this.pages.push({ canvas, ctx, shelves: new Map(), nextY: 0 });
        continue;
      }
      // 満杯: 全部捨てて作り直す (キャッシュも捨ててもらう必要がある)
      this.reset();
      this.overflowed = true;
    }
    throw new Error("atlas allocation failed");
  }

  private place(p: Page, w: number, bucket: number): [number, number] | null {
    const shelf = p.shelves.get(bucket);
    if (shelf && shelf.x + w <= Atlas.PAGE) {
      const x = shelf.x;
      shelf.x += w;
      return [x, shelf.y];
    }
    if (p.nextY + bucket <= Atlas.PAGE) {
      const y = p.nextY;
      p.nextY += bucket;
      p.shelves.set(bucket, { y, x: w });
      return [0, y];
    }
    return null;
  }

  reset(): void {
    for (const p of this.pages) {
      p.ctx.clearRect(0, 0, Atlas.PAGE, Atlas.PAGE);
      p.shelves.clear();
      p.nextY = 0;
    }
    this.overflowed = false;
  }

  /**
   * keep のスプライトだけを新しいページに詰め直し、それ以外の領域を空ける。
   * スプライトの位置はその場で書き換えるので、参照している側は何もしなくてよい。
   * 詰め直しきれなかったら false (呼び出し側で全部作り直す)。
   */
  compact(keep: Iterable<Sprite>): boolean {
    const old = this.pages;
    this.pages = [];
    this.overflowed = false;
    for (const s of keep) {
      if (this.pages.length >= Atlas.MAX_PAGES - 2 && !this.pages.some((p) => this.fits(p, s.w, Math.ceil(s.h / 8) * 8))) {
        // 残しておきたいものだけで埋まってしまう: あきらめて全部作り直す
        for (const p of this.pages) p.canvas.width = 0;
        this.pages = old;
        this.reset();
        this.overflowed = true;
        return false;
      }
      const slot = this.alloc(s.w, s.h);
      slot.ctx.drawImage(s.canvas, s.sx, s.sy, s.w, s.h, slot.sx, slot.sy, s.w, s.h);
      s.canvas = slot.canvas;
      s.sx = slot.sx;
      s.sy = slot.sy;
    }
    for (const p of old) p.canvas.width = 0;
    return true;
  }

  private fits(p: Page, w: number, bucket: number): boolean {
    const shelf = p.shelves.get(bucket);
    return (shelf !== undefined && shelf.x + w <= Atlas.PAGE) || p.nextY + bucket <= Atlas.PAGE;
  }

  get pageCount(): number {
    return this.pages.length;
  }
}

export const atlas = new Atlas();

export function toSprite(r: Raster, ox = 0, oy = 0): Sprite {
  const slot = atlas.alloc(r.w, r.h);
  slot.ctx.putImageData(new ImageData(r.data, r.w, r.h), slot.sx, slot.sy);
  return { canvas: slot.canvas, sx: slot.sx, sy: slot.sy, w: r.w, h: r.h, ox, oy, used: spriteFrame };
}

/** スプライトのキャッシュ。 */
export class SpriteCache<T> {
  private map = new Map<string, T>();
  get(key: string, make: () => T): T {
    let v = this.map.get(key);
    if (v === undefined) {
      v = make();
      this.map.set(key, v);
    }
    return v;
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
  /** keep が false を返した項目を捨てる */
  prune(keep: (v: T) => boolean): void {
    for (const [k, v] of this.map) if (!keep(v)) this.map.delete(k);
  }
  values(): IterableIterator<T> {
    return this.map.values();
  }
}
