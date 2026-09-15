import { describe, it, expect } from 'vitest';
import { parseFloor, floorFromPropertyType } from './floor.js';

describe('parseFloor', () => {
  it('returns nulls when the text says nothing about a floor', () => {
    expect(parseFloor('Spacious 3 bed house with lawn in DHA')).toEqual({
      floor: null,
      floorNum: null,
      floorRaw: null,
    });
  });

  it('detects ground floor and pins it to floor 0', () => {
    const r = parseFloor('Ground Floor Portion For Rent, Block J, 400 Sq Yards');
    expect(r.floor).toBe('ground');
    expect(r.floorNum).toBe(0);
    expect(r.floorRaw?.toLowerCase()).toContain('ground floor');
  });

  it('detects an ordinal floor and extracts its number', () => {
    expect(parseFloor('500 Yards Luxurious 1st Floor Portion Near Karsaz')).toMatchObject({
      floor: 'numbered',
      floorNum: 1,
    });
    expect(parseFloor('Well maintained 3rd floor apartment')).toMatchObject({
      floor: 'numbered',
      floorNum: 3,
    });
    expect(parseFloor('Located on the 12th Floor with sea view')).toMatchObject({
      floor: 'numbered',
      floorNum: 12,
    });
  });

  it('handles the "floor N" word order', () => {
    expect(parseFloor('Apartment on floor 7, corner unit')).toMatchObject({
      floor: 'numbered',
      floorNum: 7,
    });
  });

  it('handles spelled-out ordinals', () => {
    expect(parseFloor('Second floor portion available immediately')).toMatchObject({
      floor: 'numbered',
      floorNum: 2,
    });
  });

  it('detects higher/upper floor as a bucket with no number', () => {
    expect(parseFloor('4-Bedroom Apartment 2,671 Sq. Ft. | Higher Floor')).toMatchObject({
      floor: 'upper',
      floorNum: null,
    });
    expect(parseFloor('Upper portion for rent, separate entrance')).toMatchObject({
      floor: 'upper',
    });
  });

  it('detects lower portion as "lower"', () => {
    expect(parseFloor('500 Square Yards Lower Portion For rent In Darussalam')).toMatchObject({
      floor: 'lower',
      floorNum: null,
    });
  });

  it('detects top floor / penthouse', () => {
    expect(parseFloor('Top floor penthouse with terrace')).toMatchObject({ floor: 'top' });
  });

  it('prefers the explicit ordinal when both an ordinal and a vague word appear', () => {
    expect(parseFloor('Upper portion, 2nd floor, west open')).toMatchObject({
      floor: 'numbered',
      floorNum: 2,
    });
  });

  it('does not mistake "flooring" for a floor statement', () => {
    expect(parseFloor('Imported wooden flooring throughout the house')).toEqual({
      floor: null,
      floorNum: null,
      floorRaw: null,
    });
  });

  it('does not treat "ground" alone (e.g. playground) as a floor', () => {
    expect(parseFloor('House facing a playground and park')).toEqual({
      floor: null,
      floorNum: null,
      floorRaw: null,
    });
  });

  it('ignores an absurd floor number rather than trusting it', () => {
    expect(parseFloor('Located on the 250th floor')).toEqual({
      floor: null,
      floorNum: null,
      floorRaw: null,
    });
  });

  it('is case insensitive', () => {
    expect(parseFloor('GROUND FLOOR AVAILABLE')).toMatchObject({ floor: 'ground', floorNum: 0 });
  });
});

describe('floorFromPropertyType', () => {
  it('treats an Upper Portion listing as an upper floor', () => {
    expect(floorFromPropertyType('Upper Portions')).toEqual({
      floor: 'upper',
      floorNum: null,
      floorRaw: 'Upper Portions',
    });
  });

  it('treats a Lower Portion listing as a lower floor', () => {
    expect(floorFromPropertyType('Lower Portions')).toMatchObject({ floor: 'lower' });
  });

  it('treats a Penthouse as a top floor', () => {
    expect(floorFromPropertyType('Penthouse')).toMatchObject({ floor: 'top' });
  });

  it('infers nothing from a plain House or Flat', () => {
    expect(floorFromPropertyType('Houses')).toEqual({ floor: null, floorNum: null, floorRaw: null });
    expect(floorFromPropertyType('Flats')).toEqual({ floor: null, floorNum: null, floorRaw: null });
  });
});
