import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './AuthContext';
import type { Role } from './types';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Register from './pages/Register';
import PatientSurvey from './pages/PatientSurvey';
import KioskSurvey from './pages/KioskSurvey';
import PatientPromsForm from './pages/PatientPromsForm';
import PatientPromsOptOut from './pages/PatientPromsOptOut';
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

// Hiding a link from the sidebar (DashboardLayout's NAV_ITEMS) isn't real access control — a
// user who already knows or guesses the URL would otherwise still mount the full page, which
// then either shows a confusing pile of failed/empty requests (routes the API does protect) or,
// worse, renders data from routes the API leaves open to any authenticated user. This gate is
// the actual enforcement point on the client; the server-side requireRole() checks remain the
// real security boundary regardless.
function RoleGate({ allow, children }: { allow: Role[]; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!allow.includes(user.role)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center" dir="rtl">
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-lg font-semibold text-slate-700">لا تملك صلاحية الوصول لهذه الصفحة</p>
          <p className="mt-1 text-sm text-slate-500">هذه الصفحة مخصّصة لأدوار محدّدة فقط.</p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password/:token" element={<ResetPassword />} />
      <Route path="/register" element={<Register />} />
      <Route path="/s/:token" element={<PatientSurvey />} />
      <Route path="/k/:code" element={<KioskSurvey />} />
      <Route path="/p/:token" element={<PatientPromsForm />} />
      <Route path="/p/:token/opt-out" element={<PatientPromsOptOut />} />
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
        <Route
          path="survey-studio"
          element={
            <RoleGate allow={['SystemAdmin', 'QualityManager']}>
              <SurveyStudio />
            </RoleGate>
          }
        />
        <Route
          path="data-center"
          element={
            <RoleGate allow={['SystemAdmin', 'QualityManager']}>
              <DataCenter />
            </RoleGate>
          }
        />
        <Route
          path="admin"
          element={
            <RoleGate allow={['SystemAdmin']}>
              <Admin />
            </RoleGate>
          }
        />
        <Route
          path="settings"
          element={
            <RoleGate allow={['SystemAdmin']}>
              <Settings />
            </RoleGate>
          }
        />
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
