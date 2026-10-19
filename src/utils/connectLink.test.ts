import { describe, expect, it } from 'vitest';
import { parseConnectLink } from './connectLink';

const token = 'rysh_ct_' + 'a1'.repeat(24);

describe('parseConnectLink', () => {
  it('reads the dashboard deep link', () => {
    expect(
      parseConnectLink(`rysh://connect?server=https%3A%2F%2Fletchat.ai&token=${token}`)
    ).toEqual({ server: 'https://letchat.ai', token });
  });

  it('reads the terminal line, the install line, and a bare pair', () => {
    expect(parseConnectLink(`ry connect https://letchat.ai ${token}`)).toEqual({ server: 'https://letchat.ai', token });
    expect(
      parseConnectLink(`curl -fsSL https://rysh.ai/install.sh | RYSH_CONNECT="http://127.0.0.1:18080 ${token}" sh`)
    ).toEqual({ server: 'http://127.0.0.1:18080', token });
    expect(parseConnectLink(`  https://letchat.ai/   ${token}  `)).toEqual({ server: 'https://letchat.ai', token });
  });

  it('rejects anything that is not a server plus a whole code', () => {
    expect(parseConnectLink('')).toBeNull();
    expect(parseConnectLink('rysh://open?server=https://letchat.ai&token=' + token)).toBeNull();
    expect(parseConnectLink('https://letchat.ai')).toBeNull();
    expect(parseConnectLink(`letchat.ai ${token}`)).toBeNull();
    expect(parseConnectLink(`https://letchat.ai ${token.slice(0, -2)}`)).toBeNull();
    expect(parseConnectLink('rysh://connect?server=https://letchat.ai&token=rysh_abc')).toBeNull();
  });
});
