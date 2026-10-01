/**
 * Web Audio で生成する環境音。外部ファイルは使わない。
 * - 列車の走行音 (ローパスしたノイズ + ガタンゴトンの揺らぎ)
 * - 踏切の警報音 (2 音の交互)
 * - 雨音
 * - 春〜夏の昼の鳥の声
 */
export interface SoundState {
  /** 画面内を走る列車の強さ 0..1 */
  train: number;
  /** 画面内に鳴っている踏切があるか */
  crossing: boolean;
  rain: boolean;
  /** 鳥が鳴く時間帯か */
  birds: boolean;
  /** 夏の夜の虫の声 */
  insects: boolean;
  /** 花火が上がった回数 (増えたら音を鳴らす) */
  fireworkBursts: number;
  paused: boolean;
}

export class SoundSystem {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private trainGain!: GainNode;
  private rainGain!: GainNode;
  private insectGain!: GainNode;
  private nextBell = 0;
  private bellHigh = true;
  private nextBird = 0;
  private lastBursts = 0;
  enabled = false;

  constructor() {
    try {
      this.enabled = localStorage.getItem("quaterview-town-sim/sound") === "1";
    } catch {
      this.enabled = false;
    }
  }

  /** ユーザー操作の中で呼ぶ必要がある */
  toggle(): boolean {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem("quaterview-town-sim/sound", this.enabled ? "1" : "0");
    } catch {
      // 保存できなくてもよい
    }
    if (this.enabled) this.ensure();
    else if (this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    return this.enabled;
  }

  /** 最初のユーザー操作で呼ぶ (自動再生制限のため) */
  unlock(): void {
    if (this.enabled) this.ensure();
  }

  private ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      this.master.gain.setTargetAtTime(0.5, this.ctx.currentTime, 0.1);
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    const noise = this.noiseSource(ctx);
    // 列車
    const trainLp = ctx.createBiquadFilter();
    trainLp.type = "lowpass";
    trainLp.frequency.value = 420;
    this.trainGain = ctx.createGain();
    this.trainGain.gain.value = 0;
    const wobble = ctx.createGain();
    wobble.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = "square";
    lfo.frequency.value = 4.2;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.35;
    lfo.connect(lfoAmt).connect(wobble.gain);
    lfo.start();
    noise.connect(trainLp).connect(wobble).connect(this.trainGain).connect(this.master);
    // 雨
    const rainBp = ctx.createBiquadFilter();
    rainBp.type = "bandpass";
    rainBp.frequency.value = 2400;
    rainBp.Q.value = 0.6;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    noise.connect(rainBp).connect(this.rainGain).connect(this.master);
    // 虫の声: 高い音の細かい震え
    const insect = ctx.createOscillator();
    insect.type = "sine";
    insect.frequency.value = 4300;
    const trem = ctx.createGain();
    const tremLfo = ctx.createOscillator();
    tremLfo.frequency.value = 23;
    const tremAmt = ctx.createGain();
    tremAmt.gain.value = 0.5;
    tremLfo.connect(tremAmt).connect(trem.gain);
    trem.gain.value = 0.5;
    this.insectGain = ctx.createGain();
    this.insectGain.gain.value = 0;
    insect.connect(trem).connect(this.insectGain).connect(this.master);
    insect.start();
    tremLfo.start();
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // 少し茶色いノイズ
      const white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;
      d[i] = last * 4 + white * 0.15;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    return src;
  }

  update(s: SoundState): void {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const mute = s.paused ? 0 : 1;
    this.trainGain.gain.setTargetAtTime(s.train * 0.5 * mute, t, 0.3);
    this.rainGain.gain.setTargetAtTime((s.rain ? 0.12 : 0) * mute, t, 0.8);
    this.insectGain.gain.setTargetAtTime((s.insects ? 0.02 : 0) * mute, t, 1.0);
    if (s.crossing && !s.paused && t >= this.nextBell) {
      this.beep(this.bellHigh ? 740 : 580, t, 0.14, 0.08);
      this.bellHigh = !this.bellHigh;
      this.nextBell = t + 0.36;
    }
    if (s.birds && !s.paused && t >= this.nextBird) {
      this.chirp(t);
      this.nextBird = t + 1.5 + Math.random() * 5;
    }
    if (s.fireworkBursts !== this.lastBursts) {
      if (s.fireworkBursts > this.lastBursts && !s.paused) this.boom(t);
      this.lastBursts = s.fireworkBursts;
    }
  }

  private beep(freq: number, t: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private chirp(t: number): void {
    const ctx = this.ctx!;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = "sine";
      const base = 2600 + Math.random() * 1400;
      const start = t + i * 0.13;
      o.frequency.setValueAtTime(base, start);
      o.frequency.linearRampToValueAtTime(base * 1.3, start + 0.05);
      o.frequency.linearRampToValueAtTime(base * 0.9, start + 0.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.03, start + 0.02);
      g.gain.linearRampToValueAtTime(0, start + 0.11);
      o.connect(g).connect(this.master);
      o.start(start);
      o.stop(start + 0.15);
    }
  }

  private boom(t: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * 0.8);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(150, t + 0.7);
    const g = ctx.createGain();
    g.gain.value = 0.25;
    src.connect(lp).connect(g).connect(this.master);
    src.start(t + 0.6); // 光ってから少し遅れて聞こえる
  }
}
