// Starting point: axiomlayer apps/browser-extension/src/lib/domain.test.ts (single-author),
// adapted for the dropped path helper and the new capture/exclusion rules.
import { describe, expect, it } from 'vitest';
import { appNameFromDomain, captureFromUrl, getDomainFromUrl, isExcludedHost, registrableDomain } from '../src/lib/domain';
import { isSafeHost, sanitizeUrlToHost } from '../src/lib/sanitize';

describe('getDomainFromUrl', () => {
  it('returns the lowercased hostname for http(s) urls, never path or query', () => {
    expect(getDomainFromUrl('https://App.Example.com/dashboard?token=secret#x')).toBe('app.example.com');
    expect(getDomainFromUrl('http://EXAMPLE.org/')).toBe('example.org');
    expect(getDomainFromUrl('https://example.org./a')).toBe('example.org');
  });
  it('rejects non-web schemes and garbage', () => {
    for (const u of ['chrome://extensions', 'file:///Users/me/secret.txt', 'about:blank', 'chrome-extension://abc/page.html', 'data:text/html,hi', 'not a url', undefined]) {
      expect(getDomainFromUrl(u)).toBeNull();
    }
  });
});

describe('captureFromUrl (the capture boundary)', () => {
  it('returns only host + boolean; userinfo, port, path, query and fragment are dropped', () => {
    const c = captureFromUrl('https://user:CANARYPW@acme.slack.com:8443/CANARYPATH?token=CANARYQ#CANARYF');
    expect(c).toEqual({ host: 'acme.slack.com', loginHint: false });
    expect(JSON.stringify(c)).not.toMatch(/CANARY/);
  });
  it('excludes localhost, IP literals, single-label and malformed hosts', () => {
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://[::1]:8080/', 'http://intranet/', 'http://foo.localhost/', 'http://192.168.1.10/login']) {
      expect(captureFromUrl(u)).toBeNull();
    }
  });
  it('derives the login hint from host labels', () => {
    expect(captureFromUrl('https://login.microsoftonline.com/common')?.loginHint).toBe(true);
    expect(captureFromUrl('https://accounts.google.com/')?.loginHint).toBe(true);
    expect(captureFromUrl('https://sso.acme.io/')?.loginHint).toBe(true);
    // the registrable label itself is not a login signal (e.g. id.me)
    expect(captureFromUrl('https://auth.com/')?.loginHint).toBe(false);
  });
  it('derives the login hint from a transient path test, without keeping the path', () => {
    expect(captureFromUrl('https://app.newtool.io/login')?.loginHint).toBe(true);
    expect(captureFromUrl('https://app.newtool.io/auth/saml/')?.loginHint).toBe(true);
    expect(captureFromUrl('https://app.newtool.io/sign-in?next=/x')?.loginHint).toBe(true);
    expect(captureFromUrl('https://app.newtool.io/blog/logins-are-hard')?.loginHint).toBe(false);
    expect(captureFromUrl('https://app.newtool.io/?q=/login')?.loginHint).toBe(false);
  });
});

describe('isExcludedHost', () => {
  it('accepts normal hostnames', () => {
    expect(isExcludedHost('app.notion.so')).toBe(false);
    expect(isExcludedHost('xn--bcher-kva.example')).toBe(false);
  });
  it('rejects bad shapes', () => {
    for (const h of ['', 'a..b.com', '-a.com', 'a-.com', 'a b.com', 'a/b.com', 'localhost', '10.0.0.1']) expect(isExcludedHost(h)).toBe(true);
  });
});

describe('registrableDomain / appNameFromDomain', () => {
  it('handles simple and multi-part suffixes', () => {
    expect(registrableDomain('acme.slack.com')).toBe('slack.com');
    expect(registrableDomain('slack.com')).toBe('slack.com');
    expect(registrableDomain('team.foo.co.uk')).toBe('foo.co.uk');
    expect(registrableDomain('shop.example.com.au')).toBe('example.com.au');
  });
  it('uses the registrable label as the app name', () => {
    expect(appNameFromDomain('app.notion.so')).toBe('notion');
    expect(appNameFromDomain('team.foo.co.uk')).toBe('foo');
    expect(appNameFromDomain('localhost')).toBe('localhost');
  });
});

describe('sanitize', () => {
  it('sanitizeUrlToHost returns a bare host', () => {
    expect(sanitizeUrlToHost('https://a.example.com/p?q')).toBe('a.example.com');
  });
  it('isSafeHost rejects anything that is not a bare host', () => {
    expect(isSafeHost('a.example.com')).toBe(true);
    for (const h of ['a.example.com/p', 'a.example.com?x', 'a.example.com#f', 'user@a.example.com', 'a.example.com:443', ' a.com', 42, null]) {
      expect(isSafeHost(h)).toBe(false);
    }
  });
});
