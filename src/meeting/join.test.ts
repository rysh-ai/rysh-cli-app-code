import { describe, expect, it } from 'vitest';
import { checkGrant, parseJoinLink, validRoom } from './join';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2ln';

describe('checkGrant', () => {
  it('accepts wss anywhere and ws only on localhost', () => {
    expect(checkGrant({ url: 'wss://lk.rysh.ai', token: JWT }).url).toBe('wss://lk.rysh.ai');
    expect(checkGrant({ url: 'ws://localhost:7880', token: JWT }).url).toBe('ws://localhost:7880');
    expect(() => checkGrant({ url: 'ws://lk.example.com', token: JWT })).toThrow(/wss/);
    expect(() => checkGrant({ url: 'https://lk.rysh.ai', token: JWT })).toThrow(/wss/);
    expect(() => checkGrant({ url: 'wss://u:p@lk.rysh.ai', token: JWT })).toThrow(/credentials/);
  });
  it('rejects tokens that are not JWT-shaped', () => {
    expect(() => checkGrant({ url: 'wss://lk.rysh.ai', token: 'hunter2' })).toThrow(/token/);
    expect(() => checkGrant({ url: 'wss://lk.rysh.ai' })).toThrow();
  });
});

describe('parseJoinLink', () => {
  it('reads url/token from the query, the fragment, or the LiveKit Meet form', () => {
    expect(parseJoinLink(`https://rysh.ai/meet?url=wss://lk.rysh.ai&token=${JWT}&room=standup`)).toEqual({
      url: 'wss://lk.rysh.ai',
      token: JWT,
      room: 'standup',
    });
    expect(parseJoinLink(`https://rysh.ai/meet#url=${encodeURIComponent('ws://localhost:7880')}&token=${JWT}`).url).toBe(
      'ws://localhost:7880',
    );
    expect(parseJoinLink(`https://meet.livekit.io/custom?liveKitUrl=wss://lk.rysh.ai&token=${JWT}`).token).toBe(JWT);
  });
  it('reads a JSON grant', () => {
    expect(parseJoinLink(JSON.stringify({ url: 'wss://lk.rysh.ai', token: JWT, identity: 'ada' })).identity).toBe('ada');
  });
  it('explains what is wrong', () => {
    expect(() => parseJoinLink('hello')).toThrow(/join link/);
    expect(() => parseJoinLink('{nope')).toThrow(/JSON/);
    expect(() => parseJoinLink('https://rysh.ai/meet?url=wss://lk.rysh.ai')).toThrow();
  });
});

it('validRoom', () => {
  expect(validRoom('standup-2')).toBe(true);
  expect(validRoom('')).toBe(false);
  expect(validRoom('a b')).toBe(false);
  expect(validRoom('x'.repeat(65))).toBe(false);
});
