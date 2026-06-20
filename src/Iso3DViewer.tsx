import { useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE_T from 'three'; // 型別用（編譯期抹除）；執行期 dynamic import
import type { SoilSurveyTab, VectorLayer } from './types';
import { buildDepthKeys, buildSurveyVolume, type SurveyVolume } from './iso3d';

type Mode = 'slices' | 'isosurface';

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
async function renderThree(container: HTMLDivElement, vol: SurveyVolume, zExag: number): Promise<() => void> {
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
  // 置中：所有色帶座標平均
  let cx = 0; let cy = 0; let n = 0;
  for (const s of vol.slices) for (const b of s.bands) for (const poly of b.polysM) for (const ring of poly) for (const [x, y] of ring) { cx += x; cy += y; n++; }
  if (n > 0) { cx /= n; cy /= n; }

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

  for (const s of vol.slices) {
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
        const geo = new THREE.ExtrudeGeometry(makeShape(poly), { depth: thickness, bevelEnabled: false });
        geos.push(geo);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = -s.depth * zExag;
        group.add(mesh);
      }
    }
  }

  // 障礙物灰柱（depthTop~depthBottom）
  for (const ob of vol.obstacles) {
    const outer = ob.ringsM[0];
    if (!outer || outer.length < 3) continue;
    const shape = new THREE.Shape();
    outer.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x - cx, y - cy) : shape.lineTo(x - cx, y - cy)));
    const tk = Math.max((ob.depthBottom - ob.depthTop) * zExag, 0.5);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: tk, bevelEnabled: false });
    geos.push(geo);
    const mat = new THREE.MeshLambertMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.28, side: THREE.DoubleSide });
    mats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -ob.depthTop * zExag;
    group.add(mesh);
  }
  scene.add(group);

  const span = Math.max(vol.horizSpanM, 10);
  scene.add(new THREE.GridHelper(span * 1.6, 16, 0x334155, 0x1f2937));

  // 軸標 + 刻度（X/Y 距離 m、Z 真實深度 m）
  const labelH = span * 0.06;
  const off = span * 0.62;
  const addLabel = (t: string, x: number, y: number, z: number, c?: string) => {
    const spr = makeLabel(THREE, t, labelH, c);
    spr.position.set(x, y, z);
    scene.add(spr);
  };
  addLabel('東西 X (m)', off, 0, 0, '#93c5fd');
  addLabel('南北 Y (m)', 0, 0, off, '#86efac');
  addLabel(`寬約 ${Math.round(span)} m`, off, labelH * 1.2, 0, '#64748b');
  // Z 深度刻度（真實深度）
  const dStep = Math.max(1, Math.round(vol.maxDepthM / 5));
  for (let d = 0; d <= vol.maxDepthM + 1e-9; d += dStep) {
    addLabel(`${d} m`, -off, -d * zExag, -off, '#fca5a5');
  }
  addLabel('深度', -off, labelH * 1.5, -off, '#fca5a5');

  const targetY = -(vol.maxDepthM * zExag) / 2;
  const target = new THREE.Vector3(0, targetY, 0);
  const dist = span * 1.5 + 50;
  camera.position.set(dist * 0.85, dist * 0.7 + Math.abs(targetY), dist * 0.85);
  camera.lookAt(target);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
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

// ---- (B) Plotly isosurface ----
async function renderPlotly(
  container: HTMLDivElement,
  vol: SurveyVolume,
  zExag: number,
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
  const lo = threshold - Math.max(1, vol.valueMax - threshold);
  const X: number[] = []; const Y: number[] = []; const Z: number[] = []; const V: number[] = [];
  for (let k = 0; k < depths.length; k++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = values[k * N * N + j * N + i];
        X.push(xM[i]); Y.push(yM[j]); Z.push(-depths[k] * zExag); V.push(Number.isFinite(v) ? v : lo);
      }
    }
  }
  const trace = {
    type: 'isosurface',
    x: X, y: Y, z: Z, value: V,
    isomin: threshold,
    isomax: Math.max(threshold + 1e-6, vol.valueMax),
    cmin: threshold,
    cmax: Math.max(threshold + 1e-6, vol.valueMax),
    surface: { count: 4, fill: 1 },
    opacity: 0.6,
    colorscale: buildColorscale(threshold, vol.valueMax, M, C),
    caps: { x: { show: false }, y: { show: false }, z: { show: false } },
    colorbar: { title: vol.unit || 'mg/kg', thickness: 10, len: 0.6 },
  };
  // Z 軸標真實深度（在誇張位置標真實值）
  const dStep = Math.max(1, Math.round(vol.maxDepthM / 5));
  const tickvals: number[] = []; const ticktext: string[] = [];
  for (let d = 0; d <= vol.maxDepthM + 1e-9; d += dStep) { tickvals.push(-d * zExag); ticktext.push(`${d}`); }
  const axis = { backgroundcolor: '#0b0f14', gridcolor: '#1f2937', color: '#94a3b8' };
  const layout = {
    paper_bgcolor: '#0b0f14',
    font: { color: '#cbd5e1', size: 11 },
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      aspectmode: 'data',
      xaxis: { ...axis, title: '東西 X (m)' },
      yaxis: { ...axis, title: '南北 Y (m)' },
      zaxis: { ...axis, title: '深度 (m)', tickvals, ticktext },
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
      substanceName: sub.name, unit: sub.unit ?? '', obstacles: tab.obstacles, fillGaps: tab.fillGaps,
    });
  }, [layer, tab.id, tab.obstacles, tab.fillGaps, subId, sub, interval, maxDepth, threshold]);

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
          ? await renderThree(container, vol, zExag)
          : await renderPlotly(container, vol, zExag, threshold, sub?.monitorConc, sub?.controlConc);
      } catch (e) {
        if (!disposed) setErr((e as Error).message || String(e));
      }
      if (!disposed) setLoading(false);
    })();
    return () => { disposed = true; try { cleanup(); } catch { /* noop */ } };
  }, [mode, vol, threshold, sub]);

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
                <span>閾值 ≥ {threshold} {sub?.unit || ''}{hasEstimated ? '・含推估層*' : ''}</span>
                <span className="iso3d-vol">
                  {mode === 'slices' ? '堆疊體積' : '平滑體積'} ≈ {activeVolume && activeVolume > 0 ? `${Math.round(activeVolume).toLocaleString()} m³` : '—'}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
