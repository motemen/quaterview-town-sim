import { Rng } from "./rng";

const PREFIX = ["緑", "桜", "若", "新", "東", "西", "北", "南", "中", "大", "小", "高", "松", "梅", "川", "山", "港", "旭", "光", "春", "宮", "星", "栄", "富士", "白", "青", "朝", "清", "常", "花"];
const SUFFIX = ["ヶ丘", "台", "野", "川", "町", "原", "崎", "浜", "山", "橋", "丘", "谷", "本町", "中央", "見", "島", "沢", "森", "泉", "の宮"];

/** 和風の地名を作る。 */
export function makePlaceName(rng: Rng, used: Set<string> = new Set()): string {
  for (let i = 0; i < 20; i++) {
    const name = rng.pick(PREFIX) + rng.pick(SUFFIX);
    if (!used.has(name)) return name;
  }
  return rng.pick(PREFIX) + rng.pick(SUFFIX) + String(rng.int(9) + 1);
}
