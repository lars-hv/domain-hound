import { orderBody } from '../clis/spaceship/buy.mjs';
import { readOffer } from '../clis/spaceship/quote.mjs';

// Test only: a registrar that has the guarantees the public API lacks. It knows the owner contact, re-reads the exact
// price right before sending and refuses any difference, and sends domainCreate only to the local mock (the client
// itself refuses any other host).
export function testRegistrar(client, ownerContact = 'owner-contact-1') {
  return {
    kind: 'test-mock',
    exactAmount: true,
    idempotent: true,
    ownerContact,
    async placeOrder(order) {
      const now = readOffer(order.domain, { domain: order.domain, result: 'available' }, await client.pricing(order.domain), order.years);
      if (now.status !== 'available' || now.amount !== order.amount || now.currency !== order.currency) {
        throw Object.assign(Error('the price changed right before sending.'), { notSent: true });
      }
      return client.createDomain(order.domain, orderBody(order, order.owner));
    },
    operation: id => client.operation(id),
    info: domain => client.info(domain),
  };
}
