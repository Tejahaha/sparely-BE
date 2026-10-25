// Complete, valid onboarding facts per category for tests.
export const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=';
const privateFacts = { address: '12 Test Lane, Madhapur, Hyderabad 500081', accessInstructions: 'Ring the side bell; code 4821.' };

export const equipmentProfile = (overrides = {}) => ({
  facts: { public: { condition: 'good', defects: '', functionCheck: 'working', functionNote: '', checkedOn: '2026-10-20', restrictions: 'Indoor use only.', safety: '', declaration: true, ...overrides }, private: privateFacts },
  addPhotos: [{ kind: 'item', image: photo }],
});
export const parkingProfile = (overrides = {}) => ({
  facts: { public: { vehicles: ['hatchback'], space: { length: 5, width: 2.5, unit: 'm' }, heightKnown: 'none', covered: 'yes', gate: 'key', accessHours: '7 am–10 pm', restrictions: '', declaration: true, ...overrides }, private: privateFacts },
  addPhotos: [],
});
export const storageFacts = (overrides = {}) => ({
  mode: 'shared', room: { length: 5, width: 4, height: 8, unit: 'ft' }, usableArea: 20, usableUnit: 'sqft',
  doorway: { width: 3, height: 7, unit: 'ft' }, floor: 'Ground', access: 'ground', accessRoute: 'Side gate, first door on the right.',
  condition: 'Dry, painted concrete floor.', damp: 'none_known', ventilation: 'good', pests: 'none_known', petsPresent: 'no',
  sharedAccess: 'yes', whoCanAccess: 'Host and other renters by appointment.', security: 'Padlocked door.', accessHours: '9 am–6 pm',
  notice: '24h', appointment: 'yes', allowedGoods: 'Sealed boxes\nSuitcases', prohibitedGoods: 'Food\nFlammables', stacking: 'Up to 1.5 m.',
  declaration: true, ...overrides,
});
export const storageProfile = (overrides = {}) => ({
  facts: { public: storageFacts(overrides), private: privateFacts },
  addPhotos: [{ kind: 'room', image: photo }, { kind: 'entrance', image: photo }],
});
export const profileFor = category => (category === 'storage' ? storageProfile() : category === 'parking' ? parkingProfile() : equipmentProfile());
export const storageIntake = (sqft = 4) => ({ items: [{ description: 'Sealed boxes', quantity: 2, length: 2, width: 1, height: 1, unit: 'ft' }], footprintSqft: sqft, accessNeeds: '', environment: '', prohibitedAcknowledged: true });
