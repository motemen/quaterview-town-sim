import { Rng } from "../sim/rng";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

const COLORS = ["#ffd080", "#ff8080", "#80e0ff", "#c0ff90", "#ffa0e0", "#ffffff"];

/** 夏の夜の花火。ワールド座標 (ネイティブピクセル) で粒子を持つ。 */
export class Fireworks {
  private particles: Particle[] = [];
  private timer = 1;
  private rng = new Rng(12345);

  /** anchor は打ち上げ位置の基準 (駅の上空など) */
  update(dt: number, active: boolean, anchorX: number, anchorY: number): void {
    if (active) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 1.2 + this.rng.next() * 2.2;
        this.burst(anchorX + (this.rng.next() - 0.5) * 320, anchorY - 90 - this.rng.next() * 70);
      }
    }
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += 22 * dt;
      p.vx *= 0.985;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  /** デバッグ用: すぐに打ち上げる */
  burstNow(x: number, y: number): void {
    this.burst(x, y);
  }

  private burst(x: number, y: number): void {
    const color = COLORS[this.rng.int(COLORS.length)];
    const n = 28 + this.rng.int(16);
    const speed = 26 + this.rng.next() * 22;
    const twoTone = this.rng.chance(0.3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rng.next() * 0.2;
      const s = speed * (0.7 + this.rng.next() * 0.4);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s * 0.8,
        life: 1.2 + this.rng.next() * 0.6,
        maxLife: 1.8,
        color: twoTone && i % 2 ? "#ffffff" : color,
      });
    }
  }

  get active(): boolean {
    return this.particles.length > 0;
  }

  /** カメラ変換がかかった ctx に描く */
  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      const a = Math.max(0, Math.min(1, p.life / 0.6));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const s = p.life > 0.8 ? 2 : 1;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), s, s);
    }
    ctx.globalAlpha = 1;
  }
}
