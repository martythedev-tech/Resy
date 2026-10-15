import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { TimezoneProvider } from './contexts/TimezoneContext';
import { NotificationContainer } from './components/NotificationContainer';
import { Layout } from './components/Layout';
import { Login } from './components/Login';
import { ChangePassword } from './components/ChangePassword';
import { RoomPicker } from './components/RoomPicker';
import { Calendar } from './components/Calendar';
import { MyBookings } from './components/MyBookings';
import { AdminPanel } from './components/AdminPanel';
import { Reports } from './components/Reports';

// Protected route wrapper
const ProtectedRoute = ({ children, allowPasswordReset = false }: { children: React.ReactNode; allowPasswordReset?: boolean }) => {
  const { isAuthenticated, user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  if (!allowPasswordReset && user?.must_reset_password) return <Navigate to="/force-password" replace />;
  return <>{children}</>;
};

// Admin-only route wrapper
const AdminRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, user, loading } = useAuth();
  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.must_reset_password) return <Navigate to="/force-password" replace />;
  if (user?.role !== 'admin' && user?.role !== 'room_manager') return <Navigate to="/rooms" replace />;
  return <>{children}</>;
};

const ReportsRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, user, loading } = useAuth();
  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.must_reset_password) return <Navigate to="/force-password" replace />;
  if (!['admin', 'room_manager', 'report_viewer'].includes(user?.role || '')) return <Navigate to="/rooms" replace />;
  return <>{children}</>;
};

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={
        <Layout>
          <Login />
        </Layout>
      } />
      <Route path="/force-password" element={
        <ProtectedRoute allowPasswordReset>
          <ChangePassword />
        </ProtectedRoute>
      } />
      <Route path="/rooms" element={
        <ProtectedRoute>
          <Layout>
            <RoomPicker />
          </Layout>
        </ProtectedRoute>
      } />
      <Route path="/calendar" element={
        <ProtectedRoute>
          <Layout>
            <Calendar />
          </Layout>
        </ProtectedRoute>
      } />
      <Route path="/my-bookings" element={
        <ProtectedRoute>
          <Layout>
            <MyBookings />
          </Layout>
        </ProtectedRoute>
      } />
      <Route path="/admin" element={
        <AdminRoute>
          <Layout>
            <AdminPanel />
          </Layout>
        </AdminRoute>
      } />
      <Route path="/reports" element={
        <ReportsRoute>
          <Layout>
            <Reports />
          </Layout>
        </ReportsRoute>
      } />
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <ThemeProvider>
      <NotificationProvider>
        <TimezoneProvider>
          <AuthProvider>
            <BrowserRouter>
              <NotificationContainer />
              <AppRoutes />
            </BrowserRouter>
          </AuthProvider>
        </TimezoneProvider>
      </NotificationProvider>
    </ThemeProvider>
  );
}

export default App;
