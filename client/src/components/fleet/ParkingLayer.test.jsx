import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('maplibre-gl', () => ({
  default: {
    Popup: class {
      setLngLat() { return this; }
      setDOMContent(el) { this.el = el; return this; }
      addTo() { return this; }
      remove() {}
    },
  },
}));

const { default: ParkingLayer, ParkingLegend, ParkingNote, describe: describeRow, googleMapsUrl, milesText, toFeatureCollection, PARKING_URL } = await import('./ParkingLayer.jsx');

const MI_LAT = 1 / 69;
const DATA = {
  version: 1,
  source: '© OpenStreetMap contributors (ODbL)',
  points: [
    [-95.5, 32 + 2 * MI_LAT, 1, "Love's Travel Stop", 3, 80],
    [-96.5, 32, 2, ''],
    [-80, 40, 3, 'Far away lot'],
  ],
};
const ROUTE = { key: 'C1:L1', from: 'truck', label: 'Dallas → Shreveport', points: Array.from({ length: 201 }, (_, i) => [-97 + i * 0.01, 32]) };

/** Just enough of a MapLibre map to watch what the layer does to it. */
function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  const calls = { setData: [], visibility: [], paint: [] };
  const handlers = [];
  const map = {
    calls, handlers, sources, layers,
    isStyleLoaded: () => true,
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => sources.set(id, { spec, setData: (d) => calls.setData.push([id, d]), getClusterExpansionZoom: async () => 9 }),
    getLayer: (id) => layers.get(id),
    addLayer: (spec, before) => layers.set(spec.id, { spec, before }),
    hasImage: () => false,
    addImage: vi.fn(),
    setLayoutProperty: (id, k, v) => calls.visibility.push([id, v]),
    setPaintProperty: (id, k, v) => calls.paint.push([id, k, v]),
    on: (...a) => handlers.push(a),
    off: vi.fn(),
    getCanvas: () => ({ style: {} }),
    queryRenderedFeatures: () => [],
    getZoom: () => 6,
    flyTo: vi.fn(),
    easeTo: vi.fn(),
  };
  return map;
}

let qc;
const wrap = (ui) => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => DATA }));
});
afterEach(() => { delete globalThis.fetch; });

describe('ParkingLayer', () => {
  it('fetches nothing and touches no map while the layer is off', () => {
    const map = fakeMap();
    const { container } = render(wrap(<ParkingLayer map={map} on={false} route={ROUTE} />));
    expect(container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
    expect(map.sources.size).toBe(0);
  });

  it('turning it on loads the file once, adds a clustered source and sets the data once', async () => {
    const map = fakeMap();
    const { rerender } = render(wrap(<ParkingLayer map={map} on route={null} />));
    await waitFor(() => expect(map.calls.setData.some(([id]) => id === 'parking')).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(PARKING_URL);
    expect(map.sources.get('parking').spec).toMatchObject({ type: 'geojson', cluster: true });
    expect(map.sources.get('parking').spec.attribution).toContain('OpenStreetMap contributors');
    const sent = map.calls.setData.filter(([id]) => id === 'parking');
    expect(sent).toHaveLength(1);
    expect(sent[0][1].features).toHaveLength(3);

    // Re-rendering with the same inputs sends nothing again.
    rerender(wrap(<ParkingLayer map={map} on route={null} />));
    expect(map.calls.setData.filter(([id]) => id === 'parking')).toHaveLength(1);

    // Off: hidden, not removed; on again: no new download.
    rerender(wrap(<ParkingLayer map={map} on={false} route={null} />));
    expect(map.calls.visibility.filter(([, v]) => v === 'none').length).toBeGreaterThanOrEqual(7);
    rerender(wrap(<ParkingLayer map={map} on route={null} />));
    expect(map.calls.visibility.at(-1)[1]).toBe('visible');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lists the next stops along the route with miles and the availability caveat', async () => {
    const map = fakeMap();
    render(wrap(<ParkingLayer map={map} on route={ROUTE} />));
    const card = await screen.findByRole('region', { name: 'Parking along this route' });
    await waitFor(() => expect(card).toHaveTextContent('2 within 10 mi · Dallas → Shreveport'));
    const rows = card.querySelectorAll('ol li');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Rest area'); // unnamed rest area first (about 29 miles)
    expect(rows[1]).toHaveTextContent("Love's Travel Stop");
    expect(rows[1]).toHaveTextContent('Open 24/7');
    expect(card).toHaveTextContent('Space availability is not shown');
    expect(card).toHaveTextContent('OpenStreetMap contributors');
    // The highlight source holds only the places near the route, ranked.
    const route = map.calls.setData.filter(([id]) => id === 'parking-route').at(-1)[1];
    expect(route.features.map((f) => f.properties.r)).toEqual([1, 2]);
    // Other parking steps back while the route is highlighted.
    expect(map.calls.paint).toContainEqual(['parking-points', 'icon-opacity', 0.4]);

    fireEvent.click(rows[1].querySelector('button'));
    expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [DATA.points[0][0], DATA.points[0][1]], zoom: 11 }));
  });

  it('shows an error with a retry when the file does not load', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    render(wrap(<ParkingNote />));
    // One retry (about a second) before the error shows.
    expect(await screen.findByText('Truck parking did not load', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('notes attribution and the caveat once loaded, and has legend entries', async () => {
    render(wrap(<><ParkingNote /><ParkingLegend /></>));
    expect(await screen.findByText(/Truck parking © OpenStreetMap contributors\. Space availability is not shown\./)).toBeInTheDocument();
    for (const l of ['Truck stop', 'Rest area', 'Truck parking']) expect(screen.getByText(l)).toBeInTheDocument();
  });
});

describe('parking helpers', () => {
  it('describes rows, formats miles and links to Google Maps', () => {
    const d = describeRow([-95.5, 32.1, 1, 'Pilot', 3, 80]);
    expect(d.title).toBe('Pilot');
    expect(d.extras).toEqual(['Open 24/7', 'Showers', '80 truck spaces mapped']);
    expect(describeRow([-95.5, 32.1, 2, '']).title).toBe('Rest area');
    expect(googleMapsUrl(32.1, -95.5)).toBe('https://www.google.com/maps/search/?api=1&query=32.1,-95.5');
    expect(milesText(3.24)).toBe('3.2 mi');
    expect(milesText(1234.4)).toBe('1,234 mi');
    expect(milesText(undefined)).toBe('');
    const fc = toFeatureCollection(DATA.points);
    expect(fc.features[1].properties).toEqual({ k: 2, i: 1 });
    expect(fc.features[0].properties.n).toBe("Love's Travel Stop");
  });
});
