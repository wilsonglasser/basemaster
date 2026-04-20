import * as Sentry from "@sentry/react";

/** DSN público do Sentry. Pode ser setado em build-time via env var
 *  VITE_SENTRY_DSN. Se vazio, inicialização vira no-op. */
const DSN = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? "";

export function initSentry() {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    integrations: [],
    // Release desktop — sampling baixo pra não estourar quota.
    tracesSampleRate: 0.0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,
    beforeSend(event) {
      // Não envia PII básica — remove username/email/IP.
      if (event.user) event.user = { id: event.user.id };
      return event;
    },
  });
}

export const ErrorBoundary = Sentry.ErrorBoundary;
