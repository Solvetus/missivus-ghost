/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */

/**
 * Header-level surgery on a raw RFC 5322 message — no body parsing, ever. Graph accepts the MIME
 * verbatim; the only thing app-only sending cannot honour is a From that is not the shared
 * mailbox, so that one header is rewritten and the requested address preserved as Reply-To.
 */

export interface ForcedFromResult {
    mime: Uint8Array;
    /** The address the message asked for, '' when none was present. */
    requestedFrom: string;
    /** True when the From header differed from the sender and was rewritten. */
    changed: boolean;
}

const CRLF = '\r\n';

export function forceFrom(mime: Uint8Array, sender: string): ForcedFromResult {
    const text = latin1Decode(mime);
    const headerEnd = findHeaderEnd(text);
    const head = headerEnd === -1 ? text : text.slice(0, headerEnd);
    const rest = headerEnd === -1 ? '' : text.slice(headerEnd);

    const lines = unfoldPreservingRaw(head);
    const fromIndex = lines.findIndex(l => /^from:/i.test(l.logical));
    const requested = fromIndex === -1 ? '' : extractAddress(lines[fromIndex]?.logical ?? '');
    const displayName = fromIndex === -1 ? '' : extractDisplayName(lines[fromIndex]?.logical ?? '');

    if (requested !== '' && requested.toLowerCase() === sender.toLowerCase()) {
        return {mime, requestedFrom: requested, changed: false};
    }

    const newFrom = displayName !== ''
        ? `From: ${quoteDisplayName(displayName)} <${sender}>`
        : `From: ${sender}`;

    const outLines: string[] = [];
    let replaced = false;
    for (const line of lines) {
        if (/^from:/i.test(line.logical)) {
            if (!replaced) {
                outLines.push(newFrom);
                replaced = true;
            }
            continue;
        }
        outLines.push(line.raw);
    }
    if (!replaced) {
        outLines.push(newFrom);
    }

    // Keep the requested address reachable — but only when nothing else claimed Reply-To,
    // so an explicit one is never clobbered.
    const hasReplyTo = lines.some(l => /^reply-to:/i.test(l.logical));
    if (!hasReplyTo && requested !== '' && requested.toLowerCase() !== sender.toLowerCase()) {
        outLines.push(`Reply-To: ${requested}`);
    }

    const rebuilt = outLines.join(CRLF) + (rest === '' ? CRLF + CRLF : rest);
    return {mime: latin1Encode(rebuilt), requestedFrom: requested, changed: requested.toLowerCase() !== sender.toLowerCase()};
}

interface HeaderLine {
    /** The header with its folded continuations joined, for matching. */
    logical: string;
    /** The original bytes-as-string, folds intact, for writing back out. */
    raw: string;
}

function findHeaderEnd(text: string): number {
    const crlf = text.indexOf('\r\n\r\n');
    if (crlf !== -1) {
        return crlf;
    }
    const lf = text.indexOf('\n\n');
    return lf;
}

function unfoldPreservingRaw(head: string): HeaderLine[] {
    const rawLines = head.split(/\r\n|\n/);
    const out: HeaderLine[] = [];
    for (const raw of rawLines) {
        if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) {
            const last = out[out.length - 1];
            if (last) {
                last.logical += ` ${raw.trim()}`;
                last.raw += CRLF + raw;
            }
            continue;
        }
        out.push({logical: raw, raw});
    }
    return out;
}

export function extractAddress(headerLine: string): string {
    const value = headerLine.replace(/^[^:]*:/, '').trim();
    const angled = /<([^<>]*)>/.exec(value);
    if (angled) {
        return (angled[1] ?? '').trim();
    }
    // Bare address form; strip comments and take the first token that looks like one.
    const bare = /[^\s,;"']+@[^\s,;"')]+/.exec(value);
    return bare ? bare[0] : '';
}

function extractDisplayName(headerLine: string): string {
    const value = headerLine.replace(/^[^:]*:/, '').trim();
    const m = /^(.*?)</.exec(value);
    if (!m) {
        return '';
    }
    return (m[1] ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
}

function quoteDisplayName(name: string): string {
    return /^[A-Za-z0-9 .-]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`;
}

/** MIME is treated as opaque bytes; latin1 round-trips every byte through a JS string. */
function latin1Decode(bytes: Uint8Array): string {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        out += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return out;
}

function latin1Encode(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i) & 0xff;
    }
    return bytes;
}
