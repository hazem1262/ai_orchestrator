import { notifyManager } from '@tanstack/react-query';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// TanStack Query notifies observers on `setTimeout(0)` by default, which `act()` does not wait for.
// A microtask lets `await act(async () => ...)` see the re-render a query update causes.
notifyManager.setScheduler(queueMicrotask);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

class ResizeObserverStub {
  observe(): void {
    // jsdom has no layout; nothing to observe
  }
  unobserve(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}
if (!('ResizeObserver' in globalThis)) Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });

// TanStack Virtual measures the scroll element with offsetWidth/offsetHeight; jsdom reports 0.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => undefined;
