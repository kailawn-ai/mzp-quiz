import { useEffect, useState, type ChangeEvent } from 'react';
import { api, apiBaseUrl, type EventItem, type OverlayLayout, type OverlaySettings } from './api';

const fallback: OverlaySettings = {
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
  participantBadgeMode: 'manual',
  participantBadgeParticipantId: null,
};

const overlayLayouts: Array<{ value: OverlayLayout; label: string; description: string }> = [
  { value: 'classic', label: 'Classic Quiz', description: 'Centered glass panel with balanced answers' },
  { value: 'competition', label: 'Competition', description: 'High-contrast game-show frame and score colors' },
  { value: 'minimal', label: 'Minimal', description: 'Typography-led with fine answer dividers' },
  { value: 'rapid_fire', label: 'Rapid Fire', description: 'Compact stacked answers with punchy accents' },
  { value: 'neon', label: 'Neon Pulse', description: 'Glowing outlines and vivid highlights' },
  { value: 'studio', label: 'Studio Panel', description: 'Layered broadcast desk with an inset frame' },
  { value: 'ticker', label: 'Ticker', description: 'Wide, centered broadcast information band' },
  { value: 'spotlight', label: 'Spotlight', description: 'Open layout with a dramatic light halo' },
  { value: 'cards', label: 'Card Grid', description: 'Rounded pill-shaped answer cards' },
  { value: 'lower_third', label: 'Lower Third', description: 'Centered bottom banner with a top accent' },
];

