import { useCallback } from "react";
import { Outlet, createHashHistory, createRootRoute, createRoute, createRouter, redirect, useRouterState } from "@tanstack/react-router";
import { kbEntryKindSchema } from "@study-studio/shared";
import { z } from "zod";
import { AppShell } from "@/components/layout/AppShell";
import { OrganizeDialogHost } from "@/components/organize/OrganizeDialog";
import { OrganizeEventsBridge } from "@/components/organize/OrganizeEventsBridge";
import { KbEntryPage } from "@/pages/kb/KbEntryPage";
import { KbPage } from "@/pages/kb/KbPage";
import { HomePage } from "@/pages/home/HomePage";
import { InboxPage } from "@/pages/inbox/InboxPage";
import { ItemDetailPage } from "@/pages/inbox/ItemDetailPage";
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage";
import { ProgressPage } from "@/pages/progress/ProgressPage";
import { RunDetailPage } from "@/pages/runs/RunDetailPage";
import { RunsPage } from "@/pages/runs/RunsPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { api } from "@/api";
import "@/styles/kb.css";

const rootRoute = createRootRoute({
  component: () => <Outlet />
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: function AppLayout() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    return (
      <AppShell fit={pathname === "/wiki"}>
        <Outlet />
        <OrganizeDialogHost />
        <OrganizeEventsBridge />
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

const wikiSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  kind: kbEntryKindSchema.optional().catch(undefined),
  sel: z.string().optional().catch(undefined)
});

const wikiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/wiki",
  validateSearch: (search) => wikiSearchSchema.parse(search),
  component: function WikiRoute() {
    const search = wikiRoute.useSearch();
    const navigate = wikiRoute.useNavigate();
    const onFilterChange = useCallback(
      (next: { q: string; kind: z.infer<typeof wikiSearchSchema>["kind"] }) => {
        void navigate({ search: (prev) => ({ ...prev, q: next.q.trim() ? next.q : undefined, kind: next.kind }), replace: true });
      },
      [navigate]
    );
    return <KbPage q={search.q ?? ""} kind={search.kind} selectedId={search.sel} onFilterChange={onFilterChange} />;
  }
});

const wikiEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/wiki/$entryId",
  component: function WikiEntryRoute() {
    const { entryId } = wikiEntryRoute.useParams();
    return <KbEntryPage entryId={entryId} />;
  }
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
  component: RunsPage
});

const runDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/runs/$runId",
  component: function RunDetailRoute() {
    const { runId } = runDetailRoute.useParams();
    return <RunDetailPage runId={runId} />;
  }
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
  appRoute.addChildren([
    indexRoute,
    homeRoute,
    wikiRoute,
    wikiEntryRoute,
    progressRoute,
    inboxRoute,
    itemRoute,
    runsRoute,
    runDetailRoute,
    settingsIndexRoute,
    settingsRoute
  ])
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
