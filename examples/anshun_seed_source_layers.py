"""
台南中石化(台鹼)安順整治場址 — Web GIS 示範專案產生器（模擬資料）。

污染物與標準依公開事實與台灣土壤/地下水污染管制標準：
  汞    土壤 管制20 / 監測10 mg/kg；地下水 管制0.02 / 監測0.01 mg/L
  五氯酚 土壤 管制200 / 監測200 mg/kg；地下水 管制0.08 / 監測0.04 mg/L
  戴奧辛 土壤 管制1000 / 監測1000 ng-TEQ/kg（地下水無標準）
濃度為模擬值，以場址實際熱點（海水貯水池底泥）為峰，並採用已公開的最高值
（汞 9,950 mg/kg、戴奧辛 64,100,000 ng I-TEQ/kg）作為最嚴重採樣點。
場址座標 ~23.0303N,120.1234E（安南區北汕尾，鹿耳門溪南岸）；幾何為示意配置。

產生 4 個來源圖層；等濃度線/超標圖由前端「生成」鈕產出（本檔只放來源資料）。
"""
import json, math, urllib.request, http.cookiejar, time

BASE = "http://127.0.0.1:8011"

LON0, LAT0 = 120.1234, 23.0303
M_PER_DEG_LON = 102470.0  # @ lat 23.03
M_PER_DEG_LAT = 110570.0


def off(e, n):
    """east/north metres from site origin -> [lon, lat] (6 dp)."""
    return [round(LON0 + e / M_PER_DEG_LON, 6), round(LAT0 + n / M_PER_DEG_LAT, 6)]


def ring(pts):
    r = [off(e, n) for (e, n) in pts]
    r.append(r[0])
    return [r]


def g2(e, n, ce, cn, sigma):
    """unit gaussian by distance from (ce,cn)."""
    d2 = (e - ce) ** 2 + (n - cn) ** 2
    return math.exp(-d2 / (2 * sigma * sigma))


# ----------------------------------------------------------------------------
# Layer 1 — 場址範圍與貯水池
# ----------------------------------------------------------------------------
site_polys = [
    ("中石化安順廠 廠區範圍", "#f59e0b",
     [(-260, -230), (330, -230), (330, 270), (-260, 270)]),
    ("海水貯水池 A 區（底泥熱點）", "#ef4444",
     [(-580, 30), (-360, 30), (-360, 200), (-580, 200)]),
    ("海水貯水池 B 區（底泥熱點）", "#ef4444",
     [(-580, -160), (-360, -160), (-360, 20), (-580, 20)]),
]
site_features = [{
    "type": "Feature",
    "properties": {"名稱": name, "_fill": color},
    "geometry": {"type": "Polygon", "coordinates": ring(pts)},
} for (name, color, pts) in site_polys]

site_layer = {
    "id": "anshun-site",
    "name": "場址範圍與海水貯水池",
    "visible": True, "opacity": 0.35,
    "color": "#f59e0b", "strokeColor": "#fcharacters", "strokeWidth": 2,
    "kind": "polygon",
    "labelVisible": True, "labelColor": "#ffffff", "labelSize": 12,
    "data": {"type": "FeatureCollection", "features": site_features},
    "featureCount": len(site_features),
}
# fix stray
site_layer["strokeColor"] = "#fbbf24"

# ----------------------------------------------------------------------------
# Layer 2 — 地下水監測井（汞 + 五氯酚，三期）
# ----------------------------------------------------------------------------
GW_DATES = ["2013-09-15", "2018-12-10", "2024-11-20"]
HG_C = (-470, 60)   # 汞源：貯水池
PCP_C = (110, 60)   # 五氯酚源：五氯酚廠
# 各期峰值（整治後遞減）
HG_PEAK = {"2013-09-15": 0.155, "2018-12-10": 0.068, "2024-11-20": 0.034}
PCP_PEAK = {"2013-09-15": 0.330, "2018-12-10": 0.140, "2024-11-20": 0.058}
HG_BG, PCP_BG = 0.0015, 0.004

wells = [
    ("MW-01", -470, 90), ("MW-02", -500, -60), ("MW-03", -360, 20),
    ("MW-04", -150, 120), ("MW-05", 120, 60), ("MW-06", 250, -120),
    ("MW-07", -300, 260), ("MW-08", -550, 230), ("MW-09", -650, 120),
    ("MW-10", 350, 200), ("MW-11", 300, -230), ("MW-12", -700, -120),
]
gw_features = []
for (wid, e, n) in wells:
    hg = {}
    pcp = {}
    for dt in GW_DATES:
        hg[dt] = round(HG_BG + HG_PEAK[dt] * g2(e, n, *HG_C, 300), 4)
        pcp[dt] = round(PCP_BG + PCP_PEAK[dt] * g2(e, n, *PCP_C, 260), 4)
    gw_features.append({
        "type": "Feature",
        "properties": {"名稱": wid, "__gwConc": {"tab-gw": {"gw-hg": hg, "gw-pcp": pcp}}},
        "geometry": {"type": "Point", "coordinates": off(e, n)},
    })

