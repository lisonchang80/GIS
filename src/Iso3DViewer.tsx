import { useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE_T from 'three'; // 型別用（編譯期抹除）；執行期 dynamic import
import type { SoilSurveyTab, VectorLayer } from './types';
import { buildDepthKeys, buildSurveyVolume, depthRangeLabel, type SurveyVolume } from './iso3d';

type Mode = 'slices' | 'isosurface';
type SliceLayout = 'stack' | 'separate' | 'flat';

// Three.js 用 canvas 貼圖做文字 sprite（不需字型檔）。
function makeLabel(
  THREE: typeof THREE_T,
  text: string,
  worldH: number,
  color = '#cbd5e1',
): THREE_T.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '44px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(worldH * 4, worldH, 1);
  return spr;
}

// ---- (A) Three.js 堆疊切片：各深度層分級色帶擠出疊放 + 障礙物灰柱 + 軸標 ----
// layout：stack=依真實深度連續堆疊；separate=拉開間距的分離（爆炸）視圖；flat=全部攤平在地面網格比較
async function renderThree(
  container: HTMLDivElement,
  vol: SurveyVolume,
  zExag: number,
  layout: SliceLayout,
  showPoints: boolean,
): Promise<() => void> {
  const THREE = await import('three');
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
  container.innerHTML = '';
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 420;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f14);
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1e8);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dl = new THREE.DirectionalLight(0xffffff, 0.4);
  dl.position.set(1, 2, 1.5);
  scene.add(dl);

  const thickness = Math.max(vol.interval * zExag, 0.5);
  const span = Math.max(vol.horizSpanM, 10);
  const n = vol.slices.length;
  // layout 幾何參數
  const sepSpacing = thickness * 2.6;                 // 分離視圖每層間距
  const flatTk = Math.max(thickness * 0.5, 0.6);      // 攤平視圖薄片厚
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cell = span * 1.3;                            // 攤平視圖格距

  // 置中：所有色帶座標平均
  let cx = 0; let cy = 0; let np = 0;
  for (const s of vol.slices) for (const b of s.bands) for (const poly of b.polysM) for (const ring of poly) for (const [x, y] of ring) { cx += x; cy += y; np++; }
  if (np > 0) { cx /= np; cy /= np; }

  const geos: THREE_T.BufferGeometry[] = [];
  const mats: THREE_T.Material[] = [];
  const group = new THREE.Group();

  const makeShape = (poly: number[][][]) => {
    const outer = poly[0];
    const shape = new THREE.Shape();
    outer.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x - cx, y - cy) : shape.lineTo(x - cx, y - cy)));
    for (let hi = 1; hi < poly.length; hi++) {
      const path = new THREE.Path();
      poly[hi].forEach(([x, y], i) => (i === 0 ? path.moveTo(x - cx, y - cy) : path.lineTo(x - cx, y - cy)));
      shape.holes.push(path);
    }
    return shape;
  };

  const labelH = span * 0.06;
  const off = span * 0.62;
  const addLabel = (t: string, x: number, y: number, z: number, c?: string, h = labelH) => {
    const spr = makeLabel(THREE, t, h, c);
    spr.position.set(x, y, z);
    scene.add(spr);
  };
  // 每層在各 layout 下的擺位（mesh 旋轉後 local z→world y(上)，local 平面落在 world XZ）
  const slabPose = (k: number): { tk: number; baseY: number; offX: number; offZ: number } => {
    const top = parseFloat(vol.slices[k].topKey);
    if (layout === 'flat') {
      const col = k % cols; const row = Math.floor(k / cols);
      return {
        tk: flatTk, baseY: 0,
        offX: (col - (cols - 1) / 2) * cell,
        offZ: (row - (rows - 1) / 2) * cell,
      };
    }
    if (layout === 'separate') {
      // 由淺到深往下拉開：第 k 層的底在 -(k+1)*sepSpacing
      return { tk: thickness, baseY: -(k + 1) * sepSpacing, offX: 0, offZ: 0 };
    }
    // stack：依真實深度，層底 = -(top+interval)，往上擠出 interval（與障礙物同座標系）
    return { tk: thickness, baseY: -(top + vol.interval) * zExag, offX: 0, offZ: 0 };
  };

  vol.slices.forEach((s, k) => {
    const pose = slabPose(k);
    for (const band of s.bands) {
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(band.color),
        transparent: true,
        opacity: s.estimated ? 0.32 : 0.62,
        side: THREE.DoubleSide,
      });
      mats.push(mat);
      for (const poly of band.polysM) {
        if (!poly[0] || poly[0].length < 3) continue;
        const geo = new THREE.ExtrudeGeometry(makeShape(poly), { depth: pose.tk, bevelEnabled: false });
        geos.push(geo);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(pose.offX, pose.baseY, pose.offZ);
        group.add(mesh);
      }
    }
    // 分離 / 攤平：每片只標深度區間（體積改列於右下角表格，圖面不放數字）
    if (layout === 'separate') {
      addLabel(depthRangeLabel(s.topKey, vol.interval), off, pose.baseY + pose.tk / 2, 0, '#cbd5e1');
    } else if (layout === 'flat') {
      addLabel(depthRangeLabel(s.topKey, vol.interval), pose.offX, flatTk + 1, pose.offZ, '#e2e8f0', labelH * 1.7);
    }
  });

  // 障礙物：在每個「深度區間與障礙物重疊」的切片上畫灰盒 + 白色邊框（堆疊→連成柱、
  // 分離/攤平→各層各一盒），所有佈局都顯示。盒子與切片同 pose，故與該層挖空處對齊。
  for (const ob of vol.obstacles) {
    const outer = ob.ringsM[0];
    if (!outer || outer.length < 3) continue;
    const shape = new THREE.Shape();
    outer.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x - cx, y - cy) : shape.lineTo(x - cx, y - cy)));
    let labelled = false;
    vol.slices.forEach((s, k) => {
      const top = parseFloat(s.topKey);
      const bot = top + vol.interval;
      if (!(top < ob.depthBottom - 1e-9 && bot > ob.depthTop + 1e-9)) return; // 此層與障礙物不重疊
      const pose = slabPose(k);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: pose.tk, bevelEnabled: false });
      geos.push(geo);
      const mat = new THREE.MeshLambertMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
      mats.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(pose.offX, pose.baseY, pose.offZ);
      group.add(mesh);
      // 白色邊框讓障礙物清楚可辨
      const eg = new THREE.EdgesGeometry(geo);
      geos.push(eg);
      const emat = new THREE.LineBasicMaterial({ color: 0xe5e7eb, transparent: true, opacity: 0.8 });
      mats.push(emat);
      const edges = new THREE.LineSegments(eg, emat);
      edges.rotation.x = -Math.PI / 2;
      edges.position.set(pose.offX, pose.baseY, pose.offZ);
      group.add(edges);
      if (!labelled) {
        labelled = true;
        let mx = 0; let my = 0;
        outer.forEach(([x, y]) => { mx += x - cx; my += y - cy; });
        mx /= outer.length; my /= outer.length;
        addLabel(ob.label || '障礙物', pose.offX + mx, pose.baseY + pose.tk + labelH * 0.6, pose.offZ + my, '#cbd5e1', labelH * 0.7);
      }
    });
  }

  // 採樣點位標記：自地表沿深度直線貫穿每一層（堆疊＝真實深度；分離＝串起拉開的各層）。
  if (showPoints && vol.points.length && (layout === 'stack' || layout === 'separate')) {
    const n2 = vol.slices.length;
    const markH = span * 0.05;
    const topY = layout === 'stack' ? thickness * 0.4 : slabPose(0).baseY + thickness;
    const botY = layout === 'stack' ? -vol.maxDepthM * zExag : slabPose(Math.max(0, n2 - 1)).baseY;
    for (const pt of vol.points) {
      const px = pt.x - cx;
      const pz = pt.y - cy;
      const lgeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(px, topY, pz),
        new THREE.Vector3(px, botY, pz),
      ]);
      geos.push(lgeo);
      const lmat = new THREE.LineBasicMaterial({ color: 0xf1f5f9, transparent: true, opacity: 0.85, depthTest: false });
      mats.push(lmat);
      group.add(new THREE.Line(lgeo, lmat));
      // 地表倒錐標記（永遠可見）
      const cone = new THREE.ConeGeometry(markH * 0.5, markH, 10);
      geos.push(cone);
      const cmat = new THREE.MeshBasicMaterial({ color: 0xf8fafc, depthTest: false });
      mats.push(cmat);
      const m = new THREE.Mesh(cone, cmat);
      m.position.set(px, topY + markH * 0.6, pz);
      m.rotation.x = Math.PI;                      // 尖端朝下指向地表
      group.add(m);
      if (pt.name) addLabel(pt.name, px, topY + markH * 2.0, pz, '#e2e8f0', labelH * 0.75);
    }
  }
  scene.add(group);

  const gridSpan = layout === 'flat' ? Math.max(cols, rows) * cell * 1.2 : span * 1.6;
  scene.add(new THREE.GridHelper(gridSpan, 16, 0x334155, 0x1f2937));

  // 軸標 / 刻度
  if (layout !== 'flat') {
    addLabel('東西 X (m)', off, 0, 0, '#93c5fd');
    addLabel('南北 Y (m)', 0, 0, off, '#86efac');
    addLabel(`寬約 ${Math.round(span)} m`, off, labelH * 1.2, 0, '#64748b');
  }
  if (layout === 'stack') {
    // Z 深度刻度（真實深度）
    const dStep = Math.max(1, Math.round(vol.maxDepthM / 5));
    for (let d = 0; d <= vol.maxDepthM + 1e-9; d += dStep) {
      addLabel(`${d} m`, -off, -d * zExag, -off, '#fca5a5');
    }
    addLabel('深度', -off, labelH * 1.5, -off, '#fca5a5');
  }

  // 相機 / 控制
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  if (layout === 'flat') {
    // 正放俯視、不加旋轉：正上方直視，北（world -Z）朝上，只能平移/縮放
    const target = new THREE.Vector3(0, 0, 0);
    const reach = Math.max(cols, rows) * cell;
    camera.up.set(0, 0, -1);
    camera.position.set(0, reach * 1.5, 0);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    controls.enableRotate = false;
  } else {
    const vBottom = layout === 'separate' ? n * sepSpacing : vol.maxDepthM * zExag;
    const targetY = -vBottom / 2;
    const target = new THREE.Vector3(0, targetY, 0);
    const dist = Math.max(span * 1.5, vBottom) + 50;
    camera.position.set(dist * 0.85, dist * 0.55 + Math.abs(targetY), dist * 0.85);
    camera.lookAt(target);
    controls.target.copy(target);
  }
  controls.update();

  let raf = 0;
  const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();
  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth || w; const nh = container.clientHeight || h;
    camera.aspect = nw / nh; camera.updateProjectionMatrix(); renderer.setSize(nw, nh);
  });
  ro.observe(container);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    renderer.dispose();
    if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
  };
}

