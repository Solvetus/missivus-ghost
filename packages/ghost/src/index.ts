/**
 * Missivus for Ghost — send Ghost transactional email through Microsoft Graph with application
 * permissions and a shared mailbox. No SMTP (to Microsoft), no user login. Free, GPLv3.
 *
 * @link    https://github.com/Solvetus/missivus-ghost
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
export {SmtpShimServer, smtpSafeLine} from './smtp-server.ts';
export type {SmtpEnvelope, DeliverFn, SmtpShimServerOptions} from './smtp-server.ts';
export {resolveConfig, configurationProblem} from './config.ts';
export type {ShimConfig, FallbackConfig} from './config.ts';
export {buildDeliver, buildMailer, buildRedactor, addMissingBccHeader} from './deliver.ts';
export {relayOverSmtp} from './smtp-client.ts';
export {main} from './cli.ts';
