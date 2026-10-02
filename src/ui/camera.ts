import { HALF_H, HALF_W, LEVEL_H, screenToTile, tileOrigin } from "../render/iso";
import { World, cornerHeights, inBounds } from "../sim/world";

export const ZOOM_LEVELS = [1, 1.5, 2, 2.5, 3, 4] as const;

export class Camera {
  /** ビューポート左上のワールド座標 (ネイティブピクセル) */
  x = 0;
  y = 0;
  zoom = 2;

  constructor(private canvas: HTMLCanvasElement) {}

  get viewW(): number {
    return this.canvas.clientWidth / this.zoom;
  }
  get viewH(): number {
    return this.canvas.clientHeight / this.zoom;
  }

  centerOnTile(tx: number, ty: number): void {
    const [ox, oy] = tileOrigin(tx, ty);
    this.x = ox + HALF_W - this.viewW / 2;
    this.y = oy + HALF_H - this.viewH / 2;
  }

  /** 画面のピクセル位置を基準にズーム */
  zoomAt(clientX: number, clientY: number, newZoom: number): void {
    const wx = this.x + clientX / this.zoom;
    const wy = this.y + clientY / this.zoom;
    this.zoom = newZoom;
    this.x = wx - clientX / this.zoom;
    this.y = wy - clientY / this.zoom;
  }

  clampTo(world: World): void {
    const minX = -(world.h - 1) * HALF_W - 64;
    const maxX = (world.w + 1) * HALF_W + 64;
    const minY = -3 * LEVEL_H - 96;
    const maxY = (world.w + world.h) * HALF_H + 64;
    this.x = Math.max(minX - this.viewW / 2, Math.min(maxX - this.viewW / 2, this.x));
    this.y = Math.max(minY - this.viewH / 2, Math.min(maxY - this.viewH / 2, this.y));
  }

  /** 画面座標からタイルを求める (高さを考慮) */
  pick(world: World, clientX: number, clientY: number): [number, number] | null {
    const wx = this.x + clientX / this.zoom;
    const wy = this.y + clientY / this.zoom;
    for (let h = 3; h >= 0; h--) {
      const [tx, ty] = screenToTile(wx, wy + h * LEVEL_H);
      const ix = Math.floor(tx + 0.5);
      const iy = Math.floor(ty + 0.5);
      if (!inBounds(world, ix, iy)) continue;
      const c = cornerHeights(world, ix, iy);
      const avg = Math.round((c[0] + c[1] + c[2] + c[3]) / 4);
      if (avg === h) return [ix, iy];
    }
    const [tx, ty] = screenToTile(wx, wy);
    const ix = Math.floor(tx + 0.5);
    const iy = Math.floor(ty + 0.5);
    return inBounds(world, ix, iy) ? [ix, iy] : null;
  }
}

export interface InputHandlers {
  onClick(clientX: number, clientY: number): void;
}

/** ドラッグ・ホイール・キーボードでカメラを操作する */
export function attachInput(canvas: HTMLCanvasElement, cam: Camera, handlers: InputHandlers): void {
  // ポインタ (マウス・タッチ) を ID ごとに追跡。1 本ならドラッグ、2 本ならピンチズーム
  const pointers = new Map<number, { x: number; y: number }>();
  let moved = false;
  let pinchDist = 0;
  let pinchZoom = 1;
  const pinchCenter = (): [number, number] => {
    const pts = [...pointers.values()];
    return [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
  };
  const pinchDistance = (): number => {
    const pts = [...pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };
  canvas.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 1) moved = false;
    if (pointers.size === 2) {
      pinchDist = pinchDistance();
      pinchZoom = cam.zoom;
      moved = true;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (moved) {
        cam.x -= dx / cam.zoom;
        cam.y -= dy / cam.zoom;
        canvas.classList.add("dragging");
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
    } else if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const d = pinchDistance();
      if (pinchDist > 0) {
        // 連続的な倍率を一番近い段階に丸める
        const want = pinchZoom * (d / pinchDist);
        let best = ZOOM_LEVELS[0] as number;
        for (const z of ZOOM_LEVELS) if (Math.abs(z - want) < Math.abs(best - want)) best = z;
        if (best !== cam.zoom) {
          const [cx, cy] = pinchCenter();
          cam.zoomAt(cx, cy, best);
        }
      }
    }
  });
  const end = (e: PointerEvent) => {
    const had = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    if (!had) return;
    if (pointers.size === 0) {
      canvas.classList.remove("dragging");
      if (!moved) handlers.onClick(e.clientX, e.clientY);
    } else if (pointers.size === 1) {
      // ピンチ終了後はドラッグとして続ける
      moved = true;
      pinchDist = 0;
    }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const i = ZOOM_LEVELS.indexOf(cam.zoom as (typeof ZOOM_LEVELS)[number]);
      const next = e.deltaY < 0 ? Math.min(ZOOM_LEVELS.length - 1, i + 1) : Math.max(0, i - 1);
      if (next !== i) cam.zoomAt(e.clientX, e.clientY, ZOOM_LEVELS[next]);
    },
    { passive: false },
  );
  const keys = new Set<string>();
  const zoomStep = (dir: number) => {
    const i = ZOOM_LEVELS.indexOf(cam.zoom as (typeof ZOOM_LEVELS)[number]);
    const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + dir));
    if (next !== i) cam.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, ZOOM_LEVELS[next]);
  };
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "+" || e.key === "=" || e.key === ";") zoomStep(1);
    else if (e.key === "-" || e.key === "_") zoomStep(-1);
    keys.add(e.key);
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key));
  const step = () => {
    const v = 6 / cam.zoom;
    if (keys.has("ArrowLeft") || keys.has("a")) cam.x -= v;
    if (keys.has("ArrowRight") || keys.has("d")) cam.x += v;
    if (keys.has("ArrowUp") || keys.has("w")) cam.y -= v;
    if (keys.has("ArrowDown") || keys.has("s")) cam.y += v;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
