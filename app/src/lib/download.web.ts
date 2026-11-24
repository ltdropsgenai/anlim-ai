import { tr } from "./i18n";
// Save a signed storage file under a readable name (web). Fetches it and hands the browser a same-origin blob link,
// because a cross-origin <a download> is ignored and opens the file instead. @anlim
export async function downloadFile(url: string, name: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(tr("Download failed ({status})", { status: r.status }));
  const href = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}
