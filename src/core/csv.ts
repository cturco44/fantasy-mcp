/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Returns rows as objects keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => r.length > 1 || r[0])
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** Numeric CSV cell, treating "", "NA" and garbage as undefined. */
export function num(v: string | undefined): number | undefined {
  if (v == null || v === "" || v === "NA") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** String CSV cell, treating "" and "NA" as undefined. */
export function str(v: string | undefined): string | undefined {
  return v == null || v === "" || v === "NA" ? undefined : v;
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.text();
}
