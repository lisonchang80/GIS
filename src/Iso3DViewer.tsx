import { useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE_T from 'three'; // 型別用（編譯期抹除，不進 bundle）；執行期走 dynamic import
import type { SoilSurveyTab, VectorLayer } from './types';
import { buildDepthKeys, buildSurveyVolume, type SurveyVolume } from './iso3d';

type Mode = 'slices' | 'isosurface';

// ---- (A) Three.js 堆疊切片：各深度層的閾值多邊形擠出成薄板、疊在深度位置 ----
async function renderThree(
  container: HTMLDivElement,
  vol: SurveyVolume,
  zExag: number,
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
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dl = new THREE.DirectionalLight(0xffffff, 0.45);
  dl.position.set(1, 2, 1.5);
  scene.add(dl);

  const slices = vol.slices.filter((s) => s.ringsM.length > 0);
  const maxD = vol.maxDepthM || 1;
  const thickness = Math.max(vol.interval * zExag, 1);

  // 置中：所有環座標的平均
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const s of slices) for (const ring of s.ringsM) for (const [x, y] of ring) { cx += x; cy += y; n++; }
  if (n > 0) { cx /= n; cy /= n; }

  const group = new THREE.Group();
  const geos: THREE_T.BufferGeometry[] = [];
  const mats: THREE_T.Material[] = [];
  for (const s of slices) {
    const t = Math.min(1, s.depth / maxD);
    const color = new THREE.Color().setHSL(0.14 * (1 - t), 0.85, 0.5); // 淺黃→深紅
    const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    mats.push(mat);
    for (const ring of s.ringsM) {
      if (ring.length < 3) continue;
      const shape = new THREE.Shape();
      ring.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x - cx, y - cy) : shape.lineTo(x - cx, y - cy)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
      geos.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; // 形狀 XY 平面 → 世界水平面，擠出方向 → 向下
      mesh.position.y = -s.depth * zExag;
      group.add(mesh);
    }
  }
  scene.add(group);

  const span = Math.max(vol.horizSpanM, 10);
  const grid = new THREE.GridHelper(span * 1.6, 16, 0x334155, 0x1f2937);
  scene.add(grid);
  scene.add(new THREE.AxesHelper(span * 0.4));

  const targetY = -(maxD * zExag) / 2;
  const target = new THREE.Vector3(0, targetY, 0);
  const dist = span * 1.5 + 50;
  camera.position.set(dist * 0.8, dist * 0.7 + Math.abs(targetY), dist * 0.8);
  camera.lookAt(target);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.update();

  let raf = 0;
  const loop = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth || w;
    const nh = container.clientHeight || h;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
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

// ---- (B) Plotly isosurface：把規則 3D 純量場餵給 isosurface trace ----
async function renderPlotly(
  container: HTMLDivElement,
  vol: SurveyVolume,
  zExag: number,
  threshold: number,
): Promise<() => void> {
  const mod = await import('plotly.js-dist-min');
  // dist-min 沒有型別宣告，整包當 any 用。
  const Plotly = ((mod as unknown as { default?: unknown }).default ?? mod) as {
    newPlot: (el: HTMLElement, data: unknown[], layout: unknown, config: unknown) => Promise<unknown>;
    purge: (el: HTMLElement) => void;
  };
  const field = vol.field;
  if (!field) return () => {};
  const { xM, yM, depths, values } = field;
  const N = xM.length;
  const lo = threshold - Math.max(1, vol.valueMax - threshold); // 無資料層的填充值，壓在 isomin 之下
  const X: number[] = [];
  const Y: number[] = [];
  const Z: number[] = [];
  const V: number[] = [];
  for (let k = 0; k < depths.length; k++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = values[k * N * N + j * N + i];
        X.push(xM[i]);
        Y.push(yM[j]);
        Z.push(-depths[k] * zExag);
        V.push(Number.isFinite(v) ? v : lo);
      }
    }
  }
  const trace = {
    type: 'isosurface',
    x: X,
    y: Y,
    z: Z,
    value: V,
    isomin: threshold,
    isomax: Math.max(threshold + 1e-6, vol.valueMax),
    cmin: threshold,
    cmax: Math.max(threshold + 1e-6, vol.valueMax),
    surface: { count: 3, fill: 1 },
    opacity: 0.55,
    colorscale: 'YlOrRd',
    caps: { x: { show: false }, y: { show: false }, z: { show: false } },
    colorbar: { title: vol.unit || '', thickness: 10, len: 0.6 },
  };
  const axis = { backgroundcolor: '#0b0f14', gridcolor: '#1f2937', color: '#94a3b8' };
  const layout = {
    paper_bgcolor: '#0b0f14',
    font: { color: '#cbd5e1', size: 11 },
    margin: { l: 0, r: 0, t: 0, b: 0 },
    scene: {
      aspectmode: 'data',
      xaxis: { ...axis, title: 'X (m)' },
      yaxis: { ...axis, title: 'Y (m)' },
      zaxis: { ...axis, title: '深度×誇張' },
    },
  };
  await Plotly.newPlot(container, [trace], layout, { responsive: true, displaylogo: false });
  return () => {
    try {
      Plotly.purge(container);
    } catch {
      /* noop */
    }
  };
}

