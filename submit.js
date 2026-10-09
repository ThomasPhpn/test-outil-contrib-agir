// api/submit.js — Fonction Vercel (Node.js) qui reçoit une contribution et l'envoie par email via Resend.
//
// Variables d'environnement (Vercel > Settings > Environment Variables) :
//   RESEND_API_KEY   (obligatoire) clé API Resend, commence par re_
//   MAIL_TO          (obligatoire) destinataire(s), séparés par des virgules
//   MAIL_FROM        (facultatif)  expéditeur, ex. "Contributions <contributions@votre-domaine.fr>"
//                                  par défaut : onboarding@resend.dev (test : n'envoie qu'à l'adresse du compte Resend)
//   ALLOWED_ORIGINS  (facultatif)  origines autorisées, séparées par des virgules, ex. "https://mon-site.vercel.app"

const MAX_BYTES = 300_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- Utilitaires ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escText = (s) => s.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (v, max = 5000) => String(v ?? "").trim().slice(0, max);
const frDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v.split("-").reverse().join("/") : v);
const slug = (s) => String(s || "contribution").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "contribution";

/* ---------- Nettoyage du HTML (liste blanche) ---------- */
// Le navigateur nettoie déjà, mais on ne fait jamais confiance à ce qui arrive : on refait le tri ici.
const ALLOWED = new Set(["p", "br", "strong", "em", "h2", "h3", "ul", "ol", "li", "a", "blockquote"]);
const RENAME = { b: "strong", i: "em", h1: "h2", h4: "h3", h5: "h3", h6: "h3" };

function sanitizeHTML(input) {
  const html = String(input || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|template|svg|math|title)\b[\s\S]*?<\/\1\s*>/gi, "");
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g;
  let out = "", last = 0, m;
  const stack = [];
  while ((m = re.exec(html))) {
    out += escText(html.slice(last, m.index));
    last = re.lastIndex;
    const closing = m[0][1] === "/";
    let tag = m[1].toLowerCase();
    tag = RENAME[tag] || tag;
    if (!ALLOWED.has(tag)) continue;
    if (tag === "br") { out += "<br>"; continue; }
    if (closing) {
      const i = stack.lastIndexOf(tag);
      if (i < 0) continue;
      while (stack.length > i) out += `</${stack.pop()}>`;
    } else if (tag === "a") {
      const h = m[2].match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const href = h ? (h[2] ?? h[3] ?? h[4]).replace(/&amp;/g, "&").trim() : "";
      if (!/^(https?:\/\/|mailto:)/i.test(href)) continue;
      out += `<a href="${esc(href)}">`; stack.push("a");
    } else {
      out += `<${tag}>`; stack.push(tag);
    }
  }
  out += escText(html.slice(last));
  while (stack.length) out += `</${stack.pop()}>`;
  return out.replace(/<(p|h2|h3|li)>(\s|&nbsp;|<br>)*<\/\1>/g, "").trim();
}

// Mise en forme lisible du code HTML pour le bloc « à coller »
const prettyHTML = (h) => h.replace(/(<\/(p|h2|h3|ul|ol|blockquote)>)/g, "$1\n").replace(/<li>/g, "\n  <li>").replace(/<\/(ul|ol)>/g, "\n</$1>").replace(/\n{2,}/g, "\n").trim();

