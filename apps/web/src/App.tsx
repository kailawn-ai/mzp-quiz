import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, apiBaseUrl, getAdminToken, type EventItem, type QuestionAdmin, type QuestionItem, type RoundItem } from './api';
import { OverlayScreen } from './OverlayScreen';
import { TeamScreen } from './TeamScreen';
import { LiveControl } from './LiveControl';
import { LeaderboardPanel, ParticipantManager, SubmissionReviewPanel } from './CompetitionPanels';
import { OverlaySettingsPanel } from './OverlaySettingsPanel';

type View = 'dashboard' | 'live' | 'events' | 'questions' | 'overlays' | 'settings';
export type Route = 'admin' | 'overlay' | 'team';

function getActiveRoute(): Route {
  if (typeof window === 'undefined') return 'admin';
  const path = window.location.pathname.toLowerCase();
  const search = new URLSearchParams(window.location.search);
  const viewParam = search.get('view')?.toLowerCase();
  if (path === '/team-screen') return 'team';

  if (path.includes('overlay') || viewParam === 'overlay') {
    return 'overlay';
  }
  return 'admin';
}
type ServiceState = 'checking' | 'connected' | 'offline';
const roundTypes = [['quick_questions', 'Quick Question'], ['rapid_fire', 'Rapid Fire'], ['multiple_choice', 'Multiple Choice'], ['buzzer', 'Buzzer'], ['written_answer', 'Written Answer'], ['true_false', 'True or False'], ['image_audio_clue', 'Image or Audio Clue'], ['bonus_round', 'Bonus Round'], ['tie_breaker', 'Tie-breaker']];
const questionTypes = [['quick_question', 'Quick Question'], ['rapid_fire', 'Rapid Fire'], ['multiple_choice', 'Multiple Choice'], ['buzzer', 'Buzzer'], ['written_answer', 'Written Answer'], ['true_false', 'True or False'], ['image_audio_clue', 'Image or Audio Clue'], ['bonus_round', 'Bonus Round'], ['tie_breaker', 'Tie-breaker']];

function labelFor(values: string[][], value: string) { return values.find(([key]) => key === value)?.[1] ?? value; }
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'; }

function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' }) { return <span className={`pill ${tone}`}>{children}</span>; }
function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-mark">+</div><h3>{title}</h3><p>{detail}</p>{action}</div>; }
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}{hint && <small>{hint}</small>}</span>{children}</label>; }
function SectionHeader({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: ReactNode }) { return <div className="section-header"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</div>; }

function Dashboard({ counts, events, onNavigate }: { counts: { events: number; rounds: number; questions: number } | null; events: EventItem[]; onNavigate: (view: View) => void }) {
  return <div className="page"><SectionHeader eyebrow="OVERVIEW" title="Control centre" detail="Prepare content and manage live competitions in real time." action={<div style={{ display: 'flex', gap: '.6rem' }}><button className="button" onClick={() => onNavigate('live')}>▶ Live Control</button><StatusPill tone="warning">Development admin</StatusPill></div>} /><div className="metric-grid">{[['Events', counts?.events ?? '—', 'Prepared events'], ['Rounds', counts?.rounds ?? '—', 'Across all events'], ['Questions', counts?.questions ?? '—', 'In the question bank']].map(([title, value, detail]) => <button className="metric-card" key={title} onClick={() => onNavigate(title === 'Questions' ? 'questions' : 'events')}><span>{title}</span><strong>{value}</strong><small>{detail}</small></button>)}</div><section className="panel"><div className="panel-heading"><div><h3>Recent events</h3><p>Your locally stored quiz events.</p></div><button className="button secondary" onClick={() => onNavigate('events')}>View all events</button></div>{events.length === 0 ? <EmptyState title="No events yet" detail="Create an event to start building your quiz." action={<button className="button" onClick={() => onNavigate('events')}>Create event</button>} /> : <div className="table-list">{events.slice(0, 5).map((event) => <div className="table-row" key={event.id}><div><strong>{event.title}</strong><span>{event.description || 'No description'}</span></div><div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}><StatusPill>{event.status}</StatusPill><button className="link-button" onClick={() => onNavigate('live')}>Open in Live Control</button></div></div>)}</div>}</section></div>;
}

