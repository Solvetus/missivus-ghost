/**
 * Missivus for Ghost — send Ghost transactional email through the Microsoft Graph API.
 *
 * The seam between the SMTP listener and the Graph transport. Failure policy per the family
 * rules: every Graph failure is logged at error level AND surfaced to Ghost through the SMTP
 * reply — nothing is ever swallowed. The optional fallback (default OFF) relays the unmodified
 * message to an operator-configured SMTP server after the failure is logged.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import type {GraphMailer, Logger} from '@missivus/graph-transport';
import {createGraphTransport, GraphError, Redactor} from '@missivus/graph-transport';
import {loadCertificate} from '@missivus/graph-transport/node';
import type {ShimConfig} from './config.ts';
import {configurationProblem} from './config.ts';
import type {DeliverFn, SmtpEnvelope} from './smtp-server.ts';
import {relayOverSmtp} from './smtp-client.ts';

export interface DeliverDependencies {
    /** Injectable for tests. */
    fetch?: Parameters<typeof createGraphTransport>[0]['fetch'];
    relay?: typeof relayOverSmtp;
}

export function buildRedactor(config: ShimConfig): Redactor {
    return new Redactor([config.clientSecret, config.certificatePassphrase, config.fallback.pass]);
}

export function buildMailer(config: ShimConfig, logger: Logger, deps: DeliverDependencies = {}): GraphMailer {
    const redactorLogger: Logger = logger;
    const options: Parameters<typeof createGraphTransport>[0] = {
        tenantId: config.tenantId,
        clientId: config.clientId,
        sender: config.sender,
        saveToSentItems: config.saveToSentItems,
        graphBaseUrl: config.graphBaseUrl,
        loginBaseUrl: config.loginBaseUrl,
        logger: redactorLogger
    };
    if (config.certificatePath !== '') {
        options.certificate = {
            ...loadCertificate(config.certificatePath, config.certificatePassphrase),
            algorithm: config.certificateAlgorithm
        };
    } else {
        options.clientSecret = config.clientSecret;
    }
    if (deps.fetch) {
        options.fetch = deps.fetch;
    }
    return createGraphTransport(options);
}

/**
 * Build the deliver function the SMTP listener calls once per message. The MIME goes to Graph
 * verbatim (forced-From applied by the transport); envelope recipients that do not appear in the
 * message headers — SMTP Bcc semantics — are added as a Bcc header so Graph still delivers to
 * them.
 */
export function buildDeliver(config: ShimConfig, logger: Logger, deps: DeliverDependencies = {}): DeliverFn {
    const redactor = buildRedactor(config);
    const problem = configurationProblem(config);
    const mailer: GraphMailer | null = problem === '' ? buildMailer(config, logger, deps) : null;
    const relay = deps.relay ?? relayOverSmtp;

    return async (envelope: SmtpEnvelope, mime: Uint8Array): Promise<void> => {
        if (mailer === null) {
            logger.error(problem);
            throw new GraphError(problem);
        }
        const prepared = addMissingBccHeader(mime, envelope);
        try {
            await mailer.sendMime(prepared);
        } catch (err) {
            const graphError = err instanceof GraphError ? err.redactedWith(redactor) : new GraphError(redactor.redact(String(err instanceof Error ? err.message : err)));
            // Logged at error level either way — the family's hard rule is that nothing is swallowed.
            logger.error(`Missivus: sending over Microsoft Graph failed: ${redactor.redact(graphError.message)}`);

            if (config.fallback.host === '') {
                throw graphError;
            }
            logger.error(`Missivus: falling back to the configured SMTP transport at ${config.fallback.host}`);
            try {
                await relay(config.fallback, envelope, mime);
            } catch (relayErr) {
                const text = relayErr instanceof Error ? relayErr.message : String(relayErr);
                throw new GraphError(
                    `${redactor.redact(graphError.message)} — and the SMTP fallback also failed: ${redactor.redact(text)}`
                );
            }
        }
    };
}

/** Envelope recipients missing from To/Cc/Bcc headers get a Bcc header appended. */
export function addMissingBccHeader(mime: Uint8Array, envelope: SmtpEnvelope): Uint8Array {
    const text = Buffer.from(mime).toString('binary');
    const headerEnd = text.indexOf('\r\n\r\n');
    const head = headerEnd === -1 ? text : text.slice(0, headerEnd);
    const inHeaders = new Set<string>();
    for (const m of head.matchAll(/^(?:to|cc|bcc):(.*(?:\r\n[ \t].*)*)/gim)) {
        for (const addr of (m[1] ?? '').matchAll(/[^\s,;<>"']+@[^\s,;<>"')]+/g)) {
            inHeaders.add(addr[0].toLowerCase());
        }
    }
    const missing = envelope.to.filter(r => r !== '' && !inHeaders.has(r.toLowerCase()));
    if (missing.length === 0 || headerEnd === -1) {
        return mime;
    }
    const rebuilt = `${head}\r\nBcc: ${missing.join(', ')}${text.slice(headerEnd)}`;
    return Buffer.from(rebuilt, 'binary');
}
