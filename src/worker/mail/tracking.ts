// Open and click tracking: rewriting outgoing HTML, and telling people from machines.
//
// Opens and clicks are noisy. Apple Mail Privacy Protection fetches every image when mail
// arrives, whether or not anyone reads it; Gmail and Outlook fetch images through their own
// proxies, hiding the device; security scanners (Microsoft Defender, Mimecast, Proofpoint, …)
// follow every link before the recipient sees the message. Each hit gets a source so the counts
// can show likely people apart from machines.

export type HitSource = 'human' | 'proxy' | 'apple' | 'scanner';

export function pixelUrl(base: string, token: string): string {
  return `${base}/api/t/${token}.gif`;
}

export function linkUrl(base: string, token: string, index: number): string {
  return `${base}/api/t/${token}/${index}`;
}

// Adds the pixel and sends http(s) links through the redirect. Returns the original URLs by
// index; the same URL twice shares an index.
export async function applyTracking(html: string, opts: { base: string; token: string }): Promise<{ html: string; links: string[] }> {
  const links: string[] = [];
  const pixel = `<img src="${pixelUrl(opts.base, opts.token)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0">`;
  let placed = false;
  const rewriter = new HTMLRewriter()
    .on('a[href]', {
      element(el) {
        const href = (el.getAttribute('href') ?? '').trim();
        if (!/^https?:\/\//i.test(href)) return;
        let i = links.indexOf(href);
        if (i < 0) i = links.push(href) - 1;
        el.setAttribute('href', linkUrl(opts.base, opts.token, i));
      },
    })
    .on('body', {
      element(el) {
        el.onEndTag((end) => {
          end.before(pixel, { html: true });
          placed = true;
        });
      },
    })
    .onDocument({
      end(end) {
        if (!placed) end.append(pixel, { html: true });
      },
    });
  const out = await rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).text();
  return { html: out, links };
}

const PROXY_UA = /GoogleImageProxy|YahooMailProxy|ggpht\.com/i;
const BOT_UA = /bot\b|crawl|spider|preview|scan|python|curl|wget|go-http|java\/|okhttp|headless|libwww|httpclient|safelinks|barracuda|mimecast|proofpoint/i;
// Networks of mail security vendors and data centers. Not Cloudflare, Akamai or Fastly: iCloud
// Private Relay sends real people through them.
const SCANNER_ORG = /mimecast|proofpoint|barracuda|cisco|ironport|forcepoint|sophos|trend ?micro|zscaler|fortinet|symantec|broadcom|trustwave|amazon|google cloud|digitalocean|ovh|hetzner|linode|vultr|choopa/i;
// A click this soon after sending is a scanner: nobody reads and clicks that fast.
const INSTANT_CLICK_MS = 10_000;

export function classifyHit(hit: { kind: 'open' | 'click'; method: string; userAgent: string; org: string; msSinceSent: number | null }): HitSource {
  const ua = hit.userAgent.trim();
  if (hit.method === 'HEAD') return 'scanner';
  if (PROXY_UA.test(ua)) return 'proxy';
  // Mail Privacy Protection fetches from Apple's network with a bare user agent.
  if (/\bapple\b/i.test(hit.org) || ua === 'Mozilla/5.0') return hit.kind === 'open' ? 'apple' : 'scanner';
  // Outlook.com fetches images through Microsoft's network for the reader, while Defender
  // follows links from it before anyone reads them.
  if (/microsoft/i.test(hit.org)) return hit.kind === 'open' ? 'proxy' : 'scanner';
  if (!ua || BOT_UA.test(ua) || SCANNER_ORG.test(hit.org)) return 'scanner';
  if (hit.kind === 'click' && hit.msSinceSent !== null && hit.msSinceSent < INSTANT_CLICK_MS) return 'scanner';
  return 'human';
}

export interface TrackingSummary {
  // Opens by people, directly or through a mail provider's image proxy.
  opened: number;
  firstOpenedAt: number | null;
  lastOpenedAt: number | null;
  // Apple Mail prefetches and scanner fetches: the message arrived, nothing more.
  machineOpens: number;
  clicked: number;
  firstClickedAt: number | null;
  machineClicks: number;
  links: { url: string; clicks: number }[];
}

export interface EventCount {
  kind: 'open' | 'click';
  source: HitSource;
  link: number | null;
  n: number;
  first: number;
  last: number;
}

export function summarize(links: string[], counts: EventCount[]): TrackingSummary {
  const person = (c: EventCount) => c.source === 'human' || c.source === 'proxy';
  const opens = counts.filter((c) => c.kind === 'open');
  const clicks = counts.filter((c) => c.kind === 'click');
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
  const sum = (xs: EventCount[]) => xs.reduce((n, c) => n + c.n, 0);
  return {
    opened: sum(opens.filter(person)),
    firstOpenedAt: min(opens.filter(person).map((c) => c.first)),
    lastOpenedAt: max(opens.filter(person).map((c) => c.last)),
    machineOpens: sum(opens.filter((c) => !person(c))),
    clicked: sum(clicks.filter(person)),
    firstClickedAt: min(clicks.filter(person).map((c) => c.first)),
    machineClicks: sum(clicks.filter((c) => !person(c))),
    links: links.map((url, i) => ({ url, clicks: sum(clicks.filter((c) => person(c) && c.link === i)) })),
  };
}
