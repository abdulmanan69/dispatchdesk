import { createBrowserRouter } from 'react-router';
import { Loading } from './components/ui.jsx';
import { page, layout, requires, bindRouter, NotFound, RouteError, PageError } from './context/routes.jsx';

/**
 * Routes load lazily with React Router's route-level `lazy`, so a page's chunk downloads in parallel with the
 * layout's chunk and with /api/auth/me instead of after them. Public pages and the driver's /track page never load
 * the app shell. A missing chunk after a deploy reloads the tab once (see context/reload.js).
 * Errors: a crash inside a page shows PageError inside the layout (sidebar and header keep working); only a crash
 * of a layout itself shows the full-screen RouteError.
 */

const boot = <Loading className="h-full" />;

export const router = createBrowserRouter([
  // Driver live-location link: public, no app chrome, opened on the driver's phone.
  { path: '/track/:token', errorElement: <RouteError />, hydrateFallbackElement: boot, lazy: page(() => import('./pages/track/DriverTrack.jsx')) },
  { path: '/t/:token', errorElement: <RouteError />, hydrateFallbackElement: boot, lazy: page(() => import('./pages/track/LoadTrack.jsx')) },
  { path: '/portal/:token', errorElement: <RouteError />, hydrateFallbackElement: boot, lazy: page(() => import('./pages/portal/CarrierPortal.jsx')) },
  { path: '/onboard/:token', errorElement: <RouteError />, hydrateFallbackElement: boot, lazy: page(() => import('./pages/onboard/CarrierOnboarding.jsx')) },
  {
    lazy: layout(() => import('./layouts/PublicLayout.jsx')),
    errorElement: <RouteError />,
    hydrateFallbackElement: boot,
    children: [{
      errorElement: <PageError />,
      children: [
        { path: '/', lazy: page(() => import('./pages/public/Home.jsx')) },
        { path: '/features', lazy: page(() => import('./pages/public/Features.jsx')) },
        { path: '/pricing', lazy: page(() => import('./pages/public/Pricing.jsx')) },
        { path: '/training', lazy: page(() => import('./pages/training/PublicTraining.jsx')) },
        { path: '/marketplace', lazy: page(() => import('./pages/marketplace/MarketplaceBrowse.jsx')) },
        { path: '/marketplace/:id', lazy: page(() => import('./pages/marketplace/ListingDetail.jsx')) },
        { path: '/community', lazy: page(() => import('./pages/community/CommunityFeed.jsx')) },
        { path: '/community/:id', lazy: page(() => import('./pages/community/PostDetail.jsx')) },
        { path: '/u/:userId', lazy: page(() => import('./pages/community/UserProfile.jsx')) },
        { path: '/login', lazy: page(() => import('./pages/auth/Login.jsx')) },
        { path: '/register', lazy: page(() => import('./pages/auth/Register.jsx')) },
        { path: '/forgot-password', lazy: page(() => import('./pages/auth/ForgotPassword.jsx')) },
        { path: '/reset-password', lazy: page(() => import('./pages/auth/ResetPassword.jsx')) },
        { path: '/verify-email', lazy: page(() => import('./pages/auth/VerifyEmail.jsx')) },
        { path: '/invite/:token', lazy: page(() => import('./pages/team/AcceptInvite.jsx')) },
        { path: '/unsubscribe', lazy: page(() => import('./pages/public/Unsubscribe.jsx')) },
        { path: '/terms', lazy: page(() => import('./pages/public/Terms.jsx')) },
        { path: '/privacy', lazy: page(() => import('./pages/public/Privacy.jsx')) },
        { path: '*', element: <NotFound /> },
      ],
    }],
  },
  {
    path: '/app',
    lazy: layout(() => import('./layouts/AppLayout.jsx')),
    errorElement: <RouteError />,
    hydrateFallbackElement: <Loading label="Loading your workspace…" className="h-full" />,
    children: [{
      errorElement: <PageError />,
      children: [
        { index: true, lazy: page(() => import('./pages/dashboard/Dashboard.jsx')) },
        // Leads & CRM
        { path: 'discover', lazy: page(() => import('./pages/carriers/Discover.jsx')) },
        { path: 'market', lazy: page(() => import('./pages/market/Market.jsx')) },
        { path: 'fleet', lazy: page(() => import('./pages/fleet/Fleet.jsx')) },
        { path: 'today', lazy: page(() => import('./pages/today/Today.jsx')) },
        { path: 'templates', lazy: page(() => import('./pages/templates/Templates.jsx')) },
        { path: 'invoices', lazy: page(() => import('./pages/invoices/Invoices.jsx')) },
        { path: 'reports', lazy: page(() => import('./pages/reports/Reports.jsx')) },
        { path: 'new-authority', lazy: page(() => import('./pages/leads/NewAuthority.jsx')) },
        { path: 'truck-posts', lazy: page(() => import('./pages/leads/TruckPosts.jsx')) },
        { path: 'lead-generator', lazy: page(() => import('./pages/carriers/LeadGenerator.jsx')) },
        { path: 'carriers', lazy: page(() => import('./pages/carriers/CarrierList.jsx')) },
        { path: 'carriers/:id', lazy: page(() => import('./pages/carriers/CarrierDetail.jsx')) },
        { path: 'import', lazy: page(() => import('./pages/carriers/ImportCsv.jsx')) },
        { path: 'pipeline', lazy: page(() => import('./pages/carriers/Pipeline.jsx')) },
        { path: 'prospecting', lazy: page(() => import('./pages/prospecting/Prospecting.jsx')) },
        { path: 'sequences', lazy: page(() => import('./pages/prospecting/Sequences.jsx')) },
        { path: 'sequences/:id', lazy: page(() => import('./pages/prospecting/SequenceEditor.jsx')) },
        { path: 'dialer', lazy: page(() => import('./pages/calling/PowerDialer.jsx')) },
        { path: 'call-scripts', lazy: page(() => import('./pages/calling/CallScripts.jsx')) },
        { path: 'tools', lazy: page(() => import('./pages/tools/ToolsHub.jsx')) },
        { path: 'extension', lazy: page(() => import('./pages/calling/ExtensionSetup.jsx')) },
        { path: 'follow-ups', lazy: page(() => import('./pages/prospecting/FollowUps.jsx')) },
        // Deals & dispatch
        { path: 'opportunities', lazy: page(() => import('./pages/deals/Opportunities.jsx')) },
        { path: 'customers', lazy: page(() => import('./pages/deals/Customers.jsx')) },
        { path: 'customers/:id', lazy: page(() => import('./pages/deals/CustomerDetail.jsx')) },
        { path: 'brokers', lazy: page(() => import('./pages/dispatch/Brokers.jsx')) },
        { path: 'brokers/:id', lazy: page(() => import('./pages/dispatch/BrokerDetail.jsx')) },
        { path: 'loads', lazy: page(() => import('./pages/dispatch/Loads.jsx')) },
        { path: 'loads/calculator', lazy: page(() => import('./pages/dispatch/RateCalculator.jsx')) },
        // Outreach & AI
        { path: 'email', lazy: page(() => import('./pages/email/EmailCenter.jsx')) },
        { path: 'automations', lazy: page(() => import('./pages/email/Automations.jsx')) },
        { path: 'ai', lazy: page(() => import('./pages/ai/AiDispatcher.jsx')) },
        { path: 'ai/knowledge', lazy: page(() => import('./pages/ai/KnowledgeBase.jsx')) },
        // Grow
        { path: 'training', lazy: page(() => import('./pages/training/TrainingHome.jsx')) },
        { path: 'training/messages', lazy: page(() => import('./pages/training/TrainerMessages.jsx')) },
        { path: 'training/:slug', lazy: page(() => import('./pages/training/CourseView.jsx')) },
        { path: 'training/:slug/:lessonId', lazy: page(() => import('./pages/training/LessonView.jsx')) },
        { path: 'marketplace', lazy: page(() => import('./pages/marketplace/MyMarketplace.jsx')) },
        { path: 'marketplace/new', lazy: page(() => import('./pages/marketplace/ListingForm.jsx')) },
        { path: 'marketplace/:id/edit', lazy: page(() => import('./pages/marketplace/ListingForm.jsx')) },
        { path: 'community', lazy: page(() => import('./pages/community/CommunityFeed.jsx')) },
        { path: 'community/:id', lazy: page(() => import('./pages/community/PostDetail.jsx')) },
        { path: 'team', lazy: page(() => import('./pages/team/Team.jsx')) },
        // Account
        { path: 'billing', lazy: page(() => import('./pages/account/Billing.jsx')) },
        { path: 'settings', lazy: page(() => import('./pages/account/Settings.jsx')) },
        { path: 'notifications', lazy: page(() => import('./pages/account/Notifications.jsx')) },
        // Admin (backend enforces admin.* permissions on every API call)
        { path: 'admin', lazy: page(() => import('./pages/admin/Admin.jsx'), requires('admin.access')) },
        { path: 'admin/training', lazy: page(() => import('./pages/training/TrainingAdmin.jsx'), requires('training.manage')) },
        { path: '*', element: <NotFound /> },
      ],
    }],
  },
]);

bindRouter(router);
