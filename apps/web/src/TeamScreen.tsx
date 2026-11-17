import { useEffect, useState } from 'react';
import { api } from './api';

export function TeamScreen() {
  const query = new URLSearchParams(window.location.search);
  const eventId = query.get('eventId') ?? '';
  const participantId = query.get('participantId') ?? '';
  const [data, setData] = useState<Awaited<ReturnType<typeof api.teamScreen>> | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const next = await api.teamScreen(eventId, participantId); if (active) { setData(next); setError(''); } }
      catch { if (active) { setData(null); setError('Connection unavailable. Reconnecting…'); } }
    };
    void refresh(); const poll = window.setInterval(() => void refresh(), 500);
    const clock = window.setInterval(() => setNow(Date.now()), 200);
    return () => { active = false; clearInterval(poll); clearInterval(clock); };
  }, [eventId, participantId]);
  const session = data?.session;
  const question = session?.question;
  const remaining = Math.ceil(Math.max(0, session?.questionState === 'active' && session.timer.deadlineTimestamp ? session.timer.deadlineTimestamp - now : session?.timer.timeRemainingMs ?? 0) / 1000);
  const prompt = question?.questionType === 'rapid_fire' ? session?.rapidFire?.items[session.rapidFire.currentItemIndex]?.prompt : question?.prompt;
  return <main className="team-display">
    <header className="team-display-header"><div><small>COMPETITOR DISPLAY</small><h1>{data?.participant.displayName ?? 'Team screen'}</h1></div><button className="button secondary" onClick={() => void document.documentElement.requestFullscreen?.()}>Full screen</button></header>
    {question && session ? <section className="team-display-question" aria-live="polite"><div className="team-display-meta"><span>{session.round?.name} · Question {question.orderIndex + 1}</span><strong>{Math.floor(remaining / 60).toString().padStart(2, '0')}:{(remaining % 60).toString().padStart(2, '0')}</strong></div><h2>{prompt}</h2>
      {question.mediaPath && (/\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(question.mediaPath) ? <audio controls src={question.mediaPath} /> : <img className="team-display-media" src={question.mediaPath} alt="Question clue" />)}
      <div className="team-display-choices">{question.choices.map((choice, index) => <div key={choice.id}><b>{String.fromCharCode(65 + index)}</b><span>{choice.choiceText || 'Waiting for option…'}</span></div>)}</div>
      <footer>{session.status === 'paused' ? 'Session paused' : session.questionState === 'expired' ? 'Time is up' : session.questionState === 'revealed' ? 'Answer revealed · follow the host' : 'Listen to your host'}</footer>
    </section> : <section className="team-display-waiting"><span>●</span><h2>{error || 'Ready for your next question'}</h2><p>Your assigned question will appear here when the host reveals it.</p></section>}
  </main>;
}
