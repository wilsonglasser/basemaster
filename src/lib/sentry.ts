import * as Sentry from "@sentry/react";

/** Public Sentry DSN. Can be set at build-time via env var
 *  VITE_SENTRY_DSN. If empty, init becomes a no-op. */
const DSN = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? "";

export function initSentry() {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    integrations: [],
    // Desktop release — low sampling to avoid blowing quota.
    tracesSampleRate: 0.0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,
    beforeSend(event) {
      // Don't send basic PII — strip username/email/IP.
      if (event.user) event.user = { id: event.user.id };
      return event;
    },
  });
}

export const ErrorBoundary = Sentry.ErrorBoundary;
