import { sessionState, sessionReady } from "../session.js";

async function protectAppPage() {
  await sessionReady;
  const redirectUrl = window.location.href;

  if (!sessionState.user) {
    window.location.href = `/auth?redirect=${encodeURIComponent(redirectUrl)}`;
    return;
  }

  // User is logged in, continue loading the page
}

protectAppPage();
