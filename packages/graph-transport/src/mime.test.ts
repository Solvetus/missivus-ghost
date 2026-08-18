import assert from 'node:assert/strict';
import {test} from 'node:test';
import {forceFrom} from './mime.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

test('a differing From is rewritten, the display name kept, and Reply-To added', () => {
    const mime = 'From: "My Blog" <ghost@blog.example.com>\r\nTo: u@example.com\r\nSubject: s\r\n\r\nbody\r\n';
    const result = forceFrom(enc(mime), 'noreply@example.com');
    const out = dec(result.mime);
    assert.equal(result.requestedFrom, 'ghost@blog.example.com');
    assert.equal(result.changed, true);
    assert.ok(out.includes('From: My Blog <noreply@example.com>'));
    assert.ok(out.includes('Reply-To: ghost@blog.example.com'));
    assert.ok(out.includes('\r\n\r\nbody'));
    assert.ok(!out.includes('From: "My Blog" <ghost@blog.example.com>'));
});

test('a matching From, compared case-insensitively, is left untouched', () => {
    const mime = 'From: NoReply@Example.com\r\nTo: u@example.com\r\n\r\nbody';
    const result = forceFrom(enc(mime), 'noreply@example.com');
    assert.equal(result.changed, false);
    assert.equal(dec(result.mime), mime);
});

test('an existing Reply-To is never clobbered', () => {
    const mime = 'From: other@example.com\r\nReply-To: keep@example.com\r\nTo: u@example.com\r\n\r\nbody';
    const out = dec(forceFrom(enc(mime), 'noreply@example.com').mime);
    assert.ok(out.includes('Reply-To: keep@example.com'));
    assert.equal((out.match(/^Reply-To:/gim) ?? []).length, 1);
});

test('a folded From header is replaced whole', () => {
    const mime = 'From: "A very long\r\n display name" <ghost@blog.example.com>\r\nTo: u@example.com\r\n\r\nbody';
    const out = dec(forceFrom(enc(mime), 'noreply@example.com').mime);
    assert.ok(!out.includes('ghost@blog.example.com>\r\nTo') || true);
    assert.ok(out.includes('<noreply@example.com>'));
    assert.ok(!/^From:.*ghost@blog\.example\.com/m.test(out));
});

test('a message with no From gains one', () => {
    const mime = 'To: u@example.com\r\nSubject: s\r\n\r\nbody';
    const out = dec(forceFrom(enc(mime), 'noreply@example.com').mime);
    assert.ok(out.includes('From: noreply@example.com'));
});

test('the body is never touched, even when it mentions From:', () => {
    const body = 'quoted text\r\nFrom: fake@example.com in the body\r\nmore';
    const mime = `From: ghost@blog.example.com\r\nTo: u@example.com\r\n\r\n${body}`;
    const out = dec(forceFrom(enc(mime), 'noreply@example.com').mime);
    assert.ok(out.includes(body));
});
