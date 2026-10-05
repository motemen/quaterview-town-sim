/**
 * 画面の保存: スクリーンショット (PNG) と録画 (MediaRecorder)。
 * キャンバスの中身だけを保存する (HUD は含まない)。
 */
export class Capture {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private parts: Blob[] = [];
  private startedAt = 0;
  private timer = 0;
  /** 録画の上限 (秒)。ファイルが大きくなりすぎないように */
  static readonly MAX_SECONDS = 120;

  constructor(
    private canvas: HTMLCanvasElement,
    private onState: (recording: boolean) => void,
  ) {}

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** 録画中の経過秒 */
  get elapsed(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  static get canRecord(): boolean {
    return typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";
  }

  /** いまの画面を PNG で保存する。成功したら true */
  async screenshot(name: string): Promise<boolean> {
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, "image/png"));
    if (!blob) return false;
    await deliver(blob, `${name}.png`);
    return true;
  }

  /** 録画の開始/停止を切り替える。開始できなければ false */
  toggleRecording(name: string): boolean {
    if (this.recorder) {
      this.stop();
      return true;
    }
    return this.start(name);
  }

  private start(name: string): boolean {
    if (!Capture.canRecord) return false;
    const mimeType = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) return false;
    let stream: MediaStream;
    let recorder: MediaRecorder;
    try {
      stream = this.canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    } catch {
      return false;
    }
    this.parts = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.parts.push(e.data);
    };
    recorder.onstop = () => {
      const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
      const blob = new Blob(this.parts, { type: mimeType.split(";")[0] });
      this.parts = [];
      if (blob.size > 0) void deliver(blob, `${name}.${ext}`);
    };
    recorder.start(1000);
    this.recorder = recorder;
    this.stream = stream;
    this.startedAt = performance.now();
    this.timer = window.setTimeout(() => this.stop(), Capture.MAX_SECONDS * 1000);
    this.onState(true);
    return true;
  }

  stop(): void {
    const rec = this.recorder;
    if (!rec) return;
    window.clearTimeout(this.timer);
    this.recorder = null;
    if (rec.state !== "inactive") rec.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.onState(false);
  }
}

/** ファイルを渡す: タッチ端末で共有シートが使えればそれで (写真に保存できる)、だめならダウンロード */
async function deliver(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type });
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (coarse && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      // キャンセルされたら何もしない。それ以外はダウンロードにフォールバック
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}
