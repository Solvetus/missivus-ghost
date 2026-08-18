import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Redactor} from './redactor.ts';

const MASK = Redactor.MASK;

test('a known literal is blanked wherever it appears', () => {
    const r = new Redactor(['hunter2-correct-horse-battery']);
    const out = r.redact('Entra said: invalid_client hunter2-correct-horse-battery again hunter2-correct-horse-battery');
    assert.ok(!out.includes('hunter2-correct-horse-battery'));
    assert.ok(out.includes('invalid_client'));
});

test('literals shorter than eight characters are ignored', () => {
    const r = new Redactor(['short']);
    assert.equal(r.redact('a short word'), 'a short word');
});

test('a mailbox and a Graph URL are not mangled', () => {
    const r = new Redactor();
    const line = 'Missivus: forcing From to noreply@example.com; see https://graph.example.test/v1.0/users/noreply@example.com/sendMail';
    assert.equal(r.redact(line), line);
});

test('credentials inside a URL lose the userinfo but keep the host', () => {
    const r = new Redactor();
    const out = r.redact('refused https://admin:hunter2-correct-horse@login.evil.test');
    assert.ok(!out.includes('hunter2-correct-horse'));
    assert.ok(!out.includes('admin:'));
    assert.ok(out.includes('login.evil.test'));
});

test('secret-looking query parameters are blanked and ordinary ones survive', () => {
    const r = new Redactor();
    const out = r.redact('https://x.test/?access_token=abc123456&client_secret=def&code=ghi&tenant=contoso');
    assert.ok(!out.includes('abc123456'));
    assert.ok(!out.includes('def'));
    assert.ok(!out.includes('ghi'));
    assert.ok(out.includes('tenant=contoso'));
});

test('an uploadUrl in JSON is blanked but its neighbours survive', () => {
    const r = new Redactor();
    const out = r.redact('{"uploadUrl":"https://outlook.office.com/upload/AQMkAGY-capability","expirationDateTime":"2026-01-01"}');
    assert.ok(!out.includes('AQMkAGY-capability'));
    assert.ok(out.includes('expirationDateTime'));
});

test('a bearer token and a bare JWT are blanked', () => {
    const r = new Redactor();
    const out = r.redact('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln plus eyJhbGciOiJQUzI1NiJ9.eyJhIjoxfQ.c2ln');
    assert.ok(!out.includes('eyJhbGci'));
    assert.ok(out.includes(MASK));
});

test('a URL fragment is blanked', () => {
    const r = new Redactor();
    const out = r.redact('see https://x.test/page#access_token=leaky-token-value');
    assert.ok(!out.includes('leaky-token-value'));
});

test('redactBody truncates before it redacts', () => {
    const r = new Redactor();
    const out = r.redactBody('x'.repeat(5000));
    assert.ok(out.includes('(truncated)'));
    assert.ok(out.length < 2100);
});

test('an Entra body echoing our own secret is redacted everywhere', () => {
    const r = new Redactor(['hunter2-correct-horse-battery']);
    const out = r.redactBody('{"error":"invalid_client","error_description":"secret hunter2-correct-horse-battery is expired"}');
    assert.ok(!out.includes('hunter2-correct-horse-battery'));
    assert.ok(out.includes('invalid_client'));
});
