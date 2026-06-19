// Client-side auth helpers. The backend issues an httpOnly session cookie at
// login; all calls use credentials: 'include' so the cookie rides along.

export interface AuthUser {
  id: number;
  email: string;
  name?: string | null;
  picture?: string | null;
}

export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const r = await fetch('/api/me', { credentials: 'include' });
    if (!r.ok) return null;
    const d = await r.json();
    return (d?.user as AuthUser) ?? null;
  } catch {
    return null;
  }
}

export async function googleLogin(credential: string): Promise<AuthUser> {
  const r = await fetch('/api/auth/google', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  return (await r.json()).user as AuthUser;
}

export async function devLogin(): Promise<AuthUser> {
  const r = await fetch('/api/auth/dev-login', { method: 'POST', credentials: 'include' });
  if (!r.ok) throw new Error('dev login unavailable');
  return (await r.json()).user as AuthUser;
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    /* ignore */
  }
}