// 由分級斷點建離散 colorscale（對齊 2D 等濃度線）。
function buildColorscale(threshold: number, vmax: number, M?: number, C?: number): [number, string][] {
  const cmin = threshold;
  const cmax = Math.max(vmax, threshold + 1e-6);
  const norm = (v: number) => Math.max(0, Math.min(1, (v - cmin) / (cmax - cmin)));
  if (!(typeof M === 'number' && typeof C === 'number' && M > 0 && C > M)) {
    return [[0, '#ef4444'], [1, '#ef4444']];
  }
  const segs = [
    { to: M / 2, color: '#22c55e' },
    { to: M, color: '#eab308' },
    { to: C, color: '#f97316' },
    { to: cmax, color: '#ef4444' },
  ];
  const stops: [number, string][] = [];
  let prev = 0;
  for (const seg of segs) {
    const t = norm(seg.to);
    if (t <= prev + 1e-6) continue;
    stops.push([prev, seg.color]);
    stops.push([t, seg.color]);
    prev = t;
  }
  if (stops.length === 0) return [[0, '#ef4444'], [1, '#ef4444']];
  if (stops[stops.length - 1][0] < 1) {
    stops.push([prev, '#ef4444']);
    stops.push([1, '#ef4444']);
  }
  if (stops[0][0] > 0) stops.unshift([0, stops[0][1]]);
  return stops;
}

