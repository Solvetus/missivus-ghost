import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normaliseEndpoint} from './endpoint.ts';
import {GraphError} from './errors.ts';

function refusalOf(url: string): string {
    try {
        normaliseEndpoint(url, 'graph_base_url');
    } catch (err) {
        assert.ok(err instanceof GraphError);
        return err.message;
    }
    throw new Error('expected a refusal that never came');
}

test('a bare https origin is kept and a trailing slash dropped', () => {
    assert.equal(normaliseEndpoint('https://graph.microsoft.com/', 'graph_base_url'), 'https://graph.microsoft.com');
});

test('port and path survive normalisation', () => {
    assert.equal(normaliseEndpoint('https://mock.test:8443/graph/', 'graph_base_url'), 'https://mock.test:8443/graph');
});

test('http is refused, naming the setting', () => {
    const message = refusalOf('http://graph.microsoft.com');
    assert.ok(message.includes('graph_base_url'));
    assert.ok(message.includes('https://'));
});

test('embedded credentials are refused and never repeated', () => {
    const message = refusalOf('https://admin:super-secret-value@evil.test');
    assert.ok(!message.includes('super-secret-value'));
    assert.ok(!message.includes('admin'));
    assert.ok(message.includes('evil.test'));
});

test('a query string is refused and never repeated', () => {
    const message = refusalOf('https://host.test?access_token=leaky-token-value');
    assert.ok(!message.includes('leaky-token-value'));
    assert.ok(message.includes('bare https origin'));
});

test('a fragment is refused and never repeated', () => {
    const message = refusalOf('https://host.test/#secret-fragment-value');
    assert.ok(!message.includes('secret-fragment-value'));
});

test('an unparseable value is not echoed at all', () => {
    const message = refusalOf('not a url at all with secret-looking-thing');
    assert.ok(!message.includes('secret-looking-thing'));
    assert.ok(message.includes('expected scheme://host'));
});

test('an invalid host name is named as a reason, not a value', () => {
    const message = refusalOf('https://bad_host!name/path');
    assert.ok(!message.includes('bad_host!name'));
    assert.ok(message.includes('invalid host name'));
});

test('an empty value is refused', () => {
    assert.ok(refusalOf('   ').includes('must not be empty'));
});
