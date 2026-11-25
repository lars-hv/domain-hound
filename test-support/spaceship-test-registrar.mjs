import { ownerContactId } from './spaceship-mock.mjs';

// Test only: the synthetic server environment a person sets to opt into direct purchase through Spaceship's REST API.
// It adds no guarantees of its own. Spaceship's domainCreate has no price cap and no idempotency, so every limit the tests
// check is enforced by Domain Hound's own code, and orders go only to the local mock.
export const directPurchaseEnv = Object.freeze({
  DOMAIN_HOUND_DIRECT_PURCHASE: '1',
  DOMAIN_HOUND_SPACESHIP_CONTACT_ID: ownerContactId,
});
