import { createContext, useContext } from 'react';
import type { AuthUser } from './auth';

export interface AuthContextValue {
  user: AuthUser;
  logout: () => void;
}

// Provided by LoginGate once authenticated; consumed by the panel header so the
// app (rendered as LoginGate's children, without props) can show who's logged in.
const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = AuthContext.Provider;

export function useAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
