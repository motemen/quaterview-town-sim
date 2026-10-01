/** ゲーム内時刻。1日 = 1440分、1月 = 30日、1年 = 12月の簡易暦。 */
export const MINUTES_PER_DAY = 1440;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const MINUTES_PER_MONTH = MINUTES_PER_DAY * DAYS_PER_MONTH;
export const MINUTES_PER_YEAR = MINUTES_PER_MONTH * MONTHS_PER_YEAR;

/** 現実の1秒あたりに進むゲーム内分 (x1 時)。60秒で1日。 */
export const MINUTES_PER_REAL_SECOND = MINUTES_PER_DAY / 60;

export const START_YEAR = 1985;
export const START_MINUTES = (3 * DAYS_PER_MONTH) * MINUTES_PER_DAY + 6 * 60; // 4月1日 06:00

export interface Calendar {
  year: number;
  month: number; // 1..12
  day: number; // 1..30
  hour: number; // 0..23
  minute: number; // 0..59
  /** 0..1 の一日内の位置 */
  dayFraction: number;
  totalDays: number;
}

export function toCalendar(minutes: number): Calendar {
  const totalDays = Math.floor(minutes / MINUTES_PER_DAY);
  const inDay = minutes - totalDays * MINUTES_PER_DAY;
  const year = START_YEAR + Math.floor(totalDays / (DAYS_PER_MONTH * MONTHS_PER_YEAR));
  const dayOfYear = totalDays % (DAYS_PER_MONTH * MONTHS_PER_YEAR);
  return {
    year,
    month: Math.floor(dayOfYear / DAYS_PER_MONTH) + 1,
    day: (dayOfYear % DAYS_PER_MONTH) + 1,
    hour: Math.floor(inDay / 60),
    minute: Math.floor(inDay % 60),
    dayFraction: inDay / MINUTES_PER_DAY,
    totalDays,
  };
}

export type Season = "spring" | "summer" | "autumn" | "winter";

export function seasonOf(month: number): Season {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

export const SEASON_LABEL: Record<Season, string> = {
  spring: "春",
  summer: "夏",
  autumn: "秋",
  winter: "冬",
};

/**
 * 夜の度合い (0 = 真昼, 1 = 真夜中)。時刻 (0..24) から求める。
 * 季節で日の出・日の入りが少しずれる。
 */
export function nightFactor(hour: number, season: Season = "spring"): number {
  const shift = season === "summer" ? -0.7 : season === "winter" ? 0.7 : 0;
  const sunrise = 6 + shift;
  const sunset = 18 - shift;
  const dawnLen = 1.5;
  const duskLen = 1.5;
  if (hour < sunrise - dawnLen || hour > sunset + duskLen) return 1;
  if (hour < sunrise + dawnLen) {
    const t = (hour - (sunrise - dawnLen)) / (2 * dawnLen);
    return 1 - t;
  }
  if (hour > sunset - duskLen) {
    const t = (hour - (sunset - duskLen)) / (2 * duskLen);
    return t;
  }
  return 0;
}

/** 空の色 (昼夜で変化)。 */
export function skyColor(hour: number, season: Season = "spring"): [number, number, number] {
  const n = nightFactor(hour, season);
  const day: [number, number, number] = [120, 172, 216];
  const night: [number, number, number] = [12, 14, 40];
  const dusk: [number, number, number] = [220, 140, 90];
  // 夕焼け・朝焼けは n が 0.3..0.8 のあたりで混ざる
  const duskAmt = Math.max(0, 1 - Math.abs(n - 0.5) * 3);
  const base = lerp3(day, night, n);
  return lerp3(base, dusk, duskAmt * 0.6);
}

/** 乗算合成で画面にかける色。昼は白、夜は青く暗く、夕暮れは橙。 */
export function tintColor(hour: number, season: Season = "spring"): [number, number, number] {
  const n = nightFactor(hour, season);
  const day: [number, number, number] = [255, 255, 255];
  const night: [number, number, number] = [70, 80, 150];
  const dusk: [number, number, number] = [255, 190, 130];
  const duskAmt = Math.max(0, 1 - Math.abs(n - 0.45) * 3);
  const base = lerp3(day, night, n);
  return lerp3(base, dusk, duskAmt * 0.5);
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