// ---- (B) Plotly 平滑曲面（isosurface：分級等濃度面 + 障礙物挖空 + 真實公尺軸）----
async function renderPlotly(
  container: HTMLDivElement,
  vol: SurveyVolume,
  threshold: number,
  M?: number,
  C?: number,
): Promise<() => void> {
  const mod = await import('plotly.js-dist-min');
  const Plotly = ((mod as unknown as { default?: unknown }).default ?? mod) as {
    newPlot: (el: HTMLElement, data: unknown[], layout: unknown, config: unknown) => Promise<unknown>;
    purge: (el: HTMLElement) => void;
  };
  container.innerHTML = ''; // 清掉前一個渲染器（如 Three.js canvas）殘留
  const field = vol.field;
  if (!field) return () => {};
  const { xM, yM, depths, values } = field;
  const N = xM.length;
  const lo = threshold - Math.max(1, vol.valueMax - threshold); // 障礙物/缺值體素 → 低於閾值（透明、挖空）
  const X: number[] = []; const Y: number[] = []; const Z: number[] = []; const V: number[] = [];
  for (let k = 0; k < depths.length; k++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = values[k * N * N + j * N + i];
        X.push(xM[i]); Y.push(yM[j]); Z.push(-depths[k]); V.push(Number.isFinite(v) ? v : lo); // Z 用真實公尺
      }
    }
  }
  const cmax = Math.max(threshold + 1e-6, vol.valueMax);
  // 用 isosurface 畫分級等濃度面（清晰的曲面，非 volume 霧化）：外綠半透→內紅核可見。
  // 起算改從「½ 監測」帶，避免整域被閾值=0 的外殼包成一大塊；showscale 關閉以免與 HTML 分級圖例重複。
  const isoStart = typeof M === 'number' && M > 0 ? Math.max(threshold, M / 2) : threshold;
  const trace = {
    type: 'isosurface',
    x: X, y: Y, z: Z, value: V,
    isomin: isoStart,
    isomax: cmax,
    cmin: threshold,
    cmax,
    surface: { count: 5, fill: 1 },
    opacity: 0.5,
    colorscale: buildColorscale(threshold, vol.valueMax, M, C),
    showscale: false,
    caps: { x: { show: false }, y: { show: false }, z: { show: false } },
  };
  // Z 軸真實深度刻度（公尺）
  const dStep = Math.max(1, Math.round(vol.maxDepthM / 5));
  const tickvals: number[] = []; const ticktext: string[] = [];
  for (let d = 0; d <= vol.maxDepthM + 1e-9; d += dStep) { tickvals.push(-d); ticktext.push(`${d} m`); }
  // X/Y/Z 全用真實公尺；深度以 aspectratio 視覺誇張（單位一致，不假造資料值）
  const spanX = (Math.max(...xM) - Math.min(...xM)) || 1;
  const spanY = (Math.max(...yM) - Math.min(...yM)) || 1;
  const maxH = Math.max(spanX, spanY);
  const axis = { backgroundcolor: '#0b0f14', gridcolor: '#1f2937', color: '#94a3b8' };
  const layout = {
    paper_bgcolor: '#0b0f14',
    font: { color: '#cbd5e1', size: 11 },
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      aspectmode: 'manual',
      aspectratio: { x: spanX / maxH, y: spanY / maxH, z: 0.7 },
      // Plotly 3.x：軸標題須用 { text }（字串簡寫不再生效，會退回預設 x/y/z 無單位）。
      // 三軸統一公尺：X/Y 刻度加 ' m' 後綴，Z 刻度文字直接帶 m。
      xaxis: { ...axis, title: { text: '東西 X (m)' }, ticksuffix: ' m' },
      yaxis: { ...axis, title: { text: '南北 Y (m)' }, ticksuffix: ' m' },
      zaxis: { ...axis, title: { text: '深度 (m)' }, tickvals, ticktext },
    },
  };
  await Plotly.newPlot(container, [trace], layout, { responsive: true, displaylogo: false });
  return () => { try { Plotly.purge(container); } catch { /* noop */ } };
}

