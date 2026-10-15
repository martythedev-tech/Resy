import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User } from '../types';
import { api } from '../config/api';
import { safeStorage } from '../utils/storage';

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<User | null>;
  logout: () => void;
  isAuthenticated: boolean;
  loading: boolean;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Check for existing session on mount
  useEffect(() => {
    const token = safeStorage.getItem('auth_token');
    let active = true;
    const handleExpired = () => setUser(null);
    window.addEventListener('auth-expired', handleExpired);

    if (!token) {
      setLoading(false);
      return () => window.removeEventListener('auth-expired', handleExpired);
    }

    api.getMe()
      .then(data => {
        if (!active) return;
        setUser(data);
        safeStorage.setItem('user', JSON.stringify(data));
      })
      .catch(() => {
        if (!active) return;
        api.logout();
        setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      window.removeEventListener('auth-expired', handleExpired);
    };
  }, []);

  const login = async (email: string, password: string): Promise<User | null> => {
    try {
      const data = await api.login(email, password);
      setUser(data.user);
      return data.user;
    } catch (error: any) {
      console.error('Login failed:', error.message);
      return null;
    }
  };

  const logout = () => {
    api.logout();
    setUser(null);
  };

  const refreshUser = async () => {
    try {
      const data = await api.getMe();
      setUser(data);
      safeStorage.setItem('user', JSON.stringify(data));
    } catch (error) {
      console.error('Failed to refresh user');
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      login,
      logout,
      isAuthenticated: !!user,
      loading,
      refreshUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
