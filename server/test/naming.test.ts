/**
 * The naming scan (docs/arcade/platform.md §18, plan.md §3.2 "Naming"). Product names the games
 * must never borrow, and the name of the chat app this project is an alternative to, are on a deny
 * list that lives outside the repository; only SHA-256 hashes of its lower-cased words and word pairs
 * are here. The test tokenizes the client and server sources, docs/, the READMEs and the landing page
 * and fails on a match. `node ops/scripts/name-hashes.mjs <list-file>` prints the hashes for new
 * entries; `node ops/scripts/name-hashes.mjs --git` scans commit messages before a release.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs helper without types
import { findHits, sha, terms } from '../../ops/scripts/name-hashes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DENY = new Set([
'e1ba4807a15d8579f79cfd90a07fc015e6125565c9271eb94aded0b2ebf86163',
  'c0a4942143e872cd1ae29fc759e04526de2e909ac1732734d38550a29c2e2516',
  '8d01416611a03b7c979d6fdee3b16006da68e29b5bd5cbc8785bc0e10205b7e8',
  '6e649ccc4f5484fa486efbfcd59ffc2f2def03a71fa8376a96a0b6826d49677d',
  '35c60b86dbcfe890aa92a44c68d36debcbc2cc79924dc5d311937ab836c1458c',
  'dffbe7770e17cd4f64838240cccbc0355b485f95df78a38cc7b0b9b9ddc2bcf4',
  '2d843741531e8a0dedbb5c3263380cdc2b437ed4596b5c4aa2ebee1fdcfad34b',
  '32a6c866b8261c05a2e747287c275529fb77168a202d077e53a665efb86f35be',
  '592701839ced7b9118a13612dfde03bdc0236155edcb2b2febbf11dd70cedd0f',
  'c74e9b181843c69dd23d0c3e506cd69372ce73e3bf180e35c3cfbf5efce9305c',
  '0c2bc41c0f4d60a3866fecd1318c7b76d1521ce2215cd2f6bc856a10cc8af2e5',
  'f2423d071f26082d053141bad42a7cb050310a1c0dfc7be5e6333fa76d32328e',
  '4eb7ef52a0e1337a674211b8ebd5709a92871d0f31e813d791cdd83ac56ff706',
  '33b87960247f42effbab829d86419879b3c4692bc7cb5cb30bd0489cd92ef404',
  'f40a789dfb4086388d1a1bc44c847df26c517e19dd0408e5798a27da1668111d',
  'd5789450f9a0ece0663d127115abef00e4c33fee2c08e1e200b8d4cce80f24ca',
  '8003a34f79b0b98ca5f70817272d4e88ddd4caa036264a9aef27154da65dfccd',
  '794b63816fc5c5f3fdd2752b022b7f4708b3779fbd38d36b8d5b6c831b724e20',
  'f03b4f5c5b362013814b4a5c2bdef49ee8488b3ad742f3d48b19da0637763301',
  '9ed733dd393b1639f776e644f387e6848cd80ac3462465b556e6302abc6280b3',
  '7576f72e3dc2edc57b5368bec100409007579e1b3f126e91db8c54eab5dcdca5',
  '8129924072252bb869d172ae9bf4655b63922caaeb44381e78d12156bd29b47e',
  '0c450b852b5751f3821aadec07d34757642bd3fc011ce081fda51ff78969e340',
  '538ece7e8db0b14fc1d6885295a29798f52f60cd225bcfa834cc912b63029185',
  'cf19e6938204ff711969e0e9a0bfc03b42c562f756327e954a8517d61f186eac',
  '93ff011b38dc23e3c50e3f55729af29253bf2b2dd48f6abc69e5d36808b8ae8b',
  '47baa85f73934172a83affbc2e11635e99cc9617f455c3a7887c5a66be5c06d0',
  '6a8df6fd94b61b0921f22cb6f2109e283db57721fe1260f5e4d22ad4d2c50813',
  'ea2eed3c9233d3d2c02d72f21d1e353154bd069ca4fa35cc2999e4212679cc99',
  '74e85dc5d4edb6e5b27beb45645782be4d0f659c42c97e0c99b6dc27c20c0ef7',
  '5fcfe1b9433151c103831afbee16dc08862ce61a8eaf38e34634200f4568ba24',
  '7e91833849bf84f4113115fc1f75fb4e530ced2df97cd479ae307924347b1d62',
  '9d7ceff28c3941a11158a3b46bd0042040d03ed574ef65fcc915a7df2c5f09e7',
  'e090e8f2a7bcaa38297eb52d39c4820bc7e1464ae88571302280c568df747f6c',
]);

const SCANNED = ['client/src', 'server/src', 'docs', 'README.md', 'client/README.md', 'server/README.md', 'ops/README.md', 'client/public/landing.html', 'client/public/downloads.html'];
const TEXT = /.(ts|tsx|js|mjs|json|md|html|css|txt|py)$/;

const walk = (path: string): string[] => {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => (name === 'node_modules' || name === 'dist' ? [] : walk(join(path, name))));
};

describe('the naming scan', () => {
  it('tokenizes words and word pairs the same way as the helper', () => {
    const t = terms('Hello, Big-World and more') as Set<string>;
    expect([...t]).toEqual(expect.arrayContaining(['hello', 'bigworld', 'hello bigworld', 'and more']));
    expect(sha('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(findHits('nothing to see here', DENY)).toEqual([]);
  });

  it('finds no deny-listed name in the sources, docs, READMEs or the landing page', () => {
    const hits: string[] = [];
    for (const base of SCANNED) {
      for (const file of walk(join(ROOT, base))) {
        if (!TEXT.test(file)) continue;
        const found = findHits(readFileSync(file, 'utf8'), DENY) as string[];
        if (found.length) hits.push(relative(ROOT, file).split(sep).join('/') + ': ' + found.join(', '));
      }
    }
    expect(hits).toEqual([]);
  });
});
