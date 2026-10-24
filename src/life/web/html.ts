// TEMPORARY local port (Living cast L2) of winter's HTML → text step for web pages (winter-agent-sdk,
// packages/runtime/src/tools/impl/_web-fetch-html.ts, MIT, ours), until `@yanlinglabs/winter-web`
// ships. winter's version walks the page with Bun's HTMLRewriter; this one is a small Node tokenizer
// with the same output idea: readable markdown-ish text (headings `#`, list items `- `, links
// `[text](url)`, paragraphs separated by blank lines), scripts, styles and markup dropped.

const DROP_WHOLE = ["script", "style", "noscript", "template", "svg", "head", "iframe", "object", "canvas", "math", "select", "button", "form"];
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "blockquote", "pre", "table", "tr", "thead", "tbody",
  "tfoot", "ul", "ol", "dl", "dt", "dd", "figure", "figcaption", "address", "details", "summary", "hr", "h1", "h2", "h3", "h4", "h5", "h6"
]);

const NAMED: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", mdash: "—", ndash: "–",
  hellip: "…", copy: "©", reg: "®", trade: "™", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»",
  deg: "°", plusmn: "±", times: "×", divide: "÷", sect: "§", para: "¶", middot: "·", bull: "•", euro: "€", pound: "£",
  yen: "¥", cent: "¢", shy: "", zwnj: "", zwj: "", lrm: "", rlm: "", larr: "←", rarr: "→", uarr: "↑", darr: "↓"
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtmlEntities(value).trim();
}

function absoluteHttpUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The page's `<title>`, decoded and trimmed (undefined when it has none). */
export function htmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? decodeHtmlEntities(match[1]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() : "";
  return title || undefined;
}

/** HTML → readable text. `baseUrl` resolves relative links. */
export function htmlToText(html: string, baseUrl: string): string {
  const title = htmlTitle(html);
  let source = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!doctype[^>]*>/gi, " ");
  for (const tag of DROP_WHOLE) source = source.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  const out: string[] = [];
  let link: { href: string | undefined; start: number } | undefined;
  let listDepth = 0;
  let pre = 0;
  const pushBreak = (blank: boolean) => out.push(blank ? "\n\n" : "\n");
  const tokens = source.split(/(<[^>]*>)/);
  for (const token of tokens) {
    if (!token) continue;
    if (token[0] !== "<" || token.length < 3) {
      const text = decodeHtmlEntities(token);
      out.push(pre > 0 ? text : text.replace(/\s+/g, " "));
      continue;
    }
    const closing = token[1] === "/";
    const name = /^<\/?\s*([a-z0-9]+)/i.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    if (name === "br") {
      pushBreak(false);
      continue;
    }
    if (name === "pre") pre = Math.max(0, pre + (closing ? -1 : 1));
    if (name === "ul" || name === "ol") listDepth = Math.max(0, listDepth + (closing ? -1 : 1));
    if (/^h[1-6]$/.test(name)) {
      pushBreak(true);
      if (!closing) out.push(`${"#".repeat(Number(name[1]))} `);
      continue;
    }
    if (name === "li") {
      pushBreak(false);
      if (!closing) out.push(`${"  ".repeat(Math.max(0, listDepth - 1))}- `);
      continue;
    }
    if (name === "a") {
      if (!closing) {
        link = { href: absoluteHttpUrl(attribute(token, "href"), baseUrl), start: out.length };
      } else if (link) {
        const text = out.slice(link.start).join("").replace(/\s+/g, " ").trim();
        out.length = link.start;
        out.push(link.href && text && text !== link.href ? `[${text}](${link.href})` : text || link.href || "");
        link = undefined;
      }
      continue;
    }
    if (name === "img" && !closing) {
      const alt = attribute(token, "alt");
      if (alt) out.push(`[image: ${alt}]`);
      continue;
    }
    if (name === "td" || name === "th") {
      if (!closing) out.push(" | ");
      continue;
    }
    if (BLOCK.has(name)) pushBreak(name !== "tr" && name !== "dd" && name !== "dt");
  }
  const body = out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+(?=[^-\s])/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title && !body.startsWith(`# ${title}`) ? `# ${title}\n\n${body}` : body;
}
