"""
澎湖中油湖西油庫漏油場址 — Web GIS 示範專案產生器（模擬資料）。

依環境部／澎湖縣環保局公告之「澎湖縣湖西供油中心（中油湖西油庫）」整治場址。
2017-06 漏油約 68.4 公秉，2018-12-10 公告為整治場址，整治期限至 2024-02-19。
公告地下水污染物與最高濃度（mg/L）：TPH 33.2、苯 4.47、萘 0.515、MTBE 120。

場址範圍採**油庫實際 footprint**（OpenStreetMap way 508438551「中油湖西油庫」，
landuse=industrial，地址澎湖縣湖西鄉湖西村102號之2，~6.7 公頃，中心約
119.6544E,23.5762N）——油庫為單一工業地塊，未對應「湖西段」農地地號，且整治場址
逐筆公告地號未公開，故以實際範圍定界（與台南安順採真實地籍地號的方式不同，已於 README 揭露）。

污染物與標準依台灣土壤及地下水污染管制標準：
  TPH 土壤管制1000 mg/kg・地下水管制10 mg/L；苯 土壤管制5 mg/kg・地下水管制0.05 mg/L；
  MTBE 地下水管制1 mg/L。監測/篩選值取管制值之半，為展示分級用。
  濃度為模擬值：垂向 3D 峰值取中等(4500)使等濃度線/體積穩定，表層抓樣保留石油類常見高值。
場址西側地勢較高、東側較低 → 地下水位西高東低，地下水向東流。
"""
import json, math, http.cookiejar, time, urllib.request

BASE = "http://127.0.0.1:8011"
LON0, LAT0 = 119.654368, 23.576235       # 油庫中心（OSM footprint 質心）
M_PER_DEG_LON = 102063.0                  # 111320*cos(23.576°)
M_PER_DEG_LAT = 110570.0

# 中油湖西油庫實際 footprint（OpenStreetMap way 508438551, landuse=industrial,
# 地址澎湖縣湖西鄉湖西村102號之2；經緯度逐點，~6.7 公頃）。
DEPOT_RING = [
    [119.656504, 23.577396], [119.655366, 23.574641], [119.65529, 23.574723],
    [119.65522, 23.57474], [119.654971, 23.575038], [119.654665, 23.575196],
    [119.654582, 23.575176], [119.654397, 23.575275], [119.654308, 23.575246],
    [119.654263, 23.57536], [119.653953, 23.575526], [119.654043, 23.575702],
    [119.653631, 23.575942], [119.653647, 23.576062], [119.653389, 23.576249],
    [119.653644, 23.576184], [119.653646, 23.576297], [119.653599, 23.576319],
    [119.653711, 23.576469], [119.653933, 23.57695], [119.653998, 23.577066],
    [119.654016, 23.577244], [119.653974, 23.577276], [119.654054, 23.577455],
    [119.654237, 23.577729], [119.654264, 23.577722], [119.654484, 23.578198],
    [119.656504, 23.577396],
]


def off(e, n):
    return [round(LON0 + e / M_PER_DEG_LON, 6), round(LAT0 + n / M_PER_DEG_LAT, 6)]


def ring(pts):
    r = [off(e, n) for (e, n) in pts]
    r.append(r[0])
    return [r]


def g2(e, n, ce, cn, sigma):
    return math.exp(-((e - ce) ** 2 + (n - cn) ** 2) / (2 * sigma * sigma))


# ---------------------------------------------------------------- 場址範圍（OSM 實際 footprint）
depot_ring = DEPOT_RING
print("depot nodes:", len(depot_ring))

site_layer = {
    "id": "huxi-site",
    "name": "整治場址範圍（中油湖西油庫）",
    "visible": True, "opacity": 0.20,
    "color": "#f59e0b", "strokeColor": "#f59e0b", "strokeWidth": 2,
    "kind": "polygon", "labelVisible": False,
    "data": {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"名稱": "中油湖西油庫", "地址": "澎湖縣湖西鄉湖西村102號之2"},
         "geometry": {"type": "Polygon", "coordinates": [depot_ring]}},
    ]},
    "featureCount": 1,
}

