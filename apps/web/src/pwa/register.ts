import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  registerSW({
    immediate: true,
    onRegisterError(error: unknown) {
      console.warn('service worker registration failed', error);
    },
  });
}
