import { Rng } from "./rng";
import { World, createEmptyWorld, updateSlopes } from "./world";

export const SAVE_VERSION = 1;
export const SAVE_KEY = "quaterview-town-sim/save";

interface SaveData {
  v: number;
  seed: number;
  w: number;
  h: number;
  minutes: number;
  rng: number;
  lastHour: number;
  population: number;
  stations: World["stations"];
  arrays: Record<string, string>;
}

const U8_FIELDS = ["height", "water", "kind", "value", "bLevel", "bStyle", "bState", "bProgress", "lotTimer", "lights"] as const;
const U16_FIELDS = ["bAge"] as const;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function serialize(w: World): string {
  const arrays: Record<string, string> = {};
  for (const f of U8_FIELDS) arrays[f] = toBase64(w[f]);
  for (const f of U16_FIELDS) arrays[f] = toBase64(new Uint8Array(w[f].buffer, w[f].byteOffset, w[f].byteLength));
  const data: SaveData = {
    v: SAVE_VERSION,
    seed: w.seed,
    w: w.w,
    h: w.h,
    minutes: w.minutes,
    rng: w.rng.state,
    lastHour: w.lastHour,
    population: w.population,
    stations: w.stations,
    arrays,
  };
  return JSON.stringify(data);
}

export function deserialize(json: string): World | null {
  let data: SaveData;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || data.v !== SAVE_VERSION) return null;
  const w = createEmptyWorld(data.seed, data.w, data.h);
  for (const f of U8_FIELDS) {
    const bytes = fromBase64(data.arrays[f]);
    if (bytes.length !== w[f].length) return null;
    w[f].set(bytes);
  }
  for (const f of U16_FIELDS) {
    const bytes = fromBase64(data.arrays[f]);
    if (bytes.length !== w[f].byteLength) return null;
    new Uint8Array(w[f].buffer).set(bytes);
  }
  w.minutes = data.minutes;
  w.rng = new Rng(1);
  w.rng.state = data.rng >>> 0;
  w.lastHour = data.lastHour;
  w.population = data.population;
  w.stations = data.stations;
  updateSlopes(w);
  return w;
}
