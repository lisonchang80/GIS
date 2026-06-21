"""
台南中石化(台鹼)安順整治場址 — Web GIS 示範專案產生器（模擬資料）。

v3：依臺南市環保局公告之**真實地籍**重建（來源：臺南市環保局土壤及地下水污染整治
場址頁 m=20120524154554）。場址範圍、海水貯水池、東側已解除管制區皆採**安南區鹽田段
真實地號**（經 twland 地籍 API 取得，等同 App「輸入地號新增多邊形」）：
  廠區整治場址：鹽田段 668、668-1~668-6、669
  海水貯水池(底泥熱點)：鹽田段 659、661-667、640-643、646、638-638-2、634-637
  2等9號道路東側(已解除管制)：鹽田段 544-2、541-2、543、545、550-552
場址中心 ~120.1223E, 23.0303N（安南區鹿耳里北汕尾二路；西側為台江內海，地下水向海流）。

污染物與標準依公開事實與台灣土壤/地下水污染管制標準：
  汞 土壤20/10 mg/kg・地下水0.02/0.01 mg/L；五氯酚 土壤200/200・地下水0.08/0.04；
  戴奧辛 土壤1000/1000 ng-TEQ/kg。濃度為模擬值，垂向鑽探峰值取中等(90)使等濃度線穩定，
  表層抓樣保留已公開最高值(汞9,950、戴奧辛64,100,000)。
"""
import json, math, urllib.parse, urllib.request, http.cookiejar, time

BASE = "http://127.0.0.1:8011"
LON0, LAT0 = 120.1223, 23.0303          # 真實場址中心（鹽田段廠區）
M_PER_DEG_LON = 102474.0                 # 111320*cos(23.03°)
M_PER_DEG_LAT = 110570.0
TWLAND = "https://twland.ronny.tw/index/search"
SECTION = "鹽田段"


def off(e, n):
    return [round(LON0 + e / M_PER_DEG_LON, 6), round(LAT0 + n / M_PER_DEG_LAT, 6)]


def ring(pts):
    r = [off(e, n) for (e, n) in pts]
    r.append(r[0])
    return [r]


def g2(e, n, ce, cn, sigma):
    return math.exp(-((e - ce) ** 2 + (n - cn) ** 2) / (2 * sigma * sigma))


# ---------------------------------------------------------------- 地號 → 多邊形
def fetch_parcels(parcels):
    """parcels: list of 地號字串；回傳該段的 polygon Feature 陣列（真實地籍幾何）。"""
    feats = []
    for p in parcels:
        url = TWLAND + "?lands[]=" + urllib.parse.quote(f"臺南市,{SECTION},{p}")
        for attempt in range(3):
            try:
                d = json.load(urllib.request.urlopen(
                    urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=20))
                break
            except Exception:
                time.sleep(1)
        else:
            print("  parcel fail", p); continue
        for f in d.get("features", []):
            if not f.get("geometry"):
                continue
            feats.append({
                "type": "Feature",
                "properties": {"名稱": f"{SECTION} {p}", "地號": str(p)},
                "geometry": f["geometry"],
            })
    return feats


FACTORY_PARCELS = ["668", "668-1", "668-2", "668-3", "668-4", "668-5", "668-6", "669"]
POND_PARCELS = ["659", "661", "662", "663", "664", "665", "666", "667",
                "640", "641", "642", "643", "646", "638", "638-1", "638-2",
                "634", "635", "636", "637"]
EAST_PARCELS = ["544-2", "541-2", "543", "545", "550", "551", "552"]

factory_parcels = fetch_parcels(FACTORY_PARCELS)
pond_parcels = fetch_parcels(POND_PARCELS)
east_parcels = fetch_parcels(EAST_PARCELS)
print("parcels:", len(factory_parcels), len(pond_parcels), len(east_parcels))

site_layer = {
    "id": "anshun-site",
    "name": "整治場址範圍（廠區・鹽田段地號）",
    "visible": True, "opacity": 0.22,
    "color": "#f59e0b", "strokeColor": "#f59e0b", "strokeWidth": 2,
    "kind": "polygon", "labelVisible": False,
    "data": {"type": "FeatureCollection", "features": factory_parcels},
    "featureCount": len(factory_parcels),
}

pond_layer = {
    "id": "anshun-pond",
    "name": "海水貯水池（底泥熱點・鹽田段地號）",
    "visible": True, "opacity": 0.35,
    "color": "#ef4444", "strokeColor": "#ef4444", "strokeWidth": 2,
    "kind": "polygon", "labelVisible": False,
    "data": {"type": "FeatureCollection", "features": pond_parcels},
    "featureCount": len(pond_parcels),
}

east_layer = {
    "id": "anshun-east",
    "name": "2等9號道路東側（已解除管制・鹽田段地號）",
    "visible": False, "opacity": 0.25,
    "color": "#22c55e", "strokeColor": "#16a34a", "strokeWidth": 2,
    "kind": "polygon", "labelVisible": False,
    "data": {"type": "FeatureCollection", "features": east_parcels},
    "featureCount": len(east_parcels),
}

