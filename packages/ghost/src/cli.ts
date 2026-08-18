#!/usr/bin/env node
/**
 * Missivus for Ghost — send Ghost transactional email through the Microsoft Graph API.
 *
 * The `missivus-ghost` daemon: a local SMTP-to-Graph shim. Point Ghost's own supported SMTP
 * transport at it — nothing in Ghost is patched, and upgrades cannot break the wiring.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import process from 'node:process';
import type {Logger} from '@missivus/graph-transport';
import {configurationProblem, resolveConfig} from './config.ts';
import {buildDeliver, buildRedactor} from './deliver.ts';
import {SmtpShimServer} from './smtp-server.ts';

function parseArgs(argv: string[]): {ghostConfig?: string; host?: string; port?: number} {
    const out: {ghostConfig?: string; host?: string; port?: number} = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--ghost-config' && argv[i + 1] !== undefined) {
            out.ghostConfig = argv[++i] ?? '';
        } else if (arg === '--host' && argv[i + 1] !== undefined) {
            out.host = argv[++i] ?? '';
        } else if (arg === '--port' && argv[i + 1] !== undefined) {
            out.port = parseInt(argv[++i] ?? '', 10);
        } else if (arg === '--help' || arg === '-h') {
            process.stdout.write(
                'missivus-ghost — SMTP-to-Graph shim for Ghost transactional email\n\n'
                + 'Options:\n'
                + '  --ghost-config <path>  read mail.options from a Ghost config.*.json\n'
                + '  --host <address>       listen address (default 127.0.0.1, env MISSIVUS_LISTEN_HOST)\n'
                + '  --port <port>          listen port (default 2525, env MISSIVUS_LISTEN_PORT)\n\n'
                + 'Configuration: MISSIVUS_* env vars win over Ghost-style mail__options__* env vars,\n'
                + 'which win over the config file. See the README for the full key list.\n'
            );
            process.exit(0);
        }
    }
    return out;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
    const args = parseArgs(argv);
    const config = resolveConfig(process.env, args.ghostConfig);
    if (args.host !== undefined) {
        config.listenHost = args.host;
    }
    if (args.port !== undefined && !Number.isNaN(args.port)) {
        config.listenPort = args.port;
    }

    const redactor = buildRedactor(config);
    const logger: Logger = {
        error: m => process.stderr.write(`[missivus] ERROR ${redactor.redact(m)}\n`),
        warning: m => process.stderr.write(`[missivus] WARN ${redactor.redact(m)}\n`),
        info: m => process.stdout.write(`[missivus] ${redactor.redact(m)}\n`)
    };

    const problem = configurationProblem(config);
    if (problem !== '') {
        // Start anyway and fail per message, loudly: a Ghost pointing at a dead socket would
        // surface only a connect error, which names nothing.
        logger.error(`${problem} — every message will be refused until this is fixed`);
    }

    const deliver = buildDeliver(config, logger);
    const server = new SmtpShimServer({
        deliver,
        log: line => { logger.error(line); }
    });
    const bound = await server.listen(config.listenPort, config.listenHost);
    logger.info(`listening on ${bound.host}:${String(bound.port)}; sending as ${config.sender === '' ? '(sender not configured)' : config.sender}`);
    logger.info(`point Ghost at it: mail__transport=SMTP mail__options__host=${bound.host} mail__options__port=${String(bound.port)}`);

    const shutdown = (): void => {
        void server.close().then(() => {
            process.exit(0);
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

const invokedDirectly = process.argv[1] !== undefined
    && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) {
    main().catch((err: unknown) => {
        process.stderr.write(`[missivus] FATAL ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}
