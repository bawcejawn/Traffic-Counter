import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBot, parseUA, screenBucket } from '../src/ua.js';
import { normalizePath, parseReferrer, parseCampaign, hostMatches, primaryLanguage } from '../src/ingest.js';
import { localMidnight, localDateStr, addDays } from '../src/time.js';
import { badgeSvg, formatCount } from '../src/badge.js';
import { parseCsv } from '../src/import.js';

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

test('user agent parsing', () => {
  assert.deepEqual(parseUA(CHROME_WIN), { browser: 'Chrome', version: '130', os: 'Windows', device: 'Desktop' });
  assert.deepEqual(parseUA(SAFARI_IOS), { browser: 'Safari', version: '17', os: 'iOS', device: 'Mobile' });
  assert.equal(parseUA(EDGE).browser, 'Edge');
  assert.deepEqual(parseUA(FIREFOX_LINUX), { browser: 'Firefox', version: '131', os: 'Linux', device: 'Desktop' });
  assert.equal(parseUA(ANDROID).device, 'Mobile');
  assert.equal(parseUA(ANDROID).os, 'Android');
});

test('bot detection', () => {
  assert.equal(isBot(CHROME_WIN), false);
  assert.equal(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isBot('curl/8.4.0'), true);
  assert.equal(isBot('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)'), true);
  assert.equal(isBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0.0.0 Safari/537.36'), true);
  assert.equal(isBot(''), true);
});

test('screen buckets', () => {
  assert.equal(screenBucket(390), 'Phone (<576px)');
  assert.equal(screenBucket(1920), 'Desktop (1440–2559px)');
  assert.equal(screenBucket(0), '');
});

test('path normalization', () => {
  assert.equal(normalizePath('/a/b?x=1#top'), '/a/b');
  assert.equal(normalizePath('blog'), '/blog');
  assert.equal(normalizePath('/docs/index.html'), '/docs/');
  assert.equal(normalizePath('//a//b'), '/a/b');
  assert.equal(normalizePath('https://example.com/full/url?q'), '/full/url');
  assert.equal(normalizePath('/caf%C3%A9'), '/café');
  assert.equal(normalizePath(''), '/');
});

test('referrer parsing', () => {
  assert.deepEqual(parseReferrer('https://www.google.com/search?q=x', 'example.com'), { ref: 'Google', refPath: '' });
  assert.deepEqual(parseReferrer('https://news.ycombinator.com/item?id=1', 'example.com'), { ref: 'Hacker News', refPath: '/item' });
  assert.deepEqual(parseReferrer('https://example.com/other', 'example.com'), { ref: '', refPath: '' });
  assert.deepEqual(parseReferrer('https://www.example.com/other', 'example.com'), { ref: '', refPath: '' });
  assert.deepEqual(parseReferrer('https://blog.someone.dev/post/1', 'example.com'), { ref: 'blog.someone.dev', refPath: '/post/1' });
  assert.deepEqual(parseReferrer('', 'example.com'), { ref: '', refPath: '' });
});

test('campaign parsing', () => {
  assert.deepEqual(parseCampaign('?utm_source=newsletter&utm_medium=email&utm_campaign=launch'), { source: 'newsletter', medium: 'email', campaign: 'launch' });
  assert.deepEqual(parseCampaign('?ref=producthunt'), { source: 'producthunt', medium: '', campaign: '' });
  assert.deepEqual(parseCampaign(''), { source: '', medium: '', campaign: '' });
});

test('domain allow-list', () => {
  assert.equal(hostMatches('example.com', ''), true);
  assert.equal(hostMatches('www.example.com', 'example.com'), true);
  assert.equal(hostMatches('blog.example.com', '*.example.com'), true);
  assert.equal(hostMatches('example.com', '*.example.com'), true);
  assert.equal(hostMatches('evil.com', 'example.com,other.org'), false);
  assert.equal(hostMatches('', 'example.com'), false);
});

test('language', () => {
  assert.equal(primaryLanguage('en-US,en;q=0.9'), 'en');
  assert.equal(primaryLanguage('pt-BR'), 'pt');
  assert.equal(primaryLanguage(''), '');
});

test('timezone helpers', () => {
  assert.equal(new Date(localMidnight('2026-06-15', 'UTC')).toISOString(), '2026-06-15T00:00:00.000Z');
  assert.equal(new Date(localMidnight('2026-06-15', 'America/Los_Angeles')).toISOString(), '2026-06-15T07:00:00.000Z');
  assert.equal(new Date(localMidnight('2026-01-15', 'America/Los_Angeles')).toISOString(), '2026-01-15T08:00:00.000Z');
  assert.equal(new Date(localMidnight('2026-06-15', 'Asia/Kolkata')).toISOString(), '2026-06-14T18:30:00.000Z');
  // DST change day in the US
  assert.equal(new Date(localMidnight('2026-03-08', 'America/New_York')).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(localDateStr(Date.parse('2026-06-15T06:59:00Z'), 'America/Los_Angeles'), '2026-06-14');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
});

test('badges', () => {
  const svg = badgeSvg({ label: 'views', value: '1,234' });
  assert.match(svg, /^<svg/);
  assert.match(svg, /1,234/);
  assert.doesNotMatch(badgeSvg({ label: '<script>' }), /<script>/);
  assert.equal(formatCount(12345, true), '12.3k');
  assert.equal(formatCount(1234, true), '1,234');
  assert.equal(formatCount(2500000, true), '2.5M');
});

test('csv parser', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
});
