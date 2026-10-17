/**
 * A place dataset small enough to read, standing in for the generated files in
 * `public/geo/` (which no test fetches: the pickers take their source as a prop).
 *
 * It holds the three shapes the pickers have to cope with — a country with one timezone,
 * a country with several whose states settle them and whose cities correct two of those,
 * and a country with no subdivisions at all. `overrides` replaces either loader, which is
 * how the "the data did not arrive" paths are tested.
 */
export const geoWorld = (overrides = {}) => ({
  countries: async () => [
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬', zones: ['Africa/Lagos'], tz: 'Africa/Lagos' },
    { code: 'SG', name: 'Singapore', flag: '🇸🇬', zones: ['Asia/Singapore'], tz: 'Asia/Singapore' },
    {
      code: 'US', name: 'United States', flag: '🇺🇸',
      zones: ['America/Boise', 'America/Chicago', 'America/Indianapolis', 'America/New_York'], tz: null,
    },
  ],
  country: async (code) => {
    const datasets = {
      NG: {
        code: 'NG', zones: ['Africa/Lagos'], tz: 'Africa/Lagos',
        states: [{ code: 'LA', name: 'Lagos', tz: 'Africa/Lagos' }, { code: 'RI', name: 'Rivers', tz: 'Africa/Lagos' }],
        cities: { LA: ['Lagos'], RI: ['Port Harcourt', 'Buguma'] },
      },
      SG: { code: 'SG', zones: ['Asia/Singapore'], tz: 'Asia/Singapore', states: [], cities: { '': ['Singapore'] } },
      US: {
        code: 'US',
        zones: ['America/Boise', 'America/Chicago', 'America/Indianapolis', 'America/New_York'],
        tz: null,
        states: [
          { code: 'ID', name: 'Idaho', tz: 'America/Boise' },
          { code: 'IN', name: 'Indiana', tz: 'America/Indianapolis' },
        ],
        cities: { ID: ['Boise'], IN: ['Gary', 'Indianapolis'] },
        cityZones: { IN: { Gary: 'America/Chicago' } },
      },
    };
    const dataset = datasets[code];
    if (!dataset) throw new Error(`no place data for ${code}`);
    return dataset;
  },
  ...overrides,
});