gw_layer = {
    "id": "anshun-gw",
    "name": "地下水監測井",
    "visible": True, "opacity": 1, "color": "#2563eb",
    "kind": "point", "pointShape": "circle", "pointRadius": 6,
    "strokeColor": "#ffffff", "strokeWidth": 1.5,
    "labelVisible": True, "labelColor": "#ffffff", "labelSize": 11,
    "data": {"type": "FeatureCollection", "features": gw_features},
    "featureCount": len(gw_features),
    "gwConcTabs": [{
        "id": "tab-gw",
        "label": "台南市環保局 / SGS（模擬）",
        "dates": GW_DATES,
        "substances": [
            {"id": "gw-hg", "name": "汞", "controlConc": 0.02, "monitorConc": 0.01, "unit": "mg/L"},
            {"id": "gw-pcp", "name": "五氯酚", "controlConc": 0.08, "monitorConc": 0.04, "unit": "mg/L"},
        ],
    }],
}

# ----------------------------------------------------------------------------
# Layer 3 — 土壤採樣點位（汞 + 戴奧辛；超標點位圖；兩批）
# ----------------------------------------------------------------------------
soil_pts = [
    # 批次, 名稱, e, n, 汞 mg/kg, 戴奧辛 ng-TEQ/kg
    ("貯水池底泥 0–0.5m", "SD-01", -470, 100, 9950, 64100000),
    ("貯水池底泥 0–0.5m", "SD-02", -520, -40, 3200, 8500000),
    ("貯水池底泥 0–0.5m", "SD-03", -400, 30, 780, 1200000),
    ("貯水池底泥 0–0.5m", "SD-04", -560, 150, 145, 42000),
    ("貯水池底泥 0–0.5m", "SD-05", -380, -120, 56, 5400),
    ("貯水池底泥 0–0.5m", "SD-06", -480, 180, 22, 1500),
    ("廠區表土 0–0.3m", "SS-01", 120, 60, 38, 9200),
    ("廠區表土 0–0.3m", "SS-02", -150, 120, 14, 620),
    ("廠區表土 0–0.3m", "SS-03", 250, -120, 8, 180),
    ("廠區表土 0–0.3m", "SS-04", 300, 200, 6.5, 95),
    ("廠區表土 0–0.3m", "SS-05", -50, -180, 25, 2100),
    ("廠區表土 0–0.3m", "SS-06", 200, 100, 11, 430),
    ("廠區表土 0–0.3m", "SS-07", -200, -100, 4.2, 60),
    ("廠區表土 0–0.3m", "SS-08", 350, -50, 9, 210),
]
sc_features = []
for (batch, sid, e, n, hg, dx) in soil_pts:
    sc_features.append({
        "type": "Feature",
        "properties": {
            "名稱": sid, "批次名稱": batch,
            "__soilConc": {"tab-sc": {"sc-hg": hg, "sc-dx": dx}},
        },
        "geometry": {"type": "Point", "coordinates": off(e, n)},
    })

sc_layer = {
    "id": "anshun-soilconc",
    "name": "土壤採樣點位",
    "visible": True, "opacity": 1, "color": "#16a34a",
    "kind": "point", "pointShape": "circle", "pointRadius": 6,
    "strokeColor": "#ffffff", "strokeWidth": 1.5,
    "labelVisible": True, "labelColor": "#ffffff", "labelSize": 11,
    "data": {"type": "FeatureCollection", "features": sc_features},
    "featureCount": len(sc_features),
    "soilConcTabs": [{
        "id": "tab-sc",
        "label": "SGS 台灣檢驗（模擬）",
        "landUse": "general",
        "substances": [
            {"id": "sc-hg", "name": "汞", "controlConc": 20, "monitorConc": 10, "unit": "mg/kg"},
            {"id": "sc-dx", "name": "戴奧辛", "controlConc": 1000, "monitorConc": 1000, "unit": "ng-TEQ/kg"},
        ],
    }],
}

