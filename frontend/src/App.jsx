import { AuthProvider } from './contexts/AuthContext';
import AppRoutes from './routes/AppRoutes';
import RealtimeToasts from './components/RealtimeToasts';
import { ToastHost } from './components/ui/Toast';

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
      <RealtimeToasts />
      <ToastHost />
    </AuthProvider>
  );
}
