import type {TokenUsage} from './types.js';

/**
 * Claude API list prices in USD per million tokens (platform.claude.com/docs/en/about-claude/pricing).
 * A subscription is not billed per token, but its usage limits weigh tokens by model and kind much like these
 * prices do: reading the prompt cache costs a small fraction of fresh input, writing it more than fresh input,
 * output several times input. Pricing a run this way shows what actually drew down the limits.
 */
type Price = {input: number; write5m: number; write1h: number; read: number; output: number};

const PRICES: Array<{match: RegExp; price: Price}> = [
	{match: /fable|mythos/, price: {input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50}},
	{match: /opus-5-5/, price: {input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20}},
	{match: /opus/, price: {input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25}},
	{match: /sonnet-5-5/, price: {input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10}},
	{match: /sonnet/, price: {input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10}},
	// Haiku 5.5 costs more for prompts over 100k tokens; a role's prompt rarely gets there.
	{match: /haiku-5-5/, price: {input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5}},
	{match: /haiku/, price: {input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5}},
];

export const priceOf = (model: string): Price | null => PRICES.find(entry => entry.match.test(model.toLowerCase()))?.price ?? null;

/** `cacheWrite1h` is the part of the cache writes kept for an hour; the rest is priced as 5-minute writes. */
export function costUsd(model: string, usage: TokenUsage & {cacheWrite1h?: number}): number | null {
	const price = priceOf(model);
	if (!price) return null;
	const long = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWriteTokens);
	return (
		(usage.inputTokens * price.input +
			long * price.write1h +
			(usage.cacheWriteTokens - long) * price.write5m +
			usage.cacheReadTokens * price.read +
			usage.outputTokens * price.output) /
		1_000_000
	);
}