function upload(file: File, onDone: (url: string) => void, onError: (message: string) => void) {
  if (file.size > 5 * 1024 * 1024) {
    onError('Assets must be 5 MB or smaller.');
    return;
  }
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'font/woff', 'font/woff2', 'font/ttf'];
  if (!allowed.includes(file.type)) {
    onError('Unsupported asset type. Use PNG, JPEG, WebP, SVG, WOFF, WOFF2, or TTF.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => onDone(String(reader.result));
  reader.onerror = () => onError('Unable to read the selected asset.');
  reader.readAsDataURL(file);
}

export function OverlaySettingsPanel({ events }: { events: EventItem[] }) {
  const [eventId, setEventId] = useState(events[0]?.id ?? '');
  const [settings, setSettings] = useState<OverlaySettings>(fallback);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (eventId) {
      void api.overlaySettings(eventId)
        .then(setSettings)
        .catch((error) => setMessage(error instanceof Error ? error.message : 'Unable to load settings.'));
    }
  }, [eventId]);

  useEffect(() => {
    if (!eventId && events[0]) setEventId(events[0].id);
  }, [eventId, events]);

  const update = <K extends keyof OverlaySettings>(key: K, value: OverlaySettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  async function save() {
    if (!eventId) return;
    setSaving(true);
    setMessage('');
    try {
      setSettings(await api.updateOverlaySettings(eventId, settings));
      setMessage('Overlay settings saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save settings.');
    } finally {
      setSaving(false);
    }
  }

  async function handleAsset(event: ChangeEvent<HTMLInputElement>, field: 'logoPath' | 'backgroundImagePath') {
    const file = event.target.files?.[0];
    if (!file || !eventId) return;
    upload(
      file,
      async (data) => {
        try {
          const saved = await api.uploadOverlayAsset(eventId, { contentType: file.type, data });
          update(field, `${apiBaseUrl}${saved.url}`);
          setMessage('Asset uploaded. Save settings to apply it.');
        } catch (error) {
          setMessage(error instanceof Error ? error.message : 'Unable to upload asset.');
        }
      },
      setMessage,
    );
  }

  const previewUrl = eventId
    ? `/overlay/main?eventId=${encodeURIComponent(eventId)}&layout=${settings.layout}&scale=${settings.contentScale}&x=${settings.positionX ?? 0}&y=${settings.positionY ?? 0}`
    : '/overlay/main';

  return (
    <div className="page overlay-admin-page">
      <div className="section-header">
        <div>
          <div className="eyebrow">BROADCAST / OBS</div>
          <h2>Overlay studio</h2>
          <p>Configure a read-only transparent overlay and preview it before going live.</p>
        </div>
      </div>
      <div className="overlay-studio-grid">
        <section className="form-card">
          <label className="field">
            <span>Event</span>
            <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
              {events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}
            </select>
          </label>
          <section className="layout-picker" aria-labelledby="overlay-layout-title">
            <div className="layout-picker-heading">
              <div><h3 id="overlay-layout-title">Choose a broadcast layout</h3><p>Select a style to update the live preview.</p></div>
              <span className="layout-count">10 styles</span>
            </div>
            <div className="layout-options">
              {overlayLayouts.map(({ value, label, description }) => (
                <button
                  type="button"
                  className={`layout-option ${settings.layout === value ? 'selected' : ''}`}
                  key={value}
                  aria-pressed={settings.layout === value}
                  onClick={() => update('layout', value)}
                >
                  <span className={`layout-option-preview preview-${value}`} aria-hidden="true">
                    <span className="preview-question" />
                    <span className="preview-answer-row"><i /><i /></span>
                    <span className="preview-meta" />
                  </span>
                  <span className="layout-option-copy"><strong>{label}</strong><small>{description}</small></span>
                  {settings.layout === value && <span className="layout-option-check" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </section>
          <section className="overlay-settings-group">
            <div className="overlay-settings-group-title"><div><h3>Panel &amp; timer</h3><p>Control the overall overlay frame and timing treatment.</p></div></div>
            <div className="form-grid">
              <label className="field"><span>Horizontal position (X) · {settings.positionX ?? 0}%</span><input aria-label="Layout horizontal position" type="range" min="-50" max="50" step="1" value={settings.positionX ?? 0} onChange={(event) => update('positionX', Number(event.target.value))} /><small>Left ← → Right</small></label>
              <label className="field"><span>Vertical position (Y) · {settings.positionY ?? 0}%</span><input aria-label="Layout vertical position" type="range" min="-80" max="20" step="1" value={settings.positionY ?? 0} onChange={(event) => update('positionY', Number(event.target.value))} /><small>Up ← → Down · percentage of screen height</small></label>
            </div>
            <button type="button" className="button secondary small" onClick={() => setSettings((current) => ({ ...current, positionX: 0, positionY: 0 }))}>Reset position</button>
          <label className="field">
            <span>Overlay content size <strong>{Math.round(settings.contentScale * 100)}%</strong></span>
            <input
              aria-label="Overlay content size"
              type="range"
              min="0.5"
              max="1.2"
              step="0.05"
              value={settings.contentScale}
              onChange={(event) => update('contentScale', Number(event.target.value))}
            />
            <small>Adjust the question panel, choices, and timer together. Preview updates immediately.</small>
          </label>
          <label className="checkbox overlay-background-toggle">
            <input
              aria-label="Show overlay panel background"
              type="checkbox"
              checked={settings.showPanelBackground}
              onChange={(event) => update('showPanelBackground', event.target.checked)}
            />
            <span>
              <strong>Show overlay panel background</strong>
              <small>Turn off for a fully transparent panel; the question and answers retain readable backgrounds.</small>
            </span>
            <span className="overlay-background-toggle-state">{settings.showPanelBackground ? 'Visible' : 'Transparent'}</span>
          </label>
          <div className="form-grid">
            <label className="field">
              <span>Countdown</span>
              <select
                value={settings.countdownStyle}
                onChange={(event) => update('countdownStyle', event.target.value as OverlaySettings['countdownStyle'])}
              >
                <option value="ring">Text</option>
                <option value="bar">Bar</option>
                <option value="badge">Badge</option>
              </select>
            </label>
          </div>
          </section>
          <section className="overlay-settings-group">
            <div className="overlay-settings-group-title"><div><h3>Colors</h3><p>Match the overlay to your show identity.</p></div></div>
          <div className="form-grid">
            <label className="field">
              <span>Primary color</span>
              <input type="color" value={settings.primaryColor} onChange={(event) => update('primaryColor', event.target.value)} />
            </label>
            <label className="field">
              <span>Secondary color</span>
              <input type="color" value={settings.secondaryColor} onChange={(event) => update('secondaryColor', event.target.value)} />
            </label>
            <label className="field">
              <span>Background color</span>
              <input type="color" value={settings.backgroundColor} onChange={(event) => update('backgroundColor', event.target.value)} />
            </label>
            <label className="field">
              <span>Panel color</span>
              <input type="color" value={settings.panelColor} onChange={(event) => update('panelColor', event.target.value)} />
            </label>
            <label className="field">
              <span>Panel opacity</span>
              <input
                type="number"
                min="0"
                max="1"
                step=".05"
                value={settings.panelOpacity}
                onChange={(event) => update('panelOpacity', Number(event.target.value))}
              />
            </label>
          </div>
          </section>
          <section className="overlay-settings-group">
            <div className="overlay-settings-group-title"><div><h3>Content &amp; branding</h3><p>Fine-tune type, messaging, and visual assets.</p></div></div>
          <div className="form-grid">
            <label className="field">
              <span>Question size</span>
              <input
                type="number"
                min="24"
                max="120"
                value={settings.questionFontSize}
                onChange={(event) => update('questionFontSize', Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Choice size</span>
              <input
                type="number"
                min="16"
                max="72"
                value={settings.choiceFontSize}
                onChange={(event) => update('choiceFontSize', Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Choice spacing</span>
              <input
                type="number"
                min="8"
                max="64"
                value={settings.choiceGap}
                onChange={(event) => update('choiceGap', Number(event.target.value))}
              />
            </label>
          </div>
          <label className="field">
            <span>Event title override</span>
            <input maxLength={160} value={settings.eventTitle} onChange={(event) => update('eventTitle', event.target.value)} />
          </label>
          <label className="field">
            <span>Local font family</span>
            <input
              maxLength={100}
              value={settings.customFontFamily}
              onChange={(event) => update('customFontFamily', event.target.value)}
              placeholder="A locally installed font family"
            />
          </label>
          <label className="field">
            <span>Lower-third announcement</span>
            <input
              maxLength={240}
              value={settings.lowerThirdText}
              onChange={(event) => update('lowerThirdText', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Logo image</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(event) => void handleAsset(event, 'logoPath')}
            />
          </label>
          <label className="field">
            <span>Question backdrop image</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(event) => void handleAsset(event, 'backgroundImagePath')}
            />
            <small className="field-hint">Clipped to the question panel; keep it empty for a completely clear frame.</small>
          </label>
          </section>
          <div className="form-actions">
            <button className="button" disabled={saving || !eventId} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save overlay settings'}
            </button>
            {message && (
              <span className={message.includes('saved') || message.includes('uploaded') ? 'success-text' : 'error-text'}>
                {message}
              </span>
            )}
          </div>
        </section>
        <section className="panel overlay-preview-panel">
          <div className="panel-heading">
            <div>
              <h3>Live preview</h3>
              <p>Transparent areas let your broadcast show through. The preview never receives answer keys before reveal.</p>
            </div>
            <a className="button secondary small" href={previewUrl} target="_blank" rel="noreferrer">Open overlay</a>
          </div>
          <iframe title="OBS overlay preview" src={previewUrl} />
        </section>
      </div>
    </div>
  );
}