export function Iso3DViewer({
  layer,
  tab,
  subId,
  onClose,
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
  const model = tab.model ?? 'idw';

  const vol = useMemo(() => {
    if (!sub) return null;
    const depthKeys = buildDepthKeys(interval, maxDepth);
    return buildSurveyVolume(layer, tab.id, subId, depthKeys, interval, threshold, model, sub.name, sub.unit ?? '');
  }, [layer, tab.id, subId, sub, interval, maxDepth, threshold, model]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!vol || !vol.hasData) {
      container.innerHTML = '';
      setLoading(false);
      return;
    }
    let disposed = false;
    let cleanup: () => void = () => {};
    setLoading(true);
    setErr(null);
    const zExag = Math.max((vol.horizSpanM / (vol.maxDepthM || 1)) * 0.5, 1);
    (async () => {
      try {
        cleanup = mode === 'slices'
          ? await renderThree(container, vol, zExag)
          : await renderPlotly(container, vol, zExag, threshold);
      } catch (e) {
        if (!disposed) setErr((e as Error).message || String(e));
      }
      if (!disposed) setLoading(false);
    })();
    return () => {
      disposed = true;
      try {
        cleanup();
      } catch {
        /* noop */
      }
    };
  }, [mode, vol, threshold]);

  return (
    <div className="iso3d-overlay" onClick={onClose}>
      <div className="iso3d-modal" onClick={(e) => e.stopPropagation()}>
        <div className="iso3d-header">
          <div className="iso3d-title">3D 等濃度體積 — {sub?.name ?? ''}</div>
          <div className="iso3d-modes">
            <button className={`btn xs${mode === 'slices' ? ' primary' : ''}`} onClick={() => setMode('slices')}>
              堆疊切片
            </button>
            <button className={`btn xs${mode === 'isosurface' ? ' primary' : ''}`} onClick={() => setMode('isosurface')}>
              平滑曲面
            </button>
          </div>
          <button className="iso3d-close" onClick={onClose} title="關閉">×</button>
        </div>
        <div className="iso3d-body">
          <div ref={containerRef} className="iso3d-canvas" />
          {loading && <div className="iso3d-hud iso3d-loading">載入 3D…</div>}
          {!loading && (!vol || !vol.hasData) && (
            <div className="iso3d-hud">尚無足夠資料（每深度層至少 3 個有效濃度值）</div>
          )}
          {err && <div className="iso3d-hud iso3d-err">3D 載入失敗：{err}</div>}
          {vol?.hasData && (
            <div className="iso3d-stats">
              <span>閾值 ≥ {threshold} {sub?.unit || ''}</span>
              <span className="iso3d-vol">體積 ≈ {vol.volume > 0 ? `${Math.round(vol.volume).toLocaleString()} m³` : '—'}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
