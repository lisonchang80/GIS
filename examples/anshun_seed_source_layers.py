"""
台南中石化(台鹼)安順整治場址 — Web GIS 示範專案產生器（模擬資料）。

v2：重新定位到真實場址（安南區顯宮段，~120.1345E,23.0482N），場址範圍改用
**真實地號**（顯宮段 270–300，經 twland 地籍 API 取得，等同 App「輸入地號新增多邊形」），
資料採緊湊佈局置於地號街廓上；新增「地下水位（等水位線/流向）」。

污染物與標準依公開事實與台灣土壤/地下水污染管制標準：
  汞 土壤20/10 mg/kg・地下水0.02/0.01 mg/L；五氯酚 土壤200/200・地下水0.08/0.04；
  戴奧辛 土壤1000/1000 ng-TEQ/kg。濃度為模擬值，垂向鑽探峰值取中等(90)使等濃度線穩定，
  表層抓樣保留已公開最高值(汞9,950、戴奧辛64,100,000)。
"""
import json, math, urllib.parse, urllib.request, http.cookiejar, time

BASE = "http://127.0.0.1:8011"
LON0, LAT0 = 120.1345, 23.0482          # 真實場址中心（顯宮段街廓）
M_PER_DEG_LON = 102470.0
M_PER_DEG_LAT = 110570.0
TWLAND = "https://twland.ronny.tw/index/search"


def off(e, n):
    return [round(LON0 + e / M_PER_DEG_LON, 6), round(LAT0 + n / M_PER_DEG_LAT, 6)]


def ring(pts):
    r = [off(e, n) for (e, n) in pts]
    r.append(r[0])
    return [r]


def g2(e, n, ce, cn, sigma):
    return math.exp(-((e - ce) ** 2 + (n - cn) ** 2) / (2 * sigma * sigma))


# ---------------------------------------------------------------- 地號 → 場址範圍
def fetch_parcels(first, last):
    feats = []
    for p in range(first, last + 1):
        url = TWLAND + "?lands[]=" + urllib.parse.quote(f"臺南市,顯宮段,{p}")
        try:
            d = json.load(urllib.request.urlopen(url, timeout=15))
        except Exception:
            continue
        for f in d.get("features", []):
            if not f.get("geometry"):
                continue
            feats.append({
                "type": "Feature",
                "properties": {"名稱": f"顯宮段 {p}", "地號": str(p)},
                "geometry": f["geometry"],
            })
    return feats


parcel_features = fetch_parcels(270, 300)
print("parcels fetched:", len(parcel_features))

site_layer = {
    "id": "anshun-site",
    "name": "整治場址範圍（顯宮段地號）",
    "visible": True, "opacity": 0.25,
    "color": "#f59e0b", "strokeColor": "#f59e0b", "strokeWidth": 2,
    "kind": "polygon",
    "labelVisible": False,
    "data": {"type": "FeatureCollection", "features": parcel_features},
    "featureCount": len(parcel_features),
}

# ---------------------------------------------------------------- 海水貯水池
pond_layer = {
    "id": "anshun-pond",
    "name": "海水貯水池（底泥熱點）",
    "visible": True, "opacity": 0.35,
    "color": "#ef4444", "strokeColor": "#ef4444", "strokeWidth": 2,
    "kind": "polygon",
    "labelVisible": True, "labelColor": "#ffffff", "labelSize": 12,
    "data": {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"名稱": "貯水池 A 區"},
         "geometry": {"type": "Polygon", "coordinates": ring([(-120, 40), (120, 40), (120, 160), (-120, 160)])}},
        {"type": "Feature", "properties": {"名稱": "貯水池 B 區"},
         "geometry": {"type": "Polygon", "coordinates": ring([(-120, -120), (120, -120), (120, 30), (-120, 30)])}},
    ]},
    "featureCount": 2,
}

# ---------------------------------------------------------------- 地下水監測井（濃度 + 水位）
GW_DATES = ["2013-09-15", "2018-12-10", "2024-11-20"]
HG_C, PCP_C = (0, 40), (130, -40)
HG_PEAK = {"2013-09-15": 0.155, "2018-12-10": 0.068, "2024-11-20": 0.034}
PCP_PEAK = {"2013-09-15": 0.330, "2018-12-10": 0.140, "2024-11-20": 0.058}
HG_BG, PCP_BG = 0.0015, 0.004
HYDRO_DATE = "2024-11-20"

