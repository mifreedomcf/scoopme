import { useEffect, useState } from "react";
import { base44, postMessage, readMessages, type ApiError } from "@/lib/api";
import { Empty } from "@/components/Chrome";

interface Thread {
  id: string; kind: string; subject?: string; locked: boolean;
  lock_reason?: string; last_message_at?: string;
}
interface Msg { id: string; sender_role: string; body: string; sent_at: string }

const KIND_LABELS: Record<string, string> = {
  adult_ride: "About a ride",
  minor_ride: "About a child's ride",
  support: "Support",
  organization: "Organization",
};

export default function Messages() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [open, setOpen] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    base44.entities.MessageThread.list("-last_message_at", 50)
      .then((rows) => setThreads(rows as Thread[]))
      .catch(() => setNote("We could not load your messages."));
  }, []);

  async function openThread(thread: Thread) {
    setOpen(thread);
    setNote(null);
    try {
      const r = await readMessages(thread.id);
      const res = r as unknown as { messages: Msg[]; notice?: string };
      setMessages(res.messages);
      if (res.notice) setNote(res.notice);
    } catch (err) {
      setNote((err as ApiError).message);
    }
  }

  async function send() {
    if (!open) return;
    setNote(null);
    try {
      const r = await postMessage(open.id, draft);
      const res = r as { notice?: string };
      if (res.notice) setNote(res.notice);
      setDraft("");
      await openThread(open);
    } catch (err) {
      setNote((err as ApiError).message);
    }
  }

  if (open) {
    return (
      <main id="main" className="pad">
        <button className="btn btn--secondary" onClick={() => setOpen(null)}>Back to all messages</button>
        <h1>{KIND_LABELS[open.kind] ?? "Conversation"}</h1>

        {open.kind === "minor_ride" && (
          <div className="band band--pilot" role="note" style={{ margin: "1rem 0" }}>
            A coordinator can see everything here, and every time it is opened is recorded. Drivers and
            children never message each other — this goes through the guardian.
          </div>
        )}

        {note && <p role="status" className="field-error">{note}</p>}

        {messages.length === 0 && <Empty title="Nothing yet" body="Write the first message below." />}
        {messages.map((m) => (
          <article className="record" key={m.id}>
            <span className="status status--wait">{m.sender_role.replace(/_/g, " ")}</span>
            <p>{m.body}</p>
            <p className="meta">{new Date(m.sent_at).toLocaleString()}</p>
          </article>
        ))}

        {open.locked ? (
          <p className="field-error">{open.lock_reason ?? "This conversation is closed."}</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="draft">Your message</label>
              <span className="hint">
                Keep it here. Phone numbers and email addresses are removed automatically, and on a child&apos;s
                conversation they are refused outright.
              </span>
              <textarea id="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
            </div>
            <button className="btn btn--primary" onClick={send} disabled={draft.trim().length === 0}>Send</button>
          </>
        )}
      </main>
    );
  }

  return (
    <main id="main" className="pad">
      <h1>Messages</h1>
      {note && <p role="status" className="field-error">{note}</p>}
      {threads.length === 0 && (
        <Empty title="No messages" body="Conversations about your rides appear here. Everything stays in the app so a coordinator can help if something goes wrong." />
      )}
      {threads.map((t) => (
        <article className="record" key={t.id}>
          <span className="status status--wait">{KIND_LABELS[t.kind] ?? t.kind}</span>
          <h3>{t.subject ?? "Conversation"}</h3>
          {t.last_message_at && <p className="meta">{new Date(t.last_message_at).toLocaleString()}</p>}
          <button className="btn btn--secondary" onClick={() => openThread(t)}>Open</button>
        </article>
      ))}
    </main>
  );
}