function EventEditor({ event, onSaved, onDeleted, onCancel }: { event: EventItem | null; onSaved: (event: EventItem) => void; onDeleted?: (eventId: string) => void; onCancel?: () => void }) {
  const [title, setTitle] = useState(event?.title ?? ''); const [description, setDescription] = useState(event?.description ?? ''); const [allowAnswerChanges, setAllowAnswerChanges] = useState(event?.settings.allowAnswerChanges === true); const [saving, setSaving] = useState(false); const [deleting, setDeleting] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => { setTitle(event?.title ?? ''); setDescription(event?.description ?? ''); setAllowAnswerChanges(event?.settings.allowAnswerChanges === true); setMessage(''); }, [event?.id]);
  async function submit(formEvent: FormEvent) { formEvent.preventDefault(); setSaving(true); setMessage(''); const settings = { ...(event?.settings ?? {}), allowAnswerChanges }; try { const saved = event ? await api.updateEvent(event.id, { title, description, settings }) : await api.createEvent({ title, description, settings }); onSaved(saved); setMessage(event ? 'Event details saved.' : 'Event created.'); if (!event) { setTitle(''); setDescription(''); } } catch (cause) { setMessage(errorMessage(cause)); } finally { setSaving(false); } }
  async function remove() { if (!event || !window.confirm(`Delete “${event.title}”? This permanently removes the event, all rounds, questions, participants, scores, and submissions. This cannot be undone.`)) return; setDeleting(true); setMessage(''); try { await api.deleteEvent(event.id); onDeleted?.(event.id); } catch (cause) { setMessage(errorMessage(cause)); } finally { setDeleting(false); } }
  return <form className="form-card" onSubmit={submit}><div className="panel-heading"><div><h3>{event ? 'Edit event' : 'Create an event'}</h3><p>{event ? 'Update the event details used by the host.' : 'Start a new local quiz event.'}</p></div>{event && <StatusPill>{event.status}</StatusPill>}</div><Field label="Event title"><input required minLength={2} maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Annual Quiz Night" /></Field><Field label="Description" hint="Optional"><textarea maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A short description for the event" /></Field><label className="checkbox"><input type="checkbox" checked={allowAnswerChanges} onChange={(e) => setAllowAnswerChanges(e.target.checked)} /> Allow contestants to change an answer before the deadline</label><div className="form-actions"><button className="button" disabled={saving || deleting}>{saving ? 'Saving…' : event ? 'Save changes' : 'Create event'}</button>{event && <button type="button" className="button danger" disabled={saving || deleting} onClick={() => void remove()}>{deleting ? 'Deleting…' : 'Delete event'}</button>}{!event && onCancel && <button type="button" className="button secondary" onClick={onCancel}>← Back to events</button>}{message && <span className={message.endsWith('.') ? 'success-text' : 'error-text'}>{message}</span>}</div></form>;
}

const overlayKinds = [
  ['main', 'Main'],
  ['question', 'Question'],
  ['timer', 'Timer'],
  ['leaderboard', 'Leaderboard'],
  ['round', 'Round'],
  ['announcement', 'Announcement'],
] as const;

function EventOverlayLinks({ event }: { event: EventItem }) {
  const [message, setMessage] = useState('');
  const urls = overlayKinds.map(([kind, label]) => ({
    kind,
    label,
    url: new URL(`/overlay/${kind}?eventId=${encodeURIComponent(event.id)}`, window.location.origin).toString(),
  }));

  async function copyUrl(url: string, label: string, kind: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        throw new Error('Clipboard API unavailable.');
      }
      setMessage(`${label} URL copied. Paste it into an OBS Browser Source.`);
    } catch {
      const field = document.getElementById(`overlay-url-${event.id}-${kind}`);
      if (!(field instanceof HTMLInputElement)) {
        setMessage('Could not copy the URL. Select and copy it manually.');
        return;
      }
      field?.focus();
      field?.select();
      setMessage(`Could not copy automatically. The ${label} URL is selected; copy it and paste it into OBS.`);
    }
  }

  return <section className="panel event-overlay-links">
    <div className="panel-heading">
      <div><h3>OBS overlay URLs</h3><p>Event-specific links, ready to paste into OBS Browser Sources.</p></div>
    </div>
    <div className="overlay-url-list">
      {urls.map(({ kind, label, url }) => <div className="overlay-url-row" key={kind}>
        <label htmlFor={`overlay-url-${event.id}-${kind}`}>{label}</label>
        <input id={`overlay-url-${event.id}-${kind}`} readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="button secondary small" onClick={() => void copyUrl(url, label, kind)}>Copy</button>
      </div>)}
    </div>
    {message && <p className={message.startsWith('Could not') ? 'error-text' : 'success-text'} role="status">{message}</p>}
  </section>;
}

