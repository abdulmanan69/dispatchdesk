import { lazy, Suspense } from 'react';
import { createBrowserRouter, Link } from 'react-router';
import PublicLayout from './layouts/PublicLayout.jsx';
import AppLayout, { RequirePermission } from './layouts/AppLayout.jsx';
import { Loading } from './components/ui.jsx';

const L = (fn) => {
  const C = lazy(fn);
  return <Suspense fallback={<Loading />}><C /></Suspense>;
};

function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="text-5xl font-semibold text-muted/40 tabular">404</p>
      <h1 className="mt-3 text-lg font-semibold">Page not found</h1>
      <p className="mt-1 text-sm text-muted">The page you're looking for doesn't exist or was moved.</p>
      <Link to="/" className="mt-5 inline-block text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">Back to home</Link>
    </div>
  );
}

function RouteError() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-1 text-sm text-muted">This page failed to load. Reload to try again — if you just deployed an update, a refresh fetches the new version.</p>
      <button type="button" onClick={() => window.location.reload()} className="mt-5 text-sm font-medium text-brand-700 hover:underline">Reload</button>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: L(() => import('./pages/public/Home.jsx')) },
      { path: '/features', element: L(() => import('./pages/public/Features.jsx')) },
      { path: '/pricing', element: L(() => import('./pages/public/Pricing.jsx')) },
      { path: '/training', element: L(() => import('./pages/training/PublicTraining.jsx')) },
      { path: '/marketplace', element: L(() => import('./pages/marketplace/MarketplaceBrowse.jsx')) },
      { path: '/marketplace/:id', element: L(() => import('./pages/marketplace/ListingDetail.jsx')) },
      { path: '/community', element: L(() => import('./pages/community/CommunityFeed.jsx')) },
      { path: '/community/:id', element: L(() => import('./pages/community/PostDetail.jsx')) },
      { path: '/u/:userId', element: L(() => import('./pages/community/UserProfile.jsx')) },
      { path: '/login', element: L(() => import('./pages/auth/Login.jsx')) },
      { path: '/register', element: L(() => import('./pages/auth/Register.jsx')) },
      { path: '/forgot-password', element: L(() => import('./pages/auth/ForgotPassword.jsx')) },
      { path: '/reset-password', element: L(() => import('./pages/auth/ResetPassword.jsx')) },
      { path: '/verify-email', element: L(() => import('./pages/auth/VerifyEmail.jsx')) },
      { path: '/invite/:token', element: L(() => import('./pages/team/AcceptInvite.jsx')) },
      { path: '/unsubscribe', element: L(() => import('./pages/public/Unsubscribe.jsx')) },
      { path: '/terms', element: L(() => import('./pages/public/Terms.jsx')) },
      { path: '/privacy', element: L(() => import('./pages/public/Privacy.jsx')) },
      { path: '*', element: <NotFound /> },
    ],
  },
  {
    path: '/app',
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: L(() => import('./pages/dashboard/Dashboard.jsx')) },
      // Leads & CRM
      { path: 'discover', element: L(() => import('./pages/carriers/Discover.jsx')) },
      { path: 'market', element: L(() => import('./pages/market/Market.jsx')) },
      { path: 'fleet', element: L(() => import('./pages/fleet/Fleet.jsx')) },
      { path: 'lead-generator', element: L(() => import('./pages/carriers/LeadGenerator.jsx')) },
      { path: 'carriers', element: L(() => import('./pages/carriers/CarrierList.jsx')) },
      { path: 'carriers/:id', element: L(() => import('./pages/carriers/CarrierDetail.jsx')) },
      { path: 'import', element: L(() => import('./pages/carriers/ImportCsv.jsx')) },
      { path: 'pipeline', element: L(() => import('./pages/carriers/Pipeline.jsx')) },
      { path: 'prospecting', element: L(() => import('./pages/prospecting/Prospecting.jsx')) },
      { path: 'sequences', element: L(() => import('./pages/prospecting/Sequences.jsx')) },
      { path: 'sequences/:id', element: L(() => import('./pages/prospecting/SequenceEditor.jsx')) },
      { path: 'dialer', element: L(() => import('./pages/calling/PowerDialer.jsx')) },
      { path: 'call-scripts', element: L(() => import('./pages/calling/CallScripts.jsx')) },
      { path: 'tools', element: L(() => import('./pages/tools/ToolsHub.jsx')) },
      { path: 'extension', element: L(() => import('./pages/calling/ExtensionSetup.jsx')) },
      { path: 'follow-ups', element: L(() => import('./pages/prospecting/FollowUps.jsx')) },
      // Deals & dispatch
      { path: 'opportunities', element: L(() => import('./pages/deals/Opportunities.jsx')) },
      { path: 'customers', element: L(() => import('./pages/deals/Customers.jsx')) },
      { path: 'customers/:id', element: L(() => import('./pages/deals/CustomerDetail.jsx')) },
      { path: 'brokers', element: L(() => import('./pages/dispatch/Brokers.jsx')) },
      { path: 'brokers/:id', element: L(() => import('./pages/dispatch/BrokerDetail.jsx')) },
      { path: 'loads', element: L(() => import('./pages/dispatch/Loads.jsx')) },
      { path: 'loads/calculator', element: L(() => import('./pages/dispatch/RateCalculator.jsx')) },
      // Outreach & AI
      { path: 'email', element: L(() => import('./pages/email/EmailCenter.jsx')) },
      { path: 'automations', element: L(() => import('./pages/email/Automations.jsx')) },
      { path: 'ai', element: L(() => import('./pages/ai/AiDispatcher.jsx')) },
      { path: 'ai/knowledge', element: L(() => import('./pages/ai/KnowledgeBase.jsx')) },
      // Grow
      { path: 'training', element: L(() => import('./pages/training/TrainingHome.jsx')) },
      { path: 'training/messages', element: L(() => import('./pages/training/TrainerMessages.jsx')) },
      { path: 'training/:slug', element: L(() => import('./pages/training/CourseView.jsx')) },
      { path: 'training/:slug/:lessonId', element: L(() => import('./pages/training/LessonView.jsx')) },
      { path: 'marketplace', element: L(() => import('./pages/marketplace/MyMarketplace.jsx')) },
      { path: 'marketplace/new', element: L(() => import('./pages/marketplace/ListingForm.jsx')) },
      { path: 'marketplace/:id/edit', element: L(() => import('./pages/marketplace/ListingForm.jsx')) },
      { path: 'community', element: L(() => import('./pages/community/CommunityFeed.jsx')) },
      { path: 'community/:id', element: L(() => import('./pages/community/PostDetail.jsx')) },
      { path: 'team', element: L(() => import('./pages/team/Team.jsx')) },
      // Account
      { path: 'billing', element: L(() => import('./pages/account/Billing.jsx')) },
      { path: 'settings', element: L(() => import('./pages/account/Settings.jsx')) },
      { path: 'notifications', element: L(() => import('./pages/account/Notifications.jsx')) },
      // Admin (backend enforces admin.* permissions on every API call)
      { path: 'admin', element: <RequirePermission perm="admin.access">{L(() => import('./pages/admin/Admin.jsx'))}</RequirePermission> },
      { path: 'admin/training', element: <RequirePermission perm="training.manage">{L(() => import('./pages/training/TrainingAdmin.jsx'))}</RequirePermission> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
