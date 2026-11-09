import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { getMe, postLogin, postLogout, refreshSession } from '../services/authApi';

// The access cookie lives 15 minutes. Renewing it on a timer keeps requests
// that cannot retry on a 401 working: <audio src> for answer and TTS audio,
// and the viva socket handshake.
const KEEP_ALIVE_MS = 10 * 60 * 1000;

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  // `user` holds the server session (incl. uppercase role) or null when signed
  // out. `loading` stays true until the initial /auth/me resolves so routes can
  // avoid redirecting before the session is known.
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getMe();
      setUser(data.user);
      return data.user;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      await refresh();
      if (active) {
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [refresh]);

  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return undefined;
    const timer = setInterval(() => { refreshSession(); }, KEEP_ALIVE_MS);
    return () => clearInterval(timer);
  }, [signedIn]);

  const login = useCallback(
    async (identifier, password) => {
      await postLogin(identifier, password);
      return refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await postLogout();
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
};
