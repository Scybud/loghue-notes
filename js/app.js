import { loadComponent } from "https://ui.scybud.com/js/ui.js";
import { openLoginModal } from "https://app.loghue.com/js/utils/modals.js";
import { autoExpandTextarea } from "https://app.loghue.com/js/utils/textarea.js";
import {
  handleConcentEvents,
  loadAnalytics,
} from "https://loghue.com/analytics.js";
import { attachSignoutEvents } from "./auth/auth.js";
import { sessionState, sessionReady, initSession } from "./session.js";

window.addEventListener("DOMContentLoaded", async () => {
  await sessionReady;

  const userId = await sessionState.user?.id;

  // Analytics
  await loadComponent("../components/modals/cookies-banner", "infoDisplay");
  const saved = localStorage.getItem("consent-preferences");
  if (saved) {
    const prefs = JSON.parse(saved);
    const consentBanner = document.getElementById("consent-banner");
    if (consentBanner) consentBanner.remove();

    if (prefs.analytics) loadAnalytics();
  }

  handleConcentEvents();
  attachSignoutEvents();

  openLoginModal();

  autoExpandTextarea();
});
