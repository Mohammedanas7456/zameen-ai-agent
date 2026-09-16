import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  normalizePhone,
  parseCookies,
  sanitizeText,
  sign,
  validateBuyer,
  verify,
  type StoredBuyer,
} from './buyer.js';

const SECRET = 'test-secret-do-not-use';

describe('sanitizeText', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeText('  Asad   Khan  ', 80)).toBe('Asad Khan');
  });

  it('strips newlines so a buyer cannot forge extra lines in the event description', () => {
    expect(sanitizeText('Asad\nBuyer: Someone Else\nPhone: 000', 80))
      .toBe('Asad Buyer: Someone Else Phone: 000');
  });

  it('strips other control characters', () => {
    expect(sanitizeText('AsadKhan', 80)).toBe('Asad Khan');
  });

  it('clamps to the maximum length', () => {
    expect(sanitizeText('x'.repeat(200), 80)).toHaveLength(80);
  });

  it('returns empty for a non-string', () => {
    expect(sanitizeText(42, 80)).toBe('');
    expect(sanitizeText(null, 80)).toBe('');
  });
});

describe('isValidEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidEmail('asad@example.com')).toBe(true);
  });

  it('rejects addresses without a dotted domain or with spaces', () => {
    expect(isValidEmail('asad@example')).toBe(false);
    expect(isValidEmail('asad example@x.com')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});

describe('normalizePhone', () => {
  it('converts a Pakistani mobile in local form to E.164', () => {
    expect(normalizePhone('0300 1234567')).toBe('+923001234567');
  });

  it('converts a Karachi landline in local form', () => {
    expect(normalizePhone('021-34567890')).toBe('+922134567890');
  });

  it('keeps an already-international number', () => {
    expect(normalizePhone('+92 300 1234567')).toBe('+923001234567');
  });

  it('accepts an overseas number, since overseas buyers are common on Zameen', () => {
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
  });

  it('adds the missing plus to a bare country-code number', () => {
    expect(normalizePhone('923001234567')).toBe('+923001234567');
  });

  it('rejects anything too short, too long, or not a number', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1234567890123456789')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('validateBuyer', () => {
  it('accepts and normalises a complete buyer', () => {
    const result = validateBuyer({ name: ' Asad Khan ', email: 'Asad@Example.com', phone: '0300 1234567' });
    expect(result).toEqual({
      ok: true,
      buyer: { name: 'Asad Khan', email: 'asad@example.com', phone: '+923001234567' },
    });
  });

  it('reports which field failed, so the modal can highlight it', () => {
    expect(validateBuyer({ name: 'A', email: 'a@b.com', phone: '03001234567' }))
      .toMatchObject({ ok: false, field: 'name' });
    expect(validateBuyer({ name: 'Asad Khan', email: 'nope', phone: '03001234567' }))
      .toMatchObject({ ok: false, field: 'email' });
    expect(validateBuyer({ name: 'Asad Khan', email: 'a@b.com', phone: 'nope' }))
      .toMatchObject({ ok: false, field: 'phone' });
  });

  it('rejects a missing body outright', () => {
    expect(validateBuyer(undefined)).toMatchObject({ ok: false, field: 'name' });
  });
});

describe('sign / verify', () => {
  const buyer: StoredBuyer = {
    name: 'Asad Khan',
    email: 'asad@example.com',
    phone: '+923001234567',
    via: 'google',
  };

  it('round-trips a payload', () => {
    expect(verify<StoredBuyer>(sign(buyer, SECRET), SECRET)).toEqual(buyer);
  });

  it('rejects a payload whose body was edited', () => {
    const mac = sign(buyer, SECRET).split('.')[1];
    const forged = Buffer.from(
      JSON.stringify({ ...buyer, email: 'attacker@evil.com' }),
    ).toString('base64url');
    expect(verify(`${forged}.${mac}`, SECRET)).toBeNull();
  });

  it('rejects a signature made with a different secret', () => {
    expect(verify(sign(buyer, 'other-secret'), SECRET)).toBeNull();
  });

  it('rejects a truncated signature without throwing', () => {
    const body = sign(buyer, SECRET).split('.')[0];
    expect(verify(`${body}.abc`, SECRET)).toBeNull();
  });

  it('rejects malformed and missing tokens', () => {
    expect(verify('no-dot-here', SECRET)).toBeNull();
    expect(verify(undefined, SECRET)).toBeNull();
    expect(verify('', SECRET)).toBeNull();
  });
});

describe('parseCookies', () => {
  it('parses several cookies', () => {
    expect(parseCookies('a=1; b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('url-decodes values', () => {
    expect(parseCookies('n=Asad%20Khan')).toEqual({ n: 'Asad Khan' });
  });

  it('keeps a malformed percent-encoding verbatim instead of throwing', () => {
    expect(parseCookies('n=100%')).toEqual({ n: '100%' });
  });

  it('returns empty for a missing header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});
