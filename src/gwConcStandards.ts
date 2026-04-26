// 地下水污染物管制 / 監測標準參考表（第二類土地概略值）
// 來源：環保署「地下水污染管制標準」與「地下水污染監測標準」
// 用作 UI 預填預設值，實際數值請對照最新公告版本核對。
// 監測標準原則上為管制標準 × 0.5（部分項目另有規範）。

export interface GwConcStandard {
  controlConc: number; // 管制濃度
  monitorConc: number; // 監測濃度
  unit: string;        // 單位
}

const STANDARDS: Record<string, GwConcStandard> = {
  // 揮發性有機物 (VOCs)
  '苯': { controlConc: 0.05, monitorConc: 0.025, unit: 'mg/L' },
  '甲苯': { controlConc: 7.0, monitorConc: 3.5, unit: 'mg/L' },
  '乙苯': { controlConc: 7.0, monitorConc: 3.5, unit: 'mg/L' },
  '二甲苯': { controlConc: 100, monitorConc: 50, unit: 'mg/L' },
  '萘': { controlConc: 0.4, monitorConc: 0.2, unit: 'mg/L' },
  'MTBE': { controlConc: 0.5, monitorConc: 0.25, unit: 'mg/L' },

  // 氯化有機物
  '三氯乙烯': { controlConc: 0.05, monitorConc: 0.025, unit: 'mg/L' },
  '四氯乙烯': { controlConc: 0.05, monitorConc: 0.025, unit: 'mg/L' },
  '氯乙烯': { controlConc: 0.02, monitorConc: 0.01, unit: 'mg/L' },
  '1,1-二氯乙烯': { controlConc: 0.07, monitorConc: 0.035, unit: 'mg/L' },
  '1,2-二氯乙烷': { controlConc: 0.05, monitorConc: 0.025, unit: 'mg/L' },
  '1,1,1-三氯乙烷': { controlConc: 2.0, monitorConc: 1.0, unit: 'mg/L' },
  '二氯甲烷': { controlConc: 0.05, monitorConc: 0.025, unit: 'mg/L' },

  // 重金屬
  '砷': { controlConc: 0.5, monitorConc: 0.25, unit: 'mg/L' },
  '鎘': { controlConc: 0.05, monitorConc: 0.025, unit: 'mg/L' },
  '鉻': { controlConc: 0.5, monitorConc: 0.25, unit: 'mg/L' },
  '鉛': { controlConc: 0.1, monitorConc: 0.05, unit: 'mg/L' },
  '銅': { controlConc: 10, monitorConc: 5, unit: 'mg/L' },
  '鋅': { controlConc: 50, monitorConc: 25, unit: 'mg/L' },
  '鎳': { controlConc: 1.0, monitorConc: 0.5, unit: 'mg/L' },
  '汞': { controlConc: 0.02, monitorConc: 0.01, unit: 'mg/L' },

  // 其他無機物
  '氰化物': { controlConc: 0.5, monitorConc: 0.25, unit: 'mg/L' },
  '硝酸鹽氮': { controlConc: 100, monitorConc: 50, unit: 'mg/L' },
  '氟鹽': { controlConc: 8, monitorConc: 4, unit: 'mg/L' },
};

const ALIASES: Record<string, string> = {
  'benzene': '苯',
  'toluene': '甲苯',
  'ethylbenzene': '乙苯',
  'xylene': '二甲苯',
  'xylenes': '二甲苯',
  'naphthalene': '萘',
  'tce': '三氯乙烯',
  'pce': '四氯乙烯',
  'vc': '氯乙烯',
  'dcm': '二氯甲烷',
  'arsenic': '砷',
  'cadmium': '鎘',
  'chromium': '鉻',
  'lead': '鉛',
  'copper': '銅',
  'zinc': '鋅',
  'nickel': '鎳',
  'mercury': '汞',
};

export function lookupGwConcStandard(pollutant: string): GwConcStandard | null {
  const key = pollutant.trim();
  if (!key) return null;
  if (STANDARDS[key]) return STANDARDS[key];
  const lower = key.toLowerCase();
  const aliased = ALIASES[lower];
  if (aliased && STANDARDS[aliased]) return STANDARDS[aliased];
  return null;
}