wells = [
    ("MW-01", 0, 60), ("MW-02", -60, -40), ("MW-03", 110, 30),
    ("MW-04", 180, 120), ("MW-05", 130, -40), ("MW-06", 220, -130),
    ("MW-07", -40, 210), ("MW-08", -180, 180), ("MW-09", -260, 90),
    ("MW-10", 240, 200), ("MW-11", 200, -220), ("MW-12", -280, -120),
]
WATER_DEPTH = 1.3   # 量測地下水位埋深(m)，~定值
gw_features = []
for (wid, e, n) in wells:
    hg = {d: round(HG_BG + HG_PEAK[d] * g2(e, n, *HG_C, 130), 4) for d in GW_DATES}
    pcp = {d: round(PCP_BG + PCP_PEAK[d] * g2(e, n, *PCP_C, 110), 4) for d in GW_DATES}
    # 目標地下水位高程：西北(海)低、東南(內陸)高 → 流向西北。
    # 等水位線層以「高程 − __hydro(埋深)」為水位高程，故設 高程 = 目標水位 + 埋深。
    head_elev = 1.40 - 0.0016 * (n - e)
    ground = round(head_elev + WATER_DEPTH, 2)
    gw_features.append({
        "type": "Feature",
        "properties": {"名稱": wid, "高程": ground,
                       "__gwConc": {"tab-gw": {"gw-hg": hg, "gw-pcp": pcp}},
                       "__hydro": {HYDRO_DATE: WATER_DEPTH}},
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
    "hydroDates": [HYDRO_DATE],
    "gwConcTabs": [{
        "id": "tab-gw", "label": "台南市環保局 / SGS（模擬）", "dates": GW_DATES,
        "substances": [
            {"id": "gw-hg", "name": "汞", "controlConc": 0.02, "monitorConc": 0.01, "unit": "mg/L"},
            {"id": "gw-pcp", "name": "五氯酚", "controlConc": 0.08, "monitorConc": 0.04, "unit": "mg/L"},
        ],
    }],
}

# ---------------------------------------------------------------- 土壤採樣點位（超標圖）
soil_pts = [
    ("貯水池底泥 0–0.5m", "SD-01", 0, 60, 9950, 64100000),
    ("貯水池底泥 0–0.5m", "SD-02", -60, -30, 3200, 8500000),
    ("貯水池底泥 0–0.5m", "SD-03", 60, 20, 780, 1200000),
    ("貯水池底泥 0–0.5m", "SD-04", -100, 120, 145, 42000),
    ("貯水池底泥 0–0.5m", "SD-05", 40, -90, 56, 5400),
    ("貯水池底泥 0–0.5m", "SD-06", -30, 150, 22, 1500),
    ("廠區表土 0–0.3m", "SS-01", 130, -40, 38, 9200),
    ("廠區表土 0–0.3m", "SS-02", 180, 90, 14, 620),
    ("廠區表土 0–0.3m", "SS-03", 230, -110, 8, 180),
    ("廠區表土 0–0.3m", "SS-04", 250, 160, 6.5, 95),
    ("廠區表土 0–0.3m", "SS-05", -120, -150, 25, 2100),
    ("廠區表土 0–0.3m", "SS-06", 190, 40, 11, 430),
    ("廠區表土 0–0.3m", "SS-07", -170, -90, 4.2, 60),
    ("廠區表土 0–0.3m", "SS-08", 260, -30, 9, 210),
]
sc_features = [{
    "type": "Feature",
    "properties": {"名稱": sid, "批次名稱": batch, "__soilConc": {"tab-sc": {"sc-hg": hg, "sc-dx": dx}}},
    "geometry": {"type": "Point", "coordinates": off(e, n)},
} for (batch, sid, e, n, hg, dx) in soil_pts]

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
        "id": "tab-sc", "label": "SGS 台灣檢驗（模擬）", "landUse": "general",
        "substances": [
            {"id": "sc-hg", "name": "汞", "controlConc": 20, "monitorConc": 10, "unit": "mg/kg"},
            {"id": "sc-dx", "name": "戴奧辛", "controlConc": 1000, "monitorConc": 1000, "unit": "ng-TEQ/kg"},
        ],
    }],
}

# ---------------------------------------------------------------- 土壤污染調查（汞・垂向 → 3D）
DEPTHS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
SV_PEAK, SV_SIGMA, SV_BG, SV_DECAY = 90.0, 68.0, 3.0, 1.6
SV_C = (0, 40)
boreholes = [
    ("BH-01", 0, 40, 1.4), ("BH-02", -42, 8, 1.5), ("BH-03", 38, 82, 1.5),
    ("BH-04", -55, 78, 1.6), ("BH-05", 56, 2, 1.5),
    ("BH-06", 0, 195, 1.7), ("BH-07", -158, 40, 1.8), ("BH-08", 125, 118, 1.6),
    ("BH-09", 0, -118, 1.6),
    ("BH-10", 0, 330, 2.0), ("BH-11", -295, 40, 2.1), ("BH-12", 275, 135, 1.9),
    ("BH-13", 0, -245, 2.0),
]
sv_features = []
for (bid, e, n, elev) in boreholes:
    surf = SV_PEAK * g2(e, n, *SV_C, SV_SIGMA) + SV_BG
    prof = {("%g" % round(d, 3)): round((surf - SV_BG) * math.exp(-d / SV_DECAY) + SV_BG, 2) for d in DEPTHS}
    sv_features.append({
        "type": "Feature",
        "properties": {"名稱": bid, "高程": elev, "__soilSurvey": {"tab-sv": {"sv-hg": prof}}},
        "geometry": {"type": "Point", "coordinates": off(e, n)},
    })

obstacle_geom = {"type": "Polygon", "coordinates": ring([(15, 55), (60, 55), (60, 95), (15, 95)])}
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
        "id": "tab-sv", "label": "鑽探岩心（模擬）", "landUse": "general",
        "depthInterval": 0.5, "maxDepth": 4, "threshold": 20, "model": "idw",
        "fillGaps": True, "activeSubstance": "sv-hg", "activeDepth": 0,
        "substances": [{"id": "sv-hg", "name": "汞", "controlConc": 20, "monitorConc": 10, "unit": "mg/kg"}],
        "obstacles": [{"id": "ob-1", "shape": "rectangle", "geometry": obstacle_geom,
                       "depthTop": 0, "depthBottom": 1.0, "enabled": True, "label": "舊廠房基礎"}],
    }],
}

project = {
    "version": 1, "savedAt": "2026-06-22T00:00:00Z",
    "basemapId": "hybrid-google", "basemapOpacity": 1,
    "projectName": "台南安順場址污染示範（模擬）",
    "layers": [site_layer, pond_layer, gw_layer, sc_layer, sv_layer],
    "mapView": {"center": off(20, 30), "zoom": 17},
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
