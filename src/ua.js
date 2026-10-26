// User-agent parsing and bot detection.
//
// We only extract coarse, aggregate-friendly facts (browser family + major
// version, OS family, device class). The raw user agent is never stored.

const BOT_RE = new RegExp(
  [
    'bot\\b', 'bot/', 'bot-', 'crawl', 'spider', 'slurp', 'scrap', 'fetch(er)?\\b',
    'headless', 'phantomjs', 'puppeteer', 'playwright', 'selenium', 'webdriver',
    'lighthouse', 'pagespeed', 'pingdom', 'uptime', 'monitor', 'statuscake',
    'curl/', 'wget/', 'python-requests', 'python-urllib', 'aiohttp', 'httpx',
    'go-http-client', 'java/', 'okhttp', 'axios', 'node-fetch', 'undici',
    'libwww', 'httpclient', 'postman', 'insomnia', 'preview', 'facebookexternalhit',
    'whatsapp', 'telegram', 'discord', 'slack', 'embedly', 'quora link',
    'bingpreview', 'yandex', 'baidu', 'semrush', 'ahrefs', 'mj12', 'dotbot',
    'petalbot', 'bytespider', 'gptbot', 'claudebot', 'anthropic-ai', 'ccbot',
    'perplexity', 'amazonbot', 'applebot', 'duckduck', 'archive\\.org',
    'feedfetcher', 'rss', 'validator', 'checker', 'scanner', 'nmap', 'zgrab',
    'masscan', 'censys', 'hubspot', 'cloudflare-'
  ].join('|'),
  'i'
);

export function isBot(ua) {
  if (!ua || ua.length < 12) return true;
  return BOT_RE.test(ua);
}

// Order matters: more specific browsers first (Edge/Opera/etc. contain "Chrome").
const BROWSERS = [
  ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /(?:OPR|Opera)\/(\d+)/],
  ['Samsung Internet', /SamsungBrowser\/(\d+)/],
  ['Vivaldi', /Vivaldi\/(\d+)/],
  ['Yandex', /YaBrowser\/(\d+)/],
  ['UC Browser', /UCBrowser\/(\d+)/],
  ['Brave', /Brave\/(\d+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/],
  ['Internet Explorer', /(?:MSIE |Trident\/.*rv:)(\d+)/],
];

const OSES = [
  ['iOS', /iPhone|iPad|iPod/],
  ['Android', /Android/],
  ['Windows', /Windows/],
  ['ChromeOS', /CrOS/],
  ['macOS', /Mac OS X|Macintosh/],
  ['Linux', /Linux|X11/],
];

export function parseUA(ua = '') {
  let browser = 'Other';
  let version = '';
  for (const [name, re] of BROWSERS) {
    const m = ua.match(re);
    if (m) { browser = name; version = m[1] || ''; break; }
  }
  // In-app webviews
  if (/FBAN|FBAV|Instagram|Line\//.test(ua)) { browser = 'In-app'; version = ''; }

  let os = 'Other';
  for (const [name, re] of OSES) {
    if (re.test(ua)) { os = name; break; }
  }
  // iPadOS 13+ pretends to be macOS; the client can correct this via touch points.

  let device = 'Desktop';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) device = 'Tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) device = 'Mobile';

  return { browser, version, os, device };
}

// Bucket raw screen widths so we never store exact (fingerprintable) sizes.
export function screenBucket(w) {
  w = Number(w) || 0;
  if (w <= 0) return '';
  if (w < 576) return 'Phone (<576px)';
  if (w < 992) return 'Tablet (576–991px)';
  if (w < 1440) return 'Laptop (992–1439px)';
  if (w < 2560) return 'Desktop (1440–2559px)';
  return 'Large (2560px+)';
}
