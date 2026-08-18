import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {configurationProblem, resolveConfig} from './config.ts';

const dir = mkdtempSync(join(tmpdir(), 'missivus-config-'));
after(() => {
    rmSync(dir, {recursive: true, force: true});
});

const ghostConfig = join(dir, 'config.production.json');
writeFileSync(ghostConfig, JSON.stringify({
    url: 'http://localhost:2368',
    mail: {
        from: 'Example Ltd <noreply@example.com>',
        transport: 'SMTP',
        options: {
            host: '127.0.0.1',
            port: 2525,
            tenantId: 'file-tenant',
            clientId: 'file-client',
            clientSecret: 'file-secret-value',
            certificate: {path: '/etc/missivus/file.pem', passphrase: 'file-pass'},
            sender: 'noreply@example.com',
            saveToSentItems: true,
            fallback: {host: 'smtp.file.test', port: 2465, secure: true, user: 'fu', pass: 'fp'}
        }
    }
}));

test('a Ghost config file supplies every Missivus key from mail.options', () => {
    const config = resolveConfig({}, ghostConfig);
    assert.equal(config.tenantId, 'file-tenant');
    assert.equal(config.clientId, 'file-client');
    assert.equal(config.clientSecret, 'file-secret-value');
    assert.equal(config.certificatePath, '/etc/missivus/file.pem');
    assert.equal(config.certificatePassphrase, 'file-pass');
    assert.equal(config.sender, 'noreply@example.com');
    assert.equal(config.saveToSentItems, true);
    assert.deepEqual(config.fallback, {host: 'smtp.file.test', port: 2465, secure: true, user: 'fu', pass: 'fp'});
    assert.equal(configurationProblem(config), '');
});

test('Ghost-style Docker env vars win over the file', () => {
    const config = resolveConfig({
        mail__options__tenantId: 'env-tenant',
        mail__options__certificate__path: '/env/cert.pem',
        mail__options__fallback__host: 'smtp.env.test'
    }, ghostConfig);
    assert.equal(config.tenantId, 'env-tenant');
    assert.equal(config.certificatePath, '/env/cert.pem');
    assert.equal(config.fallback.host, 'smtp.env.test');
    assert.equal(config.clientId, 'file-client', 'unset keys still come from the file');
});

test('MISSIVUS_* env vars win over everything', () => {
    const config = resolveConfig({
        MISSIVUS_TENANT_ID: 'missivus-tenant',
        mail__options__tenantId: 'env-tenant',
        MISSIVUS_SENDER_MAILBOX: 'override@example.com',
        MISSIVUS_LISTEN_HOST: '0.0.0.0',
        MISSIVUS_LISTEN_PORT: '2626'
    }, ghostConfig);
    assert.equal(config.tenantId, 'missivus-tenant');
    assert.equal(config.sender, 'override@example.com');
    assert.equal(config.listenHost, '0.0.0.0');
    assert.equal(config.listenPort, 2626);
});

test('defaults are safe without any source: Microsoft endpoints, localhost bind, fallback off', () => {
    const config = resolveConfig({});
    assert.equal(config.graphBaseUrl, 'https://graph.microsoft.com');
    assert.equal(config.loginBaseUrl, 'https://login.microsoftonline.com');
    assert.equal(config.listenHost, '127.0.0.1');
    assert.equal(config.listenPort, 2525);
    assert.equal(config.fallback.host, '', 'the fallback ships off');
    assert.equal(config.saveToSentItems, false);
    assert.equal(config.certificateAlgorithm, 'PS256');
});

test('the configuration problem names the first missing parts and never a value', () => {
    const problem = configurationProblem(resolveConfig({MISSIVUS_CLIENT_ID: 'only-client'}));
    assert.ok(problem.includes('missing tenant ID'));
    assert.ok(problem.includes('client secret or certificate path'));
    assert.ok(problem.includes('sender mailbox'));
    assert.ok(!problem.includes('only-client'));
});

test('an unreadable or invalid config file is refused naming only the path', () => {
    assert.throws(() => resolveConfig({}, join(dir, 'missing.json')), /not readable at/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.throws(() => resolveConfig({}, bad), /not valid JSON/);
});

test('the RS256 escape hatch is env-only and coerced', () => {
    assert.equal(resolveConfig({MISSIVUS_CERTIFICATE_ALGORITHM: 'RS256'}).certificateAlgorithm, 'RS256');
    assert.equal(resolveConfig({MISSIVUS_CERTIFICATE_ALGORITHM: 'ES256'}).certificateAlgorithm, 'PS256');
});
