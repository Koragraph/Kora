// Network backstop for the outbound-action gate (Phase 6.4). `classifyOutbound` reads the element about to be clicked;
// a `div` that POSTs through fetch() under an innocent label slips past it. So every state-changing request
// (POST / PUT / PATCH / DELETE) that happens right after an agent action is classified here, from the request itself,
// and held (CDP Fetch pause) until the user approves. Plain GET is never touched. Pure: unit-testable without a browser.
import { hostPortOf } from './netpolicy';
import type { RiskLevel } from './safety';

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** What the host remembers about the agent's last user-visible action. */
export interface ActionContext {
  at: number;
  tool: string;
  /** Classifier result for that action. */
  level: RiskLevel;
  /** The user approved a `hard` action (so its own requests, and its payment processor's, are covered). */
  approved: boolean;
}

export interface MutatingRequest {
  method: string;
  url: string;
  /** Origin of the page that made it (the active tab's URL). */
  pageUrl: string;
  resourceType?: string;
  postData?: string;
}

const PATH_SENSITIVE = /\/(check-?out|payments?|pay|charges?|billing|card|cards|purchase|orders?|place-?order|buy|book(ing)?s?|reserve|reservations?|donate|transfer|withdraw|subscribe|subscriptions?|signup|sign-up|register|password|passwd|credentials|account|accounts|profile\/(email|delete)|delete|remove|cancel|unsubscribe|send|publish|post|submit|confirm)(\/|$|\?|\.|-)/i;
const BODY_SENSITIVE = /(card.?(number|num)|cc.?num|cvv|cvc|expir|iban|routing.?number|password|passwd|new.?password|"amount"|amount=|total=|paymentMethod|payment_method)/i;
/** Telemetry that every site sends: not an outbound action by the user. */
const TELEMETRY = /(google-analytics|googletagmanager|doubleclick|analytics|segment\.io|mixpanel|sentry\.io|datadoghq|hotjar|fullstory|newrelic|rubiconproject|adnxs|criteo|pubmatic|openx|taboola|outbrain|scorecardresearch|adsrvr|casalemedia|amazon-adsystem|adservice|googlesyndication|clarity\.ms|facebook\.com\/tr|bat\.bing|quantserve|demdex|bluekai|tiktok.*pixel|px\.ads|\/(collect|beacon|telemetry|metrics|events|log|track|pixel|ping|impression|usersync|sync|cookiesync|bid)(\/|$|\?))/i;
/** Third-party hosts that really take payments: a request to one of these is not an ad beacon. */
const PAYMENT_HOST = /(^|\.)(stripe\.com|paypal\.com|braintreegateway\.com|adyen\.com|squareup\.com|checkout\.com|klarna\.com|authorize\.net)$/i;

export interface Gate { gate: boolean; reason: string; summary: string }

export function looksSensitive(url: string, postData?: string): string | null {
  let path = url;
  try { const u = new URL(url); path = u.pathname + u.search; } catch { /* keep raw */ }
  if (PATH_SENSITIVE.test(path)) return 'looks like a checkout / payment / account request';
  if (postData && BODY_SENSITIVE.test(postData.slice(0, 4000))) return 'its body carries payment or account fields';
  return null;
}

/**
 * Decide whether a state-changing request must wait for the user. Rules:
 *  - not state-changing, or no agent action in the last `windowMs`: pass (a page may always do its own thing; the
 *    gate exists for what the AGENT's action caused);
 *  - the user was driving: pass (their own click is their own consent);
 *  - the agent's action was `hard` and the user approved it: pass (the approval covered the action and its requests);
 *  - telemetry: pass;
 *  - the action was `hard` and not approved: hold any state-changing request;
 *  - the action was `soft`: hold only a request whose path is a checkout / payment / account endpoint;
 *  - the action was not flagged: pass.
 */
export function classifyMutation(req: MutatingRequest, ctx: ActionContext | null, o: { now?: number; windowMs?: number; userDriving?: boolean } = {}): Gate {
  const pass: Gate = { gate: false, reason: '', summary: '' };
  const method = req.method.toUpperCase();
  if (!MUTATING.has(method)) return pass;
  if (o.userDriving) return pass;
  const now = o.now ?? Date.now();
  if (!ctx || now - ctx.at > (o.windowMs ?? 8000)) return pass;
  if (ctx.level === 'hard' && ctx.approved) return pass;
  if (TELEMETRY.test(req.url)) return pass;
  if (req.resourceType && /^(ping|beacon|image)$/i.test(req.resourceType)) return pass; // sendBeacon / tracking pixel
  const to = hostPortOf(req.url); const from = hostPortOf(req.pageUrl);
  const thirdParty = !!to && !!from && to.host !== from.host;
  // A third-party site that is not a payment processor is an ad / analytics / widget call: never worth stopping the
  // agent's answer for (launch QA: an ad-exchange POST was read as "payment fields" and aborted the whole turn). Only
  // what the user would call a submit (checkout, booking, account, message) on the page's own site or its processor.
  if (thirdParty && !PAYMENT_HOST.test(to!.host)) return pass;
  const where = to ? to.host : req.url;
  const what = `${method} ${where}${(() => { try { return new URL(req.url).pathname; } catch { return ''; } })().slice(0, 60)}`;
  // Only a request that follows a FLAGGED action can be held (launch QA: picking a showtime posted first-party GraphQL
  // whose body mentioned "amount", and that read as a payment). Plain navigation, seat / showtime selection, filters, cart
  // views and analytics never reach here with a flag, so they pass.
  if (ctx.level === 'none') return pass;
  if (ctx.level === 'hard') {
    return { gate: true, reason: `the page sent a ${method} after "${ctx.tool}", which looked like an outbound action`, summary: `Send data (${what})${thirdParty ? ` to another site (${where})` : ''}, triggered by the agent's ${ctx.tool}` };
  }
  // soft (a "book" / "buy" style click that is usually just a step): only a request whose own path is a checkout / payment / account endpoint
  let path = req.url;
  try { const u = new URL(req.url); path = u.pathname + u.search; } catch { /* raw */ }
  if (PATH_SENSITIVE.test(path)) { const why = 'looks like a checkout / payment / account request'; return { gate: true, reason: why, summary: `Send data (${what})${thirdParty ? ` to another site (${where})` : ''}: ${why}` }; }
  return pass;
}
