import { describe, it, expect, vi, afterEach } from 'vitest';
import { getListingById } from './vectara.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const METADATA = {
  external_id: '12345', title: 'Well maintained 3 bed flat', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', property_type: 'Flats', bedrooms: 3, bathrooms: 2,
  price_pkr: 250000, price_label: 'PKR 2.5 Lakh', area_sqft: 1800, area_sqyd: 200,
  city: 'Karachi', area_l3: 'Clifton', area_l4: 'Block 2', area_l5: '',
  area_path: 'Karachi > Clifton > Block 2', floor: 'upper', floor_num: -1, is_verified: true,
};

describe('getListingById', () => {
  it('reads the document whose id is purpose-externalId', async () => {
    const spy = stubFetch({ id: 'rent-12345', metadata: METADATA });
    const listing = await getListingById('rent', '12345');

    expect(listing?.externalId).toBe('12345');
    expect(listing?.priceLabel).toBe('PKR 2.5 Lakh');
    const firstCall = (spy.mock.calls[0] as unknown[] | undefined)?.[0] as string | undefined;
    expect(firstCall).toContain('/documents/rent-12345');
  });

  it('returns null for a document that no longer exists', async () => {
    stubFetch({ error: 'not found' }, { ok: false, status: 404 });
    await expect(getListingById('buy', '99999')).resolves.toBeNull();
  });

  it('returns null when the document carries no metadata', async () => {
    stubFetch({ id: 'rent-12345' });
    await expect(getListingById('rent', '12345')).resolves.toBeNull();
  });

  it('rejects an id containing path characters without calling the API', async () => {
    const spy = stubFetch({});
    await expect(getListingById('rent', '../../secrets')).resolves.toBeNull();
    await expect(getListingById('rent', '')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('raises on an unexpected upstream failure rather than pretending the listing is gone', async () => {
    stubFetch({ error: 'boom' }, { ok: false, status: 500 });
    await expect(getListingById('rent', '12345')).rejects.toThrow(/HTTP 500/);
  });
});
