// @vitest-environment jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api, type EventItem } from './api';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  sessionStorage.clear();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

describe('App round management', () => {
  it('shows event-specific OBS URLs and copies the selected overlay URL', async () => {
    const event: EventItem = {
      id: 'event-1',
      title: 'Annual Quiz Night',
      description: null,
      status: 'draft',
      settings: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.spyOn(api, 'health').mockResolvedValue({ service: 'mzp-quiz-server' });
    vi.spyOn(api, 'adminAuth').mockResolvedValue({ authorized: true });
    vi.spyOn(api, 'databaseHealth').mockResolvedValue({
      database: { connected: true, migrationsApplied: 4 },
      migrations: { applied: 4 },
    });
    vi.spyOn(api, 'dashboard').mockResolvedValue({ events: 1, rounds: 0, questions: 0 });
    vi.spyOn(api, 'events').mockResolvedValue([event]);
    vi.spyOn(api, 'rounds').mockResolvedValue([]);
    sessionStorage.setItem('mzp_admin_token', 'test-admin-token');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    expect(container.textContent).not.toContain('Contestant Screen');
    expect(container.textContent).not.toContain('Quiz Display');

    const eventsNav = Array.from(container.querySelectorAll('nav button')).find((button) =>
      button.textContent?.includes('Events'),
    );
    await act(async () => {
      eventsNav?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const eventCard = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(event.title),
    );
    await act(async () => {
      eventCard?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const overlaysTab = Array.from(container.querySelectorAll('[role="tab"]')).find((button) =>
      button.textContent === 'Overlays',
    );
    await act(async () => {
      overlaysTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const mainOverlayUrl = container.querySelector<HTMLInputElement>('#overlay-url-event-1-main');
    expect(mainOverlayUrl?.value).toBe(`${window.location.origin}/overlay/main?eventId=event-1`);
    const copyButton = Array.from(container.querySelectorAll('.overlay-url-row button')).find((button) =>
      button.textContent === 'Copy',
    );
    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(mainOverlayUrl?.value);
    expect(container.textContent).toContain('Main URL copied.');

    const roundsTab = Array.from(container.querySelectorAll('[role="tab"]')).find((button) =>
      button.textContent === 'Rounds',
    );
    await act(async () => {
      roundsTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const newRoundButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'New round',
    );
    await act(async () => {
      newRoundButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('input[placeholder="General Knowledge"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
