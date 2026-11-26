// 本地令牌鉴权与角色/企业范围校验。令牌仅用于合成环境。
export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function authenticate(state, req) {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new HttpError(401, 'unauthorized', '缺少 Bearer 令牌');
  }
  const token = header.slice(7).trim();
  const user = Object.values(state.users).find(u => u.token === token);
  if (!user) throw new HttpError(401, 'unauthorized', '令牌无效');
  return user;
}

export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) {
    throw new HttpError(403, 'forbidden', `当前角色 ${user.role} 无权执行该操作`);
  }
}

// 企业代表只能访问自己名下仍有代表权的企业。
export function requireCompanyAccess(state, user, companyId) {
  if (user.role === 'representative') {
    const link = user.personId
      ? state.representations.find(r => r.companyId === companyId && r.personId === user.personId && r.status === 'active')
      : null;
    if (!link) throw new HttpError(403, 'forbidden', '只能访问本人代表企业的资料');
  }
}

export function assertCompanyExists(state, companyId) {
  const company = state.companies.find(c => c.id === companyId);
  if (!company) throw new HttpError(404, 'not_found', '企业不存在');
  return company;
}

export function assertPersonExists(state, personId) {
  const person = state.persons.find(p => p.id === personId);
  if (!person) throw new HttpError(404, 'not_found', '自然人不存在');
  return person;
}

export function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) {
      throw new HttpError(413, 'payload_too_large', '请求体过大');
    }
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'bad_request', '请求体必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'bad_json', 'JSON 格式不符');
  }
}

export function requireFields(body, fields) {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      throw new HttpError(400, 'missing_field', `缺少必填字段 ${field}`);
    }
  }
}

export function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isIsoString(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// YYYY-MM-DD 字符串可直接按字典序比较（同为公历日期）。
export function dateWithin(date, start, end) {
  return date >= start && date <= end;
}

export function addAudit(state, entry) {
  state.audit.push({ id: `AUD-${state.audit.length + 1}`, at: entry.at, ...entry });
}

export function mailEvent(state, mail, at, type, note, extra = {}) {
  mail.events.push({ at, type, note, ...extra });
}
