import { describe, expect, it } from 'vitest';
import { mentionsAccount, parseMarkdown, plainText, quoteText, type BlockNode, type InlineNode } from './markdown';

const text = (value: string): InlineNode => ({ type: 'text', value });
const para = (...children: InlineNode[]): BlockNode => ({ type: 'paragraph', children });
const inline = (raw: string, mentions?: Array<{ accountId: string; name: string }>) => {
  const blocks = parseMarkdown(raw, { mentions });
  expect(blocks).toHaveLength(1);
  expect(blocks[0].type).toBe('paragraph');
  return (blocks[0] as { children: InlineNode[] }).children;
};

describe('parseMarkdown', () => {
  it('renders plain text and line breaks as they are', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('hello')).toEqual([para(text('hello'))]);
    expect(inline('one\ntwo\r\n\nfour')).toEqual([text('one'), { type: 'break' }, text('two'), { type: 'break' }, { type: 'break' }, text('four')]);
  });

  it('parses bold, italic and inline code', () => {
    expect(inline('a **bold** word')).toEqual([text('a '), { type: 'bold', children: [text('bold')] }, text(' word')]);
    expect(inline('*it* and _it_')).toEqual([{ type: 'italic', children: [text('it')] }, text(' and '), { type: 'italic', children: [text('it')] }]);
    expect(inline('use `x = 1` here')).toEqual([text('use '), { type: 'code', value: 'x = 1' }, text(' here')]);
    // Markup inside inline code is left alone; styles nest.
    expect(inline('`**not bold**`')).toEqual([{ type: 'code', value: '**not bold**' }]);
    expect(inline('**bold *and italic* and `code`**')).toEqual([
      { type: 'bold', children: [text('bold '), { type: 'italic', children: [text('and italic')] }, text(' and '), { type: 'code', value: 'code' }] },
    ]);
  });

  it('leaves unbalanced or empty markers as text', () => {
    expect(inline('2 * 3 * 4')).toEqual([text('2 * 3 * 4')]);
    expect(inline('**not closed')).toEqual([text('**not closed')]);
    expect(inline('**** nothing')).toEqual([text('**** nothing')]);
    expect(inline('`tick')).toEqual([text('`tick')]);
    expect(inline('a ** b ** c')).toEqual([text('a ** b ** c')]);
    expect(inline('snake_case_name and __init__')).toEqual([text('snake_case_name and __init__')]);
    expect(inline('one *line\nnext* line')).toEqual([text('one *line'), { type: 'break' }, text('next* line')]);
    expect(inline('|| ||')).toEqual([text('|| ||')]);
  });

  it('honours backslash escapes', () => {
    expect(inline('\\*not italic\\* and \\`not code\\` and \\\\')).toEqual([text('*not italic* and `not code` and \\')]);
    expect(inline('\\||not a spoiler||')).toEqual([text('||not a spoiler||')]);
  });

  it('parses spoilers, which can hold other markup', () => {
    expect(inline('the killer is ||**the butler**||!')).toEqual([text('the killer is '), { type: 'spoiler', children: [{ type: 'bold', children: [text('the butler')] }] }, text('!')]);
  });

  it('parses fenced code blocks with an optional language and keeps their content verbatim', () => {
    expect(parseMarkdown('look:\n```js\nconst x = **1**; // <b>\n```\ndone')).toEqual([
      para(text('look:')),
      { type: 'codeblock', language: 'js', value: 'const x = **1**; // <b>' },
      para(text('done')),
    ]);
    expect(parseMarkdown('```\nplain\n```')).toEqual([{ type: 'codeblock', language: null, value: 'plain' }]);
    // An unterminated fence runs to the end; blank lines around a block carry nothing.
    expect(parseMarkdown('```\nforever')).toEqual([{ type: 'codeblock', language: null, value: 'forever' }]);
    expect(parseMarkdown('```\nx\n```\n\nafter')).toEqual([{ type: 'codeblock', language: null, value: 'x' }, para(text('after'))]);
    // Backticks on one line are code spans: a run of them is closed by a run of the same length.
    expect(parseMarkdown('say ```hi``` there')).toEqual([para(text('say '), { type: 'code', value: 'hi' }, text(' there'))]);
    expect(inline('`` a`b `` and ``` lonely')).toEqual([{ type: 'code', value: ' a`b ' }, text(' and ``` lonely')]);
  });

  it('links http(s) URLs only and keeps trailing punctuation out of them', () => {
    expect(inline('see https://example.com/a?b=1, ok')).toEqual([text('see '), { type: 'link', href: 'https://example.com/a?b=1', value: 'https://example.com/a?b=1' }, text(', ok')]);
    expect(inline('(https://example.com/x)')).toEqual([text('('), { type: 'link', href: 'https://example.com/x', value: 'https://example.com/x' }, text(')')]);
    expect(inline('https://en.example.org/wiki/Foo_(bar)')).toEqual([{ type: 'link', href: 'https://en.example.org/wiki/Foo_(bar)', value: 'https://en.example.org/wiki/Foo_(bar)' }]);
    expect(inline('javascript:alert(1) and ftp://x and ahttps://y')).toEqual([text('javascript:alert(1) and ftp://x and ahttps://y')]);
    expect(inline('`https://example.com` in code')).toEqual([{ type: 'code', value: 'https://example.com' }, text(' in code')]);
  });

  it('never produces markup from HTML-looking text', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> <b>x</b> &amp; <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([para(text('<script>alert(1)</script> <b>x</b> &amp; <img src=x onerror=alert(1)>'))]);
    expect(plainText(blocks)).toBe('<script>alert(1)</script> <b>x</b> &amp; <img src=x onerror=alert(1)>');
    expect(parseMarkdown('```html\n<script>x</script>\n```')).toEqual([{ type: 'codeblock', language: 'html', value: '<script>x</script>' }]);
  });

  it('matches resolved mentions exactly, names with spaces included, and plain @words otherwise', () => {
    const mentions = [
      { accountId: 'a1', name: 'Bob' },
      { accountId: 'a2', name: 'Bob Smith' },
    ];
    expect(inline('hi @Bob Smith and @bob!', mentions)).toEqual([
      text('hi '),
      { type: 'mention', value: '@Bob Smith', accountId: 'a2' },
      text(' and '),
      { type: 'mention', value: '@bob', accountId: 'a1' },
      text('!'),
    ]);
    expect(inline('@Bobby is someone else', mentions)).toEqual([{ type: 'mention', value: '@Bobby', accountId: null }, text(' is someone else')]);
    expect(inline('mail bob@example.com or @.', mentions)).toEqual([text('mail bob@example.com or @.')]);
    expect(inline('@carol.', [])).toEqual([{ type: 'mention', value: '@carol', accountId: null }, text('.')]);
    const blocks = parseMarkdown('**@Bob** wins', { mentions });
    expect(mentionsAccount(blocks, 'a1')).toBe(true);
    expect(mentionsAccount(blocks, 'a2')).toBe(false);
  });

  it('flattens back to plain text', () => {
    expect(plainText(parseMarkdown('**a** _b_ `c` ||d|| https://e.example/ @f\ng'))).toBe('a b c d https://e.example/ @f\ng');
    expect(plainText(parseMarkdown('x\n```\ny\n```'))).toBe('x\ny');
  });

  it('makes a one-line quote that keeps spoilers hidden', () => {
    expect(quoteText('**bold** and\n_italic_ ||the butler|| `x`')).toBe('bold and italic [spoiler] x');
    expect(quoteText('before\n```js\ncode\n```\nafter')).toBe('before code after');
    expect(quoteText('  spaced   out  ')).toBe('spaced out');
  });
});
