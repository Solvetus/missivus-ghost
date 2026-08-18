/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */

/**
 * The last thing between a credential and a log file.
 *
 * Everything Missivus logs or puts in an error message goes through here first. Two layers,
 * because either alone would miss something:
 *
 *  1. Known literals — the actual secret and passphrase we hold, replaced wherever they appear.
 *     Catches the case where a server echoes a submitted value straight back.
 *  2. Shape matching — bearer tokens, secret-looking parameters, JWTs, and credentials carried
 *     inside a URL. Catches values we were never given, such as an access token inside an Entra
 *     error payload, or a password somebody typed into a base-URL override.
 */
export class Redactor {
    static readonly MASK = '***redacted***';

    /**
     * Parameter names whose value is assumed to be a secret, wherever `name=value` appears.
     *
     * Deliberately broader than the parameters Missivus itself sends: the point is to catch a
     * credential somebody put somewhere it does not belong — an `access_token` in an endpoint
     * override, an authorisation `code` echoed in an Entra error — not to describe our own traffic.
     */
    static readonly SECRET_PARAMS = 'access_token|refresh_token|id_token|client_secret|client_assertion'
        + '|assertion|api_key|apikey|password|passwd|pwd|secret|signature|token|code|sig|sas';

    private readonly literals: string[] = [];

    /** @param literals Secret values to blank wherever they appear. */
    constructor(literals: readonly (string | undefined)[] = []) {
        for (const literal of literals) {
            // Very short strings would mangle unrelated text for no security gain.
            if (typeof literal === 'string' && literal.length >= 8) {
                this.literals.push(literal);
            }
        }
    }

    redact(text: string): string {
        if (text === '') {
            return text;
        }

        try {
            let out = text;
            for (const literal of this.literals) {
                out = out.split(literal).join(Redactor.MASK);
            }

            // "access_token":"eyJ0..." and friends, in JSON. uploadUrl belongs in this list: it is
            // pre-authenticated, so anyone holding it can write to the draft it was issued for.
            out = out.replace(
                /("(?:access_token|refresh_token|id_token|client_secret|client_assertion|uploadUrl)"\s*:\s*")[^"]*(")/gi,
                `$1${Redactor.MASK}$2`
            );
            // Credentials inside a URL: https://user:password@host. Anchored on the "://" so an
            // ordinary email address, which never has a scheme in front of it, is left alone.
            out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+@/gi, `$1${Redactor.MASK}@`);
            // A secret-looking parameter, in a query string or a form-encoded body alike.
            out = out.replace(
                new RegExp(`\\b((?:${Redactor.SECRET_PARAMS})=)[^&\\s"'>]+`, 'gi'),
                `$1${Redactor.MASK}`
            );
            // A fragment on a URL. Nothing Missivus talks to uses one, and it is a well-worn place
            // for a token to hide, so the whole of it goes.
            out = out.replace(/(https?:\/\/[^\s#]*)#\S+/gi, `$1#${Redactor.MASK}`);
            // Authorization: Bearer <token>
            out = out.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, `$1${Redactor.MASK}`);
            // A bare JWT anywhere at all.
            out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, Redactor.MASK);

            return out;
        } catch {
            // Failing closed matters more than a readable log line.
            return Redactor.MASK;
        }
    }

    /** Trim a Graph error body to something loggable, then redact it. */
    redactBody(body: string, maxLength = 2000): string {
        let out = body;
        if (out.length > maxLength) {
            out = `${out.slice(0, maxLength)}… (truncated)`;
        }
        return this.redact(out);
    }
}
