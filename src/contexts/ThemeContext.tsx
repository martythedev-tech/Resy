import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Theme, ThemeColors } from '../types';
import { safeStorage } from '../utils/storage';
import { applyBrandingToDocument, loadStoredBranding } from '../utils/branding';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  colors: ThemeColors;
}

const lightTheme: ThemeColors = {
  bg: '#f5f7fb',
  panel: '#ffffff',
  card: '#ffffff',
  text: '#172033',
  muted: '#667085',
  primary: '#5558e3',
  primaryHover: '#4447c7',
  success: '#16845b',
  warning: '#b66a09',
  danger: '#cf3f4f',
  border: '#e4e8f0',
};

const darkTheme: ThemeColors = {
  bg: '#0f1420',
  panel: '#151c2b',
  card: '#1a2233',
  text: '#f3f5f8',
  muted: '#98a2b3',
  primary: '#818cf8',
  primaryHover: '#98a2ff',
  success: '#47c895',
  warning: '#f4b95e',
  danger: '#f07884',
  border: '#293247',
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = safeStorage.getItem('theme');
    return (saved as Theme) || 'dark';
  });

  const colors = theme === 'dark' ? darkTheme : lightTheme;

  useEffect(() => {
    safeStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);

    // Apply CSS variables to root
    const root = document.documentElement;
    Object.entries(colors).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value);
    });

    applyBrandingToDocument(loadStoredBranding(), { theme, persist: false });
  }, [theme, colors]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, colors }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
};