# 漏油污染源（儲槽區）— 小範圍標示，置於場址中心
source_layer = {
    "id": "huxi-source",
    "name": "漏油污染源（儲槽區）",
    "visible": True, "opacity": 0.45,
    "color": "#ef4444", "strokeColor": "#b91c1c", "strokeWidth": 2,
    "kind": "polygon", "labelVisible": True, "labelColor": "#ffffff", "labelSize": 12,
    "data": {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"名稱": "漏油儲槽區"},
         "geometry": {"type": "Polygon", "coordinates": ring([(-18, -14), (22, -14), (22, 20), (-18, 20)])}},
    ]},
    "featureCount": 1,
}

# ---------------------------------------------------------------- 地下水監測井（TPH/苯/MTBE + 水位）
GW_DATES = ["2018-12-15", "2021-06-15", "2024-02-15"]
TPH_C, BZ_C, MT_C = (28, 0), (45, 0), (65, 0)   # 羽流中心沿下游(東)遞遠；MTBE 最易移動、最遠
TPH_PEAK = {"2018-12-15": 33.2, "2021-06-15": 12.0, "2024-02-15": 4.5}
BZ_PEAK = {"2018-12-15": 4.47, "2021-06-15": 1.20, "2024-02-15": 0.30}
# MTBE 內插場採適中代表值（與 TPH 同數量級比值，避免等濃度線過密/檔案肥大）；
# 2018 公告實測最高達 120 mg/L，於 README 與井屬性說明欄揭露。
MT_PEAK = {"2018-12-15": 8.0, "2021-06-15": 3.0, "2024-02-15": 0.8}
TPH_BG, BZ_BG, MT_BG = 0.20, 0.002, 0.05
TPH_SIG, BZ_SIG, MT_SIG = 55.0, 60.0, 62.0
HYDRO_DATE = "2024-02-15"
WATER_DEPTH = 2.5    # 澎湖地下水較淺，量測埋深 ~2.5m

# 西側地勢較高、東側低 → 地下水位西高東低，地下水向東流（流向 ~90°）。
def head_of(e, n):
    return round(1.50 - 0.0042 * e, 3)

wells = [
    ("MW-01", 0, 0), ("MW-02", -40, 48), ("MW-03", -80, 96), ("MW-04", -120, 130),
    ("MW-05", -30, 90), ("MW-06", 40, 30), ("MW-07", -60, -10), ("MW-08", 70, -60),
    ("MW-09", 120, -120), ("MW-10", 150, 60), ("MW-11", 10, -150), ("MW-12", -140, -50),
]
gw_features = []
for (wid, e, n) in wells:
    tph = {d: round(TPH_BG + TPH_PEAK[d] * g2(e, n, *TPH_C, TPH_SIG), 3) for d in GW_DATES}
    bz = {d: round(BZ_BG + BZ_PEAK[d] * g2(e, n, *BZ_C, BZ_SIG), 4) for d in GW_DATES}
    mt = {d: round(MT_BG + MT_PEAK[d] * g2(e, n, *MT_C, MT_SIG), 3) for d in GW_DATES}
    head = head_of(e, n)
    ground = round(head + WATER_DEPTH, 2)
    gw_features.append({
        "type": "Feature",
        "properties": {"名稱": wid, "高程": ground,
                       "__gwConc": {"tab-gw": {"gw-tph": tph, "gw-bz": bz, "gw-mt": mt}},
                       "__hydro": {HYDRO_DATE: WATER_DEPTH}},
        "geometry": {"type": "Point", "coordinates": off(e, n)},
    })

