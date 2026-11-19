import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const count = (tag: string) => (html.match(new RegExp(`<${tag}(?:\\s|>)`, 'g')) || []).length;

describe('landing page headings', () => {
  test('the served HTML has exactly one h1', () => {
    expect(count('h1')).toBe(1);
    expect(html).toContain('<h1>A free AI model for your apps.</h1>');
  });

  test('each main section has an h2 and levels stay in order', () => {
    expect(count('h2')).toBe(4);
    for (const id of ['demos', 'api', 'jobs', 'how']) {
      const section = html.slice(html.indexOf(`id="${id}"`));
      expect(section.slice(0, section.indexOf('</section>'))).toContain('<h2>');
    }
    expect(count('h3')).toBe(0);
  });
});
