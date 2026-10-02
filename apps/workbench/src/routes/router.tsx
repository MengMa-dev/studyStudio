import { Outlet, createHashHistory, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "@/components/layout/AppShell";
import { HomePage } from "@/pages/home/HomePage";
import { InboxPage } from "@/pages/inbox/InboxPage";
import { ItemDetailPage } from "@/pages/inbox/ItemDetailPage";
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage";
import { PlaceholderPage } from "@/pages/placeholder/PlaceholderPage";
import { ProgressPage } from "@/pages/progress/ProgressPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { api } from "@/api";

const rootRoute = createRootRoute({
  component: () => <Outlet />
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: function AppLayout() {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  },
  beforeLoad: async ({ location }) => {
    if (location.pathname.startsWith("/onboarding")) return;
    try {
      const status = await api.getOnboarding();
      if (status.needsOnboarding) throw redirect({ to: "/onboarding" });
    } catch (error) {
      if (error && typeof error === "object" && "to" in error) throw error;
    }
  }
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/home" });
  }
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/home",
  component: HomePage
});

const wikiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/wiki",
  component: () => <PlaceholderPage title="知识库" hint="目录与词条将在 M6 实现" />
});

const progressRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/progress",
  component: ProgressPage
});

const inboxSearchSchema = z.object({
  type: z.enum(["all", "webpage", "conversation", "trash"]).catch("all"),
  status: z.enum(["all", "unread", "read", "pending", "ingested", "rejected"]).catch("all")
});

const inboxRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/inbox",
  validateSearch: (search) => inboxSearchSchema.parse(search),
  component: function InboxRoute() {
    const search = inboxRoute.useSearch();
    const navigate = inboxRoute.useNavigate();
    return (
      <InboxPage
        type={search.type}
        status={search.status}
        onTypeChange={(type) => {
          void navigate({ search: (prev) => ({ ...prev, type }) });
        }}
        onStatusChange={(status) => {
          void navigate({ search: (prev) => ({ ...prev, status }) });
        }}
      />
    );
  }
});

const itemRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/item/$itemId",
  component: function ItemRoute() {
    const { itemId } = itemRoute.useParams();
    return <ItemDetailPage itemId={itemId} />;
  }
});

const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/runs",
  component: () => <PlaceholderPage title="整理记录" hint="整理运行记录将在 M5/M6 实现；侧栏入口已预留" />
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/$section",
  component: function SettingsRoute() {
    const { section } = settingsRoute.useParams();
    const allowed = ["collect", "ai", "organize", "profile", "data"] as const;
    const current = allowed.includes(section as (typeof allowed)[number]) ? (section as (typeof allowed)[number]) : "collect";
    return <SettingsPage section={current} />;
  }
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "collect" } });
  }
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: function OnboardingLayout() {
    return (
      <AppShell>
        <OnboardingPage />
      </AppShell>
    );
  }
});

const routeTree = rootRoute.addChildren([
  onboardingRoute,
  appRoute.addChildren([indexRoute, homeRoute, wikiRoute, progressRoute, inboxRoute, itemRoute, runsRoute, settingsIndexRoute, settingsRoute])
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent"
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
