import { isIPv4, isIPv6 } from 'node:net';
import { digest } from './store.mjs';

export const planLifetimeMs = 10 * 60_000;
const ttl = 3600;

// Documented fields per record type (docs.spaceship.dev, DNS records). Other types are left alone.
const fieldsByType = { A: ['address'], AAAA: ['address'], ALIAS: ['aliasName'], CNAME: ['cname'], MX: ['exchange', 'preference'], TXT: ['value'] };
const addressTypes = ['A', 'AAAA', 'ALIAS', 'CNAME'];

export const websiteProviders = ['github-pages', 'vercel', 'netlify', 'cloudflare-pages', 'ip', 'cname'];
export const mailProviders = ['google-workspace', 'microsoft-365', 'fastmail', 'proton', 'icloud', 'forward-only'];

// Provider values from their own setup docs. Account-specific values always come from the person.
const githubPagesIps = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
const mailPresets = {
  'google-workspace': { mx: [{ exchange: 'smtp.google.com', preference: 1 }], spf: 'v=spf1 include:_spf.google.com ~all' },
  'microsoft-365': { spf: 'v=spf1 include:spf.protection.outlook.com -all' },
  fastmail: { mx: [{ exchange: 'in1-smtp.messagingengine.com', preference: 10 }, { exchange: 'in2-smtp.messagingengine.com', preference: 20 }],
    spf: 'v=spf1 include:spf.messagingengine.com ?all' },
  proton: { mx: [{ exchange: 'mail.protonmail.ch', preference: 10 }, { exchange: 'mailsec.protonmail.ch', preference: 20 }],
    spf: 'v=spf1 include:_spf.protonmail.ch ~all' },
  icloud: { mx: [{ exchange: 'mx01.mail.icloud.com', preference: 10 }, { exchange: 'mx02.mail.icloud.com', preference: 10 }],
    spf: 'v=spf1 include:icloud.com ~all' },
  // Forwarding only: the domain sends no mail of its own.
  'forward-only': { spf: 'v=spf1 -all', dmarc: 'reject' },
};

const lower = value => String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

// A host name only: no scheme, path, port or URL.
function host(value, what) {
  const text = lower(value);
  if (typeof value !== 'string' || !hostPattern.test(text)) throw Error(what + ' must be a host name like example.com, not a URL.');
  return text;
}

