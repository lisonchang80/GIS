import { useEffect, useRef, useState } from 'react';
import {
  GOOGLE_CLIENT_ID,
  devLogin,
  fetchMe,
  googleLogin,
  logout,
  type AuthUser,
} from './auth';
import { AuthProvider } from './authContext';
import './auth.css';

// Minimal typing for the Google Identity Services global.
interface GsiId {
  initialize: (opts: { client_id: string; callback: (r: { credential: string }) => void }) => void;
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GsiId } };
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';

function loadGsi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const existing = document.getElementById('gsi-script') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('GSI load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.id = 'gsi-script';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('GSI load failed'));
    document.head.appendChild(s);
  });
}

type Phase = 'loading' | 'anon' | 'authed';

export function LoginGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchMe().then((u) => {
      if (u) {
        setUser(u);
        setPhase('authed');
      } else {
        setPhase('anon');
      }
    });
  }, []);

  useEffect(() => {
    const clientId = GOOGLE_CLIENT_ID;
    if (phase !== 'anon' || !clientId) return;
    let cancelled = false;
    loadGsi()
      .then(() => {
        const id = window.google?.accounts?.id;
        if (cancelled || !id || !btnRef.current) return;
        id.initialize({
          client_id: clientId,
          callback: async (resp) => {
            try {
              const u = await googleLogin(resp.credential);
              setUser(u);
              setPhase('authed');
            } catch {
              setError('登入失敗，請再試一次');
            }
          },
        });
        id.renderButton(btnRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'pill',
        });
      })
      .catch(() => setError('無法載入 Google 登入元件'));
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setError(null);
    setPhase('anon');
  };

  if (phase === 'loading') {
    return (
      <div className="login-screen">
        <div className="login-spinner">載入中…</div>
      </div>
    );
  }

  if (phase === 'authed' && user) {
    return <AuthProvider value={{ user, logout: handleLogout }}>{children}</AuthProvider>;
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">🗺️</div>
        <h1 className="login-title">Web GIS</h1>
        <p className="login-sub">請以 Google 帳號登入，以使用與儲存你的專案。</p>
        {GOOGLE_CLIENT_ID ? (
          <div ref={btnRef} className="login-gbtn" />
        ) : (
          <p className="login-warn">尚未設定 Google Client ID（VITE_GOOGLE_CLIENT_ID）</p>
        )}
        {import.meta.env.DEV && (
          <button
            className="login-dev-btn"
            onClick={async () => {
              try {
                const u = await devLogin();
                setUser(u);
                setPhase('authed');
              } catch {
                setError('Dev 登入不可用（需後端 GIS_DEV_LOGIN=1）');
              }
            }}
          >
            Dev 登入（本機測試）
          </button>
        )}
        {error && <p className="login-error">{error}</p>}
      </div>
    </div>
  );
}
