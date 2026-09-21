import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