// '@' for the apex, else the name relative to the domain.
export function relativeName(value, domain, what = 'name') {
  const text = lower(value);
  if (text === '@' || text === domain) return '@';
  const name = text.endsWith('.' + domain) ? text.slice(0, -domain.length - 1) : text;
  if (!/^(?=.{1,190}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/.test(name)) {
    throw Error(what + ' must be @ or a name under ' + domain + '.');
  }
  return name;
}

// The comparable form of a record: type, relative name and its documented values.
export function normalize(item, domain) {
  const type = String(item?.type ?? '').toUpperCase();
  let name;
  try { name = relativeName(String(item?.name ?? '@'), domain); } catch { name = lower(item?.name); }
  const fields = {};
  for (const field of fieldsByType[type] ?? []) {
    const value = item?.[field];
    fields[field] = field === 'preference' ? Number(value) : field === 'value' ? String(value ?? '') : lower(value);
  }
  return { type, name, fields, ttl: item?.ttl, group: item?.group?.type ?? null, known: Object.hasOwn(fieldsByType, type) };
}

const identity = row => row.type + ' ' + row.name + ' ' + JSON.stringify(row.fields);
export const apiRecord = row => ({ type: row.type, name: row.name, ...row.fields });
export const recordText = row => row.type + ' ' + row.name + ' ' + (fieldsByType[row.type] ?? []).map(field => row.fields[field]).join(' ');
const isSpf = row => row.type === 'TXT' && row.name === '@' && /^v=spf1(?:\s|$)/i.test(row.fields.value);
const isDmarc = row => row.type === 'TXT' && row.name === '_dmarc' && /^v=dmarc1\s*;/i.test(row.fields.value);
// An SPF record covers the preset when it has every include of the preset. A preset without includes must match exactly.
function spfCovers(current, preset) {
  const tokens = value => value.trim().toLowerCase().split(/\s+/);
  const includes = tokens(preset).filter(token => token.startsWith('include:'));
  return includes.length ? includes.every(token => tokens(current).includes(token)) : tokens(current).join(' ') === tokens(preset).join(' ');
}
const validDmarc = row => isDmarc(row) && /(?:^|;)\s*p\s*=\s*(?:none|quarantine|reject)\s*(?:;|$)/i.test(row.fields.value);

// Validate the person's choices into desired records and the slots they take over.
export function desiredRecords(domain, { website, mail } = {}) {
  const want = [];
  const slots = [];
  const notices = [];
  const add = (type, name, fields) => want.push({ type, name, fields });
  if (website) {
    const { provider } = website;
    const ips = (list, check, what) => {
      if (list === undefined) return [];
      if (!Array.isArray(list) || list.length > 8 || !list.every(ip => typeof ip === 'string' && check(ip.trim()))) {
        throw Error(what + ' must list valid addresses.');
      }
      return [...new Set(list.map(ip => ip.trim().toLowerCase()))];
    };
    if (provider === 'github-pages') {
      const target = host(website.target, 'website.target');
      if (!/^[a-z0-9-]+\.github\.io$/.test(target)) throw Error('For GitHub Pages, website.target is your user.github.io host.');
      for (const address of githubPagesIps) add('A', '@', { address });
      add('CNAME', 'www', { cname: target });
      slots.push('@', 'www');
    } else if (provider === 'vercel') {
      // Vercel shows the exact apex IP and a unique www CNAME in the project's domain settings.
      const [address, ...more] = ips(website.ipv4, isIPv4, 'website.ipv4');
      if (!address || more.length || website.www_target === undefined) {
        throw Error('For Vercel, copy the exact apex IP (website.ipv4) and the www CNAME (website.www_target) from the project’s Domains page.');
      }
      add('A', '@', { address });
      add('CNAME', 'www', { cname: host(website.www_target, 'website.www_target') });
      slots.push('@', 'www');
    } else if (provider === 'netlify') {
      const target = host(website.target, 'website.target');
      if (!/^[a-z0-9-]+\.netlify\.app$/.test(target)) throw Error('For Netlify, website.target is your site.netlify.app host.');
      add('ALIAS', '@', { aliasName: 'apex-loadbalancer.netlify.com' });
      add('CNAME', 'www', { cname: target });
      slots.push('@', 'www');
    } else if (provider === 'cloudflare-pages') {
      const target = host(website.target, 'website.target');
      if (!/^[a-z0-9-]+\.pages\.dev$/.test(target)) throw Error('For Cloudflare Pages, website.target is your project.pages.dev host.');
      add('CNAME', 'www', { cname: target });
      slots.push('www');
      notices.push('Cloudflare Pages: add www.' + domain + ' as a custom domain in the Pages project first. '
        + 'The apex needs Cloudflare nameservers, which Domain Hound does not set.');
    } else if (provider === 'ip') {
      const v4 = ips(website.ipv4, isIPv4, 'website.ipv4');
      const v6 = ips(website.ipv6, isIPv6, 'website.ipv6');
      if (!v4.length && !v6.length) throw Error('For a plain IP, give website.ipv4 or website.ipv6.');
      for (const name of ['@', 'www']) {
        for (const address of v4) add('A', name, { address });
        for (const address of v6) add('AAAA', name, { address });
      }
      slots.push('@', 'www');
    } else if (provider === 'cname') {
      const target = host(website.target, 'website.target');
      add('ALIAS', '@', { aliasName: target });
      add('CNAME', 'www', { cname: target });
      slots.push('@', 'www');
    } else {
      throw Error('website.provider must be one of: ' + websiteProviders.join(', ') + '.');
    }
  }
  let spf = null;
  let dmarc = null;
  if (mail) {
    const preset = mailPresets[mail.provider];
    if (!preset) throw Error('mail.provider must be one of: ' + mailProviders.join(', ') + '.');
    let mx = preset.mx;
    if (mail.mx !== undefined) {
      if (!Array.isArray(mail.mx) || !mail.mx.length || mail.mx.length > 5) throw Error('mail.mx must list 1 to 5 MX records.');
      mx = mail.mx.map((row, index) => {
        const preference = row?.preference;
        if (!Number.isInteger(preference) || preference < 0 || preference > 65535) throw Error('mail.mx[' + index + '].preference must be 0 to 65535.');
        return { exchange: host(row?.exchange, 'mail.mx[' + index + '].exchange'), preference };
      });
    }
    if (mail.provider === 'microsoft-365') {
      if (!mx?.length || !mx.every(row => /\.mail\.protection\.outlook\.com$/.test(row.exchange))) {
        throw Error('For Microsoft 365, copy your tenant MX (…mail.protection.outlook.com) from the Microsoft 365 admin center into mail.mx.');
      }
      add('CNAME', 'autodiscover', { cname: 'autodiscover.outlook.com' });
      slots.push('autodiscover');
    }
    if (mail.provider === 'forward-only' && !mx?.length) {
      throw Error('For forwarding, copy the MX records your forwarding service gives you into mail.mx. '
        + 'Spaceship’s API cannot turn on its own forwarding.');
    }
    for (const row of mx) add('MX', '@', { exchange: row.exchange, preference: row.preference });
    spf = preset.spf;
    const policy = mail.dmarc;
    if (policy !== undefined && !['none', 'quarantine', 'reject'].includes(policy)) throw Error('mail.dmarc must be none, quarantine or reject.');
    dmarc = { explicit: policy !== undefined, policy: policy ?? preset.dmarc ?? 'none' };
    for (const [index, row] of (mail.records ?? []).entries()) {
      const what = 'mail.records[' + index + ']';
      const type = String(row?.type ?? '').toUpperCase();
      const name = relativeName(row?.name, domain, what + '.name');
      if (type === 'TXT') {
        const value = row?.value;
        if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\p{Cc}]/u.test(value)) throw Error(what + '.value must be text.');
        if (/^v=(?:spf1|dmarc1)\b/i.test(value.trim())) throw Error(what + ': Domain Hound sets SPF and DMARC itself, one of each.');
        add('TXT', name, { value: value.trim() });
      } else if (type === 'CNAME') {
        if (name === '@') throw Error(what + ': a CNAME cannot sit on the apex.');
        add('CNAME', name, { cname: host(row?.value, what + '.value') });
        slots.push(name);
      } else {
        throw Error(what + '.type must be TXT or CNAME, as your mail provider lists it.');
      }
    }
    if (mail.provider === 'icloud' && !(mail.records ?? []).length) {
      notices.push('iCloud: add the apple-domain TXT and sig1._domainkey CNAME from iCloud settings in mail.records to finish.');
    }
    if (mail.provider === 'forward-only') notices.push('Turn on forwarding with your forwarding service. Spaceship’s API cannot turn it on.');
  }
  if (!website && !mail) throw Error('Choose a website or mail setup.');
  return { want: want.map(row => ({ ...row, ttl })), slots: [...new Set(slots)], spf, dmarc, notices };
}