# 場址內局部錨點（相對新原點的公尺位移）
POND = (-115, 275)          # 海水貯水池底泥熱點（北側）
FACTORY = (-30, 33)         # 廠區 668（鹼氯廠，垂向汞）
PCP_SRC = (-100, -150)      # 五氯酚廠（南側，近 669）

# ---------------------------------------------------------------- 地下水監測井（濃度 + 水位）
GW_DATES = ["2013-09-15", "2018-12-10", "2024-11-20"]
HG_C = (-90, 180)           # 汞地下水羽流（池/廠區間）
PCP_C = PCP_SRC             # 五氯酚地下水羽流（南側廠區）
HG_PEAK = {"2013-09-15": 0.155, "2018-12-10": 0.068, "2024-11-20": 0.034}
PCP_PEAK = {"2013-09-15": 0.330, "2018-12-10": 0.140, "2024-11-20": 0.058}
HG_BG, PCP_BG = 0.0015, 0.004
HYDRO_DATE = "2024-11-20"

wells = [
    ("MW-01", -115, 275), ("MW-02", -50, 230), ("MW-03", -185, 240),
    ("MW-04", -30, 33), ("MW-05", 70, 60), ("MW-06", -100, -150),
    ("MW-07", 45, -80), ("MW-08", 185, 95), ("MW-09", 255, 0),
    ("MW-10", -225, 65), ("MW-11", -30, -255), ("MW-12", 120, 205),
]
WATER_DEPTH = 1.3   # 量測地下水位埋深(m)，~定值
gw_features = []
for (wid, e, n) in wells:
    hg = {d: round(HG_BG + HG_PEAK[d] * g2(e, n, *HG_C, 150), 4) for d in GW_DATES}
    pcp = {d: round(PCP_BG + PCP_PEAK[d] * g2(e, n, *PCP_C, 130), 4) for d in GW_DATES}
    # 西側為台江內海 → 地下水位東(內陸)高、西(海)低，略偏南；水流向西南入海。
    # 等水位線層以「高程 − __hydro(埋深)」為水位高程，故 高程 = 目標水位 + 埋深。
    head_elev = round(1.30 + 0.0018 * e + 0.0006 * n, 3)
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
# SD = 海水貯水池底泥(北側熱點，保留已公開最高值)；SS = 廠區表土(南/中)
soil_pts = [
    ("貯水池底泥 0–0.5m", "SD-01", -115, 275, 9950, 64100000),
    ("貯水池底泥 0–0.5m", "SD-02", -70, 255, 3200, 8500000),
    ("貯水池底泥 0–0.5m", "SD-03", -150, 300, 780, 1200000),
    ("貯水池底泥 0–0.5m", "SD-04", -55, 235, 145, 42000),
    ("貯水池底泥 0–0.5m", "SD-05", -185, 255, 56, 5400),
    ("貯水池底泥 0–0.5m", "SD-06", -110, 325, 22, 1500),
    ("廠區表土 0–0.3m", "SS-01", -30, 33, 38, 9200),
    ("廠區表土 0–0.3m", "SS-02", 70, 60, 14, 620),
    ("廠區表土 0–0.3m", "SS-03", 150, -20, 8, 180),
    ("廠區表土 0–0.3m", "SS-04", 45, 120, 6.5, 95),
    ("廠區表土 0–0.3m", "SS-05", -100, -150, 25, 2100),
    ("廠區表土 0–0.3m", "SS-06", 120, 70, 11, 430),
    ("廠區表土 0–0.3m", "SS-07", 180, -120, 4.2, 60),
    ("廠區表土 0–0.3m", "SS-08", -30, -255, 9, 210),
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
# 廠區 668 鑽探岩心；內部封閉羽流佈局（核心熱、周界背景<閾值）使逐層超標面積單調收斂。
DEPTHS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
SV_PEAK, SV_SIGMA, SV_BG, SV_DECAY = 90.0, 68.0, 3.0, 1.6
SV_C = FACTORY                      # 垂向汞中心 = 廠區 668
boreholes = [  # (id, e, n, 高程) — 相對 FACTORY 的核心/中環/周界背景
    ("BH-01", -30, 73, 1.4), ("BH-02", -72, 41, 1.5), ("BH-03", 8, 115, 1.5),
    ("BH-04", -85, 111, 1.6), ("BH-05", 26, 35, 1.5),
    ("BH-06", -30, 228, 1.7), ("BH-07", -188, 73, 1.8), ("BH-08", 95, 151, 1.6),
    ("BH-09", -30, -85, 1.6),
    ("BH-10", -30, 363, 2.0), ("BH-11", -325, 73, 2.1), ("BH-12", 245, 168, 1.9),
    ("BH-13", -30, -212, 2.0),
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

obstacle_geom = {"type": "Polygon", "coordinates": ring([(-15, 48), (30, 48), (30, 88), (-15, 88)])}
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
    "layers": [site_layer, pond_layer, east_layer, gw_layer, sc_layer, sv_layer],
    "mapView": {"center": off(0, -20), "zoom": 16.3},
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
