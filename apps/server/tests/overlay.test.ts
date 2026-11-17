import { describe, expect, it } from 'vitest';
import { overlayLayouts, overlaySettingsSchema, updateOverlaySettings } from '../src/game/overlay.js';

describe('overlay layout settings', () => {
  it('does not include the retired audience vote count setting', () => {
    expect(overlaySettingsSchema.parse({})).not.toHaveProperty('showAudienceVotes');
    expect(updateOverlaySettings({}, { layout: 'neon' })).not.toHaveProperty('showAudienceVotes');
  });

  it('defaults the overall overlay size to compact and validates the adjustable scale', () => {
    expect(overlaySettingsSchema.parse({}).contentScale).toBe(0.72);
    expect(overlaySettingsSchema.parse({}).showPanelBackground).toBe(true);
    expect(updateOverlaySettings({}, { showPanelBackground: false }).showPanelBackground).toBe(false);
    expect(updateOverlaySettings({}, { contentScale: 0.9 }).contentScale).toBe(0.9);
    expect(() => updateOverlaySettings({}, { contentScale: 1.3 })).toThrow();
    expect(() => updateOverlaySettings({}, { contentScale: 0.4 })).toThrow();
  });

  it('accepts all ten layouts for both defaults and updates', () => {
    expect(overlayLayouts).toHaveLength(10);
    for (const layout of overlayLayouts) {
      expect(overlaySettingsSchema.parse({ layout }).layout).toBe(layout);
      expect(updateOverlaySettings({}, { layout }).layout).toBe(layout);
    }
  });
});