// Compare the wanted records with what Spaceship lists, and produce exact changes or blocks.
export function planChanges(domain, choices, items) {
  const { want, slots, spf, dmarc, notices: presetNotices } = desiredRecords(domain, choices);
  const existing = items.map(item => normalize(item, domain));
  const notices = [...presetNotices];
  const blocks = [];
  const adds = [];
  const deletes = [];
  const keeps = [];
  const has = row => existing.find(item => identity(item) === identity(row));
  const remove = (row, why) => {
    if (row.group !== 'custom') {
      blocks.push(recordText(row) + ' is managed by Spaceship (' + (row.group ?? 'unknown group') + '). Domain Hound will not remove it' + why + '.');
    } else if (!deletes.some(item => identity(item) === identity(row))) {
      deletes.push(row);
    }
  };
  // Keep one existing SPF record that already covers the provider, so other senders listed in it keep working.
  const currentSpf = existing.filter(isSpf);
  if (spf && currentSpf.length === 1 && spfCovers(currentSpf[0].fields.value, spf)) {
    notices.push('Keeps your SPF record, which already covers this provider: ' + currentSpf[0].fields.value);
    want.push({ type: 'TXT', name: '@', ttl, fields: { value: currentSpf[0].fields.value } });
  } else if (spf) want.push({ type: 'TXT', name: '@', ttl, fields: { value: spf } });
  if (dmarc) {
    const current = existing.filter(isDmarc);
    const keep = !dmarc.explicit && current.length === 1 && validDmarc(current[0]);
    if (keep) notices.push('Keeps your DMARC policy: ' + current[0].fields.value);
    else want.push({ type: 'TXT', name: '_dmarc', ttl, fields: { value: 'v=DMARC1; p=' + dmarc.policy } });
  }
  const wanted = new Set(want.map(identity));
  for (const row of want) (has(row) ? keeps : adds).push(row);
  for (const row of existing) {
    if (wanted.has(identity(row))) continue;
    if (slots.includes(row.name) && addressTypes.includes(row.type)) remove(row, ', which the new ' + row.name + ' records replace');
    else if (row.type === 'MX' && row.name === '@' && want.some(item => item.type === 'MX')) remove(row, ' to switch mail');
    else if (spf && isSpf(row)) {
      remove(row, ' to keep one SPF record');
      notices.push('Replaces your SPF record: ' + row.fields.value);
    } else if (dmarc && isDmarc(row) && want.some(item => item.name === '_dmarc')) {
      remove(row, ' to keep one DMARC record');
      notices.push('Replaces your DMARC record: ' + row.fields.value);
    }
  }
  // A CNAME cannot share its name with any other record that stays.
  for (const row of want.filter(item => item.type === 'CNAME')) {
    if (want.some(other => other.name === row.name && identity(other) !== identity(row))) {
      blocks.push('The proposed CNAME at ' + row.name + ' conflicts with another proposed record.');
    }
    for (const other of existing) {
      if (other.name !== row.name || identity(other) === identity(row) || deletes.some(item => identity(item) === identity(other))) continue;
      blocks.push('The CNAME at ' + row.name + ' collides with ' + recordText(other) + '. Remove that record yourself first.');
    }
  }
  for (const row of want.filter(item => item.type !== 'CNAME')) {
    const cname = existing.find(other => other.type === 'CNAME' && other.name === row.name && !deletes.some(item => identity(item) === identity(other)));
    if (cname) blocks.push(recordText(row) + ' collides with ' + recordText(cname) + '. Remove that CNAME yourself first.');
  }
  return { adds, deletes, keeps, notices: [...new Set(notices)], blocks: [...new Set(blocks)],
    recordsDigest: digest(existing.map(row => [identity(row), row.group, row.ttl]).sort()) };
}