# ----------------------------------------------------------------------------
# Layer 4 — 土壤污染調查（汞，垂向多深度，供 3D）
# 汞污染集中於貯水池上層底泥：水平 Gaussian 熱羽（核 9,950 mg/kg）× 垂向指數衰減，
# 使「超管制標準(20)面積」隨深度單調收斂、約 3.5m 以下回到乾淨原生土（面積→0），
# 同時每層皆有 紅核→橘→黃→綠 的水平梯度。場外圍魚塭點位呈現背景值。
# ----------------------------------------------------------------------------
DEPTHS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
# 系統性鑽探剖面：峰值取 240 mg/kg（仍為管制標準20的12倍，嚴重污染），與表層
# 「抓樣熱點」最高值 9,950（見土壤採樣點位層，為單點抓樣）為不同採樣方法/位置。
# 峰值取中等使「超標(≥20)區」在每層皆為場區內部封閉羽流、隨深度單調收斂，等濃度線/
# 體積計算才穩定（過高的點會讓 IDW 超標區漫到格網邊界、isobands 退化）。
SV_PEAK, SV_SIGMA, SV_BG, SV_DECAY = 90.0, 68.0, 3.0, 1.6
SV_C = (-470, 70)  # 熱點中心
# 內核(高)→中圈(過渡)→外圈(背景<20)，使每個深度層的超標區皆為「內部封閉島」、
# 隨深度單調收斂；外圈背景點＝周邊魚塭界定污染範圍（與實務一致）。
boreholes = [
    # 名稱, e, n, 高程(m)
    ("BH-01", -470, 70, 1.4), ("BH-02", -512, 38, 1.5), ("BH-03", -432, 112, 1.5),
    ("BH-04", -525, 108, 1.6), ("BH-05", -414, 32, 1.5),
    ("BH-06", -470, 225, 1.7), ("BH-07", -628, 70, 1.8), ("BH-08", -345, 148, 1.6),
    ("BH-09", -470, -88, 1.6),
    ("BH-10", -470, 360, 2.0), ("BH-11", -765, 70, 2.1), ("BH-12", -195, 165, 1.9),
    ("BH-13", -470, -215, 2.0),
]
sv_features = []
for (bid, e, n, elev) in boreholes:
    surf = SV_PEAK * g2(e, n, *SV_C, SV_SIGMA) + SV_BG
    prof = {}
    for d in DEPTHS:
        v = (surf - SV_BG) * math.exp(-d / SV_DECAY) + SV_BG
        prof["%g" % round(d, 3)] = round(v, 2)
    sv_features.append({
        "type": "Feature",
        "properties": {"名稱": bid, "高程": elev, "__soilSurvey": {"tab-sv": {"sv-hg": prof}}},
        "geometry": {"type": "Point", "coordinates": off(e, n)},
    })

# 障礙物：舊廠房混凝土基礎（0–1m），在貯水池內挖空
obstacle_geom = {"type": "Polygon", "coordinates": ring([(-455, 45), (-410, 45), (-410, 85), (-455, 85)])}

sv_layer = {
    "id": "anshun-soilsurvey",
    "name": "土壤污染調查（汞・垂向）",
    "visible": True, "opacity": 1, "color": "#a21caf",
    "kind": "point", "pointShape": "triangle", "pointRadius": 6,
    "strokeColor": "#ffffff", "strokeWidth": 1.5,
    "labelVisible": True, "labelColor": "#ffffff", "labelSize": 11,
    "data": {"type": "FeatureCollection", "features": sv_features},
    "featureCount": len(sv_features),
    "soilSurveyTabs": [{
        "id": "tab-sv",
        "label": "鑽探岩心（模擬）",
        "landUse": "general",
        "depthInterval": 0.5,
        "maxDepth": 4,
        "threshold": 20,
        "model": "idw",
        "fillGaps": True,
        "activeSubstance": "sv-hg",
        "activeDepth": 0,
        "substances": [
            {"id": "sv-hg", "name": "汞", "controlConc": 20, "monitorConc": 10, "unit": "mg/kg"},
        ],
        "obstacles": [{
            "id": "ob-1", "shape": "rectangle", "geometry": obstacle_geom,
            "depthTop": 0, "depthBottom": 1.0, "enabled": True, "label": "舊廠房基礎",
        }],
    }],
}

project = {
    "version": 1,
    "savedAt": "2026-06-22T00:00:00Z",
    "basemapId": "hybrid-google",
    "basemapOpacity": 1,
    "projectName": "台南安順場址污染示範（模擬）",
    "layers": [site_layer, gw_layer, sc_layer, sv_layer],
    "mapView": {"center": off(-150, 20), "zoom": 16},
    "colorCursor": 0,
}


def main():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    def call(path, data=None, method="GET"):
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(
            BASE + path, data=body,
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
            print("retry", attempt, exc)
            time.sleep(2)


if __name__ == "__main__":
    main()
