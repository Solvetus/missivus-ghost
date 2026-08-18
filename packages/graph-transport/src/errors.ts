/**
 * Missivus — send email through the Microsoft Graph API.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
import {Redactor} from './redactor.ts';

/**
 * The one failure type. Carries the HTTP status and the (possibly truncated) response body so a
 * host can classify a failure, and keeps the pre-body message apart so a redaction pass can
 * rebuild the whole thing from clean parts.
 */
export class GraphError extends Error {
    override readonly name = 'GraphError';
    readonly httpStatus: number;
    readonly responseBody: string;
    private readonly baseMessage: string;

    constructor(message: string, httpStatus = 0, responseBody = '') {
        super(responseBody !== '' ? `${message} — response: ${responseBody}` : message);
        this.baseMessage = message;
        this.httpStatus = httpStatus;
        this.responseBody = responseBody;
    }

    /**
     * Belt and braces: rebuild this error from redacted parts. Returns `this` untouched when
     * there was nothing to hide, so the ordinary path keeps its original stack trace.
     *
     * The replacement deliberately does not chain the original as `cause`: a handler that prints
     * the whole chain would otherwise print the very text this pass exists to remove.
     */
    redactedWith(redactor: Redactor): GraphError {
        const message = redactor.redact(this.baseMessage);
        const body = redactor.redact(this.responseBody);
        if (message === this.baseMessage && body === this.responseBody) {
            return this;
        }
        return new GraphError(message, this.httpStatus, body);
    }
}
