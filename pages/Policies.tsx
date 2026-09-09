import { useEffect, useState } from "react";
import { acceptLegalDocument, base44, type AppConfig } from "@/lib/api";

interface Doc {
  id: string; document_key: string; version: string; title: string;
  body_markdown: string; review_status: string; applies_to_roles?: string[];
}

/** Deliberately minimal markdown rendering: headings, blockquote, bold, paragraphs. */
function renderBlocks(markdown: string) {
  return markdown.split("\n\n").map((block, i) => {
    const trimmed = block.trim();
    if (trimmed.startsWith("> ")) {
      return <blockquote key={i}>{trimmed.replace(/^> /gm, "").replace(/\*\*/g, "")}</blockquote>;
    }
    if (trimmed.startsWith("## ")) return <h2 key={i}>{trimmed.slice(3)}</h2>;
    const bolded = trimmed.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
      part.startsWith("**") ? <strong key={j}>{part.slice(2, -2)}</strong> : part,
    );
    return <p key={i}>{bolded}</p>;
  });
}

export default function Policies({ config }: { config: AppConfig | null }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [open, setOpen] = useState<Doc | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    base44.entities.LegalDocument.filter({ published: true }, "document_key", 50)
      .then((rows) => setDocs(rows as Doc[])).catch(() => setDocs([]));
  }, []);

  async function accept(doc: Doc) {
    try {
      await acceptLegalDocument(doc.id, config?.roles?.roles?.[0] ?? "adult_rider");
      setNote(`Recorded your acceptance of ${doc.title} version ${doc.version}.`);
    } catch (e) { setNote((e as Error).message); }
  }

  if (open) {
    return (
      <main id="main" className="pad doc">
        <button className="btn btn--secondary" onClick={() => setOpen(null)}>Back to all policies</button>
        <h1>{open.title}</h1>
        <p className="meta">Version {open.version} · {open.review_status.replace(/_/g, " ")}</p>
        {renderBlocks(open.body_markdown)}
        <div className="actions">
          <button className="btn btn--primary" onClick={() => accept(open)}>I have read and accept this version</button>
        </div>
        {note && <p role="status">{note}</p>}
      </main>
    );
  }

  return (
    <main id="main" className="pad">
      <h1>Policies and safety</h1>
      <p>
        Every document here is a draft written for review by an attorney and an insurer. None of it has been
        approved, and none of it is legal advice.
      </p>
      {note && <p role="status">{note}</p>}
      {docs.length === 0 && <p>No documents are published yet.</p>}
      {docs.map((d) => (
        <article className="record" key={d.id}>
          <span className="status status--wait">{d.review_status.replace(/_/g, " ")}</span>
          <h3>{d.title}</h3>
          <p className="meta">Version {d.version}</p>
          <button className="btn btn--secondary" onClick={() => setOpen(d)}>Read it</button>
        </article>
      ))}
      <p className="footnote">
        Accessibility: this app is built to WCAG 2.2 AA patterns — keyboard navigation, visible focus,
        reduced motion, and form error summaries. If something does not work for you, tell us at{" "}
        {config?.support.email ?? "the support address in settings"} and we will fix it.
      </p>
    </main>
  );
}
