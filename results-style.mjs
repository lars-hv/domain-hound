import { packageFile } from './packaged.mjs';

// Domain Hound's brand B receipt, designed for the same table at phone and desktop widths.
export const receiptStyle = `
:root {
  color-scheme: light;
  --blue: #102385;
  --gold: #f4c64f;
  --cream: #fff7de;
  --lime: #cdf473;
  --coral: #ffab91;
  --mono: ui-monospace, "SFMono-Regular", Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--cream);
  color: var(--blue);
  font: 400 1.0625rem/1.5 Mulish, system-ui, sans-serif;
  overflow-wrap: anywhere;
}
main { width: min(calc(100% - 2rem), 56rem); margin: 1rem auto 3rem; }
main > header {
  padding: .875rem 1rem;
  background: var(--blue);
  color: var(--cream);
  border-bottom: .3rem solid var(--gold);
}
header small, time, code { font-family: var(--mono); }
header small { color: var(--gold); font-weight: 700; }
header a.share, header a.share:visited {
  float: right;
  min-height: 44px;
  padding: .5rem .875rem;
  border-radius: 999px;
  background: var(--lime);
  color: var(--blue);
  font-weight: 800;
}
header a.share:focus-visible { outline-color: var(--cream); }
h1, h2 { margin: 0; font-weight: 900; line-height: 1.12; letter-spacing: -.035em; }
h1 { margin-block: .2rem; font-size: clamp(2rem, 4vw, 2.75rem); }
h2 { font-size: 1.65rem; }
p { max-width: 62ch; margin: .35rem 0; }
main > section, article, footer { margin-top: 1.25rem; padding-top: 1rem; border-top: 2px solid var(--blue); }
.comparison { display: grid; gap: 2px; margin-block: .875rem; border: 2px solid var(--blue); background: var(--blue); }
.comparison > * { min-width: 0; margin: 0; padding: .6rem .8rem; background: var(--gold); }
.comparison > :last-child { background: var(--lime); }
nav { display: flex; flex-wrap: wrap; gap: 0 1rem; margin-top: 1rem; }
a, a:visited { color: inherit; text-underline-offset: .18em; }
nav a, summary { padding-block: .6rem; }
:focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; margin-block: .75rem; }
caption { padding-bottom: .35rem; text-align: left; font-weight: 750; }
th, td { padding: .5rem .4rem; border-bottom: 1px solid var(--blue); text-align: left; vertical-align: top; }
thead { background: var(--blue); color: var(--cream); }
thead th:first-child { width: 50%; }
thead th:nth-child(n+2), tbody td { text-align: right; }
tbody td { font-variant-numeric: lining-nums tabular-nums; }
th[scope="row"] code { display: block; font-weight: 800; }
th[scope="row"] small { display: block; font: 400 .9375rem/1.45 system-ui, sans-serif; }
.name-score { margin-block: .5rem; padding: .5rem .8rem; border: 2px solid var(--blue); background: var(--gold); }
.name-score p { margin: 0; font-weight: 800; }
.name-score ul { margin: .35rem 0 0; padding-left: 1.1rem; }
details { border-bottom: 1px dashed var(--blue); }
summary { cursor: pointer; font-weight: 750; }
details[open] { padding-bottom: .65rem; }
footer { font-size: .9375rem; }
@media (min-width: 48rem) {
  body { font-size: 1.125rem; }
  main { margin-top: 2rem; }
  main > header { padding: 1rem 1.25rem; }
  .comparison { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  thead th:first-child { width: 56%; }
  th, td { padding: .55rem .85rem; }
}
`;

// Inline packaged files so a saved result can be opened on its own.
const asset = name => packageFile('assets/' + name);
export const resultMark = 'data:image/svg+xml;base64,' + asset('icon.svg').toString('base64');
export const cardStyle = '/* ' + asset('mulish-OFL.txt') + ' */\n'
  + '@font-face{font-family:Mulish;font-weight:200 1000;font-style:normal;src:url(data:font/woff2;base64,'
  + asset('mulish-latin-wght-normal.woff2').toString('base64') + ') format("woff2")}\n' + asset('results.css');
