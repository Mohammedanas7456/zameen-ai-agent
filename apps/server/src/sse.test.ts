import { describe, it, expect } from 'vitest';
import { SseParser, describeToolInput } from './sse.js';

describe('SseParser', () => {
  it('parses a single complete event', () => {
    expect(new SseParser().push('data: {"a":1}\n\n')).toEqual([{ data: '{"a":1}' }]);
  });

  it('reassembles an event split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":')).toEqual([]);
    expect(p.push('1}\n\n')).toEqual([{ data: '{"a":1}' }]);
  });

  it('parses several events in one chunk', () => {
    expect(new SseParser().push('data: one\n\ndata: two\n\n')).toEqual([
      { data: 'one' },
      { data: 'two' },
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(new SseParser().push('data: hi\r\n\r\n')).toEqual([{ data: 'hi' }]);
  });

  it('captures a named event', () => {
    expect(new SseParser().push('event: tool\ndata: {}\n\n')).toEqual([
      { event: 'tool', data: '{}' },
    ]);
  });

  it('joins multi-line data fields', () => {
    expect(new SseParser().push('data: line1\ndata: line2\n\n')).toEqual([
      { data: 'line1\nline2' },
    ]);
  });

  it('ignores comment lines and events with no data', () => {
    expect(new SseParser().push(': keep-alive\n\ndata: real\n\n')).toEqual([{ data: 'real' }]);
  });

  it('keeps a trailing partial event buffered rather than emitting it', () => {
    const p = new SseParser();
    expect(p.push('data: complete\n\ndata: partial')).toEqual([{ data: 'complete' }]);
  });
});

describe('describeToolInput', () => {
  it('reads the query and filter from the documented shape', () => {
    expect(
      describeToolInput({
        query: '3 bed flat in DHA',
        search: { corpora: [{ corpus_key: 'x', metadata_filter: "doc.purpose = 'rent'" }] },
      }),
    ).toEqual({ query: '3 bed flat in DHA', filter: "doc.purpose = 'rent'" });
  });

  it('still finds a filter the model nested somewhere unexpected', () => {
    expect(describeToolInput({ a: { b: { metadata_filter: 'doc.bedrooms >= 2' } } }).filter).toBe(
      'doc.bedrooms >= 2',
    );
  });

  it('reports an empty filter when the model sent none (an unfiltered search)', () => {
    expect(describeToolInput({ query: 'anything' })).toEqual({ query: 'anything', filter: '' });
  });

  it('is safe on junk input', () => {
    expect(describeToolInput(null)).toEqual({ query: '', filter: '' });
    expect(describeToolInput('string')).toEqual({ query: '', filter: '' });
  });
});