export function Iso3DViewer({
  layer, tab, subId, onClose,
}: {
  layer: VectorLayer;
  tab: SoilSurveyTab;
  subId: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('slices');
  const [layout, setLayout] = useState<SliceLayout>('stack');
  const [showPoints, setShowPoints] = useState(true);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const sub = tab.substances.find((s) => s.id === subId);
  const interval = typeof tab.depthInterval === 'number' && tab.depthInterval > 0 ? tab.depthInterval : 0.5;
  const maxDepth = typeof tab.maxDepth === 'number' && tab.maxDepth >= 0 ? tab.maxDepth : 4;
  const threshold = typeof tab.threshold === 'number' ? tab.threshold : 0;

  const vol = useMemo(() => {
    if (!sub) return null;
    return buildSurveyVolume({
      layer, tabId: tab.id, subId, depthKeys: buildDepthKeys(interval, maxDepth),
      interval, threshold, monitorConc: sub.monitorConc, controlConc: sub.controlConc,
      substanceName: sub.name, unit: sub.unit ?? '', model: tab.model,
      obstacles: tab.obstacles, fillGaps: tab.fillGaps,
    });
  }, [layer, tab.id, tab.obstacles, tab.fillGaps, tab.model, subId, sub, interval, maxDepth, threshold]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!vol || !vol.hasData) { container.innerHTML = ''; setLoading(false); return; }
    let disposed = false;
    let cleanup: () => void = () => {};
    setLoading(true);
    setErr(null);
    const zExag = Math.max((vol.horizSpanM / (vol.maxDepthM || 1)) * 0.5, 1);
    (async () => {
      try {
        cleanup = mode === 'slices'
          ? await renderThree(container, vol, zExag, layout, showPoints)
          : await renderPlotly(container, vol, threshold, sub?.monitorConc, sub?.controlConc);
      } catch (e) {
        if (!disposed) setErr((e as Error).message || String(e));
      }
      if (!disposed) setLoading(false);
    })();
    return () => { disposed = true; try { cleanup(); } catch { /* noop */ } };
  }, [mode, layout, showPoints, vol, threshold, sub]);

  const activeVolume = mode === 'slices' ? vol?.volumeStack : vol?.volumeSmooth;
  const hasEstimated = !!vol?.slices.some((s) => s.estimated);

  return (
    <div className="iso3d-overlay" onClick={onClose}>
      <div className="iso3d-modal" onClick={(e) => e.stopPropagation()}>
        <div className="iso3d-header">
          <div className="iso3d-title">3D 等濃度體積 — {sub?.name ?? ''}</div>
          <div className="iso3d-modes">
            <button className={`btn xs${mode === 'slices' ? ' primary' : ''}`} onClick={() => setMode('slices')}>堆疊切片</button>
            <button className={`btn xs${mode === 'isosurface' ? ' primary' : ''}`} onClick={() => setMode('isosurface')}>平滑曲面</button>
          </div>
          {mode === 'slices' && (
            <div className="iso3d-modes iso3d-layouts">
              <button className={`btn xs${layout === 'stack' ? ' primary' : ''}`} onClick={() => setLayout('stack')} title="依真實深度連續堆疊">堆疊</button>
              <button className={`btn xs${layout === 'separate' ? ' primary' : ''}`} onClick={() => setLayout('separate')} title="拉開各層間距，逐層分離檢視">切片分離</button>
              <button className={`btn xs${layout === 'flat' ? ' primary' : ''}`} onClick={() => setLayout('flat')} title="各層攤平於地面，俯視並排比較">切片平放</button>
            </div>
          )}
          {mode === 'slices' && (
            <label className="iso3d-toggle" title="標示鑽探/採樣點位（堆疊與切片分離視圖）">
              <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />
              標示採樣點
            </label>
          )}
          <button className="iso3d-close" onClick={onClose} title="關閉">×</button>
        </div>
        <div className="iso3d-body">
          <div ref={containerRef} className="iso3d-canvas" />
          {loading && <div className="iso3d-hud iso3d-loading">載入 3D…</div>}
          {!loading && (!vol || !vol.hasData) && (
            <div className="iso3d-hud">尚無足夠資料（至少一層需 3 個有效濃度值）</div>
          )}
          {err && <div className="iso3d-hud iso3d-err">3D 載入失敗：{err}</div>}
          {vol?.hasData && (
            <>
              {vol.legend.length > 0 && (
                <div className="iso3d-legend">
                  {vol.legend.map((b) => (
                    <span key={b.color} className="iso3d-legend-row">
                      <span className="iso3d-legend-sw" style={{ background: b.color }} />
                      {b.label}
                    </span>
                  ))}
                </div>
              )}
              <div className="iso3d-stats">
                <span>閾值 {threshold === 0 ? '>' : '≥'} {threshold} {sub?.unit || ''}{hasEstimated ? '・含推估層*' : ''}</span>
                <span className="iso3d-vol">
                  {mode === 'slices' ? '堆疊體積' : '平滑體積'} ≈ {activeVolume && activeVolume > 0 ? `${Math.round(activeVolume).toLocaleString()} m³` : '—'}
                </span>
              </div>
              {mode === 'slices' && vol.slices.length > 0 && (
                <div className="iso3d-voltable">
                  <div className="iso3d-voltable-title">各深度污染體積 (m³)</div>
                  <table>
                    <tbody>
                      {vol.slices.map((s) => (
                        <tr key={s.topKey} className={s.estimated ? 'est' : undefined}>
                          <td>{depthRangeLabel(s.topKey, vol.interval)}{s.estimated ? '*' : ''}</td>
                          <td className="v">{s.area > 0 ? Math.round(s.area * vol.interval).toLocaleString() : '—'}</td>
                        </tr>
                      ))}
                      <tr className="total">
                        <td>合計</td>
                        <td className="v">{vol.volumeStack > 0 ? Math.round(vol.volumeStack).toLocaleString() : '—'}</td>
                      </tr>
                    </tbody>
                  </table>
                  {hasEstimated && <div className="iso3d-voltable-note">* 缺層垂向推估</div>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