/* ---------- Normalisation de la contribution ---------- */
function normalize(d) {
  if (!d || typeof d !== "object") throw new Error("Données invalides.");
  const label = (x) => (x && typeof x === "object" ? { id: str(x.id, 100), label: str(x.label, 200) } : null);

  const cibles = Array.isArray(d.cibles) ? d.cibles.map(label).filter((x) => x?.label).slice(0, 10) : [];
  if (!cibles.length) throw new Error("Aucune cible choisie.");
  const type = label(d.type);
  if (!type?.label) throw new Error("Type de contenu manquant.");

  const champs = (Array.isArray(d.champs) ? d.champs : []).slice(0, 40).map((c) => {
    const base = { id: str(c?.id, 100), label: str(c?.label, 200), type: str(c?.type, 30) };
    const v = c?.valeur;
    if (base.type === "wysiwyg") {
      const html = sanitizeHTML(String(v || "").slice(0, 200_000));
      return { ...base, valeur: html, texte: str(c?.texte, 100_000) };
    }
    if (Array.isArray(v)) return { ...base, valeur: v.slice(0, 100).map((x) => (typeof x === "object" ? label(x) : str(x, 200))) };
    if (v && typeof v === "object") return { ...base, valeur: label(v) };
    return { ...base, valeur: str(v, 20_000) };
  }).filter((c) => c.label);
  if (!champs.length) throw new Error("Aucun champ renseigné.");

  const medias = (Array.isArray(d.medias) ? d.medias : []).slice(0, 10)
    .map((m) => ({ url: str(m?.url, 2000), legende: str(m?.legende, 500) }))
    .filter((m) => /^https?:\/\//i.test(m.url));

  const contact = { nom: str(d.contact?.nom, 200), email: str(d.contact?.email, 200) };
  if (!contact.nom) throw new Error("Nom manquant.");
  if (!EMAIL_RE.test(contact.email)) throw new Error("Adresse email invalide.");

  return { version: 1, recu_le: new Date().toISOString(), cibles, type, champs, medias, contact };
}

/* ---------- Construction de l'email ---------- */
function valueHTML(c) {
  const v = c.valeur;
  if (c.type === "wysiwyg") return v;
  if (Array.isArray(v)) return esc(v.map((x) => x?.label ?? x).join(", "));
  if (v && typeof v === "object") return esc(v.label);
  if (c.type === "date") return esc(frDate(v));
  if (c.type === "url" && /^https?:\/\//i.test(v)) return `<a href="${esc(v)}" style="color:#2457d6">${esc(v)}</a>`;
  return esc(v).replace(/\n/g, "<br>");
}
function valueText(c) {
  const v = c.valeur;
  if (c.type === "wysiwyg") return c.texte || v;
  if (Array.isArray(v)) return v.map((x) => x?.label ?? x).join(", ");
  if (v && typeof v === "object") return v.label;
  if (c.type === "date") return frDate(v);
  return v;
}

function buildEmail(k) {
  const titre = k.champs.find((c) => c.id === "titre" || c.id === "url_article")?.valeur || "";
  const subject = `[${k.cibles.map((c) => c.label).join(", ")}] ${k.type.label}${titre ? " – " + titre : ""}`.slice(0, 250);
  const recu = new Date(k.recu_le).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" });

  const td = "padding:12px 0;border-top:1px solid #e5e8ee;vertical-align:top;";
  const rows = k.champs.map((c) => `<tr>
      <td style="${td}width:170px;padding-right:16px;color:#6b7686;font-size:13px">${esc(c.label)}</td>
      <td style="${td}font-size:15px;line-height:1.5">${c.type === "wysiwyg"
        ? `<div style="border-left:3px solid #d9dee6;padding-left:14px">${valueHTML(c)}</div>` : valueHTML(c)}</td></tr>`).join("");
  const mediasRow = k.medias.length ? `<tr><td style="${td}padding-right:16px;color:#6b7686;font-size:13px">Médias</td><td style="${td}font-size:15px">${
    k.medias.map((m) => `<a href="${esc(m.url)}" style="color:#2457d6">${esc(m.url)}</a>${m.legende ? " — " + esc(m.legende) : ""}`).join("<br>")}</td></tr>` : "";
  const codeBlocks = k.champs.filter((c) => c.type === "wysiwyg" && c.valeur).map((c) => `
      <h2 style="font-size:16px;margin:32px 0 6px">Code HTML · ${esc(c.label)}</h2>
      <p style="margin:0 0 8px;color:#6b7686;font-size:13px">À coller dans l'éditeur du back-office, en mode « Source ».</p>
      <pre style="margin:0;background:#f6f7f9;border:1px solid #e5e8ee;border-radius:8px;padding:12px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${esc(prettyHTML(c.valeur))}</pre>`).join("");

  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;color:#1c2430;max-width:720px;margin:0 auto;padding:24px 16px">
    <p style="margin:0 0 4px;color:#6b7686;font-size:13px">Nouvelle contribution reçue le ${esc(recu)}</p>
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 12px">${esc(titre || k.type.label)}</h1>
    <p style="margin:0 0 20px">${[...k.cibles.map((c) => c.label), k.type.label].map((l) =>
      `<span style="display:inline-block;background:#eef3ff;color:#1b44a8;border-radius:999px;padding:3px 12px;font-size:13px;font-weight:bold;margin:0 6px 6px 0">${esc(l)}</span>`).join("")}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}${mediasRow}
      <tr><td style="${td}padding-right:16px;color:#6b7686;font-size:13px">Contact</td>
        <td style="${td}font-size:15px">${esc(k.contact.nom)} · <a href="mailto:${esc(k.contact.email)}" style="color:#2457d6">${esc(k.contact.email)}</a></td></tr>
    </table>${codeBlocks}
    <p style="margin:32px 0 0;color:#6b7686;font-size:12px">Répondre à cet email écrit directement à ${esc(k.contact.nom)}. Les données complètes sont jointes au format JSON.</p>
  </div></body></html>`;

  const text = [
    `Cible(s) : ${k.cibles.map((c) => c.label).join(", ")}`, `Type de contenu : ${k.type.label}`, "",
    ...k.champs.flatMap((c) => [`${c.label} :`, valueText(c), ""]),
    ...(k.medias.length ? ["Médias :", ...k.medias.map((m) => `- ${m.url}${m.legende ? " (" + m.legende + ")" : ""}`), ""] : []),
    "Contact :", `${k.contact.nom} <${k.contact.email}>`,
  ].join("\n");

  const day = k.recu_le.slice(0, 10);
  return { subject, html, text, filename: `contribution-${day}-${slug(titre)}.json` };
}

/* ---------- Lecture de la requête ---------- */
async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!raw) {
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BYTES) break; }
  }
  if (raw.length > MAX_BYTES) throw Object.assign(new Error("Contribution trop volumineuse."), { status: 413 });
  try { return JSON.parse(raw || "{}"); } catch { throw new Error("Données invalides."); }
}

/* ---------- Point d'entrée ---------- */
module.exports = async function handler(req, res) {
  const reply = (status, body) => res.status(status).json(body);
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return reply(405, { ok: false, error: "Méthode non autorisée." }); }

  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(req.headers.origin)) return reply(403, { ok: false, error: "Origine non autorisée." });

  const { RESEND_API_KEY, MAIL_TO } = process.env;
  const MAIL_FROM = process.env.MAIL_FROM || "Contributions <onboarding@resend.dev>";
  if (!RESEND_API_KEY || !MAIL_TO) {
    console.error("Configuration incomplète : RESEND_API_KEY et MAIL_TO sont requis.");
    return reply(500, { ok: false, error: "Le service d'envoi n'est pas configuré." });
  }

  let data;
  try {
    data = await readBody(req);
    if (data.botcheck) return reply(200, { ok: true }); // robot : on fait semblant
    data = normalize(data);
  } catch (err) {
    return reply(err.status || 400, { ok: false, error: err.message });
  }

  const mail = buildEmail(data);
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: MAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
        reply_to: data.contact.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: [{ filename: mail.filename, content: Buffer.from(JSON.stringify(data, null, 2), "utf8").toString("base64") }],
      }),
    });
    if (!r.ok) {
      console.error("Resend a refusé l'envoi :", r.status, await r.text());
      return reply(502, { ok: false, error: "L'envoi a échoué." });
    }
    return reply(200, { ok: true });
  } catch (err) {
    console.error("Erreur d'envoi :", err);
    return reply(502, { ok: false, error: "L'envoi a échoué." });
  }
};

module.exports.sanitizeHTML = sanitizeHTML; // exposé pour les tests