function RoundManager({ event, selectedRoundId, onSelectRound }: { event: EventItem; selectedRoundId: string | null; onSelectRound: (round: RoundItem) => void }) {
  const [rounds, setRounds] = useState<RoundItem[]>([]); const [editing, setEditing] = useState<RoundItem | null>(null); const [formOpen, setFormOpen] = useState(false); const [name, setName] = useState(''); const [roundType, setRoundType] = useState('quick_questions'); const [orderIndex, setOrderIndex] = useState(0); const [configuration, setConfiguration] = useState('{}'); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); try { const value = await api.rounds(event.id); setRounds(value); if (selectedRoundId) { const selected = value.find((round) => round.id === selectedRoundId); if (selected) onSelectRound(selected); } } catch (cause) { setMessage(errorMessage(cause)); } finally { setLoading(false); } }, [event.id, onSelectRound, selectedRoundId]);
  useEffect(() => { void load(); }, [load]);
  function begin(round: RoundItem | null) { setEditing(round); setFormOpen(true); setName(round?.name ?? ''); setRoundType(round?.roundType ?? 'quick_questions'); setOrderIndex(round?.orderIndex ?? rounds.length); setConfiguration(JSON.stringify(round?.configuration ?? {}, null, 2)); setMessage(''); }
  async function submit(formEvent: FormEvent) { formEvent.preventDefault(); setMessage(''); let parsed: Record<string, unknown>; try { parsed = JSON.parse(configuration || '{}'); } catch { setMessage('Configuration must be valid JSON.'); return; } try { const saved = editing ? await api.updateRound(event.id, editing.id, { name, roundType, orderIndex, configuration: parsed }) : await api.createRound(event.id, { name, roundType, orderIndex, configuration: parsed }); setMessage('Round saved.'); setEditing(null); await load(); onSelectRound(saved); } catch (cause) { setMessage(errorMessage(cause)); } }
  return <section className="panel"><div className="panel-heading"><div><h3>Rounds</h3><p>Organize the formats and order for this event.</p></div><button className="button" onClick={() => begin(null)}>New round</button></div>{loading ? <p className="muted">Loading rounds…</p> : rounds.length === 0 ? <EmptyState title="No rounds yet" detail="Add a round before building its question bank." /> : <div className="round-list">{rounds.map((round) => <button className={`round-row ${selectedRoundId === round.id ? 'selected' : ''}`} key={round.id} onClick={() => onSelectRound(round)}><span className="order-number">{round.orderIndex + 1}</span><span><strong>{round.name}</strong><small>{labelFor(roundTypes, round.roundType)}</small></span><span className="row-actions"><span onClick={(e) => { e.stopPropagation(); begin(round); }}>Edit</span></span></button>)}</div>}{formOpen && <form className="inline-form" onSubmit={submit}><h4>{editing ? 'Edit round' : 'New round'}</h4><Field label="Round name"><input required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} placeholder="General Knowledge" /></Field><div className="form-grid"><Field label="Round type"><select value={roundType} onChange={(e) => setRoundType(e.target.value)}>{roundTypes.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="Display order"><input type="number" min="0" max="10000" value={orderIndex} onChange={(e) => setOrderIndex(Number(e.target.value))} /></Field></div><Field label="Configuration" hint="JSON, optional"><textarea className="code-field" value={configuration} onChange={(e) => setConfiguration(e.target.value)} /></Field><div className="form-actions"><button className="button" disabled={loading}>Save round</button><button type="button" className="button secondary" onClick={() => { setEditing(null); setFormOpen(false); setMessage(''); }}>Cancel</button>{message && <span className="error-text">{message}</span>}</div></form>}{message && !formOpen && <p className="error-text">{message}</p>}</section>;
}

function EventsPage({ events, selectedEvent, onSelectEvent, onEventSaved, onEventDeleted, selectedRound, onSelectRound }: { events: EventItem[]; selectedEvent: EventItem | null; onSelectEvent: (event: EventItem) => void; onEventSaved: (event: EventItem) => void; onEventDeleted: (eventId: string) => void; selectedRound: RoundItem | null; onSelectRound: (round: RoundItem) => void }) {
  const [activeTab, setActiveTab] = useState<'setup' | 'rounds' | 'participants' | 'scores' | 'overlays'>('setup');
  const [creatingEvent, setCreatingEvent] = useState(false);
  const selectEvent = (event: EventItem) => { onSelectEvent(event); setActiveTab('setup'); };
  const tabs = [
    ['setup', 'Event details'],
    ['rounds', 'Rounds'],
    ['participants', 'Participants'],
    ['scores', 'Scores & review'],
    ['overlays', 'Overlays'],
  ] as const;
  return <div className="page events-page"><SectionHeader eyebrow="CONTENT / EVENTS" title="Events" detail="Keep each quiz organised in one focused workspace." />{events.length === 0 && !selectedEvent ? <div className="event-empty-layout"><EventEditor event={null} onSaved={onEventSaved} /><EmptyState title="Start your first event" detail="Create an event, then add rounds, questions, and participants." /></div> : <div className="event-workspace"><aside className="event-sidebar"><div className="event-sidebar-heading"><div><span className="eyebrow">YOUR EVENTS</span><h3>Event library</h3></div><span>{events.length}</span></div><div className="event-list">{events.map((event) => <button className={`event-card ${selectedEvent?.id === event.id && !creatingEvent ? 'selected' : ''}`} key={event.id} onClick={() => { setCreatingEvent(false); selectEvent(event); }}><span><strong>{event.title}</strong><small>{event.description || 'No description'}</small></span><StatusPill>{event.status}</StatusPill></button>)}</div><button className="new-event-button" onClick={() => { setCreatingEvent(true); setActiveTab('setup'); }}>+ New event</button></aside><main className="event-main">{creatingEvent || !selectedEvent ? <EventEditor event={null} onSaved={(event) => { setCreatingEvent(false); onEventSaved(event); }} /> : <><div className="event-title-bar"><div><div className="eyebrow">EVENT WORKSPACE</div><h3>{selectedEvent.title}</h3><p>{selectedEvent.description || 'Build and run this event from one place.'}</p></div><StatusPill>{selectedEvent.status}</StatusPill></div><div className="event-tabs" role="tablist" aria-label="Event sections">{tabs.map(([id, label]) => <button key={id} className={activeTab === id ? 'active' : ''} role="tab" aria-selected={activeTab === id} onClick={() => setActiveTab(id)}>{label}</button>)}</div><div className="event-tab-panel">{activeTab === 'setup' && <EventEditor event={selectedEvent} onSaved={onEventSaved} onDeleted={onEventDeleted} />}{activeTab === 'rounds' && <RoundManager event={selectedEvent} selectedRoundId={selectedRound?.id ?? null} onSelectRound={onSelectRound} />}{activeTab === 'participants' && <ParticipantManager event={selectedEvent} />}{activeTab === 'scores' && <div className="stack"><LeaderboardPanel event={selectedEvent} /><SubmissionReviewPanel event={selectedEvent} /></div>}{activeTab === 'overlays' && <EventOverlayLinks event={selectedEvent} />}</div></>}</main></div>}</div>;
}

