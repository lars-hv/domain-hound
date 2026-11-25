// Match DNS suffixes on label boundaries. Generic registrar DNS (such as
// domaincontrol.com) is excluded. Parking is a sale signal, not a listing check.
const marketplaces = [
  ['GoDaddy / Afternic', ['afternic.com', 'cashparking.com', 'smartname.com', 'uniregistrymarket.link', 'internettraffic.com'],
    'https://www.godaddy.com/help/what-is-list-for-sale-27761'],
  ['Dan.com / Undeveloped', ['dan.com', 'undeveloped.com'],
    'https://www.godaddy.com/help/what-is-list-for-sale-27761'],
  ['Sedo', ['sedoparking.com', 'sedo.com'], 'https://sedo.com/uk/parking-domains/'],
  ['HugeDomains', ['hugedomains.com', 'nsg1.namebrightdns.com', 'nsg2.namebrightdns.com'],
    'Public DNS of https://www.hugedomains.com/domain_profile.cfm?d=al-ihsan.com and hoaiphuong.com'],
  ['Bodis', ['bodis.com'], 'https://www.bodis.com/terms/domain-parking-program and public parking NS ns1.bodis.com'],
  ['ParkingCrew', ['parkingcrew.net', 'parkingcrew.com'], 'https://beta.parkingcrew.com/faq.php?detail=83&mode=detail'],
  ['Atom / Squadhelp', ['atom.com', 'squadhelp.com'],
    'https://www.atom.com/help/article/sellers-how-to-update-your-name-servers'],
];

export function saleMarketplace(nameservers = []) {
  return marketplaces.find(([, suffixes]) => nameservers.some(value => {
    const host = value.toLowerCase().replace(/\.$/, '');
    return suffixes.some(suffix => host === suffix || host.endsWith('.' + suffix));
  }))?.[0] ?? null;
}

export function saleSignal(nameservers) {
  const marketplace = saleMarketplace(nameservers);
  return { forSale: Boolean(marketplace), ...(marketplace && { marketplace }) };
}
