import { Heart, ChevronRight } from 'lucide-react';
import { OurDayModal } from './OurDayModal';
import { useEffect, useRef, useState } from 'react';
import { requireSupabase } from '../../lib/supabaseClient';
import { activities, moods, fetchEverydayStatuses, saveEverydayStatus, clearEverydayStatus, acknowledgeEverydayStatus, type EverydayStatus } from '../../lib/everydayStatusService';
import './everydayStatus.css';

interface StatusTransport {
  fetch: typeof fetchEverydayStatuses;
  save: typeof saveEverydayStatus;
  clear: typeof clearEverydayStatus;
  acknowledge: typeof acknowledgeEverydayStatus;
  subscribe: (coupleId: string, userId: string, refresh: () => void) => () => void;
}
const liveTransport: StatusTransport = {
  fetch: fetchEverydayStatuses, save: saveEverydayStatus, clear: clearEverydayStatus,
  acknowledge: acknowledgeEverydayStatus,
  subscribe(coupleId, userId, refresh) {
    const client = requireSupabase();
    const channel = client.channel(`everyday:${coupleId}:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'everyday_status', filter: `couple_id=eq.${coupleId}` }, refresh)
      .subscribe((status) => { if (status === 'SUBSCRIBED') refresh(); });
    return () => { void client.removeChannel(channel); };
  },
};
interface Props { transport?: StatusTransport; coupleId: string; userId: string; partnerId: string; partnerName: string; onMessage: () => void }

/** Remounted by account/couple key: drafts and asynchronous results never cross accounts. */
export function EverydayStatusCards(props: Props) {
  return <StatusCards key={`${props.coupleId}:${props.userId}:${props.partnerId}`} {...props} />;
}
function StatusCards({ coupleId, userId, partnerId, partnerName, onMessage, transport = liveTransport }: Props) {
  const [rows, setRows] = useState<EverydayStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [mood, setMood] = useState('');
  const [activity, setActivity] = useState('');
  const [note, setNote] = useState('');
  const [hours, setHours] = useState(12);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const sequence = useRef(0);
  async function refresh() {
    const seq = ++sequence.current;
    try {
      const next = await transport.fetch(coupleId);
      if (mounted.current && seq === sequence.current) { setRows(next); setError(null); }
    } catch (err) {
      if (mounted.current && seq === sequence.current) setError(err instanceof Error ? err.message : 'Could not load check-ins.');
    } finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 30_000);
    const resume = () => { if (document.visibilityState === 'visible') { setNow(Date.now()); void refresh(); } };
    document.addEventListener('visibilitychange', resume);
    const unsubscribe = transport.subscribe(coupleId, userId, () => { void refresh(); });
    return () => { mounted.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', resume); unsubscribe(); };
    // Scope changes remount this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const active = rows.filter(row => Date.parse(row.expires_at) > now);
  const mine = active.find(row => row.user_id === userId);
  const theirs = active.find(row => row.user_id === partnerId);
  async function run(action: () => Promise<void>, close = false) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await action();
      if (!mounted.current) return;
      if (close) setEditing(false);
      await refresh();
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : 'Please try again.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  function snapshot(row: EverydayStatus | undefined) {
    if (!row) return <p className="day-muted">{loading ? 'Loading check-in…' : 'No update right now'}</p>;
    const minutes = Math.max(0, Math.floor((now - Date.parse(row.updated_at)) / 60_000));
    return <>
      <p className="day-summary">{[row.mood, row.activity].filter(Boolean).join(' · ')}</p>
      {row.note && <p className="day-note">{row.note}</p>}
      <p className="day-muted">Updated {minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`} · Expires {new Date(row.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
    </>;
  }
  const closeModal = () => { setOpen(false); setEditing(false); };
  return <>
    <button type="button" className="our-day-card" data-card="our-day" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setNow(Date.now()); setOpen(true); void refresh(); }}>
      <span className="our-day-card-title"><Heart size={13} aria-hidden="true" /> Our day <ChevronRight size={14} aria-hidden="true" /></span>
      <span className="our-day-card-subtext">{loading ? 'A little of our day' : error ? 'Check-ins unavailable · Tap to retry' : theirs ? `${partnerName} left a message` : `Update ${partnerName} on your day`}</span>
    </button>
    {open && <OurDayModal onClose={closeModal}>
    <div className="day-grid">
      <article><h3>Your day</h3>{snapshot(mine)}
        {mine?.acknowledged_at && <p className="day-ack">💛 {partnerName} is thinking of you</p>}
        <button type="button" disabled={loading || busy} onClick={() => { setMood(mine?.mood ?? ''); setActivity(mine?.activity ?? ''); setNote(mine?.note ?? ''); setHours(12); setEditing(true); }}>Update my day</button>
        {mine && <button type="button" disabled={busy} onClick={() => void run(transport.clear)}>Clear</button>}
      </article>
      <article><h3>{partnerName}’s day</h3>{snapshot(theirs)}
        {theirs && <button type="button" disabled={busy || !!theirs.acknowledged_at} onClick={() => void run(() => transport.acknowledge(theirs))}>{theirs.acknowledged_at ? '💛 Sent with love' : '💛 Thinking of you'}</button>}
        <button type="button" onClick={() => { closeModal(); onMessage(); }}>Message</button>
      </article>
    </div>
    {error && <p role="alert">{error} <button type="button" disabled={busy} onClick={() => void refresh()}>Retry</button></p>}
    {editing && <div className="day-editor">
      <form aria-label="Update my day" onSubmit={event => { event.preventDefault(); void run(() => transport.save(mood, activity, note, hours), true); }}>
        <h3>How’s your day?</h3><p>All optional. Share just what feels right.</p>
        <label>How are you feeling?<select value={mood} onChange={e => setMood(e.target.value)}><option value="">Rather not say</option>{moods.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>What are you up to?<select value={activity} onChange={e => setActivity(e.target.value)}><option value="">Rather not say</option>{activities.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>A little note<textarea value={note} maxLength={120} onChange={e => setNote(e.target.value)} placeholder="A busy day, but thinking of you…" /><small>{note.length}/120</small></label>
        <label>Keep this update for<select value={hours} onChange={e => setHours(Number(e.target.value))}><option value={1}>1 hour</option><option value={4}>4 hours</option><option value={12}>12 hours</option></select></label>
        <p className="day-muted">Only your partner can see this. No notification is sent. “Free to talk” is your choice, not online tracking.</p>
        <button type="submit" disabled={busy || (!mood && !activity && !note.trim())}>{busy ? 'Saving…' : 'Share my day'}</button>
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      </form>
    </div>}
    </OurDayModal>}
  </>;
}