type QuestionDraft = { questionType: string; prompt: string; explanation: string; mediaPath: string; durationSeconds: number; points: number; penaltyPoints: number; orderIndex: number; status: string; assignedParticipantId: string; manualJudging: boolean; correctValue?: boolean; acceptedAnswers: string; speedBonusEnabled: boolean; speedBonusThresholdMs: number; speedBonusPoints: number; choices: Array<{ choiceText: string; isCorrect: boolean }>; rapidFireItems: Array<{ prompt: string; answerText: string }> };
const emptyQuestion = (orderIndex = 0): QuestionDraft => ({ questionType: 'quick_question', prompt: '', explanation: '', mediaPath: '', durationSeconds: 30, points: 10, penaltyPoints: 0, orderIndex, status: 'draft', assignedParticipantId: '', manualJudging: false, correctValue: undefined, acceptedAnswers: '', speedBonusEnabled: false, speedBonusThresholdMs: 5000, speedBonusPoints: 0, choices: [{ choiceText: '', isCorrect: false }, { choiceText: '', isCorrect: false }], rapidFireItems: [{ prompt: '', answerText: '' }] });

function draftFromQuestion(question: QuestionAdmin): QuestionDraft { return { questionType: question.questionType, prompt: question.prompt, explanation: question.explanation ?? '', mediaPath: question.mediaPath ?? '', durationSeconds: question.durationMs / 1000, points: question.points, penaltyPoints: question.penaltyPoints, orderIndex: question.orderIndex, status: question.status, assignedParticipantId: question.assignedParticipantId ?? '', manualJudging: question.manualJudging, correctValue: question.correctValue ?? undefined, acceptedAnswers: question.acceptedAnswers.map((answer) => answer.answerText).join('\n'), speedBonusEnabled: Boolean(question.scoring.speedBonus), speedBonusThresholdMs: question.scoring.speedBonus?.thresholdMs ?? 5000, speedBonusPoints: question.scoring.speedBonus?.points ?? 0, choices: question.choices.map((choice) => ({ choiceText: choice.choiceText, isCorrect: choice.isCorrect })), rapidFireItems: question.rapidFireItems.map(({ prompt, answerText }) => ({ prompt, answerText })) };
}
function QuestionEditor({ round, question, onSaved, onCancel }: { round: RoundItem; question: QuestionAdmin | null; onSaved: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<QuestionDraft>(() => question ? draftFromQuestion(question) : emptyQuestion()); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(''); const [participants, setParticipants] = useState<Array<{ id: string; displayName: string; teamIdentifier: string | null }>>([]);
  useEffect(() => { setDraft(question ? draftFromQuestion(question) : emptyQuestion()); setMessage(''); }, [question?.id, round.id]);
  useEffect(() => { void api.participants(round.eventId).then((items) => setParticipants(items.filter((item) => item.enabled))).catch((cause) => setMessage(errorMessage(cause))); }, [round.eventId]);
  const update = <K extends keyof QuestionDraft>(key: K, value: QuestionDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const [uploadingMedia, setUploadingMedia] = useState(false);
  async function selectClueFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setMessage('Choose a file of 5 MB or smaller.'); return; }
    setUploadingMedia(true); setMessage('');
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Unable to read this file.')); reader.readAsDataURL(file); });
      const saved = await api.uploadOverlayAsset(round.eventId, { contentType: file.type, data });
      update('mediaPath', `${apiBaseUrl}${saved.url}`);
      setMessage('Media stored locally. Save the question to attach it.');
    } catch (cause) { setMessage(errorMessage(cause)); }
    finally { setUploadingMedia(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    const choices = draft.choices.filter((choice) => choice.choiceText.trim()).map((choice, index) => ({ ...choice, orderIndex: index }));
    const body = {
      questionType: draft.questionType,
      prompt: draft.questionType === 'rapid_fire' ? 'Rapid Fire' : draft.prompt,
      explanation: draft.explanation || undefined,
      mediaPath: draft.mediaPath || undefined,
      durationMs: Math.round(Number(draft.durationSeconds) * 1000),
      points: Number(draft.points),
      penaltyPoints: Number(draft.penaltyPoints),
      orderIndex: Number(draft.orderIndex),
      status: draft.status,
      assignedParticipantId: draft.assignedParticipantId || null,
      manualJudging: draft.manualJudging,
      correctValue: draft.questionType === 'true_false' ? draft.correctValue : undefined,
      scoring: draft.speedBonusEnabled ? { speedBonus: { thresholdMs: draft.speedBonusThresholdMs, points: draft.speedBonusPoints } } : {},
      acceptedAnswers: draft.acceptedAnswers.split('\n').map((answer) => answer.trim()).filter(Boolean).map((answerText) => ({ answerText })),
      choices,
      rapidFireItems: draft.questionType === 'rapid_fire' ? draft.rapidFireItems : [],
    };
    try {
      if (question) await api.updateQuestion(question.id, body);
      else await api.createQuestion(round.id, body);
      setMessage('Question saved.');
      onSaved();
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="form-card question-editor" onSubmit={submit}>
      <div className="panel-heading"><div><div className="eyebrow">QUESTION EDITOR</div><h3>{question ? 'Edit question' : 'New question'}</h3><p>Answers and correctness metadata are saved in the protected admin store.</p></div><button type="button" className="close-button" onClick={onCancel}>← Back to question bank</button></div>
      <Field label="Question type"><select value={draft.questionType} onChange={(e) => update('questionType', e.target.value)}>{questionTypes.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      {draft.questionType !== 'rapid_fire' && <Field label="Prompt"><textarea required minLength={1} maxLength={10000} rows={5} value={draft.prompt} onChange={(e) => update('prompt', e.target.value)} placeholder="Write the question prompt" /></Field>}
      {draft.questionType === 'rapid_fire' && (
        <div className="choice-editor rapid-fire-editor">
          <div className="field-title">Rapid-fire prompts <small>Each correct answer earns an equal share of the question points.</small></div>
          {draft.rapidFireItems.map((item, index) => (
            <div className="rapid-fire-item-editor" key={index}>
              <strong>Prompt {index + 1}</strong>
              <Field label={`Prompt ${index + 1}`}><textarea required maxLength={10000} rows={2} value={item.prompt} onChange={(event) => update('rapidFireItems', draft.rapidFireItems.map((entry, itemIndex) => itemIndex === index ? { ...entry, prompt: event.target.value } : entry))} /></Field>
              <Field label={`Accepted answer ${index + 1}`}><input required maxLength={1000} value={item.answerText} onChange={(event) => update('rapidFireItems', draft.rapidFireItems.map((entry, itemIndex) => itemIndex === index ? { ...entry, answerText: event.target.value } : entry))} /></Field>
              <button type="button" className="icon-button" aria-label={`Remove prompt ${index + 1}`} disabled={draft.rapidFireItems.length === 1} onClick={() => update('rapidFireItems', draft.rapidFireItems.filter((_, itemIndex) => itemIndex !== index))}>×</button>
            </div>
          ))}
          <button type="button" className="button secondary small" disabled={draft.rapidFireItems.length >= 50} onClick={() => update('rapidFireItems', [...draft.rapidFireItems, { prompt: '', answerText: '' }])}>Add prompt</button>
        </div>
      )}
      <div className="form-grid three"><Field label="Duration (seconds)"><input type="number" min="0.1" max="86400" step="0.1" value={draft.durationSeconds} onChange={(e) => update('durationSeconds', Number(e.target.value))} /></Field><Field label="Points"><input type="number" min="0" max="1000000" value={draft.points} onChange={(e) => update('points', Number(e.target.value))} /></Field><Field label="Penalty points"><input type="number" min="0" max="1000000" value={draft.penaltyPoints} onChange={(e) => update('penaltyPoints', Number(e.target.value))} /></Field></div>
      <label className="checkbox"><input type="checkbox" checked={draft.speedBonusEnabled} onChange={(e) => update('speedBonusEnabled', e.target.checked)} /> Enable answer-speed bonus</label>
      {draft.speedBonusEnabled && <div className="form-grid"><Field label="Answer within (ms)"><input type="number" min="0" max="86400000" value={draft.speedBonusThresholdMs} onChange={(e) => update('speedBonusThresholdMs', Number(e.target.value))} /></Field><Field label="Bonus points"><input type="number" min="0" max="1000000" value={draft.speedBonusPoints} onChange={(e) => update('speedBonusPoints', Number(e.target.value))} /></Field></div>}
      <div className="form-grid three"><Field label="Status"><select value={draft.status} onChange={(e) => update('status', e.target.value)}><option value="draft">Draft</option><option value="ready">Published</option><option value="retired">Retired</option></select></Field><Field label="Assigned participant / team"><select value={draft.assignedParticipantId} onChange={(e) => update('assignedParticipantId', e.target.value)}><option value="">Open to all</option>{participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.displayName}{participant.teamIdentifier ? ` (${participant.teamIdentifier})` : ''}</option>)}</select></Field><Field label="Display order"><input type="number" min="0" value={draft.orderIndex} onChange={(e) => update('orderIndex', Number(e.target.value))} /></Field></div>
      <Field label="Explanation" hint="Optional"><textarea maxLength={5000} value={draft.explanation} onChange={(e) => update('explanation', e.target.value)} /></Field>
      <Field label="Clue image or audio" hint="Stored on this quiz server · up to 5 MB"><input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/flac" disabled={uploadingMedia} onChange={(event) => void selectClueFile(event.target.files?.[0])} /></Field>
      {uploadingMedia && <p className="muted">Saving media locally…</p>}
      {draft.mediaPath && <div className="clue-file-preview">{/\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(draft.mediaPath) ? <audio controls src={draft.mediaPath} /> : <img src={draft.mediaPath} alt="Selected clue preview" style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }} />}<button type="button" className="button secondary small" onClick={() => update('mediaPath', '')}>Remove attachment</button></div>}
      {draft.questionType === 'true_false' && <Field label="Correct value"><select value={draft.correctValue === undefined ? '' : String(draft.correctValue)} required onChange={(e) => update('correctValue', e.target.value === 'true')}><option value="">Choose a value</option><option value="true">True</option><option value="false">False</option></select></Field>}
      {draft.questionType === 'multiple_choice' && <div className="choice-editor"><div className="field-title">Options <small>Choose exactly one correct option.</small></div>{draft.choices.map((choice, index) => <div className="choice-line" key={index}><input aria-label={`Option ${index + 1}`} value={choice.choiceText} onChange={(e) => update('choices', draft.choices.map((item, itemIndex) => itemIndex === index ? { ...item, choiceText: e.target.value } : item))} placeholder={`Option ${index + 1}`} /><label className="checkbox"><input type="radio" name="correct-option" checked={choice.isCorrect} onChange={() => update('choices', draft.choices.map((item, itemIndex) => ({ ...item, isCorrect: itemIndex === index })))} /> Correct</label><button type="button" className="icon-button" aria-label={`Remove option ${index + 1}`} onClick={() => update('choices', draft.choices.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}<button type="button" className="button secondary small" onClick={() => update('choices', [...draft.choices, { choiceText: '', isCorrect: false }])}>Add option</button></div>}
      {draft.questionType !== 'multiple_choice' && draft.questionType !== 'true_false' && draft.questionType !== 'rapid_fire' && <Field label="Accepted answers" hint="One answer per line; original trimmed text is preserved"><textarea rows={4} value={draft.acceptedAnswers} onChange={(e) => update('acceptedAnswers', e.target.value)} placeholder={'Example:\nAlternative spelling'} /></Field>}
      <label className="checkbox"><input type="checkbox" checked={draft.manualJudging} onChange={(e) => update('manualJudging', e.target.checked)} /> Manual judging required</label>
      <div className="form-actions"><button className="button" disabled={saving}>{saving ? 'Saving…' : 'Save question'}</button><button type="button" className="button secondary" onClick={onCancel}>Cancel</button>{message && <span className={message === 'Question saved.' ? 'success-text' : 'error-text'}>{message}</span>}</div>
    </form>
  );
}

function QuestionBank({ events }: { events: EventItem[] }) {
  const [eventId, setEventId] = useState(events[0]?.id ?? ''); const [rounds, setRounds] = useState<RoundItem[]>([]); const [roundId, setRoundId] = useState(''); const [questions, setQuestions] = useState<QuestionItem[]>([]); const [participants, setParticipants] = useState<Array<{ id: string; displayName: string; teamIdentifier: string | null }>>([]); const [editing, setEditing] = useState<QuestionAdmin | null | undefined>(undefined); const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all'); const [message, setMessage] = useState('');
  useEffect(() => { if (!eventId && events[0]) setEventId(events[0].id); if (eventId && !events.find((event) => event.id === eventId)) setEventId(events[0]?.id ?? ''); }, [events, eventId]);
  useEffect(() => { if (!eventId) { setRounds([]); return; } void api.rounds(eventId).then((value) => { setRounds(value); setRoundId((current) => value.some((round) => round.id === current) ? current : value[0]?.id ?? ''); }).catch((cause) => setMessage(errorMessage(cause))); }, [eventId]);
  useEffect(() => { if (!eventId) { setParticipants([]); return; } void api.participants(eventId).then(setParticipants).catch((cause) => setMessage(errorMessage(cause))); }, [eventId]);
  const loadQuestions = useCallback(async () => { if (!eventId || !roundId) { setQuestions([]); return; } try { setQuestions(await api.questions(eventId, roundId)); } catch (cause) { setMessage(errorMessage(cause)); } }, [eventId, roundId]);
  useEffect(() => { void loadQuestions(); }, [loadQuestions]);
  const visible = useMemo(() => questions.filter((question) => (!search || question.prompt.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && (filter === 'all' || question.questionType === filter || question.status === filter)), [filter, questions, search]);
  async function edit(question: QuestionItem) { try { setEditing(await api.questionAdmin(question.id)); } catch (cause) { setMessage(errorMessage(cause)); } }
  async function duplicate(question: QuestionItem) { try { await api.duplicateQuestion(question.id); setMessage('Question duplicated as a draft.'); await loadQuestions(); } catch (cause) { setMessage(errorMessage(cause)); } }
  async function remove(question: QuestionItem) { if (!window.confirm(`Delete this question permanently?\n\n“${question.prompt.slice(0, 120)}”\n\nThis cannot be undone. Questions already used in a live session cannot be deleted; retire them instead.`)) return; try { await api.deleteQuestion(question.id); setMessage('Question deleted.'); await loadQuestions(); } catch (cause) { setMessage(errorMessage(cause)); } }
  async function move(question: QuestionItem, direction: -1 | 1) { const index = questions.findIndex((item) => item.id === question.id); const next = index + direction; if (next < 0 || next >= questions.length) return; const ids = questions.map((item) => item.id); [ids[index], ids[next]] = [ids[next], ids[index]]; try { await api.reorderQuestions(roundId, ids); await loadQuestions(); } catch (cause) { setMessage(errorMessage(cause)); } }
  if (editing !== undefined && roundId) return <div className="page"><QuestionEditor round={rounds.find((round) => round.id === roundId)!} question={editing} onSaved={() => { setEditing(undefined); void loadQuestions(); }} onCancel={() => setEditing(undefined)} /></div>;
  return <div className="page"><SectionHeader eyebrow="CONTENT / QUESTION BANK" title="Question bank" detail="Create, search and organize the questions used by your rounds." /><div className="toolbar"><Field label="Event"><select value={eventId} onChange={(e) => setEventId(e.target.value)}>{events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}</select></Field><Field label="Round"><select value={roundId} onChange={(e) => setRoundId(e.target.value)}>{rounds.map((round) => <option key={round.id} value={round.id}>{round.orderIndex + 1}. {round.name}</option>)}</select></Field><Field label="Search"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search prompts" /></Field><Field label="Filter"><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All questions</option><option value="draft">Draft</option><option value="ready">Published</option>{questionTypes.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></div>{message && <p className="error-text banner-message">{message}</p>}{!eventId || !roundId ? <EmptyState title="Choose an event and round" detail="Create an event and at least one round before adding questions." /> : <section className="panel"><div className="panel-heading"><div><h3>{rounds.find((round) => round.id === roundId)?.name}</h3><p>{visible.length} question{visible.length === 1 ? '' : 's'} shown</p></div><button className="button" onClick={() => setEditing(null)}>New question</button></div>{visible.length === 0 ? <EmptyState title="No matching questions" detail={questions.length === 0 ? 'Add the first question to this round.' : 'Try a different search or filter.'} action={questions.length === 0 && <button className="button" onClick={() => setEditing(null)}>Create question</button>} /> : <div className="question-list">{visible.map((question) => { const assigned = participants.find((participant) => participant.id === question.assignedParticipantId); return <article className="question-row" key={question.id}><div className="question-number">{question.orderIndex + 1}</div><div className="question-copy"><strong>{question.prompt}</strong><span>{labelFor(questionTypes, question.questionType)} · {question.durationMs / 1000}s · {question.points} pts</span>{assigned && <span className="question-assignment">Assigned to: <b>{assigned.displayName}</b>{assigned.teamIdentifier ? ` · ${assigned.teamIdentifier}` : ''}</span>}{question.assignedParticipantId && !assigned && <span className="question-assignment muted">Assigned participant unavailable</span>}</div><StatusPill tone={question.status === 'ready' ? 'success' : 'warning'}>{question.status === 'ready' ? 'Published' : question.status}</StatusPill><div className="row-actions"><button className="link-button" onClick={() => { void edit(question); }}>Edit</button><button className="link-button" onClick={() => { void duplicate(question); }}>Duplicate</button><button className="link-button" onClick={() => { void move(question, -1); }}>Up</button><button className="link-button" onClick={() => { void move(question, 1); }}>Down</button><button className="link-button danger-link" onClick={() => { void remove(question); }}>Delete</button></div></article>; })}</div>}</section>}</div>;
}

function AdminLogin({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      await api.adminAuth(token);
      onAuthenticated();
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return <main className="page"><form className="form-card" onSubmit={submit}><div className="eyebrow">LOCAL ADMIN ACCESS</div><h2>Sign in to manage the quiz</h2><p>Enter the server's configured admin secret. It stays in this browser session.</p><Field label="Admin secret"><input type="password" autoComplete="current-password" required value={token} onChange={(event) => setToken(event.target.value)} /></Field><div className="form-actions"><button className="button" disabled={saving}>{saving ? 'Checking…' : 'Continue'}</button>{message && <span className="error-text" role="alert">{message}</span>}</div><p className="muted">Configure MZP_ADMIN_TOKEN on the server before signing in.</p></form></main>;
}

export function App() {
  const [route, setRoute] = useState<Route>(getActiveRoute);
  const [adminAuthorized, setAdminAuthorized] = useState(false);
  const [checkingAdmin, setCheckingAdmin] = useState(true);
  const [view, setView] = useState<View>('dashboard'); const [backend, setBackend] = useState<ServiceState>('checking'); const [database, setDatabase] = useState<ServiceState>('checking'); const [migration, setMigration] = useState<ServiceState>('checking'); const [counts, setCounts] = useState<{ events: number; rounds: number; questions: number } | null>(null); const [events, setEvents] = useState<EventItem[]>([]); const [selectedEventId, setSelectedEventId] = useState<string | null>(null); const [selectedRound, setSelectedRound] = useState<RoundItem | null>(null); const [globalError, setGlobalError] = useState('');

  useEffect(() => {
    const handler = () => setRoute(getActiveRoute());
    window.addEventListener('popstate', handler);
    window.addEventListener('hashchange', handler);
    return () => {
      window.removeEventListener('popstate', handler);
      window.removeEventListener('hashchange', handler);
    };
  }, []);
  useEffect(() => {
    const token = getAdminToken();
    if (!token) {
      setCheckingAdmin(false);
      return;
    }
    void api.adminAuth(token).then(() => setAdminAuthorized(true)).catch(() => {
      api.clearAdminToken();
      setAdminAuthorized(false);
    }).finally(() => setCheckingAdmin(false));
  }, []);

  const load = useCallback(async () => { setGlobalError(''); try { await api.health(); setBackend('connected'); } catch { setBackend('offline'); setDatabase('offline'); setMigration('offline'); setGlobalError('The backend is unavailable. Start the Fastify server to manage local data.'); return; } try { const health = await api.databaseHealth(); setDatabase(health.database.connected ? 'connected' : 'offline'); setMigration(health.migrations.applied > 0 ? 'connected' : 'offline'); const [dashboard, eventList] = await Promise.all([api.dashboard(), api.events()]); setCounts(dashboard); setEvents(eventList); if (selectedEventId) { const current = eventList.find((event) => event.id === selectedEventId); if (current) setSelectedEventId(current.id); } } catch (cause) { setDatabase('offline'); setMigration('offline'); setGlobalError(errorMessage(cause)); } }, [selectedEventId]);
  useEffect(() => { void load(); }, [load]);
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null;
  function savedEvent(event: EventItem) { setEvents((current) => [event, ...current.filter((item) => item.id !== event.id)]); setSelectedEventId(event.id); void load(); }

  if (route === 'overlay') {
    return <OverlayScreen />;
  }
  if (route === 'team') return <TeamScreen />;
  if (!adminAuthorized) {
    return checkingAdmin
      ? <main className="page"><p className="muted">Checking admin access…</p></main>
      : <AdminLogin onAuthenticated={() => setAdminAuthorized(true)} />;
  }

  const navItems: Array<[View, string, string]> = [['dashboard', 'Dashboard', 'Overview'], ['live', 'Live Control', 'Manage live game'], ['events', 'Events', 'Prepare events'], ['questions', 'Question Bank', 'Manage content'], ['overlays', 'OBS Overlays', 'Broadcast layouts'], ['settings', 'Settings', 'Application']];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span><strong>MZP Quiz</strong><small>Control software</small></span>
        </div>
        <nav aria-label="Main navigation">
          {navItems.map(([key, label, detail]) => (
            <button className={view === key ? 'active' : ''} key={key} onClick={() => setView(key)}>
              <span className="nav-icon" aria-hidden="true">{key === 'dashboard' ? '▦' : key === 'live' ? '▶' : key === 'events' ? '▤' : key === 'questions' ? '≡' : key === 'overlays' ? '◫' : '⚙'}</span>
              <span><strong>{label}</strong><small>{detail}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusPill tone={backend === 'connected' ? 'success' : backend === 'checking' ? 'warning' : 'neutral'}>
            {backend === 'connected' ? 'Backend connected' : backend === 'checking' ? 'Checking backend' : 'Backend offline'}
          </StatusPill>
          <small>Offline-first development workspace</small>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div><span className="breadcrumb">MZP QUIZ / {navItems.find(([key]) => key === view)?.[1].toUpperCase()}</span></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.65rem' }}>
            <button className="button secondary" onClick={() => { void load(); }}>Refresh data</button>
            <button className="button secondary small" onClick={() => { api.clearAdminToken(); setAdminAuthorized(false); }}>Sign out</button>
          </div>
        </header>
        {globalError && <div className="global-error" role="alert">{globalError}</div>}
        {view === 'dashboard' && <Dashboard counts={counts} events={events} onNavigate={setView} />}
        {view === 'live' && <LiveControl events={events} />}
        {view === 'events' && <EventsPage events={events} selectedEvent={selectedEvent} onSelectEvent={(event) => { setSelectedEventId(event.id); setSelectedRound(null); }} onEventSaved={savedEvent} onEventDeleted={(eventId) => { setEvents((current) => current.filter((event) => event.id !== eventId)); setSelectedEventId(null); setSelectedRound(null); }} selectedRound={selectedRound} onSelectRound={setSelectedRound} />}
        {view === 'questions' && <QuestionBank events={events} />}
        {view === 'overlays' && <OverlaySettingsPanel events={events} />}
        {view === 'settings' && (
          <div className="page">
            <SectionHeader eyebrow="APPLICATION" title="Settings" detail="Basic local application information for this development-stage build." />
            <section className="panel settings-panel">
              <div><h3>Connection</h3><p>Frontend API endpoint</p><code>{apiBaseUrl}</code></div>
              <div>
                <h3>Database</h3>
                <p>Connection: <StatusPill tone={database === 'connected' ? 'success' : 'warning'}>{database}</StatusPill></p>
                <p>Migrations: <StatusPill tone={migration === 'connected' ? 'success' : 'warning'}>{migration === 'connected' ? 'Applied' : migration === 'checking' ? 'Checking' : 'Unavailable'}</StatusPill></p>
              </div>
              <div className="notice"><strong>Admin security</strong><p>Administrative API and WebSocket access require the server-configured local secret.</p></div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
