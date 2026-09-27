import { initCommandPalette } from "https://app.loghue.com/js/components/commandPalette.js";
import {
  loadComponent,
  removeLoader,
  preferedPrimary,
  setTheme,
  setInterfaceDensity,
} from "https://app.loghue.com/js/ui.js";
import {
  openCreateTaskModal,
  openLogTaskModal,
  openCreateWorkspaceModal,
  openLoginModal,
} from "https://app.loghue.com/js/utils/modals.js";
import { autoExpandTextarea } from "https://app.loghue.com/js/utils/textarea.js";
import {
  handleConcentEvents,
  loadAnalytics,
} from "https://loghue.com/analytics.js";
import { attachSignoutEvents } from "./auth/auth.js";
import {
  renderGlobalNotifications,
  fetchNotificationsForUser,
} from "https://app.loghue.com/js/utils/notifications.js";
import { sessionState, sessionReady, initSession } from "./session.js";
import { initOnboarding } from "https://app.loghue.com/js/components/onboardingModal.js";

window.addEventListener("DOMContentLoaded", async () => {
  await sessionReady;

  const userId = await sessionState.user.id;

  const path = window.location.pathname;

  await initCommandPalette();

  // Load correct sidebar based on page
  if (path.includes("workspace")) {
    // Prefer a shared container id; fall back to the old ones while migrating
    const target = document.getElementById("workspaceSidebarContainer");

    if (target) {
      await loadComponent("../components/workspace-sidebar", target.id);
    }
  }

  // General sidebar is safe everywhere
  await loadComponent("../components/sidebar", "sidebarContainer");

  // SESSION FUNCTION
  initSession();

  // Analytics
  await loadComponent("../components/modals/cookies-banner", "infoDisplay");
  const saved = localStorage.getItem("consent-preferences");
  if (saved) {
    const prefs = JSON.parse(saved);
    const consentBanner = document.getElementById("consent-banner");
    if (consentBanner) consentBanner.remove();

    if (prefs.analytics) loadAnalytics();
  }

  //JOIN NOTIFICATIONS GLOBALLY
  async function loadGlobalNotifications() {
    const { notifications, hasMore } = await fetchNotificationsForUser();

    await renderGlobalNotifications(notifications, hasMore);
  }

  // Call on page load
  loadGlobalNotifications();


  await initOnboarding(userId);

  handleConcentEvents();
  setTheme();
  removeLoader();
  attachSignoutEvents();

  // Modals (safe globally) — skip log-task on workspace pages;
  // initWorkspaceDashboard wires it with a real workspaceId.
  if (!path.includes("workspace")) {
    openLogTaskModal();
  }
  openCreateTaskModal();
  openCreateWorkspaceModal();
  openLoginModal();

  autoExpandTextarea();
});

//preffered primary color
preferedPrimary();

//ADD INTERFACE DENSITY PREFFERENCE
setInterfaceDensity();
