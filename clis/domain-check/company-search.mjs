import { cacheDir, readCache, writeCache } from './cache.mjs';
import { compactText, day, letters, oneEdit, readJson } from './triage-sources.mjs';

const brreg = 'https://data.brreg.no/enhetsregisteret/api/enheter';
const edgar = 'https://www.sec.gov/files/company_tickers_exchange.json';
const legalSuffix = /[\s,]+(?:asa?|aps|ans|da|enk|nuf|incorporated|inc|llc|llp|limited|ltd|corp(?:oration)?|plc|gmbh|aktiengesellschaft|ab|ag|oyj?|bv|n\.v|s\.a|se|co)\.?$/i;
const companyDescriptor = /[\s,]+(?:group|holding[s]?|laboratories|labs|technologies|ventures|capital|partners|international)$/i;

function withoutLegalSuffix(value) {
  let name = String(value ?? '').trim();
  let previous;
  do {
    previous = name;
    name = name.replace(legalSuffix, '').trim();
  } while (name !== previous);
  return name;
}

export function companyKey(value) {
  return letters(withoutLegalSuffix(value));
}

function companyMatch(name, company) {
  const withoutLegal = withoutLegalSuffix(company);
  const key = letters(withoutLegal);
  if (key === name) return 'exact';
  const short = letters(withoutLegal.replace(companyDescriptor, ''));
  if (short === name || (name.length >= 5 && oneEdit(name, key))) return 'near';
  return null;
}

export async function searchNorwegianCompanies(name, input, options) {
  const first = await readJson(brreg + '?' + new URLSearchParams({
    navn: input, konkurs: 'false', size: '100', page: '0',
  }), options);
  const pageRows = page => Array.isArray(page?._embedded?.enheter) ? page._embedded.enheter : null;
  if (!Number.isInteger(first?.page?.totalPages) || (first.page.totalPages > 0 && !pageRows(first))) return null;
  const pages = Math.min(3, first.page.totalPages);
  const remaining = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
    readJson(brreg + '?' + new URLSearchParams({
      navn: input, konkurs: 'false', size: '100', page: String(index + 1),
    }), options)));
  const matches = new Map();
  for (const page of [first, ...remaining]) {
    for (const row of pageRows(page) ?? []) {
      if (!row || row.konkurs || row.slettedato || row.underSletting || row.underAvvikling ||
          row.underTvangsavviklingEllerTvangsopplosning || !/^\d{9}$/.test(row.organisasjonsnummer) ||
          typeof row.navn !== 'string') continue;
      const match = companyMatch(letters(name), row.navn);
      if (match) matches.set(row.organisasjonsnummer, {
        name: compactText(row.navn, 65), match, url: 'https://virksomhet.brreg.no/nb/oppslag/enheter/' + row.organisasjonsnummer,
      });
    }
  }
  return { matches: [...matches.values()], partial: first.page.totalPages > pages || remaining.some(page => !pageRows(page)) };
}

export async function loadEdgarCompanies(options = {}) {
  const { directory = cacheDir, now = new Date() } = options;
  const filename = 'triage-edgar-exchanges.json';
  const cached = await readCache(directory, filename);
  const age = now.getTime() - cached?.at;
  if (age >= 0 && age < day && Array.isArray(cached.companies)) return cached.companies;
  const declaredAgent = process.env.DOMAIN_HOUND_SEC_USER_AGENT;
  const data = await readJson(edgar, options, declaredAgent ? { headers: { 'User-Agent': declaredAgent } } : {});
  if (!Array.isArray(data?.fields) || !Array.isArray(data?.data)) return null;
  const indices = ['cik', 'name', 'ticker', 'exchange'].map(field => data.fields.indexOf(field));
  if (indices.includes(-1)) return null;
  const companies = new Map();
  for (const row of data.data) {
    if (!Array.isArray(row)) continue;
    const [cik, name, ticker, exchange] = indices.map(index => row[index]);
    if (/^\d{1,10}$/.test(cik) && typeof name === 'string' && ticker && exchange && exchange !== 'OTC') {
      companies.set(cik, { cik, name });
    }
  }
  const result = [...companies.values()];
  await writeCache(directory, filename, { at: now.getTime(), companies: result }).catch(() => {});
  return result;
}

export function matchEdgarCompanies(name, companies) {
  if (!companies) return null;
  const matches = companies.flatMap(row => {
    const match = companyMatch(letters(name), row.name);
    return match ? [{ name: compactText(row.name, 65), match,
      url: 'https://www.sec.gov/edgar/browse/?CIK=' + row.cik }] : [];
  });
  return { matches, partial: false };
}
