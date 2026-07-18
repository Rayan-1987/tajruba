import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './AuthContext';
import Login from './pages/Login';
import Register from './pages/Register';
import PatientSurvey from './pages/PatientSurvey';
import KioskSurvey from './pages/KioskSurvey';
import DashboardLayout from './pages/DashboardLayout';
import Reports from './pages/Reports';
import CommentsIntelligence from './pages/CommentsIntelligence';
import ServiceRecovery from './pages/ServiceRecovery';
import PromsMonitor from './pages/PromsMonitor';
import SurveyStudio from './pages/SurveyStudio';
import PhoneSurvey from './pages/PhoneSurvey';
import DataCenter from './pages/DataCenter';
import Settings from './pages/Settings';
import Admin from './pages/Admin';

function ProtectedRoutes({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-400">جارِ التحميل...</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/s/:token" element={<PatientSurvey />} />
      <Route path="/k/:code" element={<KioskSurvey />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoutes>
            <DashboardLayout />
          </ProtectedRoutes>
        }
      >
        <Route index element={<Navigate to="reports" replace />} />
        <Route path="reports" element={<Reports />} />
        <Route path="comments" element={<CommentsIntelligence />} />
        <Route path="service-recovery" element={<ServiceRecovery />} />
        <Route path="proms" element={<PromsMonitor />} />
        <Route path="phone-survey" element={<PhoneSurvey />} />
        <Route path="survey-studio" element={<SurveyStudio />} />
        <Route path="data-center" element={<DataCenter />} />
        <Route path="admin" element={<Admin />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