gw_layer = {
    "id": "huxi-gw",
    "name": "地下水監測井",
    "visible": True, "opacity": 1, "color": "#2563eb",
    "kind": "point", "pointShape": "circle", "pointRadius": 6,
    "strokeColor": "#ffffff", "strokeWidth": 1.5,
    "labelVisible": True, "labelColor": "#ffffff", "labelSize": 11,
    "data": {"type": "FeatureCollection", "features": gw_features},
    "featureCount": len(gw_features),
    "hydroDates": [HYDRO_DATE],
    "gwConcTabs": [{
        "id": "tab-gw", "label": "澎湖縣環保局 / 中油監測（模擬）", "dates": GW_DATES,
        "substances": [
            {"id": "gw-tph", "name": "總石油碳氫化合物 TPH", "controlConc": 10, "monitorConc": 5, "unit": "mg/L"},
            {"id": "gw-bz", "name": "苯", "controlConc": 0.05, "monitorConc": 0.005, "unit": "mg/L"},
            {"id": "gw-mt", "name": "MTBE", "controlConc": 1, "monitorConc": 0.5, "unit": "mg/L"},
        ],
    }],
}

# ---------------------------------------------------------------- 土壤採樣點位（超標圖：TPH/苯）
soil_pts = [
    ("儲槽區表土 0–0.5m", "SG-01", 0, 0, 48000, 22.0),
    ("儲槽區表土 0–0.5m", "SG-02", -30, 36, 18000, 9.5),
    ("儲槽區表土 0–0.5m", "SG-03", -70, 84, 4200, 2.1),
    ("儲槽區表土 0–0.5m", "SG-04", -20, 70, 1500, 0.8),
    ("儲槽區表土 0–0.5m", "SG-05", 30, 20, 850, 0.4),
    ("儲槽區表土 0–0.5m", "SG-06", -100, 110, 320, 0.12),
    ("場區周邊 0–1m", "SP-01", 90, -70, 95, 0.05),
    ("場區周邊 0–1m", "SP-02", 140, 40, 60, 0.03),
    ("場區周邊 0–1m", "SP-03", 10, -140, 180, 0.08),
    ("場區周邊 0–1m", "SP-04", -140, -40, 45, 0.02),
    ("場區周邊 0–1m", "SP-05", 130, -120, 30, 0.01),
    ("場區周邊 0–1m", "SP-06", -120, 150, 240, 0.10),
]
sc_features = [{
    "type": "Feature",
    "properties": {"名稱": sid, "批次名稱": batch, "__soilConc": {"tab-sc": {"sc-tph": tph, "sc-bz": bz}}},
    "geometry": {"type": "Point", "coordinates": off(e, n)},
} for (batch, sid, e, n, tph, bz) in soil_pts]

sc_layer = {
    "id": "huxi-soilconc",
    "name": "土壤採樣點位",
    "visible": True, "opacity": 1, "color": "#16a34a",
    "kind": "point", "pointShape": "circle", "pointRadius": 6,
    "strokeColor": "#ffffff", "strokeWidth": 1.5,
    "labelVisible": True, "labelColor": "#ffffff", "labelSize": 11,
    "data": {"type": "FeatureCollection", "features": sc_features},
    "featureCount": len(sc_features),
    "soilConcTabs": [{
        "id": "tab-sc", "label": "SGS 台灣檢驗（模擬）", "landUse": "general",
        "substances": [
            {"id": "sc-tph", "name": "總石油碳氫化合物 TPH", "controlConc": 1000, "monitorConc": 500, "unit": "mg/kg"},
            {"id": "sc-bz", "name": "苯", "controlConc": 5, "monitorConc": 2.5, "unit": "mg/kg"},
        ],
    }],
}

