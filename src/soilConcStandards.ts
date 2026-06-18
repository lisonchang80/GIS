// 土壤污染管制標準 / 監測標準參考表
// 來源：環保署「土壤污染管制標準」與「土壤污染監測標準」。
// 用作 UI 預填預設值，實際數值請對照最新公告版本核對。
// 部分重金屬區分「食用作物農地」與「其他用地」兩級；有機物多為單一管制值。
// 監測標準若無明確公告值，原則以管制標準 × 0.5 作為預填近似（同 gwConcStandards 慣例）。

import type { SoilLandUse } from './types';

export interface SoilConcStandard {
  controlConc: number; // 管制標準
  monitorConc: number; // 監測標準
  unit: string;
}

interface SoilEntry {
  // 重金屬：farmland / general 兩級管制標準；有機物：single
  control: number | { farmland: number; general: number };
  // 監測標準（可選）；缺省時以 control × 0.5 近似
  monitor?: number | { farmland: number; general: number };
  unit: string;
}

// 單位皆為 mg/kg
const STANDARDS: Record<string, SoilEntry> = {
  // 重金屬（管制標準；食用作物農地 / 其他用地）
  砷: { control: 60, monitor: 30, unit: 'mg/kg' },
  鎘: { control: { farmland: 5, general: 20 }, monitor: { farmland: 2.5, general: 10 }, unit: 'mg/kg' },
  鉻: { control: 250, monitor: 175, unit: 'mg/kg' },
  銅: { control: { farmland: 200, general: 400 }, monitor: { farmland: 120, general: 240 }, unit: 'mg/kg' },
  鉛: { control: { farmland: 500, general: 2000 }, monitor: { farmland: 300, general: 1200 }, unit: 'mg/kg' },
  鎳: { control: 200, monitor: 130, unit: 'mg/kg' },
  鋅: { control: { farmland: 600, general: 2000 }, monitor: { farmland: 260, general: 1000 }, unit: 'mg/kg' },
  汞: { control: { farmland: 5, general: 20 }, monitor: { farmland: 2, general: 10 }, unit: 'mg/kg' },

  // 有機物（管制標準；單一值）
  苯: { control: 5, unit: 'mg/kg' },
  甲苯: { control: 500, unit: 'mg/kg' },
  乙苯: { control: 250, unit: 'mg/kg' },
  二甲苯: { control: 500, unit: 'mg/kg' },
  三氯乙烯: { control: 60, unit: 'mg/kg' },
  四氯乙烯: { control: 10, unit: 'mg/kg' },
  總石油碳氫化合物: { control: 1000, unit: 'mg/kg' },
  TPH: { control: 1000, unit: 'mg/kg' },
};

const ALIASES: Record<string, string> = {
  arsenic: '砷',
  cadmium: '鎘',
  chromium: '鉻',
  copper: '銅',
  lead: '鉛',
  nickel: '鎳',
  zinc: '鋅',
  mercury: '汞',
  benzene: '苯',
  toluene: '甲苯',
  ethylbenzene: '乙苯',
  xylene: '二甲苯',
  xylenes: '二甲苯',
  tce: '三氯乙烯',
  pce: '四氯乙烯',
  tph: 'TPH',
};

function pick(v: number | { farmland: number; general: number }, landUse: SoilLandUse): number {
  return typeof v === 'number' ? v : v[landUse];
}

export function lookupSoilConcStandard(
  pollutant: string,
  landUse: SoilLandUse = 'general',
): SoilConcStandard | null {
  const key = pollutant.trim();
  if (!key) return null;
  const entry = STANDARDS[key] ?? STANDARDS[ALIASES[key.toLowerCase()]];
  if (!entry) return null;
  const controlConc = pick(entry.control, landUse);
  const monitorConc = entry.monitor != null ? pick(entry.monitor, landUse) : controlConc * 0.5;
  return { controlConc, monitorConc, unit: entry.unit };
}

// 常見土壤污染物清單（datalist 用）
export const SOIL_POLLUTANTS = [
  '砷', '鎘', '鉻', '銅', '鉛', '鎳', '鋅', '汞',
  '苯', '甲苯', '乙苯', '二甲苯', '三氯乙烯', '四氯乙烯', '總石油碳氫化合物',
];
