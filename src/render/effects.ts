import { hash2 } from "../sim/rng";

/** 雨・雪を画面全体に描く。time は秒。 */
export function drawPrecipitation(ctx: CanvasRenderingContext2D, W: number, H: number, kind: "rain" | "snow" | "petals", time: number, zoom: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  if (kind === "rain") {
    const n = Math.floor((W * H) / 9000);
    ctx.strokeStyle = "rgba(190, 210, 240, 0.45)";
    ctx.lineWidth = Math.max(1, zoom / 2);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const speed = 500 + hash2(3, i, 0) * 300;
      const x = ((hash2(1, i, 0) * W + time * 60) % (W + 40)) - 20;
      const y = (hash2(2, i, 0) * H + time * speed) % (H + 40);
      ctx.moveTo(x, y);
      ctx.lineTo(x - 2 * zoom, y + 7 * zoom);
    }
    ctx.stroke();
  } else if (kind === "petals") {
    // 桜吹雪: ゆっくり右下へ流れる
    const n = Math.floor((W * H) / 30000);
    const s = Math.max(1, Math.round(zoom * 0.75));
    for (let i = 0; i < n; i++) {
      const speed = 18 + hash2(3, i, 2) * 20;
      const phase = hash2(4, i, 2) * 6.28;
      const x = ((hash2(1, i, 2) * W + time * (30 + hash2(5, i, 2) * 30) + Math.sin(time * 1.3 + phase) * 10 * zoom) % (W + 20)) - 10;
      const y = (hash2(2, i, 2) * H + time * speed + Math.sin(time * 2 + phase) * 4) % (H + 20);
      ctx.fillStyle = hash2(6, i, 2) < 0.5 ? "rgba(255, 196, 214, 0.9)" : "rgba(255, 228, 236, 0.9)";
      ctx.fillRect(Math.round(x), Math.round(y), s, s);
    }
  } else {
    const n = Math.floor((W * H) / 12000);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    const s = Math.max(1, Math.round(zoom * 0.75));
    for (let i = 0; i < n; i++) {
      const speed = 25 + hash2(3, i, 1) * 25;
      const phase = hash2(4, i, 1) * 6.28;
      const x = ((hash2(1, i, 1) * W + Math.sin(time * 0.8 + phase) * 12 * zoom + time * 8) % (W + 20)) - 10;
      const y = (hash2(2, i, 1) * H + time * speed) % (H + 20);
      ctx.fillRect(Math.round(x), Math.round(y), s, s);
    }
  }
}