# ---------------------------------------------------------------- 土壤污染調查（TPH・垂向 → 3D）
# 內部封閉羽流（峰值中等、四周背景<閾值）使逐層超標面積單調收斂；比例同安順驗證版(峰/閾≈4.5)。
DEPTHS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
SV_PEAK, SV_SIGMA, SV_BG, SV_DECAY = 4500.0, 42.0, 150.0, 1.6
SV_C = (0, 0)
boreholes = [
    ("BH-01", 0, 0, 2.4), ("BH-02", -25, -19, 2.5), ("BH-03", 23, 25, 2.5),
    ("BH-04", -33, 23, 2.6), ("BH-05", 34, -23, 2.5),
    ("BH-06", 0, 93, 2.7), ("BH-07", -95, 0, 2.8), ("BH-08", 75, 47, 2.6),
    ("BH-09", 0, -95, 2.6),
    ("BH-10", 0, 174, 2.9), ("BH-11", -177, 0, 3.0), ("BH-12", 165, 81, 2.8),
    ("BH-13", 0, -147, 2.9),
]
sv_features = []
for (bid, e, n, elev) in boreholes:
    surf = SV_PEAK * g2(e, n, *SV_C, SV_SIGMA) + SV_BG
    prof = {("%g" % round(d, 3)): round((surf - SV_BG) * math.exp(-d / SV_DECAY) + SV_BG, 1) for d in DEPTHS}
    sv_features.append({
        "type": "Feature",
        "properties": {"名稱": bid, "高程": elev, "__soilSurvey": {"tab-sv": {"sv-tph": prof}}},
        "geometry": {"type": "Point", "coordinates": off(e, n)},
    })

obstacle_geom = {"type": "Polygon", "coordinates": ring([(-12, -8), (16, -8), (16, 16), (-12, 16)])}
sv_layer = {
    "id": "huxi-soilsurvey",
    "name": "土壤污染調查（TPH・垂向）",
    "visible": True, "opacity": 1, "color": "#a21caf",
    "kind": "point", "pointShape": "triangle", "pointRadius": 6,
    "strokeColor": "#ffffff", "strokeWidth": 1.5,
    "labelVisible": True, "labelColor": "#ffffff", "labelSize": 11,
    "data": {"type": "FeatureCollection", "features": sv_features},
    "featureCount": len(sv_features),
    "soilSurveyTabs": [{
        "id": "tab-sv", "label": "鑽探岩心（模擬）", "landUse": "general",
        "depthInterval": 0.5, "maxDepth": 4, "threshold": 1000, "model": "idw",
        "fillGaps": True, "activeSubstance": "sv-tph", "activeDepth": 0,
        "substances": [{"id": "sv-tph", "name": "總石油碳氫化合物 TPH", "controlConc": 1000, "monitorConc": 500, "unit": "mg/kg"}],
        "obstacles": [{"id": "ob-1", "shape": "rectangle", "geometry": obstacle_geom,
                       "depthTop": 0, "depthBottom": 1.0, "enabled": True, "label": "儲槽混凝土基座"}],
    }],
}

project = {
    "version": 1, "savedAt": "2026-06-22T00:00:00Z",
    "basemapId": "hybrid-google", "basemapOpacity": 1,
    "projectName": "澎湖中油湖西油庫漏油場址示範（模擬）",
    "layers": [site_layer, source_layer, gw_layer, sc_layer, sv_layer],
    "mapView": {"center": off(0, 0), "zoom": 17},
    "colorCursor": 0,
}


def main():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    def call(path, data=None, method="GET"):
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(BASE + path, data=body,
              headers={"Content-Type": "application/json"} if body else {}, method=method)
        return json.load(op.open(req))

    for attempt in range(6):
        try:
            call("/api/auth/dev-login", data={}, method="POST")
            pid = call("/api/projects", data={"name": project["projectName"]}, method="POST")["id"]
            call(f"/api/projects/{pid}", data=project, method="PUT")
            print("SEEDED_PID", pid)
            return
        except Exception as exc:  # noqa: BLE001
            print("retry", attempt, exc); time.sleep(2)


if __name__ == "__main__":
    main()
