export const TILE_W = 32;
export const TILE_H = 16;
export const HALF_W = 16;
export const HALF_H = 8;
/** 高さ 1 段ぶんのピクセル */
export const LEVEL_H = 8;

/** タイル (tx,ty) のスプライト枠の左上 (高さ 0 のとき) */
export function tileOrigin(tx: number, ty: number): [number, number] {
  return [(tx - ty) * HALF_W, (tx + ty) * HALF_H];
}

/** 画面座標 (高さ 0 の平面上) → 連続タイル座標 */
export function screenToTile(sx: number, sy: number): [number, number] {
  const a = (sx - HALF_W) / HALF_W; // tx - ty
  const b = (sy - HALF_H) / HALF_H; // tx + ty
  return [(a + b) / 2, (b - a) / 2];
}

/** ダイヤ内のピクセル (px,py) → タイル内座標 (u,v) ∈ [0,1]。u は東向き、v は南向き。 */
export function pixelToUV(px: number, py: number): [number, number] {
  const u = ((px - HALF_W) / HALF_W + py / HALF_H) / 2;
  const v = (py / HALF_H - (px - HALF_W) / HALF_W) / 2;
  return [u, v];
}

/** タイル内座標 (u,v) → ダイヤ内ピクセル */
export function uvToPixel(u: number, v: number): [number, number] {
  return [HALF_W + (u - v) * HALF_W, (u + v) * HALF_H];
}

/** 幅 32 のダイヤの列 x における上端・下端の行 (両端含む) */
export function diamondRows(x: number, width = TILE_W, cx = HALF_W): [number, number] {
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;
  const d = x < cx ? x - x0 : x1 - 1 - x;
  const k = Math.floor(d / 2);
  return [HALF_H - 1 - k, HALF_H + k];
}

/** 4隅の高さ [T,R,B,L] から (u,v) の高さを補間 */
export function heightAt(c: readonly [number, number, number, number], u: number, v: number): number {
  const [t, r, b, l] = c;
  // T=(0,0) R=(1,0) B=(1,1) L=(0,1)
  return t * (1 - u) * (1 - v) + r * u * (1 - v) + b * u * v + l * (1 - u) * v;
}
