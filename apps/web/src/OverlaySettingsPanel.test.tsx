// @vitest-environment jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type EventItem, type OverlaySettings } from './api';
import { OverlaySettingsPanel } from './OverlaySettingsPanel';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OverlaySettingsPanel', () => {
  it('previews and saves the selected overlay layout', async () => {
    const settings: OverlaySettings = {
      layout: 'classic',
      primaryColor: '#7dd3fc',
      secondaryColor: '#a78bfa',
      backgroundColor: '#020617',
      panelColor: '#0f172a',
      panelOpacity: 0.86,
      showPanelBackground: true,
      questionFontSize: 52,
      choiceFontSize: 30,
      choiceGap: 20,
      contentScale: 0.72,
      countdownStyle: 'ring',
      eventTitle: '',
      logoPath: null,
      backgroundImagePath: null,
      lowerThirdText: '',
      customFontFamily: '',
    };
    const event: EventItem = {
      id: 'event-1',
      title: 'Quiz Night',
      description: null,
      status: 'draft',
      settings: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const saveSettings = vi.spyOn(api, 'updateOverlaySettings').mockResolvedValue({ ...settings, layout: 'neon' });
    vi.spyOn(api, 'overlaySettings').mockResolvedValue(settings);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<OverlaySettingsPanel events={[event]} />);
    });

    expect(container.querySelectorAll('.layout-option')).toHaveLength(10);
    const backgroundToggle = container.querySelector<HTMLInputElement>('input[aria-label="Show overlay panel background"]');
    expect(backgroundToggle?.checked).toBe(true);
    await act(async () => {
      backgroundToggle!.click();
    });
    expect(container.textContent).toContain('Transparent');
    const sizeSlider = container.querySelector<HTMLInputElement>('input[aria-label="Overlay content size"]');
    expect(sizeSlider?.value).toBe('0.72');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(sizeSlider, '0.8');
      sizeSlider!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('80%');
    expect(container.querySelector<HTMLIFrameElement>('iframe')?.getAttribute('src')).toContain('scale=0.8');
    const neonOption = Array.from(container.querySelectorAll<HTMLButtonElement>('.layout-option')).find((option) =>
      option.textContent?.includes('Neon Pulse'),
    );
    await act(async () => {
      neonOption?.click();
    });
    expect(container.querySelector<HTMLIFrameElement>('iframe')?.getAttribute('src')).toContain('layout=neon');
    expect(container.querySelector<HTMLIFrameElement>('iframe')?.getAttribute('src')).toContain('scale=0.8');
    expect(neonOption?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.button:not(.secondary)')?.click();
      await Promise.resolve();
    });
    expect(saveSettings).toHaveBeenCalledWith('event-1', expect.objectContaining({
      layout: 'neon',
      showPanelBackground: false,
    }));

    await act(async () => root.unmount());
    container.remove();
  });
});