// The exact list a person reads before anything changes.
export function planText(domain, plan, { planId, expiresAt } = {}) {
  const list = rows => rows.map(row => '- ' + recordText(row));
  const lines = [domain + ' DNS plan. Nothing changed yet.'];
  if (plan.adds.length) lines.push('Add:', ...list(plan.adds));
  if (plan.deletes.length) lines.push('Remove (only with replace: true):', ...list(plan.deletes));
  if (plan.keeps.length) lines.push('Already set:', ...list(plan.keeps));
  if (!plan.adds.length && !plan.deletes.length) lines.push('Nothing to change.');
  for (const notice of plan.notices) lines.push('Note: ' + notice);
  if (plan.blocks.length) lines.push('Blocked:', ...plan.blocks.map(block => '- ' + block));
  else if (planId && (plan.adds.length || plan.deletes.length)) {
    lines.push('Plan ' + planId + ', valid until ' + expiresAt.slice(11, 16) + ' UTC. After the person says yes, call setup_domain with '
      + 'plan_id and apply: true' + (plan.deletes.length ? ', plus replace: true to remove the listed records.' : '.'));
  }
  return lines.join('\n');
}

export const sameChanges = (a, b) => digest([a.adds.map(identity).sort(), a.deletes.map(identity).sort()])
  === digest([b.adds.map(identity).sort(), b.deletes.map(identity).sort()]);
export const presentIn = (items, domain) => {
  const rows = new Set(items.map(item => identity(normalize(item, domain))));
  return row => rows.has(identity(row));
};
