import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadState, saveState } from './store.mjs';
import {
  HttpError, addAudit, authenticate, readJson, requireRole, send, requireCompanyAccess,
} from './http-util.mjs';
import * as org from './domain/organizations.mjs';
import * as tenancy from './domain/tenancy.mjs';
import * as mailDomain from './domain/mail.mjs';
import { createCarrierClient, createForwarding, syncForwarding, revokeForwarding, resolveIntercept } from './domain/forwarding.mjs';
import { openDispute, resolveDispute } from './domain/disputes.mjs';
import * as deposits from './domain/deposits.mjs';

const PARTNER_CONFIG = JSON.parse(readFileSync(new URL('../fixtures/partner.json', import.meta.url), 'utf8'));

export function createApp(options = {}) {
  const stateFile = options.stateFile;
  const seedFile = options.seedFile ?? null;
  const clock = options.clock ?? (() => new Date().toISOString());
  const state = options.state ?? loadState(stateFile, seedFile);
  const carrier = createCarrierClient({
    baseUrl: options.carrierBaseUrl ?? 'http://127.0.0.1:4317',
    config: PARTNER_CONFIG,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.carrierTimeoutMs ?? 4000,
  });
  const deps = { carrier };

  const persist = () => { if (stateFile) saveState(stateFile, state); };
  const now = () => clock();
  const audit = (actor, action, target, note, extra = {}) => {
    addAudit(state, { at: now(), actorId: actor?.id ?? 'anonymous', role: actor?.role ?? null, action, target, note, ...extra });
  };

  // 路由表：[方法, 前缀匹配, 角色, 处理函数]
  const routes = [];
  const route = (method, pattern, roles, handler) => routes.push({ method, pattern, roles, handler });

  // ---------- 基础资料 ----------
  route('GET', '/health', null, async (req, res) => send(res, 200, { status: 'ok', service: 'community-exit', at: now() }));
  route('GET', '/source-changes', ['operations', 'reviewer'], async (req, res, actor) => {
    send(res, 200, { inbound: state.inbound });
  });
  route('GET', '/audit', ['operations', 'reviewer', 'cashier'], async (req, res) => {
    send(res, 200, { audit: state.audit });
  });

  route('POST', '/persons', ['operations'], async (req, res, actor, body) => {
    const person = org.createPerson(state, body, actor, now());
    audit(actor, 'person.create', person.id, person.name); persist(); send(res, 201, person);
  });

  // ---------- 企业身份申请与核准 ----------
  route('POST', '/company-applications', ['representative', 'operations'], async (req, res, actor, body) => {
    const app = org.createCompanyApplication(state, body, actor, now());
    audit(actor, 'company.apply', app.id, app.name); persist(); send(res, 201, app);
  });
  route('POST', '/company-applications/:id/confirm', ['operations'], async (req, res, actor, body, params) => {
    const result = org.confirmCompanyApplication(state, params.id, actor, now());
    audit(actor, 'company.confirm', result.company.id, `核准申请 ${result.application.id}`); persist(); send(res, 200, result);
  });
  route('POST', '/company-applications/:id/reject', ['operations'], async (req, res, actor, body, params) => {
    const app = org.rejectCompanyApplication(state, params.id, actor, body, now());
    audit(actor, 'company.reject', app.id, app.rejectReason); persist(); send(res, 200, app);
  });
  route('GET', '/companies', ['operations', 'representative', 'frontdesk', 'reviewer', 'cashier'], async (req, res, actor) => {
    let rows = state.companies;
    if (actor?.role === 'representative') {
      const ids = state.representations.filter(r => r.personId === actor.personId && r.status === 'active').map(r => r.companyId);
      rows = rows.filter(c => ids.includes(c.id));
    }
    send(res, 200, { companies: rows });
  });

  // ---------- 企业授权：代表权 ----------
  route('POST', '/representations', ['representative', 'operations'], async (req, res, actor, body) => {
    const rep = org.createRepresentation(state, body, actor, now());
    audit(actor, 'representation.submit', rep.id, `${rep.companyId}/${rep.personId}`); persist(); send(res, 201, rep);
  });
  route('POST', '/representations/:id/verify', ['operations'], async (req, res, actor, body, params) => {
    const rep = org.verifyRepresentation(state, params.id, actor, body, now());
    audit(actor, 'representation.verify', rep.id, '代表权核实生效，旧授权待重新核实'); persist(); send(res, 200, rep);
  });
  route('POST', '/representations/:id/reject', ['operations'], async (req, res, actor, body, params) => {
    const rep = org.rejectRepresentation(state, params.id, actor, body, now());
    audit(actor, 'representation.reject', rep.id, body?.reason ?? '材料不足'); persist(); send(res, 200, rep);
  });
  route('GET', '/representations', null, async (req, res, actor, body, params, url) => {
    let rows = state.representations;
    if (url.searchParams.get('companyId')) rows = rows.filter(r => r.companyId === url.searchParams.get('companyId'));
    if (actor.role === 'representative') rows = rows.filter(r => r.personId === actor.personId);
    send(res, 200, { representations: rows });
  });

  // ---------- 企业授权：授权领取人 ----------
  route('POST', '/recipient-auths', ['representative'], async (req, res, actor, body) => {
    const auth = org.createRecipientAuth(state, body, actor, now());
    audit(actor, 'recipient-auth.submit', auth.id, `${auth.companyId}/${auth.personId}`); persist(); send(res, 201, auth);
  });
  route('POST', '/recipient-auths/:id/verify', ['operations'], async (req, res, actor, body, params) => {
    const auth = org.verifyRecipientAuth(state, params.id, actor, body, now());
    audit(actor, 'recipient-auth.verify', auth.id, '授权领取人核实通过'); persist(); send(res, 200, auth);
  });
  route('POST', '/recipient-auths/:id/revoke', ['representative', 'operations'], async (req, res, actor, body, params) => {
    const auth = org.revokeRecipientAuth(state, params.id, actor, body, now());
    audit(actor, 'recipient-auth.revoke', auth.id, body?.reason ?? '撤销'); persist(); send(res, 200, auth);
  });
  // 前台只可查询与交付资格相关的授权视图，不返回内部备注全文。
  route('GET', '/recipient-auths', ['frontdesk', 'operations', 'representative'], async (req, res, actor, body, params, url) => {
    let rows = state.recipientAuths;
    const companyId = url.searchParams.get('companyId');
    if (companyId) rows = rows.filter(a => a.companyId === companyId);
    if (actor.role === 'representative') rows = rows.filter(a => a.grantedByPersonId === actor.personId);
    const view = rows.map(a => ({
      id: a.id, companyId: a.companyId, personId: a.personId, status: a.status,
      validFrom: a.validFrom, validUntil: a.validUntil, scopeKinds: a.scopeKinds, allowHandover: a.allowHandover,
    }));
    send(res, 200, { recipientAuths: view });
  });

  // ---------- 入驻 ----------
  route('POST', '/tenancy-applications', ['representative'], async (req, res, actor, body) => {
    const app = tenancy.createTenancyApplication(state, body, actor, now());
    audit(actor, 'tenancy.apply', app.id, app.companyId); persist(); send(res, 201, app);
  });
  route('POST', '/tenancy-applications/:id/confirm', ['operations'], async (req, res, actor, body, params) => {
    const result = tenancy.confirmTenancy(state, params.id, actor, body, now());
    audit(actor, 'tenancy.confirm', result.application.id, '确认签约主体与授权领取人'); persist(); send(res, 200, result);
  });
  route('GET', '/tenancy-applications', ['operations', 'representative'], async (req, res, actor, body, params, url) => {
    let rows = state.tenancyApplications;
    if (url.searchParams.get('companyId')) rows = rows.filter(a => a.companyId === url.searchParams.get('companyId'));
    if (actor.role === 'representative') {
      const ids = state.representations.filter(r => r.personId === actor.personId && r.status === 'active').map(r => r.companyId);
      rows = rows.filter(a => ids.includes(a.companyId));
    }
    send(res, 200, { tenancyApplications: rows });
  });
  route('GET', '/services', ['operations', 'frontdesk', 'representative'], async (req, res, actor, body, params, url) => {
    let rows = state.services;
    if (url.searchParams.get('companyId')) rows = rows.filter(s => s.companyId === url.searchParams.get('companyId'));
    if (actor.role === 'representative') {
      const ids = state.representations.filter(r => r.personId === actor.personId && r.status === 'active').map(r => r.companyId);
      rows = rows.filter(s => ids.includes(s.companyId));
    }
    send(res, 200, { services: rows });
  });

  // ---------- 门禁 ----------
  route('POST', '/credentials', ['operations'], async (req, res, actor, body) => {
    const credential = tenancy.issueCredential(state, body, actor, now());
    audit(actor, 'credential.issue', credential.id, `${credential.companyId}/${credential.personId}`); persist(); send(res, 201, credential);
  });
  route('POST', '/credentials/:id/return', ['frontdesk', 'operations'], async (req, res, actor, body, params) => {
    const credential = tenancy.beginCredentialReturn(state, params.id, actor, now());
    audit(actor, 'credential.return-begin', credential.id, '归还确认中，冻结新入场'); persist(); send(res, 200, credential);
  });
  route('POST', '/credentials/:id/return-confirm', ['frontdesk', 'operations'], async (req, res, actor, body, params) => {
    const credential = tenancy.completeCredentialReturn(state, params.id, actor, body, now());
    audit(actor, 'credential.return-confirm', credential.id, credential.returnCondition); persist(); send(res, 200, credential);
  });
  route('POST', '/credentials/:id/revoke', ['operations'], async (req, res, actor, body, params) => {
    const credential = tenancy.revokeCredential(state, params.id, actor, body, now());
    audit(actor, 'credential.revoke', credential.id, body?.reason ?? ''); persist(); send(res, 200, credential);
  });
  route('GET', '/credentials', ['operations', 'frontdesk', 'representative'], async (req, res, actor, body, params, url) => {
    let rows = state.credentials;
    if (url.searchParams.get('companyId')) rows = rows.filter(c => c.companyId === url.searchParams.get('companyId'));
    if (actor.role === 'representative') rows = rows.filter(c => c.personId === actor.personId);
    send(res, 200, { credentials: rows });
  });
  route('POST', '/access-attempts', ['frontdesk', 'operations'], async (req, res, actor, body) => {
    const attempt = tenancy.recordEntryAttempt(state, body, actor, now());
    audit(actor, 'access.attempt', attempt.credentialId, attempt.allowed ? '放行' : `拒绝：${attempt.reasons.join('；')}`, { allowed: attempt.allowed });
    persist(); send(res, attempt.allowed ? 200 : 403, attempt);
  });
  route('GET', '/access-attempts', ['operations', 'frontdesk'], async (req, res) => send(res, 200, { accessAttempts: state.accessAttempts }));

  // ---------- 退驻 ----------
  route('POST', '/exits', ['representative', 'operations'], async (req, res, actor, body) => {
    const exit = tenancy.createExitApplication(state, body, actor, now());
    audit(actor, 'exit.apply', exit.id, exit.companyId); persist(); send(res, 201, exit);
  });
  route('POST', '/exits/:id/checkpoints/space', ['operations'], async (req, res, actor, body, params) => {
    const exit = tenancy.closeSpaceCheckpoint(state, params.id, actor, now());
    audit(actor, 'exit.checkpoint.space', exit.id, '空间使用结束'); persist(); send(res, 200, exit);
  });
  route('POST', '/exits/:id/checkpoints/access', ['operations'], async (req, res, actor, body, params) => {
    const exit = tenancy.closeAccessCheckpoint(state, params.id, actor, now());
    audit(actor, 'exit.checkpoint.access', exit.id, '人员进出结束'); persist(); send(res, 200, exit);
  });
  route('POST', '/exits/:id/checkpoints/address', ['operations'], async (req, res, actor, body, params) => {
    const result = tenancy.closeAddressCheckpoint(state, params.id, actor, body, now());
    audit(actor, 'exit.checkpoint.address', exitIdOf(params), result.retention ? `地址保留至 ${result.retention.end}` : '地址托管结束');
    persist(); send(res, 200, result);
  });
  route('POST', '/exits/:id/checkpoints/mail', ['operations'], async (req, res, actor, body, params) => {
    const exit = tenancy.closeMailCheckpoint(state, params.id, actor, now());
    audit(actor, 'exit.checkpoint.mail', exit.id, '未结来件清零'); persist(); send(res, 200, exit);
  });
  route('POST', '/exits/:id/checkpoints/deposit', ['operations', 'cashier'], async (req, res, actor, body, params) => {
    const exit = tenancy.closeDepositCheckpoint(state, params.id, actor, now());
    audit(actor, 'exit.checkpoint.deposit', exit.id, '押金交接勾选'); persist(); send(res, 200, exit);
  });
  route('GET', '/exits/:id/overview', ['operations', 'representative', 'cashier', 'reviewer'], async (req, res, actor, body, params) => {
    const overview = tenancy.exitOverview(state, params.id, now());
    if (actor.role === 'representative') requireCompanyAccess(state, actor, overview.exit.companyId);
    send(res, 200, overview);
  });
  route('GET', '/exits', ['operations', 'representative'], async (req, res, actor) => {
    let rows = state.exits;
    if (actor.role === 'representative') {
      const ids = state.representations.filter(r => r.personId === actor.personId && r.status === 'active').map(r => r.companyId);
      rows = rows.filter(e => ids.includes(e.companyId));
    }
    send(res, 200, { exits: rows });
  });
  route('POST', '/exits/:id/finalize', ['operations'], async (req, res, actor, body, params) => {
    const exit = tenancy.finalizeExit(state, params.id, actor, now());
    audit(actor, 'exit.finalize', exit.id, '逐项交接完成，退驻结案'); persist(); send(res, 200, exit);
  });

  // ---------- 来件 ----------
  route('POST', '/mail', ['frontdesk'], async (req, res, actor, body) => {
    const mail = mailDomain.registerMail(state, body, actor, now());
    audit(actor, 'mail.register', mail.id, `${mail.kind}/${mail.status}`); persist(); send(res, 201, mailDomain.frontDeskView(mail));
  });
  route('POST', '/mail/:id/verification', ['operations'], async (req, res, actor, body, params) => {
    const mail = mailDomain.resolveVerificationHold(state, params.id, actor, body, now());
    audit(actor, 'mail.verification', mail.id, body.decision); persist(); send(res, 200, mail);
  });
  route('POST', '/mail/:id/pickup', ['frontdesk'], async (req, res, actor, body, params) => {
    const mail = mailDomain.pickupMail(state, params.id, body, actor, now());
    audit(actor, 'mail.pickup', mail.id, `${mail.deliveryBasis} -> ${mail.deliveredToPersonId}`); persist(); send(res, 200, mail);
  });
  route('GET', '/mail', ['frontdesk', 'operations', 'representative', 'reviewer'], async (req, res, actor, body, params, url) => {
    const companyId = url.searchParams.get('companyId');
    if (actor.role === 'representative' && companyId) requireCompanyAccess(state, actor, companyId);
    const rows = mailDomain.listMail(state, actor.role, actor, companyId);
    if (actor.role === 'frontdesk') return send(res, 200, { mail: rows.map(mailDomain.frontDeskView) });
    if (actor.role === 'representative') {
      return send(res, 200, companyId ? { mail: mailDomain.companyMailList(state, companyId) } : { mail: rows });
    }
    send(res, 200, { mail: rows });
  });
  route('GET', '/mail/pending/deadlines', ['frontdesk', 'operations', 'representative'], async (req, res, actor, body, params, url) => {
    const atDate = url.searchParams.get('atDate') ?? now().slice(0, 10);
    send(res, 200, { pending: mailDomain.pendingDeadlines(state, atDate, actor.role, actor) });
  });
  route('GET', '/mail/:id', ['frontdesk', 'operations', 'representative', 'reviewer'], async (req, res, actor, body, params) => {
    const mail = mailDomain.getMailById(state, params.id);
    if (actor.role === 'representative') requireCompanyAccess(state, actor, mail.companyId);
    if (actor.role === 'frontdesk') return send(res, 200, mailDomain.frontDeskView(mail));
    send(res, 200, mail);
  });

  // ---------- 转寄 ----------
  route('POST', '/forwardings', ['operations', 'representative'], async (req, res, actor, body) => {
    if (actor.role === 'representative') {
      const mail = state.mail.find(m => m.id === body.mailId);
      if (mail) requireCompanyAccess(state, actor, mail.companyId);
    }
    const forwarding = await createForwarding(state, deps, body, actor, now());
    audit(actor, 'forwarding.create', forwarding.id, forwarding.status); persist(); send(res, 201, forwarding);
  });
  route('POST', '/forwardings/:id/sync', ['operations', 'frontdesk'], async (req, res, actor, body, params) => {
    const result = await syncForwarding(state, deps, params.id, actor, now());
    audit(actor, 'forwarding.sync', params.id, result.synced ? `承运状态 ${result.carrierStatus ?? '未找到'}` : '查单未明');
    persist(); send(res, 200, result);
  });
  route('POST', '/forwardings/:id/revoke', ['operations', 'representative'], async (req, res, actor, body, params) => {
    const result = revokeForwarding(state, body, params.id, actor, now());
    audit(actor, 'forwarding.revoke', params.id, result.kind); persist(); send(res, 200, result);
  });
  route('POST', '/forwardings/:id/intercepts/:interceptId/resolve', ['operations'], async (req, res, actor, body, params) => {
    const intercept = resolveIntercept(state, params.id, params.interceptId, body, actor, now());
    audit(actor, 'forwarding.intercept-resolve', params.interceptId, body.outcome); persist(); send(res, 200, intercept);
  });
  route('GET', '/forwardings', ['operations', 'frontdesk', 'representative'], async (req, res, actor, body, params, url) => {
    let rows = state.forwardings;
    if (url.searchParams.get('companyId')) rows = rows.filter(f => f.companyId === url.searchParams.get('companyId'));
    if (actor.role === 'representative') {
      const ids = state.representations.filter(r => r.personId === actor.personId && r.status === 'active').map(r => r.companyId);
      rows = rows.filter(f => ids.includes(f.companyId));
    }
    send(res, 200, { forwardings: rows });
  });

  // ---------- 争议复核（独立记录） ----------
  route('POST', '/disputes', ['representative', 'operations', 'reviewer'], async (req, res, actor, body) => {
    const dispute = openDispute(state, body, actor, now());
    audit(actor, 'dispute.open', dispute.id, dispute.reason); persist(); send(res, 201, dispute);
  });
  route('POST', '/disputes/:id/resolve', ['reviewer'], async (req, res, actor, body, params) => {
    const dispute = resolveDispute(state, params.id, body, actor, now());
    audit(actor, 'dispute.resolve', dispute.id, body.decision); persist(); send(res, 200, dispute);
  });
  route('GET', '/disputes', ['reviewer', 'operations', 'representative'], async (req, res, actor, body, params, url) => {
    let rows = state.disputes;
    if (url.searchParams.get('companyId')) rows = rows.filter(d => d.companyId === url.searchParams.get('companyId'));
    if (actor.role === 'representative') {
      const ids = state.representations.filter(r => r.personId === actor.personId && r.status === 'active').map(r => r.companyId);
      rows = rows.filter(d => ids.includes(d.companyId));
    }
    send(res, 200, { disputes: rows });
  });

  // ---------- 押金 ----------
  route('POST', '/deposits/fees', ['cashier', 'operations'], async (req, res, actor, body) => {
    const result = await Promise.resolve(deposits.addFee(state, body, actor, now()));
    audit(actor, 'deposit.fee', body.companyId, `${body.amountMinor} 分`); persist(); send(res, 201, result);
  });
  route('POST', '/deposits/holds', ['cashier', 'operations', 'reviewer'], async (req, res, actor, body) => {
    const result = deposits.addHold(state, body, actor, now());
    audit(actor, 'deposit.hold', body.companyId, `${body.amountMinor} 分暂扣`); persist(); send(res, 201, result);
  });
  route('POST', '/deposits/holds/:id/release', ['cashier', 'operations', 'reviewer'], async (req, res, actor, body, params) => {
    const result = deposits.releaseHold(state, params.id, body, actor, now());
    audit(actor, 'deposit.hold-release', params.id, result.hold.status); persist(); send(res, 200, result);
  });
  route('POST', '/deposits/refunds', ['cashier'], async (req, res, actor, body) => {
    const result = deposits.refundDeposit(state, body, actor, now());
    audit(actor, 'deposit.refund', body.companyId, `${body.amountMinor} 分，转寄责任保留=${result.refund.forwardingObligationsRetained}`);
    persist(); send(res, 201, result);
  });
  route('GET', '/deposits/:companyId/summary', ['cashier', 'operations', 'representative'], async (req, res, actor, body, params) => {
    if (actor.role === 'representative') requireCompanyAccess(state, actor, params.companyId);
    send(res, 200, deposits.depositSummary(state, params.companyId));
  });

  function matchRoute(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const parts = r.pattern.split('/').filter(Boolean);
      const actual = pathname.split('/').filter(Boolean);
      if (parts.length !== actual.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(actual[i]);
        else if (parts[i] !== actual[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  const server = createServer(async (req, res) => {
    let actor = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const matched = matchRoute(req.method, url.pathname);
      if (!matched) return send(res, 404, { error: '没有对应的接口', path: url.pathname });
      if (matched.route.roles) {
        actor = authenticate(state, req);
        requireRole(actor, ...matched.route.roles);
      }
      await matched.route.handler(req, res, actor, body, matched.params, url);
    } catch (error) {
      if (error instanceof HttpError) {
        return send(res, error.status, { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
      }
      console.error(error);
      return send(res, 500, { error: '服务内部错误', code: 'internal' });
    }
  });

  return { server, state, deps };
}

function exitIdOf(params) { return params.id; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stateFile = process.env.APP_STATE ?? '.local/app.json';
  const seedFile = process.env.SEED_FILE ?? new URL('../fixtures/records.json', import.meta.url).pathname;
  const { server } = createApp({
    stateFile,
    seedFile,
    carrierBaseUrl: process.env.CARRIER_URL ?? 'http://127.0.0.1:4317',
  });
  const port = Number(process.env.PORT ?? 4318);
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ message: '社区入退驻业务服务已启动', port, stateFile, seedFile }));
  });
}
