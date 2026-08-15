import { describe, it, expect } from 'vitest';
import {
	ETH_TOKEN, tokensFor, tokensFrom, findToken, isSplitDeployment, type NetworkConfig
} from './config.js';

// The asset list, which is the one part of the token path with no chain behind it.
//
// Everything else the app does with tokens is checked against a real node in e2e-live — the
// decimals, the approve, the transfer. What that cannot reach is what happens when the
// deployment JSON is missing, incomplete, or names an asset nothing knows about, because those
// states do not exist on a chain that just deployed successfully.
//
// They are also the states a fresh clone starts in, and the failure mode is quiet: an empty
// token list renders as no selector at all, and a wrong lookup renders an amount at the wrong
// scale. Neither raises anything.

const net = (over: Partial<NetworkConfig> = {}): NetworkConfig => ({
	chainId: 31337,
	chainName: 'Localhost',
	rpcUrl: 'http://127.0.0.1:8545',
	blockExplorer: '',
	poolAddress: '0x' + '1'.repeat(40),
	registryAddress: '0x' + '2'.repeat(40),
	controllerAddress: '0x' + '3'.repeat(40),
	startBlock: 0,
	tokens: [ETH_TOKEN],
	...over
});

describe('ETH_TOKEN', () => {
	it('is the zero address, which is what a note commitment carries', () => {
		expect(ETH_TOKEN.address).toBe('0x0000000000000000000000000000000000000000');
		expect(BigInt(ETH_TOKEN.address)).toBe(0n);
	});

	it('is 18 decimals', () => {
		expect(ETH_TOKEN.decimals).toBe(18);
	});
});

describe('tokensFor', () => {
	it('falls back to ETH alone for a chain this build has never heard of', () => {
		// Never an empty list. Returning nothing would render a wallet with no asset at all,
		// where "the deployment is unknown" and "this pool holds nothing" look identical.
		expect(tokensFor(999999)).toEqual([ETH_TOKEN]);
	});

	it('puts ETH first, because every deployment holds it', () => {
		const list = tokensFor(999999);
		expect(list[0]).toEqual(ETH_TOKEN);
	});
});

describe('findToken', () => {
	it('matches case-insensitively, since an address may arrive checksummed or not', () => {
		const lower = ETH_TOKEN.address.toLowerCase();
		const upper = '0x' + '0'.repeat(40);
		expect(findToken(999999, lower)).toEqual(ETH_TOKEN);
		expect(findToken(999999, upper)).toEqual(ETH_TOKEN);
	});

	it('returns ETH rather than undefined for an unknown address', () => {
		// Every caller is about to denominate an amount. There is no safe way to do that with
		// no token, so an unrecognised address resolves to the one asset always present rather
		// than to a value that would be formatted as NaN or crash a `.decimals` read.
		const stranger = '0x' + 'ab'.repeat(20);
		expect(findToken(999999, stranger)).toEqual(ETH_TOKEN);
	});
});

describe('isSplitDeployment', () => {
	it('accepts a deployment carrying all three addresses', () => {
		expect(isSplitDeployment(net())).toBe(true);
	});

	// Each address on its own, because a deployment JSON can lose one key to a typo and the
	// symptom is identical however it happened: a failure deep inside proof generation, long
	// after the point where the missing field could have been named.
	for (const field of ['poolAddress', 'registryAddress', 'controllerAddress'] as const) {
		it(`rejects a deployment missing ${field}`, () => {
			expect(isSplitDeployment(net({ [field]: undefined as any }))).toBe(false);
		});
	}

	it('rejects an empty-string address, not just a missing key', () => {
		// What a half-written JSON produces, and it would otherwise pass a truthiness check
		// written the obvious way round.
		expect(isSplitDeployment(net({ poolAddress: '' }))).toBe(false);
	});
});

describe('tokensFrom', () => {
	// The deployment JSON is written by a script and read at build time, so a malformed one
	// never surfaces as a parse error — it surfaces as a selector that is missing an asset, or
	// offering one twice.

	it('returns ETH alone when the deployment declares nothing', () => {
		expect(tokensFrom(undefined)).toEqual([ETH_TOKEN]);
		expect(tokensFrom({})).toEqual([ETH_TOKEN]);
	});

	it('ignores a tokens key that is not a list', () => {
		// Hand-edited JSON, or a script that wrote a single object instead of an array.
		expect(tokensFrom({ tokens: 'USDC' })).toEqual([ETH_TOKEN]);
		expect(tokensFrom({ tokens: { address: '0x1' } })).toEqual([ETH_TOKEN]);
		expect(tokensFrom({ tokens: null })).toEqual([ETH_TOKEN]);
	});

	it('keeps ETH first and appends what the deployment declared', () => {
		const usdc = { address: '0x' + 'aa'.repeat(20), symbol: 'USDC', decimals: 6 };
		expect(tokensFrom({ tokens: [usdc] })).toEqual([ETH_TOKEN, usdc]);
	});

	it('refuses to list ETH twice', () => {
		// A deployment that declares the zero address as a token would otherwise put two
		// identical buttons in the selector, one of which does nothing different.
		const declaredEth = { address: ETH_TOKEN.address, symbol: 'ETH', decimals: 18 };
		expect(tokensFrom({ tokens: [declaredEth] })).toEqual([ETH_TOKEN]);
	});

	it('drops an entry with no address', () => {
		const nameless = { symbol: 'MYSTERY', decimals: 18 } as any;
		expect(tokensFrom({ tokens: [nameless] })).toEqual([ETH_TOKEN]);
	});

	it('preserves declared decimals, since that is what the list exists to carry', () => {
		const wbtc = { address: '0x' + 'bb'.repeat(20), symbol: 'WBTC', decimals: 8 };
		expect(tokensFrom({ tokens: [wbtc] })[1].decimals).toBe(8);
	});
});
